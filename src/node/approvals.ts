/**
 * Permission-request bridge: DSH `approval/request` → WeChat text prompt.
 *
 * WeChat personal accounts have no buttons, so a permission request is
 * rendered as a numbered text prompt and resolved by `/yes` or `/no` (bare
 * `1`/`2` also work while exactly one request is pending). A reply timeout
 * falls back to DSH's default deny (`'rejected'`), matching the spec:
 * timeout → deny.
 *
 * Two rules learned the hard way:
 *
 * 1. **Answer for the bridge's own session namespace.** The host asks through a
 *    routed waterfall event; ownership is decided from the *session id prefix*
 *    (`wechat-`), which is this bridge's namespace by construction. Gating on
 *    `activeSessionId` equality instead meant a request arriving while that
 *    bookkeeping was stale was silently delegated away — the user saw nothing.
 * 2. **Never stay silent.** Every path out of this listener either asks in
 *    WeChat or delegates with `next()`; an internal error is reported in the
 *    chat *and* appended to `$DSH_HOME/wechat-approval.log`, because a silent
 *    answerer is indistinguishable from a dead bridge.
 *
 * @module @dsh-cowork/chatnode-wechat/node/approvals
 */

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { WechatConversationNode } from './core.ts'
import { resolveOutboundTarget, sendTextToPeer } from './outbound.ts'
import { sessionBadge } from './labels.ts'
import { platformNamespace, type PlatformId } from '../platform/index.ts'

/** Rename a log aside once it passes the cap, keeping one previous file. */
function rotateIfLarge(path: string, limit: number): void {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < limit) return
    renameSync(path, `${path}.1`)
  } catch {
    // A failed rotation must not stop the write that follows.
  }
}

/** One pending approval awaiting a WeChat reply. */
export interface PendingApproval {
  number: number
  request: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** `$DSH_HOME/wechat-approval.log` — one line per approval decision (WeChat name). */
export const APPROVAL_TRACE_FILE = 'wechat-approval.log'
/** Rotate the trace past this size, keeping one previous file. */
export const TRACE_LIMIT_BYTES = 256 * 1024

/**
 * Diagnostics path for one platform.
 *
 * The env override stays a single explicit path (tests point it at a scratch
 * file), but the default is namespaced: two profiles share a `$DSH_HOME`, and a
 * shared trace means an approval problem cannot even be attributed to a platform
 * while debugging.
 */
function approvalTracePath(platform: PlatformId): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), `${platformNamespace(platform)}approval.log`)
}

/** Append one diagnostics line; never affects the decision. */
function traceDecision(node: WechatConversationNode, line: string): void {
  try {
    const path = process.env.WECHAT_APPROVAL_TRACE ?? approvalTracePath(node.platform)
    // One line per decision, forever, is how a diagnostics file becomes a
    // multi-megabyte one; rotate at the same cap the problem ledger uses.
    rotateIfLarge(path, TRACE_LIMIT_BYTES)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Diagnostics are best-effort by definition.
  }
}

/** Readable one-line reason, cause chain included. */
function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error ? `${error.message} / ${cause.message}` : error.message
}

/** Attach the `approval/request` answerer. Returns a disposer. */
export function attachApprovalBridge(node: WechatConversationNode): () => void {
  const listener = async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    const session = (req as { agent?: { session?: { id?: unknown } } }).agent?.session
    const sessionId = session?.id === undefined ? '' : String(session.id)
    const active = node.activeSessionId === null ? '(null)' : String(node.activeSessionId)
    const owns = node.isWechatSessionId(sessionId)
    // Where this request would be asked: the turn's own target (see
    // core.currentTarget). A two-platform profile has two channels, and the
    // prompt has to appear on the one whose turn is waiting — the other peer
    // never saw the request at all. Resolved before the trace so the trace
    // names that channel.
    const target = resolveOutboundTarget(node)
    const peer = target?.peerId
    traceDecision(node, `request tool=${req.toolName ?? '?'} session=${sessionId || '(none)'} active=${active} owns=${owns} target=${target ? `${target.platform}:${peer}` : '(none)'}`)

    if (!owns) {
      traceDecision(node, '-> delegated: not a bridge session')
      return next()
    }
    if (!target || !peer) {
      traceDecision(node, '-> delegated: no peer to ask')
      return next()
    }

    try {
      const number = node.nextApprovalNumber()
      const timeoutSec = node.config.approvalTimeoutSec
      const badge = (() => {
        try {
          return sessionBadge(node, session as never)
        } catch (error) {
          traceDecision(node, `label failed: ${reason(error)}`)
          return `【${sessionId}】`
        }
      })()
      const prompt = [
        `🔐 ${badge} #${number} 需要你的确认`,
        `工具: ${req.toolName}`,
        ...(req.reason ? [`原因: ${req.reason}`] : []),
        `回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）`,
        `${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将自动拒绝。`,
      ].join('\n')

      // Ask FIRST and await the send: the user cannot answer what they cannot
      // see. The trace must not claim "asked" when the prompt never left — that
      // would make a timed-out "已拒绝" look like the owner ignored a question
      // he was never shown. `sendTextToPeer` resolves the same target, so the
      // prompt and the decision land on the channel that is waiting.
      const asked = await sendTextToPeer(node, prompt)
      traceDecision(node, asked ? `-> asked #${number} via ${target.platform}:${peer}` : `-> prompt send FAILED for #${number} (will time out)`)
      if (!asked) {
        node.problems.report('approvals/prompt', new Error('审批提示没能发出去，主人看不到这条请求'), {
          detail: `#${number} tool=${req.toolName}`,
        })
      }

      const outcome = await new Promise<ApprovalOutcome>((resolve) => {
        const timer = setTimeout(() => {
          node.clearApproval(number)
          resolve('rejected') // default deny on timeout
        }, timeoutSec * 1000)
        timer.unref?.()
        node.registerApproval(number, { number, request: req, resolve, timer })
      })

      const label = outcome === 'allowed-once' ? '✅ 已同意' : outcome === 'rejected' ? '❌ 已拒绝' : `⏳ ${outcome}`
      traceDecision(node, `-> outcome ${outcome} (#${number})`)
      void sendTextToPeer(node, `${label} ${badge}（#${number}）`)
      return outcome
    } catch (error) {
      const why = reason(error)
      traceDecision(node, `-> ERROR ${why}`)
      void sendTextToPeer(node, `❌ 审批桥内部错误：${why}`)
      return next()
    }
  }

  // Two registration flags decide whether the bridge is ever asked:
  //
  //  * `global: true` skips the routed-scope filter entirely. Without it the
  //    request is dispatched through `scopeTarget(req.agent, req.agent)` and a
  //    listener on this plugin's context may simply never match — which is
  //    indistinguishable from a dead bridge, and is what the empty trace showed.
  //  * `prepend: true` puts this answerer ahead of the desktop client's own
  //    answerer. Waterfall is first-answer-wins, and the GUI approving through
  //    its "等待审批" card would otherwise claim every request before WeChat is
  //    even consulted — the user would see a card in the app and silence in chat.
  //
  // Everything that is not this bridge's session namespace is delegated with
  // `next()`, so other answerers keep working exactly as before.
  const disposer = node.ctx.on('approval/request', listener, { prepend: true, global: true })
  return () => {
    disposer()
  }
}
