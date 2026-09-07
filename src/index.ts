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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  API_TIMEOUT_MS,
  ILINK_BASE_URL,
  LONG_POLL_TIMEOUT_MS,
  WEIXIN_CDN_BASE_URL,
} from './gateway/types.ts'
import { DEFAULT_CDN_ALLOWLIST } from './gateway/media.ts'
import { WechatGateway } from './gateway/index.ts'
import { wechatConversationNode } from './node/index.ts'

export { WechatGateway, Config as GatewayConfig } from './gateway/index.ts'
export {
  wechatConversationNode,
  WechatConversationNode,
  Config as NodeConfig,
} from './node/index.ts'
export * from './gateway/types.ts'
export { downloadMedia, parseAesKey, aes128EcbDecrypt } from './gateway/media.ts'
export { splitForWechat, digestLine, textOfAssistantMessage } from './node/outbound.ts'
export { extractText, isGroupMessage } from './node/inbound.ts'
export { listSessions } from './node/commands.ts'

/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-chatnode-wechat'

/** Services the bundle needs (provided by dsh-base). */
export const inject = ['sessions', 'agents', 'approval', 'credentials', 'sessionTitle']

/** Bundle config: gateway fields plus the node's `allowFrom` policy. */
export interface Config {
  /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
  allowFrom?: string[]
  /** Heartbeat interval for progress digests (seconds; 0 disables). */
  digestIntervalSec?: number
  /** Approval prompt timeout before default-deny (seconds). */
  approvalTimeoutSec?: number
  /** Max chars per WeChat bubble. */
  maxMessageChars?: number
  /** Throttle between outbound bubbles (ms). */
  sendChunkDelayMs?: number
  /** Working directory for `/new` sessions. */
  cwd?: string
  /** Directory inbound images are saved to (defaults under $DSH_HOME). */
  mediaDir?: string
  /** SiliconFlow API key for DeepSeek-OCR (sk-…). Empty/absent disables OCR. */
  ocrApiKey?: string
  /** DeepSeek-OCR model id (defaults to deepseek-ai/DeepSeek-OCR). */
  ocrModel?: string
  /** OpenAI-compatible base URL for OCR (defaults to SiliconFlow). */
  ocrBaseUrl?: string
  /** JSON file reminders persist to (defaults to $DSH_HOME/wechat-reminders.json). */
  reminderFile?: string
  /** JSON file the morning-greeting config persists to (defaults under $DSH_HOME). */
  morningFile?: string
  /** ESP32 PWM light base url (defaults to http://192.168.1.11:80). */
  esp32BaseUrl?: string
  /** SiliconFlow API key for image generation (defaults to ocrApiKey when absent). */
  imageGenApiKey?: string
  /** Image generation model id (defaults to Kwai-Kolors/Kolors). */
  imageGenModel?: string
  /** Where generated images are saved (defaults to <mediaDir>/generated). */
  imageGenDir?: string
  /** SiliconFlow API key for speech-to-text (defaults to ocrApiKey when absent). */
  sttApiKey?: string
  /** ASR model id (defaults to XingChenAGI/XingChenASR-V3.2-Ultra). */
  sttModel?: string
  /** SiliconFlow API key for TTS (defaults to ocrApiKey when absent). */
  ttsApiKey?: string
  /** TTS model id (defaults to FunAudioLLM/CosyVoice2-0.5B). */
  ttsModel?: string
  /** Cloned voice uri used for speech replies (e.g. speech:shiroko:…). */
  ttsVoice?: string
  /** Agent preset name for `/new` sessions. */
  agentPreset?: string
  /** Provider route for `/new` agents. */
  agentProvider?: string
  /** Model id for `/new` agents. */
  agentModel?: string
  /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
  baseUrl?: string
  /** WeChat CDN base url for media. */
  cdnBaseUrl?: string
  /** Bot token override (prefer credentials). */
  token?: string
  /** Bot account id override (prefer credentials). */
  accountId?: string
}

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
})

/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 *
 * Cordis scoping note: services mounted via `ctx.plugin()` from this apply
 * context are visible to child contexts (the conversation node resolves
 * `wechat` fine) but NOT to a direct property access on the apply context
 * itself, so the credentials boot runs inside an injected child scope.
 */
export function apply(ctx: Context, config: Config): void {
  const gatewayConfig = extractGatewayConfig(config)
  ctx.plugin(WechatGateway, gatewayConfig)
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
  })
  // Credentials go through the dsh credentials service — never in the patch
  // file. Resolve them at boot and start polling only when they exist.
  ctx.inject(['wechat', 'credentials'], (bootCtx) => {
    void bootWithCredentials(bootCtx, config)
  })
}

/**
 * Resolve WEIXIN_* credentials from `ctx.credentials` and start the gateway.
 * Without credentials the gateway stays idle; run `pnpm login` (the
 * CLI-driven QR flow) to pair a WeChat account.
 */
async function bootWithCredentials(ctx: Context, config: Config): Promise<void> {
  try {
    const token = await ctx.credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN'))
    const accountId = await ctx.credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID'))
    const baseUrl = await ctx.credentials.resolve(credentialRef('WEIXIN_BASE_URL'))
    if (token?.value && accountId?.value) {
      ctx.wechat.setCredentials({
        token: token.value,
        accountId: accountId.value,
        baseUrl: baseUrl?.value || config.baseUrl,
      })
    }
  } catch (error) {
    ctx.logger?.warn?.('[dsh-chatnode-wechat] credentials resolution failed: %s', error instanceof Error ? error.message : error)
  }
  await ctx.wechat.start()
  if (!ctx.wechat.configured) {
    ctx.logger?.info?.(
      '[dsh-chatnode-wechat] no WEIXIN_BOT_TOKEN/WEIXIN_ACCOUNT_ID credentials — gateway idle. ' +
      'Run the QR login script (packages/chatnode-wechat: `pnpm login`) to pair a WeChat account.',
    )
  }
}

function extractGatewayConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (config.baseUrl !== undefined) out.baseUrl = config.baseUrl
  if (config.cdnBaseUrl !== undefined) out.cdnBaseUrl = config.cdnBaseUrl
  if (config.token !== undefined) out.token = config.token
  if (config.accountId !== undefined) out.accountId = config.accountId
  return out
}

export default { name, inject, Config, apply }
