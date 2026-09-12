/**
 * File-based control channel for the standalone admin page (`admin/server.ts`).
 *
 * The admin page is its own process and cannot reach into the host's session
 * registry, so "new / switch / forget a WeChat session" travels through a small
 * command queue instead of an API: the page drops a JSON file into
 * `$DSH_HOME/wechat-admin/queue/`, this module executes it inside the host (where
 * `sessions`/`agents` actually live) and writes the outcome to `done/`.
 *
 * Why files rather than HTTP:
 *   - the bridge already owns `$DSH_HOME`, and the admin page already reads it;
 *   - no port, no token, no callback surface inside the host process;
 *   - a command written while the bridge is down is simply executed on the next
 *     poll (or stays queued), instead of being lost.
 *
 * Hard rule (learned the expensive way on 2026-09-12): NOTHING here may produce
 * an unhandled rejection — the host treats one as a fatal load failure and takes
 * the whole profile down. Every path is wrapped; every log goes through `ctx.get`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/admin-control
 */
import type { WechatConversationNode } from './core.ts';
/** One queued instruction from the admin page. */
export interface ControlCommand {
    /** What to do. */
    op: 'new-session' | 'switch-session' | 'forget-session';
    /** `new-session`: optional first prompt (empty = an empty new session). */
    prompt?: string;
    /** `switch-session` / `forget-session`: the target session id. */
    sessionId?: string;
    /** `new-session`: suppress the chat announcement (default: announce). */
    announce?: boolean;
}
/** Where the queue lives (shared with the admin page). */
export declare function adminControlDir(): string;
/**
 * Poll the queue and execute commands. Returns a disposer (clears the timer).
 *
 * `unref()` keeps the timer from holding the process open — the host has its own
 * lifetime, this poller must never be the reason it stays alive.
 */
export declare function attachAdminControl(node: WechatConversationNode, options?: {
    intervalMs?: number;
}): () => void;
//# sourceMappingURL=admin-control.d.ts.map