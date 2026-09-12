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
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { API_TIMEOUT_MS, ILINK_BASE_URL, LONG_POLL_TIMEOUT_MS, WEIXIN_CDN_BASE_URL, } from "./gateway/types.js";
import { DEFAULT_CDN_ALLOWLIST } from "./gateway/media.js";
import { WechatGateway } from "./gateway/index.js";
import { wechatConversationNode } from "./node/index.js";
export { WechatGateway, Config as GatewayConfig } from "./gateway/index.js";
export { wechatConversationNode, WechatConversationNode, Config as NodeConfig, } from "./node/index.js";
export * from "./gateway/types.js";
export { downloadMedia, parseAesKey, aes128EcbDecrypt } from "./gateway/media.js";
export { splitForWechat, digestLine, textOfAssistantMessage } from "./node/outbound.js";
export { extractText, isGroupMessage } from "./node/inbound.js";
export { listSessions } from "./node/commands.js";
/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-chatnode-wechat';
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
export const inject = ['sessions', 'agents', 'approval', 'credentials'];
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    digestIntervalSec: z.number().default(300),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(2000),
    sendChunkDelayMs: z.number().default(1_500),
    cwd: z.string(),
    mediaDir: z.string(),
    ocrApiKey: z.string(),
    ocrModel: z.string(),
    ocrBaseUrl: z.string(),
    reminderFile: z.string(),
    morningFile: z.string(),
    esp32BaseUrl: z.string(),
    imageGenApiKey: z.string(),
    imageGenModel: z.string(),
    imageGenDir: z.string(),
    sttApiKey: z.string(),
    sttModel: z.string(),
    ttsApiKey: z.string(),
    ttsModel: z.string(),
    ttsVoice: z.string(),
    agentPreset: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
    // Context-management scheme (JSON), switched from the standalone admin page.
    // Accepted shapes live in src/node/context-policy.ts.
    contextPolicy: z.string(),
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
    token: z.string().default(''),
    accountId: z.string().default(''),
    longPollTimeoutMs: z.number().default(LONG_POLL_TIMEOUT_MS),
    apiTimeoutMs: z.number().default(API_TIMEOUT_MS),
    retryDelayMs: z.number().default(2_000),
    backoffDelayMs: z.number().default(30_000),
    maxConsecutiveFailures: z.number().default(3),
    sessionExpiredPauseMs: z.number().default(600_000),
    sendChunkRetries: z.number().default(4),
    sendChunkRetryDelayMs: z.number().default(1_000),
    rateLimitCircuitOpenMs: z.number().default(30_000),
    rateLimitCircuitWindowMs: z.number().default(30_000),
    rateLimitCircuitThreshold: z.number().default(1),
    allowCdnHosts: z.array(z.string()).default([...DEFAULT_CDN_ALLOWLIST]),
});
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 *
 * Cordis scoping note: services mounted via `ctx.plugin()` from this apply
 * context are visible to child contexts (the conversation node resolves
 * `wechat` fine) but NOT to a direct property access on the apply context
 * itself, so the credentials boot runs inside an injected child scope.
 */
export function apply(ctx, config) {
    const gatewayConfig = extractGatewayConfig(config);
    ctx.plugin(WechatGateway, gatewayConfig);
    ctx.plugin(wechatConversationNode, {
        allowFrom: config.allowFrom ?? [],
        digestIntervalSec: config.digestIntervalSec,
        approvalTimeoutSec: config.approvalTimeoutSec,
        maxMessageChars: config.maxMessageChars,
        sendChunkDelayMs: config.sendChunkDelayMs,
        cwd: config.cwd,
        mediaDir: config.mediaDir,
        ocrApiKey: config.ocrApiKey,
        ocrModel: config.ocrModel,
        ocrBaseUrl: config.ocrBaseUrl,
        reminderFile: config.reminderFile,
        morningFile: config.morningFile,
        esp32BaseUrl: config.esp32BaseUrl,
        imageGenApiKey: config.imageGenApiKey,
        imageGenModel: config.imageGenModel,
        imageGenDir: config.imageGenDir,
        sttApiKey: config.sttApiKey,
        sttModel: config.sttModel,
        ttsApiKey: config.ttsApiKey,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        agentPreset: config.agentPreset,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        contextPolicy: config.contextPolicy,
    });
    // Credentials go through the dsh credentials service — never in the patch
    // file. Resolve them at boot and start polling only when they exist.
    ctx.inject(['wechat', 'credentials'], (bootCtx) => {
        // `.catch()` is NOT decoration: this profile reloads patches live, so the
        // scope is routinely torn down while the awaits below are pending. An
        // escaped rejection here is FATAL to the whole host —
        // "dsh: fatal load failure: cannot get required service "wechat" in
        // inactive context" → the harness exits and the desktop app blocks the
        // profile (safe mode). That is exactly what a config write did on
        // 2026-09-12 15:02. A failure now degrades to "this row did not activate".
        bootWithCredentials(bootCtx, config).catch((error) => {
            logQuietly(bootCtx, `credentials boot failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
}
/**
 * Log through `ctx.get('logger')` and never throw.
 *
 * Property access on a torn-down context throws, so a logger reached as
 * `ctx.logger` inside a `catch` turns one error into two — the second one
 * outside any handler. Every failure path in this file uses this helper.
 */
function logQuietly(ctx, message) {
    try {
        const logger = ctx.get('logger');
        logger?.warn?.(`[dsh-chatnode-wechat] ${message}`);
    }
    catch {
        // Nothing left to log to; the caller is already handling a dead context.
    }
}
/**
 * Resolve WEIXIN_* credentials from `ctx.credentials` and start the gateway.
 * Without credentials the gateway stays idle; run `pnpm login` (the
 * CLI-driven QR flow) to pair a WeChat account.
 *
 * Services are read with `ctx.get()` rather than as properties, and re-read
 * after every await: property access throws "cannot get required service … in
 * inactive context" once a live patch reload has torn the scope down, and this
 * function keeps running for a few ticks after the scope it started in is gone.
 */
async function bootWithCredentials(ctx, config) {
    const credentials = ctx.get('credentials');
    if (!credentials)
        return;
    let token;
    let accountId;
    let baseUrl;
    try {
        token = await credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN'));
        accountId = await credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID'));
        baseUrl = await credentials.resolve(credentialRef('WEIXIN_BASE_URL'));
    }
    catch (error) {
        logQuietly(ctx, `credentials resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The scope may be gone by now: re-read instead of trusting the first look.
    const wechat = ctx.get('wechat');
    if (!wechat)
        return;
    try {
        if (token?.value && accountId?.value) {
            wechat.setCredentials({
                token: token.value,
                accountId: accountId.value,
                baseUrl: baseUrl?.value || config.baseUrl,
            });
        }
    }
    catch (error) {
        logQuietly(ctx, `gateway credentials rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    const live = ctx.get('wechat');
    if (!live)
        return;
    try {
        await live.start();
    }
    catch (error) {
        logQuietly(ctx, `gateway start failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    if (ctx.get('wechat') && !live.configured) {
        logQuietly(ctx, 'no WEIXIN_BOT_TOKEN/WEIXIN_ACCOUNT_ID credentials — gateway idle. ' +
            'Run the QR login script (packages/chatnode-wechat: `pnpm login`) to pair a WeChat account.');
    }
}
function extractGatewayConfig(config) {
    const out = {};
    if (config.baseUrl !== undefined)
        out.baseUrl = config.baseUrl;
    if (config.cdnBaseUrl !== undefined)
        out.cdnBaseUrl = config.cdnBaseUrl;
    if (config.token !== undefined)
        out.token = config.token;
    if (config.accountId !== undefined)
        out.accountId = config.accountId;
    return out;
}
export default { name, inject, Config, apply };
//# sourceMappingURL=index.js.map