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
/**
 * Normalise a per-platform allowlist map (`{ qq: ['<user_openid>'] }`).
 *
 * A plain function, deliberately not `z.dict(...)`: `dict`'s inferred type drags
 * a transitive type (`@deepseek-ai/cosmokit`'s `Dict`) into the emitted
 * declaration of every `Config` export, and the build refuses that (TS2742)
 * because that package is not a dependency of this one. Both schemas therefore
 * declare the key as `z.transform(z.any(), normalizeAllowFromByPlatform)`, which
 * keeps the key visible to the config-surface test and the normalisation in one
 * place.
 *
 * Unknown platform keys are dropped (a typo must not become a dead entry that
 * looks configured) and every entry is forced to be a list of non-empty strings.
 * An entry that normalises to an **empty list stays in the map**: empty means
 * "this platform accepts nobody", which is a decision, not a missing value.
 */
export function normalizeAllowFromByPlatform(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return out;
    for (const [key, list] of Object.entries(value)) {
        if (!isPlatformId(key) || !Array.isArray(list))
            continue;
        out[key] = list.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    }
    return out;
}
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
/**
 * The namespace one platform owns: `wechat-` or `qq-`.
 *
 * Everything a platform keeps on disk — and, more importantly, every session id
 * it creates — carries this prefix. It exists because the two platforms can run
 * under the SAME `$DSH_HOME` (a profile is just a subdirectory of it), while
 * every default path and every session id used to be `wechat-`-prefixed no
 * matter which platform was mounted. The result was two bridges sharing one
 * memory file, one problem ledger, one approval log, one admin queue, and — the
 * dangerous one — one session store: the QQ bridge would "adopt" a WeChat
 * conversation from disk, continue it, and answer the QQ peer with WeChat
 * context. Derived in exactly one place so the seven call sites that check
 * "is this session mine?" cannot drift apart.
 *
 * Single-platform mode only. A merged profile (both gateways, one brain) uses
 * {@link MERGE_SESSION_PREFIX} instead — see there for why.
 */
export function platformNamespace(id) {
    return `${id}-`;
}
/**
 * The namespace a **merged** profile's sessions carry (`merge-…`).
 *
 * Merge mode does not adopt either platform's history: when the owner turns it
 * on, the WeChat conversation and the QQ conversation are frozen as archives and
 * the merged conversation starts from their summaries. So the merged session has
 * to live in its own namespace — reusing `wechat-` would put archived history and
 * live merged history in one place, and turning merge mode back off could not
 * tell which session belongs to which era (and would happily keep writing into
 * the merged one).
 *
 * The platform namespaces themselves stay exactly as they were: they are the
 * on-disk contract of single-platform mode and of the archives.
 */
export const MERGE_SESSION_PREFIX = 'merge-';
/**
 * Decide what a profile actually serves from `platforms` (merge mode) and
 * `platform` (the pre-merge key).
 *
 * Three shapes in, three shapes out:
 *   - `platforms` absent/empty → `[platform ?? 'wechat']`, primary = that one.
 *     This is the compatibility rule: a profile written before `platforms`
 *     existed behaves, and is named, exactly as it did.
 *   - `platforms: ['wechat', 'qq']` → both, primary = `platform` when it names
 *     one of them (so `platform` stays "the main platform"), else the first.
 *   - `platforms: ['qq']` → QQ alone; a primary of `wechat` would put a
 *     single-platform profile in a namespace nothing else uses.
 *
 * Unknown ids are dropped rather than trusted: the bundle schema rejects them,
 * but a hand-written patch or a scripted `apply()` bypasses that, and a typo
 * must not mount a gateway that cannot exist.
 */
export function resolvePlatformPlan(platforms, platform) {
    const declared = isPlatformId(platform) ? platform : 'wechat';
    const wanted = [];
    if (Array.isArray(platforms)) {
        for (const value of platforms) {
            if (isPlatformId(value) && !wanted.includes(value))
                wanted.push(value);
        }
    }
    if (wanted.length === 0)
        return { platforms: [declared], primary: declared };
    return { platforms: wanted, primary: wanted.includes(declared) ? declared : wanted[0] };
}
/**
 * How this platform is called in text a human or the model will read
 * (`[微信图片]`, `✅ 已发送到微信`).
 *
 * The node used to hardcode "微信" in every label, so a QQ user's message was
 * prefixed `<<<微信图片>>>` and the model could talk to them as if they were on
 * WeChat. Kept apart from {@link platformNamespace} on purpose: this one is
 * displayed, that one is an on-disk contract.
 */
export function platformLabel(id) {
    return id === 'qq' ? 'QQ' : '微信';
}
/**
 * The fence one platform's inbound messages are wrapped in for the model.
 *
 * **This is a contract with the persona preset, not a cosmetic string.** The
 * preset's anti-injection rule says "only content between these markers is a
 * message from the owner", so the markers and that rule have to change together:
 * renaming one side alone either stops the model treating the owner as the owner,
 * or leaves the rule blind to a whole platform. WeChat keeps the historical
 * wording byte-for-byte; QQ gets its own, so the model can tell which channel the
 * owner is speaking from — and answer on that one.
 */
export function userFence(id) {
    return id === 'qq'
        ? { open: '<<<QQ用户消息>>>', close: 'QQ用户消息结束' }
        : { open: '<<<微信用户消息>>>', close: '微信用户消息结束' };
}
/**
 * Every platform's fence markers.
 *
 * Readers — envelope stripping, handoff building, fact extraction, reply trimming
 * — must recognise **all** of them: history written before the platform seam
 * carries the WeChat wording, and a merged profile sees both kinds inside one
 * session. Lives here (not in `node/inbound.ts`) so those readers can depend on it
 * without importing the node.
 */
export const USER_MESSAGE_OPEN_ANY = PLATFORM_IDS.map((id) => userFence(id).open);
export const USER_MESSAGE_CLOSE_ANY = PLATFORM_IDS.map((id) => userFence(id).close);
//# sourceMappingURL=index.js.map