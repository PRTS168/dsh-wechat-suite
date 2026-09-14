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
import { type PlatformId } from '../platform/index.ts';
/** One queued instruction from the admin page. */
export interface ControlCommand {
    /** What to do. */
    op: 'new-session' | 'switch-session' | 'forget-session';
    /**
     * Which platform the page was showing when this was queued.
     *
     * Both profiles run their own node, and both poll their own queue directory —
     * but a command queued from the WeChat page must never be executed by the QQ
     * bridge (it would create/switch a session in the wrong platform). Absent means
     * "the only platform this profile serves", which is how older console builds
     * behaved.
     */
    platform?: PlatformId;
    /** `new-session`: optional first prompt (empty = an empty new session). */
    prompt?: string;
    /** `switch-session` / `forget-session`: the target session id. */
    sessionId?: string;
    /** `new-session`: suppress the chat announcement (default: announce). */
    announce?: boolean;
}
/**
 * Where this platform's queue lives (shared with the admin page).
 *
 * Namespaced per platform: one shared `wechat-admin/queue` with two profiles
 * polling it meant "whoever ticks first executes it", so a command issued on the
 * QQ page could be run by the WeChat bridge and its receipt read by both.
 */
export declare function adminControlDir(platform?: PlatformId): string;
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