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
export { WechatGateway, Config as GatewayConfig } from './gateway/index.ts';
export { wechatConversationNode, WechatConversationNode, Config as NodeConfig, } from './node/index.ts';
export * from './gateway/types.ts';
export { downloadMedia, parseAesKey, aes128EcbDecrypt } from './gateway/media.ts';
export { splitForWechat, digestLine, textOfAssistantMessage } from './node/outbound.ts';
export { extractText, isGroupMessage } from './node/inbound.ts';
export { listSessions } from './node/commands.ts';
/** Cordis plugin name used by loader diagnostics and profile config. */
export declare const name = "dsh-chatnode-wechat";
/** Services the bundle needs (provided by dsh-base). */
export declare const inject: string[];
/** Bundle config: gateway fields plus the node's `allowFrom` policy. */
export interface Config {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
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
    /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
    baseUrl?: string;
    /** WeChat CDN base url for media. */
    cdnBaseUrl?: string;
    /** Bot token override (prefer credentials). */
    token?: string;
    /** Bot account id override (prefer credentials). */
    accountId?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    allowFrom: z<string[], string[]>;
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
    esp32BaseUrl: z<string, string>;
    imageGenApiKey: z<string, string>;
    imageGenModel: z<string, string>;
    imageGenDir: z<string, string>;
    sttApiKey: z<string, string>;
    sttModel: z<string, string>;
    ttsApiKey: z<string, string>;
    ttsModel: z<string, string>;
    ttsVoice: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
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
    esp32BaseUrl: z<string, string>;
    imageGenApiKey: z<string, string>;
    imageGenModel: z<string, string>;
    imageGenDir: z<string, string>;
    sttApiKey: z<string, string>;
    sttModel: z<string, string>;
    ttsApiKey: z<string, string>;
    ttsModel: z<string, string>;
    ttsVoice: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
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
 */
export declare function apply(ctx: Context, config: Config): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        allowFrom: z<string[], string[]>;
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
        esp32BaseUrl: z<string, string>;
        imageGenApiKey: z<string, string>;
        imageGenModel: z<string, string>;
        imageGenDir: z<string, string>;
        sttApiKey: z<string, string>;
        sttModel: z<string, string>;
        ttsApiKey: z<string, string>;
        ttsModel: z<string, string>;
        ttsVoice: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
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
        esp32BaseUrl: z<string, string>;
        imageGenApiKey: z<string, string>;
        imageGenModel: z<string, string>;
        imageGenDir: z<string, string>;
        sttApiKey: z<string, string>;
        sttModel: z<string, string>;
        ttsApiKey: z<string, string>;
        ttsModel: z<string, string>;
        ttsVoice: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
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