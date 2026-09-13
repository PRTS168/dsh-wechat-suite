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
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { WechatConversationNode } from './core.ts';
/** One pending approval awaiting a WeChat reply. */
export interface PendingApproval {
    number: number;
    request: ApprovalRequest;
    resolve: (outcome: ApprovalOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}
/** `$DSH_HOME/wechat-approval.log` — one line per approval decision. */
export declare const APPROVAL_TRACE_FILE = "wechat-approval.log";
/** Rotate the trace past this size, keeping one previous file. */
export declare const TRACE_LIMIT_BYTES: number;
/** Attach the `approval/request` answerer. Returns a disposer. */
export declare function attachApprovalBridge(node: WechatConversationNode): () => void;
//# sourceMappingURL=approvals.d.ts.map