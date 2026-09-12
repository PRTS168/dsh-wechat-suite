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
import type { PendingApproval } from './approvals.ts';
import { type ContextPolicy } from './context-policy.ts';
import type { MorningService } from './morning.ts';
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
/** Pick the newest persisted `wechat-` session, or undefined when there is none. */
export declare function selectNewestWechat(entries: readonly PersistenceEntry[]): {
    id: string;
    createdAt: number;
} | undefined;
/** Runtime shape of the node plugin's config (defaults applied). */
export interface NodeConfig {
    /** Hard allowlist of WeChat sender ids allowed to drive the agent. REQUIRED. */
    allowFrom: string[];
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
    /** ESP32 PWM light base url (defaults to http://192.168.1.11:80). */
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
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId: string | null;
    /**
     * Runtime override for {@link NodeConfig.imageInput}, set by the `/识图`
     * command. Survives until the bridge process restarts; config remains the
     * source of truth for the next boot.
     */
    runtimeImageInput: 'auto' | 'native' | 'ocr' | null;
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
    readonly ctx: Context;
    readonly config: NodeConfig;
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
    constructor(ctx: Context, config: NodeConfig);
    /** Whether a rotation is currently in flight (used by tests and the guard). */
    isRotating(): boolean;
    /** Claim the rotation slot; returns false when one is already running. */
    beginRotation(): boolean;
    /** Release the rotation slot. */
    endRotation(): void;
    /** Take the queued rotation note for the next inbound message (once). */
    consumeHandoff(): string;
    /** Queue a rotation note for the next inbound message. */
    setPendingHandoff(note: string | null): void;
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
    /** Whether a session id belongs to this bridge's own WeChat sessions. */
    isWechatSessionId(id: unknown): boolean;
    /** Whether a sender is allowlisted. */
    isAllowed(senderId: string): boolean;
    /** The gateway's own account id (used for group detection). */
    get gatewayAccountId(): string;
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
    createSession(prompt: string, notice?: string | null): Promise<void>;
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
 * carries it: `contextPressure.surfaceTokens` (the live context surface) with
 * `contextBreakdown` and the cumulative `tokenUsage` as fallbacks. Returns
 * undefined when nothing usable is there — the policy module then falls back to
 * its character proxy and says so in the rotation reason.
 *
 * Read-only, best effort, and it must never throw: this runs on the turn/end path.
 */
export declare function readContextTokens(sessionId: string): number | undefined;
export declare function attachContextRotation(node: WechatConversationNode): () => void;
//# sourceMappingURL=core.d.ts.map