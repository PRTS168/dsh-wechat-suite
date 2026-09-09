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
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { PendingApproval } from './approvals.ts';
import type { MorningService } from './morning.ts';
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
}
export declare class WechatConversationNode {
    /** The active session the WeChat user drives. */
    activeSessionId: SessionId | null;
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId: string | null;
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
    constructor(ctx: Context, config: NodeConfig);
    /** The active WeChat session, if any. Never a non-`wechat-` session: this
     *  process shares its SessionStore with the Web GUI, and an inbound WeChat
     *  message must never be routed into a web conversation. */
    activeSession(): Session | undefined;
    /** The agent driving the active WeChat session, if any. */
    activeAgent(): Agent | undefined;
    /** Whether this node drives the given agent (its session is active). */
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
    /** Available permission presets as picker entries. */
    permissionPickerOptions(): Array<{
        label: string;
        value: string;
    }>;
    /** Switch the live agent's model to `provider/model` (applies next message). */
    applyModelSelection(value: string): Promise<void>;
    /** Switch the session's permission preset. */
    applyPermissionPreset(name: string): Promise<void>;
    /**
     * Return (installing on first use) the mutable model selection for an agent,
     * mirroring the host api-proxy `selectionFor`. The bridge's own agents are
     * created with a fixed AgentOptions route, so the first call here installs
     * the selection hook and later `.current` writes take effect on the next
     * prompt assembly.
     */
    selectionFor(agent: Agent): ModelSelectionRef;
    /** Create a fresh agent+session via the agent factory and make it active. */
    createSession(prompt: string): Promise<void>;
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
//# sourceMappingURL=core.d.ts.map