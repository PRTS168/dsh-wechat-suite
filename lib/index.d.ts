/**
 * dsh-chatnode-wechat — one DSH bundle, two separable Cordis plugins.
 *
 * The bundle default export is a composite plugin that mounts:
 *
 * 1. **wechat-gateway** (`WechatGateway`) — the iLink gateway as the `wechat`
 *    service: QR login, authenticated long-poll, reconnect/backoff, send
 *    retry + rate-limit circuit, typing indicator, CDN media download.
 * 2. **wechat-conversation-node** (`wechatConversationNode`) — the WeChat ⇄
 *    DSH conversation bridge: allowlist gate, session targeting, commands,
 *    digest outbound, approvals.
 *
 * Both plugins are exported by name so tests (and advanced users) can mount
 * them separately. Install the bundle with `dsh plugin add
 * @dsh-cowork/chatnode-wechat` and configure via the profile patch
 * (`plugins.dsh-chatnode-wechat`); credentials live in dsh credentials, never
 * in the patch file.
 *
 * @module @dsh-cowork/chatnode-wechat
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type PlatformId } from './platform/index.ts';
export { WechatGateway, Config as GatewayConfig } from './gateway/index.ts';
export { wechatConversationNode, WechatConversationNode, Config as NodeConfig, } from './node/index.ts';
export * from './gateway/types.ts';
export { downloadMedia, parseAesKey, aes128EcbDecrypt } from './gateway/media.ts';
export { splitForWechat, digestLine, textOfAssistantMessage } from './node/outbound.ts';
export { extractText, isGroupMessage } from './node/inbound.ts';
export { listSessions } from './node/commands.ts';
/** Cordis plugin name used by loader diagnostics and profile config. */
export declare const name = "dsh-chatnode-wechat";
/**
 * Services the bundle needs (provided by dsh-base).
 *
 * `sessionTitle` is deliberately NOT listed: it is optional (it itself requires
 * `sessionProjections`), and an optional service named in `inject` leaves this
 * row pending forever when it does not activate — dsh-app-boot then fails the
 * whole profile ("plugin tree failed to load: 1 entry did not activate").
 * The node reads it through `ctx.get('sessionTitle')` and falls back to the
 * first user message instead (see src/node/labels.ts).
 */
export declare const inject: string[];
/** Bundle config: gateway fields plus the node's `allowFrom` policy. */
export interface Config {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
    /** Chat platform to serve: `wechat` (default) or `qq`. */
    platform?: 'wechat' | 'qq';
    /**
     * The platform this profile serves, as a list.
     *
     * Only ever holds ONE entry (`['wechat']` or `['qq']`); `platform` alone is the
     * older spelling of the same statement and still works. `platform` is the
     * **primary**: it owns the session namespace and the default on-disk locations.
     * An unwritten list means "just `platform`".
     */
    platforms?: PlatformId[];
    /**
     * Per-platform allowlists, e.g. `{ qq: ['<user_openid>'] }`.
     *
     * A platform with its own entry uses it; a platform without one uses
     * `allowFrom`. An entry that is an **empty list** accepts nobody on that
     * platform.
     */
    allowFromByPlatform?: Record<string, string[]>;
    /** QQ 机器人 AppID（开放平台）。留空则从 DSH 凭据 QQ_BOT_APP_ID 取。 */
    qqAppId?: string;
    /** QQ 机器人 AppSecret。**建议只放 DSH 凭据**，不要写进 profile。 */
    qqClientSecret?: string;
    /** QQ 接口域名覆盖：沙箱是 https://sandbox.api.sgroup.qq.com。留空走正式域名。 */
    qqBaseUrl?: string;
    /** Heartbeat interval for progress digests (seconds; 0 disables). */
    digestIntervalSec?: number;
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec?: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars?: number;
    /** Throttle between outbound bubbles (ms). */
    sendChunkDelayMs?: number;
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
    /** Append-only problem log: every swallowed failure lands here (defaults under $DSH_HOME). */
    problemFile?: string;
    /** Markdown file holding long-term facts about the owner (defaults under $DSH_HOME). */
    memoryFile?: string;
    /** Inject the memory briefing on the first message and every N messages (0 = first + on change). */
    memoryInjectEvery?: number;
    /** Wall-clock "HH:MM" for the daily memory consolidation (empty disables it). */
    memoryConsolidateTime?: string;
    /** ESP32 PWM light base url (defaults to http://<esp32-ip>:80). */
    esp32BaseUrl?: string;
    /** SiliconFlow API key for image generation (defaults to ocrApiKey when absent). */
    imageGenApiKey?: string;
    /** Image generation model id (defaults to Kwai-Kolors/Kolors). */
    imageGenModel?: string;
    /** Where generated images are saved (defaults to <mediaDir>/generated). */
    imageGenDir?: string;
    /**
     * Context-management scheme (JSON), switched from the standalone admin page
     * (`admin/server.ts`) and executed by the conversation node. Absent = `manual`
     * (the conversation grows until a human types `/new`).
     */
    contextPolicy?: string;
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
    /** How one inbound image reaches the model: auto / native / ocr. */
    imageInput?: 'auto' | 'native' | 'ocr';
    /** Route used for images only, e.g. "deepseek-official/deepseek-v4-flash". */
    imageInputModel?: string;
    /**
     * SMTP account for the `send_email` tool (implicit TLS).
     *
     * These live here as well as on the conversation node on purpose: the host
     * validates the patch against THIS schema, so a key the node reads but the
     * bundle does not declare is stripped before `apply()` ever sees it — which is
     * exactly how `send_email` came to answer "SMTP 没配" on a profile whose patch
     * had the SMTP block filled in.
     */
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpPassword?: string;
    smtpFromName?: string;
    /** Agent preset name for `/new` sessions. */
    agentPreset?: string;
    /** Provider route for `/new` agents. */
    agentProvider?: string;
    /** Model id for `/new` agents. */
    agentModel?: string;
    /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
    baseUrl?: string;
    /** WeChat CDN base url for media. */
    cdnBaseUrl?: string;
    /** Bot token override (prefer credentials). */
    token?: string;
    /** Bot account id override (prefer credentials). */
    accountId?: string;
    /** Long-poll timeout for getUpdates. */
    longPollTimeoutMs?: number;
    /** Per-request API timeout. */
    apiTimeoutMs?: number;
    /** Idle pause between poll iterations (0 = rely on the server's long poll). */
    pollIdleDelayMs?: number;
    /** Poll interval while waiting for a QR scan. */
    qrPollIntervalMs?: number;
    /** Delay before retrying a failed poll. */
    retryDelayMs?: number;
    /** Delay after `maxConsecutiveFailures` consecutive failures. */
    backoffDelayMs?: number;
    /** Failures before the gateway reports itself as reconnecting. */
    maxConsecutiveFailures?: number;
    /** Pause after iLink reports the session expired. */
    sessionExpiredPauseMs?: number;
    /** Send retries per chunk. */
    sendChunkRetries?: number;
    /** Base delay between send retries. */
    sendChunkRetryDelayMs?: number;
    /** Rate-limit circuit: how long it stays open. */
    rateLimitCircuitOpenMs?: number;
    /** Rate-limit circuit: the counting window. */
    rateLimitCircuitWindowMs?: number;
    /** Rate-limit circuit: hits within the window before it opens. */
    rateLimitCircuitThreshold?: number;
    /** Hosts allowed for CDN media download (SSRF fence). */
    allowCdnHosts?: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    allowFrom: z<string[], string[]>;
    platform: z<"wechat" | "qq", "wechat" | "qq">;
    platforms: z<("wechat" | "qq")[], ("wechat" | "qq")[]>;
    allowFromByPlatform: z<any, Record<string, string[]>>;
    qqAppId: z<string, string>;
    qqClientSecret: z<string, string>;
    qqBaseUrl: z<string, string>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    mediaDir: z<string, string>;
    ocrApiKey: z<string, string>;
    ocrModel: z<string, string>;
    ocrBaseUrl: z<string, string>;
    reminderFile: z<string, string>;
    morningFile: z<string, string>;
    memoryFile: z<string, string>;
    problemFile: z<string, string>;
    memoryInjectEvery: z<number, number>;
    memoryConsolidateTime: z<string, string>;
    esp32BaseUrl: z<string, string>;
    imageGenApiKey: z<string, string>;
    imageGenModel: z<string, string>;
    imageGenDir: z<string, string>;
    sttApiKey: z<string, string>;
    sttModel: z<string, string>;
    ttsApiKey: z<string, string>;
    ttsModel: z<string, string>;
    ttsVoice: z<string, string>;
    imageInput: z<string, string>;
    imageInputModel: z<string, string>;
    smtpHost: z<string, string>;
    smtpPort: z<number, number>;
    smtpUsername: z<string, string>;
    smtpPassword: z<string, string>;
    smtpFromName: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    contextPolicy: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
    pollIdleDelayMs: z<number, number>;
    qrPollIntervalMs: z<number, number>;
    retryDelayMs: z<number, number>;
    backoffDelayMs: z<number, number>;
    maxConsecutiveFailures: z<number, number>;
    sessionExpiredPauseMs: z<number, number>;
    sendChunkRetries: z<number, number>;
    sendChunkRetryDelayMs: z<number, number>;
    rateLimitCircuitOpenMs: z<number, number>;
    rateLimitCircuitWindowMs: z<number, number>;
    rateLimitCircuitThreshold: z<number, number>;
    allowCdnHosts: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    allowFrom: z<string[], string[]>;
    platform: z<"wechat" | "qq", "wechat" | "qq">;
    platforms: z<("wechat" | "qq")[], ("wechat" | "qq")[]>;
    allowFromByPlatform: z<any, Record<string, string[]>>;
    qqAppId: z<string, string>;
    qqClientSecret: z<string, string>;
    qqBaseUrl: z<string, string>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    mediaDir: z<string, string>;
    ocrApiKey: z<string, string>;
    ocrModel: z<string, string>;
    ocrBaseUrl: z<string, string>;
    reminderFile: z<string, string>;
    morningFile: z<string, string>;
    memoryFile: z<string, string>;
    problemFile: z<string, string>;
    memoryInjectEvery: z<number, number>;
    memoryConsolidateTime: z<string, string>;
    esp32BaseUrl: z<string, string>;
    imageGenApiKey: z<string, string>;
    imageGenModel: z<string, string>;
    imageGenDir: z<string, string>;
    sttApiKey: z<string, string>;
    sttModel: z<string, string>;
    ttsApiKey: z<string, string>;
    ttsModel: z<string, string>;
    ttsVoice: z<string, string>;
    imageInput: z<string, string>;
    imageInputModel: z<string, string>;
    smtpHost: z<string, string>;
    smtpPort: z<number, number>;
    smtpUsername: z<string, string>;
    smtpPassword: z<string, string>;
    smtpFromName: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    contextPolicy: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
    pollIdleDelayMs: z<number, number>;
    qrPollIntervalMs: z<number, number>;
    retryDelayMs: z<number, number>;
    backoffDelayMs: z<number, number>;
    maxConsecutiveFailures: z<number, number>;
    sessionExpiredPauseMs: z<number, number>;
    sendChunkRetries: z<number, number>;
    sendChunkRetryDelayMs: z<number, number>;
    rateLimitCircuitOpenMs: z<number, number>;
    rateLimitCircuitWindowMs: z<number, number>;
    rateLimitCircuitThreshold: z<number, number>;
    allowCdnHosts: z<string[], string[]>;
}>>;
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 *
 * Cordis scoping note: services mounted via `ctx.plugin()` from this apply
 * context are visible to child contexts (the conversation node resolves
 * `wechat` fine) but NOT to a direct property access on the apply context
 * itself, so the credentials boot runs inside an injected child scope.
 *
 * A profile mounts ONE platform's gateway here (declared by `platforms`, defaulting
 * to `platform`) and hands the node that platform's conversation. The two
 * credential sets are independent — WeChat's live in dsh credentials, QQ's in the
 * AppID/AppSecret pair — so each platform boots through its own injected scope, and
 * a platform that fails to come up does not hold the other one's boot hostage.
 */
export declare function apply(ctx: Context, config: Config): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        allowFrom: z<string[], string[]>;
        platform: z<"wechat" | "qq", "wechat" | "qq">;
        platforms: z<("wechat" | "qq")[], ("wechat" | "qq")[]>;
        allowFromByPlatform: z<any, Record<string, string[]>>;
        qqAppId: z<string, string>;
        qqClientSecret: z<string, string>;
        qqBaseUrl: z<string, string>;
        digestIntervalSec: z<number, number>;
        approvalTimeoutSec: z<number, number>;
        maxMessageChars: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        cwd: z<string, string>;
        mediaDir: z<string, string>;
        ocrApiKey: z<string, string>;
        ocrModel: z<string, string>;
        ocrBaseUrl: z<string, string>;
        reminderFile: z<string, string>;
        morningFile: z<string, string>;
        memoryFile: z<string, string>;
        problemFile: z<string, string>;
        memoryInjectEvery: z<number, number>;
        memoryConsolidateTime: z<string, string>;
        esp32BaseUrl: z<string, string>;
        imageGenApiKey: z<string, string>;
        imageGenModel: z<string, string>;
        imageGenDir: z<string, string>;
        sttApiKey: z<string, string>;
        sttModel: z<string, string>;
        ttsApiKey: z<string, string>;
        ttsModel: z<string, string>;
        ttsVoice: z<string, string>;
        imageInput: z<string, string>;
        imageInputModel: z<string, string>;
        smtpHost: z<string, string>;
        smtpPort: z<number, number>;
        smtpUsername: z<string, string>;
        smtpPassword: z<string, string>;
        smtpFromName: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
        contextPolicy: z<string, string>;
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
        pollIdleDelayMs: z<number, number>;
        qrPollIntervalMs: z<number, number>;
        retryDelayMs: z<number, number>;
        backoffDelayMs: z<number, number>;
        maxConsecutiveFailures: z<number, number>;
        sessionExpiredPauseMs: z<number, number>;
        sendChunkRetries: z<number, number>;
        sendChunkRetryDelayMs: z<number, number>;
        rateLimitCircuitOpenMs: z<number, number>;
        rateLimitCircuitWindowMs: z<number, number>;
        rateLimitCircuitThreshold: z<number, number>;
        allowCdnHosts: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        allowFrom: z<string[], string[]>;
        platform: z<"wechat" | "qq", "wechat" | "qq">;
        platforms: z<("wechat" | "qq")[], ("wechat" | "qq")[]>;
        allowFromByPlatform: z<any, Record<string, string[]>>;
        qqAppId: z<string, string>;
        qqClientSecret: z<string, string>;
        qqBaseUrl: z<string, string>;
        digestIntervalSec: z<number, number>;
        approvalTimeoutSec: z<number, number>;
        maxMessageChars: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        cwd: z<string, string>;
        mediaDir: z<string, string>;
        ocrApiKey: z<string, string>;
        ocrModel: z<string, string>;
        ocrBaseUrl: z<string, string>;
        reminderFile: z<string, string>;
        morningFile: z<string, string>;
        memoryFile: z<string, string>;
        problemFile: z<string, string>;
        memoryInjectEvery: z<number, number>;
        memoryConsolidateTime: z<string, string>;
        esp32BaseUrl: z<string, string>;
        imageGenApiKey: z<string, string>;
        imageGenModel: z<string, string>;
        imageGenDir: z<string, string>;
        sttApiKey: z<string, string>;
        sttModel: z<string, string>;
        ttsApiKey: z<string, string>;
        ttsModel: z<string, string>;
        ttsVoice: z<string, string>;
        imageInput: z<string, string>;
        imageInputModel: z<string, string>;
        smtpHost: z<string, string>;
        smtpPort: z<number, number>;
        smtpUsername: z<string, string>;
        smtpPassword: z<string, string>;
        smtpFromName: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
        contextPolicy: z<string, string>;
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
        pollIdleDelayMs: z<number, number>;
        qrPollIntervalMs: z<number, number>;
        retryDelayMs: z<number, number>;
        backoffDelayMs: z<number, number>;
        maxConsecutiveFailures: z<number, number>;
        sessionExpiredPauseMs: z<number, number>;
        sendChunkRetries: z<number, number>;
        sendChunkRetryDelayMs: z<number, number>;
        rateLimitCircuitOpenMs: z<number, number>;
        rateLimitCircuitWindowMs: z<number, number>;
        rateLimitCircuitThreshold: z<number, number>;
        allowCdnHosts: z<string[], string[]>;
    }>>;
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map