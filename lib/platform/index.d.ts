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
import type { Context } from '@deepseek-ai/cordis';
import type { GatewayStatus, SendResult } from '../gateway/index.ts';
import type { InboundMessage } from '../gateway/types.ts';
import type { RasterImageMediaType } from '../gateway/media.ts';
/**
 * The QQ platform's four events, declared here rather than inside the QQ gateway.
 *
 * `src/gateway/index.ts` augments `Events` with the WeChat names it emits; the
 * platform layer owns the contract both platforms satisfy, so the pair sits side
 * by side and `platformEvents()` can hand cordis a literal union instead of
 * forcing a cast at every subscription.
 */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'qq/message'(message: InboundMessage): void;
        'qq/status'(status: GatewayStatus): void;
        'qq/error'(error: Error): void;
        'qq/fatal'(error: Error): void;
    }
}
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
export declare function normalizeAllowFromByPlatform(value: unknown): Record<string, string[]>;
/** Chat platforms this bridge can speak. */
export declare const PLATFORM_IDS: readonly ["wechat", "qq"];
export type PlatformId = (typeof PLATFORM_IDS)[number];
/** True for a value that names a platform we can actually mount. */
export declare function isPlatformId(value: unknown): value is PlatformId;
/**
 * The service a platform's gateway registers, plus the events it emits.
 *
 * Both come from the same id on purpose: a gateway is mounted under `ctx.qq` and
 * emits `qq/message`, so a node configured for `qq` needs no per-platform
 * wiring — it reads one id and everything else follows.
 */
export interface PlatformEvents {
    message: 'wechat/message' | 'qq/message';
    error: 'wechat/error' | 'qq/error';
    fatal: 'wechat/fatal' | 'qq/fatal';
    status: 'wechat/status' | 'qq/status';
}
/**
 * Literal unions rather than a template string on purpose: cordis types `on()`
 * against its `Events` interface, and a plain `string` would force every call
 * site to cast. Both platforms declare the same payload shapes, so the union
 * stays assignable.
 */
export declare function platformEvents(id: PlatformId): PlatformEvents;
/**
 * What one platform can actually do, as declared by its own gateway.
 *
 * Deliberately declared by the *platform*, not guessed by the node: only the
 * gateway knows whether its API can deliver an image today.
 */
export interface PlatformCapabilities {
    /** Sending local images and files. */
    readonly media: boolean;
    /** Voice bubbles (the `speak` tool's output). */
    readonly voice: boolean;
    /**
     * How many messages may answer ONE inbound message before the platform starts
     * rejecting them. WeChat has no such limit; QQ's single-chat passive window
     * allows 4 (`40034128` beyond that), and the fifth bubble silently degrades to
     * an active message — which has quotas and can be switched off by the user.
     * `undefined` = unlimited.
     */
    readonly replyBudgetPerInbound?: number;
}
/**
 * What a gateway service must provide for the node to run on it.
 *
 * Signatures mirror the WeChat gateway exactly, because that is what every call
 * site in `node/` already does. `item` stays `unknown` on purpose: inbound media
 * arrives in the platform's own wire shape and the platform's own downloader is
 * the only thing that can read it.
 */
export interface ChatPlatform {
    /** The account this bridge speaks as; used to drop our own echoes. */
    readonly accountId?: string;
    /**
     * What this platform can actually do.
     *
     * The node used to assume every platform could send images, files and voice —
     * true of WeChat, false of the QQ official API until its three-step upload is
     * implemented. Without this, `generate_image` and `speak` happily spent money
     * calling the image/voice APIs and only then discovered the platform cannot
     * deliver the result. Absent means "assume the WeChat-like default", so test
     * doubles written before this existed keep working.
     */
    readonly capabilities?: PlatformCapabilities;
    sendText(to: string, text: string, clientId?: string): Promise<SendResult>;
    sendImage(to: string, filePath: string): Promise<SendResult>;
    sendFile(to: string, filePath: string, fileName?: string): Promise<SendResult>;
    /** Cosmetic; platforms without a typing indicator no-op here. */
    sendTyping(to: string, status: 1 | 2): Promise<void>;
    downloadImage(item: unknown): Promise<{
        bytes: Uint8Array;
        mediaType: RasterImageMediaType;
    } | null>;
    downloadVoice(item: unknown): Promise<Uint8Array | null>;
    downloadAttachment(item: unknown): Promise<{
        bytes: Uint8Array;
        fileName?: string;
    } | null>;
}
/**
 * The active platform's service, or undefined while its gateway is not mounted.
 *
 * Callers treat `undefined` as "the platform is not available right now" (the
 * plugin may simply not be mounted in this profile) — never as "send anyway".
 */
export declare function chatService(ctx: Context, id: PlatformId): ChatPlatform | undefined;
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
export declare function platformNamespace(id: PlatformId): string;
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
export declare const MERGE_SESSION_PREFIX = "merge-";
/** One profile's platform plan: what to mount, and which of them is primary. */
export interface PlatformPlan {
    /**
     * Platforms whose gateways this profile mounts, in config order, deduplicated.
     * Never empty: an unwritten `platforms` means "just the primary one".
     */
    readonly platforms: PlatformId[];
    /**
     * The primary platform: it owns the session namespace, the default on-disk
     * locations and the outbound fallback when no turn is open.
     */
    readonly primary: PlatformId;
}
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
export declare function resolvePlatformPlan(platforms: unknown, platform: unknown): PlatformPlan;
/**
 * How this platform is called in text a human or the model will read
 * (`[微信图片]`, `✅ 已发送到微信`).
 *
 * The node used to hardcode "微信" in every label, so a QQ user's message was
 * prefixed `<<<微信图片>>>` and the model could talk to them as if they were on
 * WeChat. Kept apart from {@link platformNamespace} on purpose: this one is
 * displayed, that one is an on-disk contract.
 */
export declare function platformLabel(id: PlatformId): string;
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
export declare function userFence(id: PlatformId): {
    open: string;
    close: string;
};
/**
 * Every platform's fence markers.
 *
 * Readers — envelope stripping, handoff building, fact extraction, reply trimming
 * — must recognise **all** of them: history written before the platform seam
 * carries the WeChat wording, and a merged profile sees both kinds inside one
 * session. Lives here (not in `node/inbound.ts`) so those readers can depend on it
 * without importing the node.
 */
export declare const USER_MESSAGE_OPEN_ANY: readonly string[];
export declare const USER_MESSAGE_CLOSE_ANY: readonly string[];
//# sourceMappingURL=index.d.ts.map