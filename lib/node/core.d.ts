/**
 * WechatConversationNode — the orchestration state behind the
 * `wechat-conversation-node` plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 *
 * @module @dsh-cowork/chatnode-wechat/node/core
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { type ChatPlatform, type PlatformCapabilities, type PlatformEvents, type PlatformId } from '../platform/index.ts';
import type { PendingApproval } from './approvals.ts';
import { type ContextPolicy } from './context-policy.ts';
import type { MorningService } from './morning.ts';
import { ProblemReporter } from './problems.ts';
import type { MemoryService } from './memory.ts';
/**
 * One entry from `sessionPersistence.list()`.
 *
 * DSH 0.1.5 returns `SessionPersistenceSnapshot`, which carries the identity
 * under `.header`; older versions exposed `id`/`createdAt` at the top level.
 * Both are accepted so the bridge runs on either.
 */
export interface PersistenceEntry {
    id?: string;
    createdAt?: number;
    header?: {
        id?: string;
        createdAt?: number;
    };
}
/**
 * The host permission-preset service, as actually shaped by the host.
 *
 * It is **session-scoped**: `current(session)` and `set(session, name)` take a
 * session, and menu labels come from `optionOf()`. Getting this wrong is
 * invisible — the throw escapes `routeCommand`, the inbound handler swallows it
 * and the user simply gets no answer at all. That is exactly what `/perm` did
 * while this code passed an event array to `current()`.
 */
export interface HostPermissionPresets {
    names?: readonly string[];
    current(session: unknown): string;
    resolve(name: string): {
        name?: string;
        description?: string;
    };
    optionOf?(name: string): {
        name?: string;
        description?: string;
    };
    set?(session: unknown, name: string): void;
}
/**
 * Pick the newest persisted session **of this platform**, or undefined if none.
 *
 * The prefix is a parameter, not a constant: the session store is shared with
 * the Web GUI *and* with the other platform's profile, so "newest session on
 * disk" is meaningless without saying whose.
 */
export declare function selectNewestSession(entries: readonly PersistenceEntry[], prefix: string): {
    id: string;
    createdAt: number;
} | undefined;
/** Kept for callers written before the platform seam; means "newest WeChat one". */
export declare function selectNewestWechat(entries: readonly PersistenceEntry[]): {
    id: string;
    createdAt: number;
} | undefined;
/**
 * Where one outbound message goes: which platform, which peer, and the gateway
 * service that can actually send it.
 *
 * The three travel together on purpose. In a merged profile `peerId` alone is
 * ambiguous — a WeChat `wxid_…` and a QQ `user_openid` are both just strings —
 * and sending a QQ peer's answer through the WeChat gateway (or the reverse) is
 * exactly the failure this type exists to make impossible.
 */
export interface OutboundTarget {
    /** The platform the message belongs to. */
    platform: PlatformId;
    /** The peer on that platform. */
    peerId: string;
    /**
     * That platform's gateway, or undefined when its service is not mounted.
     *
     * Undefined means "cannot send", never "send on the other platform": a reply
     * that arrives on the wrong side is worse than a reply that did not arrive,
     * because the owner cannot even tell it happened.
     */
    chat?: ChatPlatform;
}
/** Runtime shape of the node plugin's config (defaults applied). */
export interface NodeConfig {
    /** Hard allowlist of WeChat sender ids allowed to drive the agent. REQUIRED. */
    allowFrom: string[];
    /** Chat platform this node serves; see platform/index.ts. */
    platform?: PlatformId;
    /**
     * The platform this node serves, as a list. Only ever one entry; unwritten
     * means "just `platform`" — the behaviour every profile written before this key
     * had.
     */
    platforms?: PlatformId[];
    /**
     * Per-platform allowlists, e.g. `{ qq: ['<user_openid>'] }`.
     *
     * Lookup rule: a platform with its own entry uses it, every other platform
     * uses `allowFrom`. An entry that is an **empty list** means "this platform
     * accepts nobody" — the strict reading, because the alternative is falling
     * back to a WeChat id list and letting a QQ stranger through.
     */
    allowFromByPlatform?: Record<string, string[]>;
    /** Heartbeat interval for progress digests (seconds; 0 disables). */
    digestIntervalSec: number;
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars: number;
    /** Throttle between outbound bubbles (ms). */
    sendChunkDelayMs: number;
    /** Working directory for `/new` sessions. */
    cwd?: string;
    /** Directory inbound images are saved to (defaults under $DSH_HOME). */
    mediaDir?: string;
    /**
     * How an inbound image reaches the model:
     * - `auto` (default) — send a real image block when the routed model declares
     *   `image` input, otherwise fall back to the OCR text path;
     * - `native` — force the image block; fall back to OCR only after the
     *   provider itself refuses one;
     * - `ocr` — always use the OCR text path (cheaper for documents/screenshots).
     */
    imageInput?: 'auto' | 'native' | 'ocr';
    /**
     * Explicit `provider/model` used for native image input. When set, this route
     * is probed for image support instead of the chat route — useful when the
     * chat model is text-only but a vision route is available for pictures.
     */
    imageInputModel?: string;
    /** SiliconFlow API key for DeepSeek-OCR (sk-…). Empty/absent disables OCR. */
    ocrApiKey?: string;
    /** DeepSeek-OCR model id (defaults to deepseek-ai/DeepSeek-OCR). */
    ocrModel?: string;
    /** OpenAI-compatible base URL for OCR (defaults to SiliconFlow). */
    ocrBaseUrl?: string;
    /** JSON file reminders persist to (defaults to $DSH_HOME/wechat-reminders.json). */
    reminderFile?: string;
    /** JSON file the morning-greeting config persists to (defaults under $DSH_HOME). */
    morningFile?: string;
    /** Markdown file holding long-term facts about the owner (defaults under $DSH_HOME). */
    memoryFile?: string;
    /** Append-only problem log (defaults under $DSH_HOME). */
    problemFile?: string;
    /** Inject the memory briefing on the first message and every N messages. */
    memoryInjectEvery?: number;
    /** Wall-clock "HH:MM" for the daily memory consolidation (empty disables). */
    memoryConsolidateTime?: string;
    /** ESP32 PWM light base url (defaults to http://<esp32-ip>:80). */
    esp32BaseUrl?: string;
    /** SiliconFlow API key for image generation (defaults to ocrApiKey when absent). */
    imageGenApiKey?: string;
    /** Image generation model id (defaults to Kwai-Kolors/Kolors). */
    imageGenModel?: string;
    /** Where generated images are saved (defaults to <mediaDir>/generated). */
    imageGenDir?: string;
    /** SiliconFlow API key for speech-to-text (defaults to ocrApiKey when absent). */
    sttApiKey?: string;
    /** ASR model id (defaults to XingChenAGI/XingChenASR-V3.2-Ultra). */
    sttModel?: string;
    /** SiliconFlow API key for TTS (defaults to ocrApiKey when absent). */
    ttsApiKey?: string;
    /** TTS model id (defaults to FunAudioLLM/CosyVoice2-0.5B). */
    ttsModel?: string;
    /** Cloned voice uri used for speech replies (e.g. speech:my-clone:…). */
    ttsVoice?: string;
    /** Agent preset name for `/new` sessions. */
    agentPreset?: string;
    /** Provider route for `/new` agents. */
    agentProvider?: string;
    /** Model id for `/new` agents. */
    agentModel?: string;
    /**
     * Context-management scheme (JSON). Parsed by `context-policy.ts`; `manual`
     * or absent keeps the legacy behaviour (rotate only when a human types /new).
     */
    contextPolicy?: string;
}
export declare class WechatConversationNode {
    /** The active session the WeChat user drives. */
    activeSessionId: SessionId | null;
    /**
     * The allowlisted peer outbound currently goes to — the target of the turn in
     * flight, or the last peer that spoke (see {@link currentTarget}).
     *
     * Kept as a property because it predates the platform seam and a dozen call
     * sites read it; assigning to it is the "one known peer" shortcut and means
     * "on the primary platform". The real routing state is the target FIFO below.
     */
    get peerId(): string | null;
    set peerId(value: string | null);
    /**
     * Runtime override for {@link NodeConfig.imageInput}, set by the `/识图`
     * command. Survives until the bridge process restarts; config remains the
     * source of truth for the next boot.
     */
    runtimeImageInput: 'auto' | 'native' | 'ocr' | null;
    /**
     * The long-term memory briefing for one inbound message, or '' when this
     * message should not carry one. Injection cadence lives in the service.
     */
    memoryPreamble(): string;
    /** Effective image-delivery policy (runtime override, else config). */
    imageInputMode(): 'auto' | 'native' | 'ocr';
    private readonly pending;
    private approvalCounter;
    private disposers;
    /** Two-step picker state (`/model`, `/perm`): waiting for a numbered reply. */
    private picker;
    /** Per-agent mutable model selection (lazily installed, mirroring the host). */
    private readonly agentSelections;
    /** Morning-greeting scheduler, when the plugin mounted one. */
    morningService?: MorningService;
    /** Long-term memory (facts about the owner), when the plugin mounted one. */
    memoryService?: MemoryService;
    /**
     * The problem ledger. Always present — a swallowed failure must have somewhere
     * to go even before any service is wired, and `/problems` reads it.
     */
    readonly problems: ProblemReporter;
    /**
     * Last gateway status seen (`wechat/status`), and when. `/status` reports it:
     * a bridge whose poller died otherwise looks identical to a quiet day.
     *
     * These two mirror the **primary** platform so every existing caller (and
     * `tests`) keeps working; {@link gatewayStatusFor} reads any platform.
     */
    gatewayStatus: string;
    gatewayStatusAt: string;
    /** Per-platform mirror of the two fields above (each platform reports its own). */
    private readonly platformStatuses;
    readonly ctx: Context;
    readonly config: NodeConfig;
    /**
     * The chat platform this node serves, resolved once from config.
     *
     * Everything platform-specific goes through {@link chat}: the gateway is
     * mounted under this id and emits `<platform>/…` events, so the node never
     * names a platform itself. Defaults to WeChat, which is what every existing
     * profile configured by saying nothing.
     *
     * In merge mode this is the **primary** platform: it names the session
     * namespace, the default on-disk locations and the outbound fallback. The
     * other mounted platform(s) live in {@link platforms}.
     */
    readonly platform: PlatformId;
    /**
     * Every platform this node is subscribed to, primary first — one element
     * unless the profile asked for merge mode.
     *
     * The node subscribes to each of them (message/status/error/fatal) and each
     * inbound message carries its own platform into the turn target, so one brain
     * answers whichever channel the owner used, on that channel only.
     */
    readonly platforms: readonly PlatformId[];
    /**
     * Outbound targets of the turns in flight, oldest first.
     *
     * A turn's replies are asynchronous — heartbeats, tool calls, the final
     * answer — while the owner can start another turn from the other platform
     * meanwhile. Binding the target at inbound time and releasing it at `turn/end`
     * is what keeps "QQ said something while WeChat's turn was running" from
     * delivering the WeChat answer to QQ. Entries are pushed only when a message
     * really becomes a turn: a command or a menu reply produces no `turn/end`, so
     * a queued target would never drain and would misroute the next real answer.
     */
    private readonly turnTargets;
    /** The last peer that spoke (any platform); the fallback when no turn is open. */
    private lastTarget;
    /**
     * The gateway of one platform, or undefined while it is not mounted.
     *
     * Two of these are live at once in merge mode, and every outbound path has to
     * go through the *target's* one — see {@link currentTarget}.
     */
    chatFor(platform: PlatformId): ChatPlatform | undefined;
    /**
     * What one platform can actually do (images, files, voice, reply budget), as
     * declared by its own gateway — not by the primary's.
     *
     * A merged profile can hold a WeChat gateway that sends images and a QQ
     * gateway that cannot; asking the primary would promise the QQ user a picture
     * that the QQ API will refuse after the image was generated and paid for.
     */
    capabilitiesFor(platform: PlatformId): PlatformCapabilities | undefined;
    /** The active platform's service, or undefined while its gateway is unmounted. */
    get chat(): ChatPlatform | undefined;
    /**
     * Where this turn's outbound messages go: queue head → last peer that spoke →
     * the primary platform's first allowlisted id.
     *
     * The last step is what lets a proactive push (a reminder, an admin
     * announcement, a rotation notice) leave the bridge at all when nothing has
     * been said yet — the owner's own allowlisted id is the only defensible
     * recipient. Returns undefined only when there is nobody to address.
     */
    currentTarget(): OutboundTarget | undefined;
    /** Queue depth of the turn targets (diagnostics and tests). */
    pendingTurnTargets(): number;
    /**
     * Record where a message came from: it becomes "the peer that spoke last".
     *
     * Called only for messages that passed the allowlist — a stranger's message
     * must not be able to steer where the bridge answers.
     */
    noteInboundTarget(platform: PlatformId, peerId: string): void;
    /** Bind the outbound target of a turn that is about to start (FIFO tail). */
    beginTurnTarget(platform: PlatformId, peerId: string): void;
    /** The turn ended: its target leaves the queue (`turn/end`). */
    endTurnTarget(): void;
    /**
     * The turn never started (submitting it threw), so take back the target that
     * was just bound. Leaving it queued would misroute the next answer, because
     * nothing will ever dequeue it.
     */
    dropTurnTarget(): void;
    /**
     * Submit a turn for the peer that spoke last, binding it as this turn's
     * outbound target.
     *
     * `/new <prompt>` is the one place a chat message starts a turn from inside the
     * node instead of from `inbound.ts`, so it has to bind the target the same way
     * — otherwise the answer to "QQ 用户开了个新会话" would go to WeChat.
     */
    submitForLastTarget(submit: () => void): void;
    /**
     * Which platform a bare peer id belongs to — for the pushes that carry only a
     * peer (a persisted reminder), never a platform.
     *
     * Explicit per-platform allowlists are the honest source: put each platform's
     * ids in `allowFromByPlatform` and every reminder finds its way back to the
     * channel it was asked for. Anything unrecognised falls to the primary
     * platform, which is exactly what a single-platform profile always did.
     */
    platformForPeer(peerId: string): PlatformId;
    /** Nobody has spoken yet: address the primary platform's first allowlisted id. */
    private fallbackTarget;
    /** Events of the active platform (`<platform>/message`, `…/error`, …). */
    get events(): PlatformEvents;
    /**
     * Context-management policy for this conversation (see context-policy.ts).
     * `manual` reproduces the legacy behaviour: the session grows until a human
     * types `/new`.
     */
    readonly contextPolicy: ContextPolicy;
    /** Re-entrancy guard: one rotation at a time. */
    private rotating;
    /**
     * A rotation's handoff note, waiting for the owner's next message.
     *
     * Deliberately NOT submitted as a turn of its own: doing that produced an extra
     * unsolicited reply on every rotation (a fresh-session greeting), because a user
     * message — fenced or not — starts a turn. The note rides along with the next
     * real inbound message instead, so a rotation costs zero extra replies.
     */
    private pendingHandoff;
    /**
     * 交接摘要"真的被一条消息带走"之后要做的事（合并模式用它删掉磁盘上的
     * `pending/<platform>.md`）。
     *
     * 删除**推迟到这一步**是有意的：摘要文件是那段历史的唯一副本，排进队列就删，
     * 进程在两条消息之间退出就等于把它丢了。宁可下次启动再排一次。
     */
    private onHandoffTaken;
    constructor(ctx: Context, config: NodeConfig);
    /** Whether a rotation is currently in flight (used by tests and the guard). */
    isRotating(): boolean;
    /** Claim the rotation slot; returns false when one is already running. */
    beginRotation(): boolean;
    /** Release the rotation slot. */
    endRotation(): void;
    /** Take the queued rotation note for the next inbound message (once). */
    consumeHandoff(): string;
    /**
     * Queue a rotation note for the next inbound message.
     *
     * `onTaken` 是可选的一次性回调（合并模式用它删除已消费的交接文件）；不给它
     * 就等价于从前那版——轮换交接没有任何副作用。
     */
    setPendingHandoff(note: string | null, onTaken?: () => void): void;
    /** Whether a rotation note is waiting (tests and diagnostics). */
    hasPendingHandoff(): boolean;
    /** The active WeChat session, if any. Never a non-`wechat-` session: this
     *  process shares its SessionStore with the Web GUI, and an inbound WeChat
     *  message must never be routed into a web conversation. */
    activeSession(): Session | undefined;
    /** The agent driving the active WeChat session, if any. */
    activeAgent(): Agent | undefined;
    /**
     * Whether the bridge drives the given agent.
     *
     * Compared as **strings**: a session id may be a branded `SessionId` object on
     * some hosts (the package exports both an identity function and a constructor),
     * and `===` against a plain string then answers "not ours" for the bridge's own
     * agent — which is how a permission request once ended up delegated and
     * invisible. A null active id means "any `wechat-` session", i.e. the bridge's
     * own namespace.
     */
    ownsAgent(agent: Agent): boolean;
    /**
     * The prefix every session of this bridge carries.
     *
     * Answers `wechat-` / `qq-` — the on-disk contract those profiles already
     * have, and the namespace their sessions live in.
     *
     * Single source of truth: seven places ask "is this session mine?", and each of
     * them used to hardcode `'wechat-'`. Fixing one and missing the others would
     * take the bridge down silently — empty `/sessions`, `/use` doing nothing,
     * outbound refusing to send, approvals all delegated, admin page blank.
     */
    sessionPrefix(): string;
    /** Whether a session id belongs to this bridge (i.e. to this platform). */
    isOwnSessionId(id: unknown): boolean;
    /** Kept for call sites written before the platform seam; platform-correct now. */
    isWechatSessionId(id: unknown): boolean;
    /** Whether a sender is allowlisted on this node's own (primary) platform. */
    isAllowed(senderId: string): boolean;
    /**
     * Whether a sender may drive the agent **on one platform**.
     *
     * A platform with its own `allowFromByPlatform` entry answers from it; every
     * other platform falls back to `allowFrom`. An entry that exists but is empty
     * allows nobody: falling back to the WeChat id list instead would mean a QQ
     * stranger passes a gate the owner never opened for that channel.
     */
    isAllowedFor(platform: PlatformId, senderId: string): boolean;
    /** The (primary) gateway's own account id (used for group detection). */
    get gatewayAccountId(): string;
    /**
     * One platform's own account id, or '' when its gateway does not publish one.
     *
     * Group detection compares the message's `to_user_id` against the account that
     * received it, so it has to be the **source** platform's id: in a merged
     * profile the QQ message carries the QQ AppID as `to_user_id`, and comparing
     * that against WeChat's account id classifies every QQ单聊 message as a group
     * message — which is dropped in silence. A platform without an account id
     * answers '', which is the "cannot tell → not a group" default the QQ gateway
     * already relied on.
     */
    gatewayAccountIdFor(platform: PlatformId): string;
    /**
     * Last status seen for one platform, and when ('' when none was ever seen).
     *
     * The primary platform also reads the two legacy fields when no status event
     * has been recorded for it: those fields are still written from outside (a
     * dozen callers and tests set them directly), and `/status` reading a stale
     * internal map instead of them would silently report "unknown" forever.
     */
    gatewayStatusFor(platform: PlatformId): {
        status: string;
        at: string;
    };
    /**
     * Record one platform's gateway status.
     *
     * Both platforms report into the same node now, so the value cannot be a single
     * field: "QQ never came up" would be invisible behind WeChat's cheerful
     * `connected`. The primary's status is mirrored onto {@link gatewayStatus} /
     * {@link gatewayStatusAt} for every caller written before merge mode.
     */
    noteGatewayStatus(platform: PlatformId, status: string): void;
    /** Switch the active session and reply confirmation to the peer. */
    setActiveSession(session: Session): void;
    /** Pick the most recent WeChat session as the default (zero-config targeting).
     *  Only `wechat-` prefixed sessions qualify: this process hosts the Web GUI
     *  too, whose sessions share the same SessionStore — routing an inbound
     *  WeChat message to a web session would leak it into the wrong conversation.
     */
    pickDefaultSession(): void;
    /** Whether a plain (non-command) message is consumed by an active picker. */
    hasActivePicker(): boolean;
    /** Start a numbered-menu picker; callers send the menu text themselves. */
    beginPicker(kind: 'model' | 'perm', options: Array<{
        label: string;
        value: string;
    }>, timeoutSec?: number): void;
    /** Resolve a numbered reply against the active picker. */
    resolvePicker(reply: string): Promise<'consumed' | 'ignored'>;
    /** Available model options as picker entries (provider + model). */
    modelPickerOptions(): Promise<Array<{
        label: string;
        value: string;
    }>>;
    /** The host permission-preset service, when the profile mounted one. */
    private permissionPresets;
    /** The preset effective for a session, or undefined when the host cannot say. */
    private activePreset;
    /** Available permission presets as picker entries. Never throws. */
    permissionPickerOptions(): Array<{
        label: string;
        value: string;
    }>;
    /** Switch the live agent's model to `provider/model` (applies next message). */
    applyModelSelection(value: string): Promise<void>;
    /** Switch the session's permission preset. Never throws. */
    applyPermissionPreset(name: string): Promise<void>;
    /**
     * Return (installing on first use) the mutable model selection for an agent,
     * mirroring the host api-proxy `selectionFor`. The bridge's own agents are
     * created with a fixed AgentOptions route, so the first call here installs
     * the selection hook and later `.current` writes take effect on the next
     * prompt assembly.
     */
    selectionFor(agent: Agent): ModelSelectionRef;
    /**
     * The `provider/model` route the active agent currently chats on, resolved
     * from (in order) an explicit `/model` pick, the session's own request
     * header, then the configured default. Used by the native-image path to ask
     * the routed model whether it accepts images.
     */
    currentModelRoute(): {
        provider: string;
        model: string;
    } | undefined;
    /**
     * Create a fresh agent+session via the agent factory and make it active.
     *
     * `notice` controls the chat line: `''` (default) uses the built-in
     * "已创建新会话" text, `null` stays silent, and any other string is sent
     * verbatim — automatic rotation passes its own reason there, and honours the
     * policy's `announce: false` by passing `null`.
     */
    createSession(prompt: string, notice?: string | null): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /**
     * Ensure the bridge targets a live WeChat agent before routing inbound
     * traffic. Correction order:
     *   1. current active id is a live WeChat agent → keep;
     *   2. any live WeChat session in the store → adopt the most recent;
     *   3. else resume the most recent persisted WeChat session (restart case);
     *   4. else nothing (caller asks the user for /new).
     * Never adopts a non-`wechat-` session (the Web GUI shares this store).
     */
    ensureWechatTarget(): Promise<boolean>;
    /**
     * Resume the most recent persisted WeChat session (id prefixed `wechat-`)
     * so a DSH restart does not strand the conversation: the session data
     * survives on disk, only the live agent instance was lost. Mirrors the Web
     * host's `ensureSession` resume path (persistence list → inspect → resume
     * with the stored preset). Returns true when a session was resumed.
     */
    resumeLatestWechatSession(): Promise<boolean>;
    nextApprovalNumber(): number;
    registerApproval(number: number, approval: PendingApproval): void;
    clearApproval(number: number): void;
    /**
     * Resolve a pending approval from a WeChat reply. `/yes` and `/no` answer
     * the most recent pending request; bare `1`/`2` only while exactly one is
     * pending (1 = allow, 2 = reject). Returns false when the text is not an
     * approval reply.
     */
    resolveApproval(text: string): boolean;
    /** Tear down all registered listeners (called on plugin dispose). */
    dispose(): void;
}
/**
 * Rotate the WeChat conversation when the configured policy says so.
 *
 * Registered on `session/event` and evaluated only on `turn/end` — the one
 * moment the bridge knows the agent finished a turn. Idleness is re-checked
 * immediately before acting, because a queued WeChat message can start the next
 * turn while this one is being evaluated: rotating then would cut a live turn in
 * half and strand the agent with the old session's context.
 *
 * Rotation goes through the SAME `createSession()` as `/new`, so there is exactly
 * one code path that creates WeChat sessions, and a rotation can never leave two
 * agents pointed at the same chat. The handoff note (when enabled) is fenced with
 * its own markers and labelled as background, never as an instruction: a rotation
 * must not look like the owner asking for something.
 */
/**
 * Real context size of a session, read from the host's projection cache.
 *
 * The token scheme wants a token budget, and the honest source is what the host
 * already measured. `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 * carries it: `contextPressure.pressureTokens` (everything the next request
 * sends), with the `contextBreakdown` parts and the live message surface as
 * fallbacks. Returns undefined when nothing usable is there — the policy module
 * then falls back to its character proxy and says so in the rotation reason.
 *
 * Read-only, best effort, and it must never throw: this runs on the turn/end path.
 */
export declare function readContextTokens(sessionId: string): number | undefined;
export declare function attachContextRotation(node: WechatConversationNode): () => void;
/**
 * Watch the gateways' own health events.
 *
 * Each gateway emits `<platform>/status`, `<platform>/error` and
 * `<platform>/fatal`, and nothing in the bridge used to subscribe: a revoked
 * credential, a 403 from a competing poller, a DNS outage or a paused session
 * all ended up in the host log at best, while from the owner's side the bridge
 * simply stopped answering. From here each of them lands in the problem ledger
 * (so `/problems` can show it), a fatal one is announced once, and the last
 * known status is kept per platform for `/status` so a silent dead gateway is
 * visible on demand.
 *
 * Every mounted platform is watched, not just the primary: in merge mode a QQ
 * long-poll that died would otherwise be indistinguishable from the owner not
 * using QQ today.
 */
export declare function attachGatewayObservability(node: WechatConversationNode): () => void;
/**
 * Re-anchor long-term memory after the host compacts a session.
 *
 * Compaction swaps older messages for a summary, and it runs before a step —
 * mid-turn, not between messages — so a session can lose its history while the
 * agent keeps working. Marking the session here makes the owner's next message
 * carry the full memory briefing again instead of waiting out the usual cadence.
 *
 * Observing events is the only route: the preset mounts compaction inside its
 * own realm, so this (host-plane) bridge cannot resolve `ctx.compaction`.
 */
export declare function attachMemoryCompactionWatch(node: WechatConversationNode): () => void;
//# sourceMappingURL=core.d.ts.map