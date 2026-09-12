/**
 * Approval-bridge tests.
 *
 * What these pin, in the order the failures were found:
 *
 * 1. The answerer must be registered where the host's routed dispatch can reach
 *    it — `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', …)` is
 *    received by listeners on the agent itself, on its ancestors, and on any
 *    untagged scope (the application root); an unrelated tagged scope is not.
 * 2. Ownership is decided from the session-id namespace: a request for a
 *    `wechat-` session is this bridge's to answer, one for a `session-` id is
 *    somebody else's and must be delegated. Comparing raw `===` against a stale
 *    active id used to delegate the bridge's own request away, and the user saw
 *    nothing at all.
 * 3. Every path either asks in WeChat or delegates: an ask with no reply still
 *    ends as DSH's default deny, an unknown peer falls back to the allowlist,
 *    and an internal error is reported in the chat instead of staying silent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the diagnostics out of the real DSH home while testing.
process.env.WECHAT_APPROVAL_TRACE = join(tmpdir(), 'wechat-approval-test.log')

import { attachApprovalBridge } from '../src/node/approvals.ts'

type Listener = (req: unknown, next: () => Promise<string>) => Promise<string>

interface Harness {
  node: never
  sent: string[]
  registrations: Array<{ number: number; resolve: (outcome: string) => void }>
  rootListeners: Listener[]
  pluginListeners: Listener[]
  pluginOptions: Array<Record<string, unknown> | undefined>
}

function harness(
  options: { timeoutSec?: number; peerId?: string | null; allowFrom?: string[]; breakCounter?: boolean } = {},
): Harness {
  const sent: string[] = []
  const registrations: Array<{ number: number; resolve: (outcome: string) => void }> = []
  const rootListeners: Listener[] = []
  const pluginListeners: Listener[] = []
  const pluginOptions: Array<Record<string, unknown> | undefined> = []
  const peerId = options.peerId === undefined ? 'peer@im.wechat' : options.peerId
  const node = {
    peerId: peerId ?? undefined,
    activeSessionId: null as string | null,
    config: {
      approvalTimeoutSec: options.timeoutSec ?? 600,
      allowFrom: options.allowFrom ?? ['allow@im.wechat'],
    },
    ctx: {
      get: (name: string) =>
        name === 'wechat'
          ? {
              sendText: async (_to: string, text: string) => {
                sent.push(text)
                return { success: true }
              },
              sendTyping: async () => {},
            }
          : undefined,
      on: (_event: string, listener: Listener, options?: Record<string, unknown>) => {
        pluginListeners.push(listener)
        pluginOptions.push(options)
        return () => {}
      },
      root: {
        on: (_event: string, listener: Listener) => {
          rootListeners.push(listener)
          return () => {}
        },
      },
      logger: { warn: () => {}, info: () => {} },
    },
    isWechatSessionId: (id: unknown) => id !== null && id !== undefined && String(id).startsWith('wechat-'),
    nextApprovalNumber: () => {
      if (options.breakCounter) throw new Error('counter exploded')
      return registrations.length + 1
    },
    registerApproval: (number: number, entry: { resolve: (outcome: string) => void }) => {
      registrations.push({ number, resolve: entry.resolve })
    },
    clearApproval: () => {},
  }
  return { node: node as never, sent, registrations, rootListeners, pluginListeners, pluginOptions }
}

/** Minimal session shape the label helpers need. */
const session = (id: string) => ({ id, snapshotEvents: () => [] })
const request = (id: string, reason?: string) => ({ toolName: 'pwsh', reason, agent: { session: session(id) } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the answerer registers globally and ahead of every other answerer', () => {
  const h = harness()
  attachApprovalBridge(h.node)
  assert.equal(h.pluginListeners.length, 1, 'one answerer on the plugin context')
  // `global` skips the routed-scope filter (otherwise the request never arrives)
  // and `prepend` beats the desktop client's own answerer, which would otherwise
  // claim the request and show a card in the app while WeChat stays silent.
  assert.deepEqual(h.pluginOptions[0], { prepend: true, global: true })
})

test('a request for another session namespace is delegated, never answered', async () => {
  const h = harness()
  attachApprovalBridge(h.node)
  let delegated = false
  const outcome = await h.pluginListeners[0]!(request('session-web-gui'), async () => {
    delegated = true
    return 'unavailable'
  })
  assert.equal(delegated, true)
  assert.equal(outcome, 'unavailable')
  assert.deepEqual(h.sent, [], 'no prompt for a request this bridge does not own')
})

test('a wechat session is answered even while the active id bookkeeping is stale', async () => {
  const h = harness()
  ;(h.node as unknown as { activeSessionId: string | null }).activeSessionId = 'wechat-some-other-boot'
  attachApprovalBridge(h.node)
  const pending = h.pluginListeners[0]!(request('wechat-x', 'escalate sandbox'), async () => 'unavailable')
  await tick()
  assert.match(h.sent.join('\n'), /需要你的确认/)
  h.registrations[0]!.resolve('allowed-once')
  assert.equal(await pending, 'allowed-once')
})

test('our own request prompts in WeChat and honours the reply', async () => {
  const h = harness()
  attachApprovalBridge(h.node)
  const pending = h.pluginListeners[0]!(request('wechat-x', 'escalate sandbox'), async () => 'unavailable')
  await tick()
  const prompt = h.sent.join('\n')
  assert.match(prompt, /需要你的确认/)
  assert.match(prompt, /工具: pwsh/)
  assert.match(prompt, /escalate sandbox/)
  assert.match(prompt, /回复 \/yes 同意/)
  h.registrations[0]!.resolve('allowed-once')
  assert.equal(await pending, 'allowed-once')
  await tick() // the trailing status line is sent with void, so let it land
  assert.match(h.sent.join('\n'), /已同意/)
})

test('a rejected reply reports the rejection and returns it', async () => {
  const h = harness()
  attachApprovalBridge(h.node)
  const pending = h.pluginListeners[0]!(request('wechat-x'), async () => 'unavailable')
  await tick()
  h.registrations[0]!.resolve('rejected')
  assert.equal(await pending, 'rejected')
  await tick()
  assert.match(h.sent.join('\n'), /已拒绝/)
})

test('no reply falls back to the DSH default deny on timeout', async () => {
  const h = harness({ timeoutSec: 0.02 })
  attachApprovalBridge(h.node)
  const outcome = await h.pluginListeners[0]!(request('wechat-x'), async () => 'unavailable')
  assert.equal(outcome, 'rejected')
  await tick()
  assert.match(h.sent.join('\n'), /已拒绝/)
})

test('an unknown peer falls back to the bridge allowlist', async () => {
  const h = harness({ peerId: null })
  attachApprovalBridge(h.node)
  const pending = h.pluginListeners[0]!(request('wechat-x'), async () => 'unavailable')
  await tick()
  assert.match(h.sent.join('\n'), /需要你的确认/)
  h.registrations[0]!.resolve('rejected')
  await pending
})

test('with neither peer nor allowlist the request is delegated', async () => {
  const h = harness({ peerId: null, allowFrom: [] })
  attachApprovalBridge(h.node)
  let delegated = false
  const outcome = await h.pluginListeners[0]!(request('wechat-x'), async () => {
    delegated = true
    return 'unavailable'
  })
  assert.equal(delegated, true)
  assert.equal(outcome, 'unavailable')
})

test('an internal failure is reported in the chat instead of staying silent', async () => {
  const h = harness({ breakCounter: true })
  attachApprovalBridge(h.node)
  let delegated = false
  const outcome = await h.pluginListeners[0]!(request('wechat-x'), async () => {
    delegated = true
    return 'unavailable'
  })
  assert.equal(delegated, true, 'a failing answerer must still delegate')
  assert.equal(outcome, 'unavailable')
  assert.match(h.sent.join('\n'), /审批桥内部错误/)
})
