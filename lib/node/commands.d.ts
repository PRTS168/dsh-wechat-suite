/**
 * WeChat command vocabulary: /sessions /use /new /stop /status /yes /no /help.
 *
 * Session targeting follows the spec: `/sessions` lists numbered sessions
 * (most recent first), `/use N` switches, `/new <prompt>` creates a fresh
 * agent+session, `/stop` cancels the active turn, `/status` reports the
 * active session. `/yes`/`/no` and bare `1`/`2` resolve pending approvals
 * (see `approvals.ts`).
 *
 * @module @dsh-cowork/chatnode-wechat/node/commands
 */
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { WechatConversationNode } from './core.ts';
/**
 * Sessions ordered most-recent-first. Only `wechat-` prefixed sessions
 * qualify: this bundle bridges WeChat, and the hosting process may also run
 * the Web GUI against the SAME SessionStore — listing every session would let
 * `/sessions`, `/use`, and default targeting reach (or leak into) a web
 * session that no WeChat message should ever touch.
 */
export declare function listSessions(node: WechatConversationNode): Session[];
/** Try to route one command. Returns true when the text was a command. */
export declare function routeCommand(node: WechatConversationNode, text: string): Promise<boolean>;
/**
 * Handle a bare numbered reply against an active two-step picker (`/model`,
 * `/perm`) BEFORE it is routed to the model as ordinary text. Returns true
 * when the message was consumed by a picker.
 */
export declare function routePickerReply(node: WechatConversationNode, text: string): Promise<boolean>;
/** Default session id prefix for /new-created sessions. */
export declare function newSessionId(node: WechatConversationNode): SessionId;
//# sourceMappingURL=commands.d.ts.map