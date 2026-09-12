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
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendTextToPeer } from "./outbound.js";
import { sessionBadge } from "./labels.js";
/** `$DSH_HOME/wechat-approval.log` — one line per approval decision. */
export const APPROVAL_TRACE_FILE = 'wechat-approval.log';
/** Append one diagnostics line; never affects the decision. */
function trace(line) {
    try {
        const path = process.env.WECHAT_APPROVAL_TRACE
            ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), APPROVAL_TRACE_FILE);
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
    }
    catch {
        // Diagnostics are best-effort by definition.
    }
}
/** Readable one-line reason, cause chain included. */
function reason(error) {
    if (!(error instanceof Error))
        return String(error);
    const cause = error.cause;
    return cause instanceof Error ? `${error.message} / ${cause.message}` : error.message;
}
/** Attach the `approval/request` answerer. Returns a disposer. */
export function attachApprovalBridge(node) {
    const listener = async (req, next) => {
        const session = req.agent?.session;
        const sessionId = session?.id === undefined ? '' : String(session.id);
        const active = node.activeSessionId === null ? '(null)' : String(node.activeSessionId);
        const owns = node.isWechatSessionId(sessionId);
        trace(`request tool=${req.toolName ?? '?'} session=${sessionId || '(none)'} active=${active} owns=${owns} peer=${node.peerId ?? '(none)'}`);
        if (!owns) {
            trace('-> delegated: not a bridge session');
            return next();
        }
        // The peer is normally known from the inbound message that started the turn;
        // the allowlist is the bridge's own definition of who may be asked.
        const peer = node.peerId ?? node.config.allowFrom?.[0];
        if (!peer) {
            trace('-> delegated: no peer to ask');
            return next();
        }
        try {
            const number = node.nextApprovalNumber();
            const timeoutSec = node.config.approvalTimeoutSec;
            const badge = (() => {
                try {
                    return sessionBadge(node, session);
                }
                catch (error) {
                    trace(`label failed: ${reason(error)}`);
                    return `【${sessionId}】`;
                }
            })();
            const prompt = [
                `🔐 ${badge} #${number} 需要你的确认`,
                `工具: ${req.toolName}`,
                ...(req.reason ? [`原因: ${req.reason}`] : []),
                `回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）`,
                `${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将自动拒绝。`,
            ].join('\n');
            // Ask FIRST and await the send: the user cannot answer what they cannot
            // see, and a failed send must show up in the trace rather than vanish.
            node.peerId = peer;
            await sendTextToPeer(node, prompt);
            trace(`-> asked #${number} via ${peer}`);
            const outcome = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    node.clearApproval(number);
                    resolve('rejected'); // default deny on timeout
                }, timeoutSec * 1000);
                timer.unref?.();
                node.registerApproval(number, { number, request: req, resolve, timer });
            });
            const label = outcome === 'allowed-once' ? '✅ 已同意' : outcome === 'rejected' ? '❌ 已拒绝' : `⏳ ${outcome}`;
            trace(`-> outcome ${outcome} (#${number})`);
            void sendTextToPeer(node, `${label} ${badge}（#${number}）`);
            return outcome;
        }
        catch (error) {
            const why = reason(error);
            trace(`-> ERROR ${why}`);
            void sendTextToPeer(node, `❌ 审批桥内部错误：${why}`);
            return next();
        }
    };
    // The host dispatches this event through a routed scope target —
    //   ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, …)
    // A listener registered on an **untagged** scope (the application root) always
    // matches, which is the safest home for a standing composition like this
    // bridge. Ownership is decided inside the listener (session namespace), and
    // every request that is not ours is delegated with `next()`.
    const scope = node.ctx.root ?? node.ctx;
    const disposer = scope.on('approval/request', listener);
    return () => {
        disposer();
    };
}
//# sourceMappingURL=approvals.js.map