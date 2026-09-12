/**
 * Approval-bridge tests.
 *
 * The regression these pin: the answerer used to be registered on the plugin's
 * own context, while the host dispatches `approval/request` through a *routed*
 * scope target —
 *
 *   ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, …)
 *
 * — whose filter only admits the agent itself, one of its ancestors, or an
 * untagged scope. The plugin context is none of those, so the request never
 * arrived: the WeChat user saw nothing and the tool call stayed in the approval
 * window until it timed out (a real `approval/asked` event with no matching
 * prompt is what exposed it).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { attachApprovalBridge } from '../src/node/approvals.ts'

type Listener = (req: unknown, next: () => Promise<string>) => Promise<string>

interface Harness {
  node: never
  sent: string[]
  registrations: Array<{ number: number; resolve: (outcome: string) => void }>
  rootListeners: Listener[]
  pluginListeners: Listener[]
}

function harness(options: { owns?: boolean; timeoutSec?: number } = {}): Harness {
  const sent: string[] = []
  const registrations: Array<{ number: number; resolve: (outcome: string) => void }> = []
  const rootListeners: Listener[] = []
  const pluginListeners: Listener[] = []
  const node = {
    peerId: 'peer@im.wechat',
    config: { approvalTimeoutSec: options.timeoutSec ?? 600 },
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
      on: (_event: string, listener: Listener) => {
        pluginListeners.push(listener)
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
    ownsAgent: () => options.owns ?? true,
    nextApprovalNumber: () => registrations.length + 1,
    registerApproval: (number: number, entry: { resolve: (outcome: string) => void }) => {
      registrations.push({ number, resolve: entry.resolve })
    },
    clearApproval: () => {},
  }
  return { node: node as never, sent, registrations, rootListeners, pluginListeners }
}

/** Minimal session shape the label helpers need. */
const session = (id: string) => ({ id, snapshotEvents: () => [] })
/** Let the void-sent status line land before asserting on it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const request = (id: string, reason?: string) => ({ toolName: 'pwsh', reason, agent: { session: session(id) } })

test('the answerer registers on the root scope, not the plugin scope', () => {
  const h = harness()
  attachApprovalBridge(h.node)
  assert.equal(h.rootListeners.length, 1, 'routed events only reach the untagged root scope')
  assert.equal(h.pluginListeners.length, 0, 'the plugin scope never sees routed approval requests')
})

test('another agent request is delegated, never answered', async () => {
  const h = harness({ owns: false })
  attachApprovalBridge(h.node)
  let delegated = false
  const outcome = await h.rootListeners[0]!(request('wechat-other'), async () => {
    delegated = true
    return 'unavailable'
  })
  assert.equal(delegated, true)
  assert.equal(outcome, 'unavailable')
  assert.deepEqual(h.sent, [], 'no prompt for a request this bridge does not own')
})

test('our own request prompts in WeChat and honours the reply', async () => {
  const h = harness()
  attachApprovalBridge(h.node)
  const pending = h.rootListeners[0]!(request('wechat-x', 'escalate sandbox'), async () => 'unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
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
  const pending = h.rootListeners[0]!(request('wechat-x'), async () => 'unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
  h.registrations[0]!.resolve('rejected')
  assert.equal(await pending, 'rejected')
  await tick()
  assert.match(h.sent.join('\n'), /已拒绝/)
})

test('no reply falls back to the DSH default deny on timeout', async () => {
  const h = harness({ timeoutSec: 0.02 })
  attachApprovalBridge(h.node)
  const outcome = await h.rootListeners[0]!(request('wechat-x'), async () => 'unavailable')
  assert.equal(outcome, 'rejected')
  await tick()
  assert.match(h.sent.join('\n'), /已拒绝/)
})

test('a request without a peer is delegated instead of being swallowed', async () => {
  const h = harness()
  ;(h.node as unknown as { peerId: string | undefined }).peerId = undefined
  attachApprovalBridge(h.node)
  let delegated = false
  const outcome = await h.rootListeners[0]!(request('wechat-x'), async () => {
    delegated = true
    return 'unavailable'
  })
  assert.equal(delegated, true)
  assert.equal(outcome, 'unavailable')
})
