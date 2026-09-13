/**
 * The seam between a chat platform and the conversation node.
 *
 * The node owns everything that is *not* platform-specific — the allowlist gate,
 * session targeting, commands, context policy, long-term memory, approvals,
 * reminders, digest outbound and the problem ledger. All of that reaches a chat
 * platform through the handful of methods below and subscribes to four events.
 * WeChat (iLink) is the first implementation; QQ is the second.
 *
 * The seam is deliberately this narrow: adding a platform must not mean touching
 * the node. A gateway registers itself under its platform id (`ctx.wechat`,
 * `ctx.qq`) and emits `<id>/message`, `<id>/error`, `<id>/fatal`, `<id>/status`;
 * everything else is shared.
 *
 * @module @dsh-cowork/chatnode-wechat/platform
 */
/** Chat platforms this bridge can speak. */
export const PLATFORM_IDS = ['wechat', 'qq'];
/** True for a value that names a platform we can actually mount. */
export function isPlatformId(value) {
    return typeof value === 'string' && PLATFORM_IDS.includes(value);
}
/**
 * Literal unions rather than a template string on purpose: cordis types `on()`
 * against its `Events` interface, and a plain `string` would force every call
 * site to cast. Both platforms declare the same payload shapes, so the union
 * stays assignable.
 */
export function platformEvents(id) {
    return id === 'qq'
        ? { message: 'qq/message', error: 'qq/error', fatal: 'qq/fatal', status: 'qq/status' }
        : { message: 'wechat/message', error: 'wechat/error', fatal: 'wechat/fatal', status: 'wechat/status' };
}
/**
 * The active platform's service, or undefined while its gateway is not mounted.
 *
 * Callers treat `undefined` as "the platform is not available right now" (the
 * plugin may simply not be mounted in this profile) — never as "send anyway".
 */
export function chatService(ctx, id) {
    return ctx.get(id);
}
//# sourceMappingURL=index.js.map