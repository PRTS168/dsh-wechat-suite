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
export const inject = ['sessions', 'agents', 'approval', 'credentials']

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
  /** Append-only problem log: every swallowed failure lands here (defaults under $DSH_HOME). */
  problemFile?: string
  /** Markdown file holding long-term facts about the owner (defaults under $DSH_HOME). */
  memoryFile?: string
  /** Inject the memory briefing on the first message and every N messages (0 = first + on change). */
  memoryInjectEvery?: number
  /** Wall-clock "HH:MM" for the daily memory consolidation (empty disables it). */
  memoryConsolidateTime?: string
  /** ESP32 PWM light base url (defaults to http://<esp32-ip>:80). */
  esp32BaseUrl?: string
  /** SiliconFlow API key for image generation (defaults to ocrApiKey when absent). */
  imageGenApiKey?: string
  /** Image generation model id (defaults to Kwai-Kolors/Kolors). */
  imageGenModel?: string
  /** Where generated images are saved (defaults to <mediaDir>/generated). */
  imageGenDir?: string
  /**
   * Context-management scheme (JSON), switched from the standalone admin page
   * (`admin/server.ts`) and executed by the conversation node. Absent = `manual`
   * (the conversation grows until a human types `/new`).
   */
  contextPolicy?: string
  /** SiliconFlow API key for speech-to-text (defaults to ocrApiKey when absent). */
  sttApiKey?: string
  /** ASR model id (defaults to XingChenAGI/XingChenASR-V3.2-Ultra). */
  sttModel?: string
  /** SiliconFlow API key for TTS (defaults to ocrApiKey when absent). */
  ttsApiKey?: string
  /** TTS model id (defaults to FunAudioLLM/CosyVoice2-0.5B). */
  ttsModel?: string
  /** Cloned voice uri used for speech replies (e.g. speech:my-clone:…). */
  ttsVoice?: string
  /** How one inbound image reaches the model: auto / native / ocr. */
  imageInput?: 'auto' | 'native' | 'ocr'
  /** Route used for images only, e.g. "deepseek-official/deepseek-v4-flash". */
  imageInputModel?: string
  /**
   * SMTP account for the `send_email` tool (implicit TLS).
   *
   * These live here as well as on the conversation node on purpose: the host
   * validates the patch against THIS schema, so a key the node reads but the
   * bundle does not declare is stripped before `apply()` ever sees it — which is
   * exactly how `send_email` came to answer "SMTP 没配" on a profile whose patch
   * had the SMTP block filled in.
   */
  smtpHost?: string
  smtpPort?: number
  smtpUsername?: string
  smtpPassword?: string
  smtpFromName?: string
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
  /** Long-poll timeout for getUpdates. */
  longPollTimeoutMs?: number
  /** Per-request API timeout. */
  apiTimeoutMs?: number
  /** Idle pause between poll iterations (0 = rely on the server's long poll). */
  pollIdleDelayMs?: number
  /** Poll interval while waiting for a QR scan. */
  qrPollIntervalMs?: number
  /** Delay before retrying a failed poll. */
  retryDelayMs?: number
  /** Delay after `maxConsecutiveFailures` consecutive failures. */
  backoffDelayMs?: number
  /** Failures before the gateway reports itself as reconnecting. */
  maxConsecutiveFailures?: number
  /** Pause after iLink reports the session expired. */
  sessionExpiredPauseMs?: number
  /** Send retries per chunk. */
  sendChunkRetries?: number
  /** Base delay between send retries. */
  sendChunkRetryDelayMs?: number
  /** Rate-limit circuit: how long it stays open. */
  rateLimitCircuitOpenMs?: number
  /** Rate-limit circuit: the counting window. */
  rateLimitCircuitWindowMs?: number
  /** Rate-limit circuit: hits within the window before it opens. */
  rateLimitCircuitThreshold?: number
  /** Hosts allowed for CDN media download (SSRF fence). */
  allowCdnHosts?: string[]
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
  memoryFile: z.string(),
  problemFile: z.string(),
  memoryInjectEvery: z.number(),
  memoryConsolidateTime: z.string(),
  esp32BaseUrl: z.string(),
  imageGenApiKey: z.string(),
  imageGenModel: z.string(),
  imageGenDir: z.string(),
  sttApiKey: z.string(),
  sttModel: z.string(),
  ttsApiKey: z.string(),
  ttsModel: z.string(),
  ttsVoice: z.string(),
  imageInput: z.string(),
  imageInputModel: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number(),
  smtpUsername: z.string(),
  smtpPassword: z.string(),
  smtpFromName: z.string(),
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
  // Declared here because GATEWAY_KEYS forwards them: a key the gateway reads
  // but this schema omits is stripped by the host before apply() runs, so the
  // setting would look accepted and change nothing.
  pollIdleDelayMs: z.number().default(0),
  qrPollIntervalMs: z.number().default(1_000),
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
    memoryFile: config.memoryFile,
    problemFile: config.problemFile,
    memoryInjectEvery: config.memoryInjectEvery,
    memoryConsolidateTime: config.memoryConsolidateTime,
    esp32BaseUrl: config.esp32BaseUrl,
    imageGenApiKey: config.imageGenApiKey,
    imageGenModel: config.imageGenModel,
    imageGenDir: config.imageGenDir,
    sttApiKey: config.sttApiKey,
    sttModel: config.sttModel,
    ttsApiKey: config.ttsApiKey,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    imageInput: config.imageInput,
    imageInputModel: config.imageInputModel,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpUsername: config.smtpUsername,
    smtpPassword: config.smtpPassword,
    smtpFromName: config.smtpFromName,
    agentPreset: config.agentPreset,
    agentProvider: config.agentProvider,
    agentModel: config.agentModel,
    contextPolicy: config.contextPolicy,
  })
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
      logQuietly(bootCtx, `credentials boot failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}

/**
 * Log through `ctx.get('logger')` and never throw.
 *
 * Property access on a torn-down context throws, so a logger reached as
 * `ctx.logger` inside a `catch` turns one error into two — the second one
 * outside any handler. Every failure path in this file uses this helper.
 */
function logQuietly(ctx: Context, message: string): void {
  try {
    const logger = ctx.get('logger') as { warn?: (msg: string) => void; info?: (msg: string) => void } | undefined
    logger?.warn?.(`[dsh-chatnode-wechat] ${message}`)
  } catch {
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
async function bootWithCredentials(ctx: Context, config: Config): Promise<void> {
  const credentials = ctx.get('credentials')
  if (!credentials) return
  let token: { value?: string } | undefined
  let accountId: { value?: string } | undefined
  let baseUrl: { value?: string } | undefined
  try {
    token = await credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN'))
    accountId = await credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID'))
    baseUrl = await credentials.resolve(credentialRef('WEIXIN_BASE_URL'))
  } catch (error) {
    logQuietly(ctx, `credentials resolution failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The scope may be gone by now: re-read instead of trusting the first look.
  const wechat = ctx.get('wechat')
  if (!wechat) return
  try {
    if (token?.value && accountId?.value) {
      wechat.setCredentials({
        token: token.value,
        accountId: accountId.value,
        baseUrl: baseUrl?.value || config.baseUrl,
      })
    }
  } catch (error) {
    logQuietly(ctx, `gateway credentials rejected: ${error instanceof Error ? error.message : String(error)}`)
  }
  const live = ctx.get('wechat')
  if (!live) return
  try {
    await live.start()
  } catch (error) {
    logQuietly(ctx, `gateway start failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (ctx.get('wechat') && !live.configured) {
    logQuietly(
      ctx,
      'no WEIXIN_BOT_TOKEN/WEIXIN_ACCOUNT_ID credentials — gateway idle. ' +
      'Run the QR login script (packages/chatnode-wechat: `pnpm login`) to pair a WeChat account.',
    )
  }
}

/**
 * Everything the gateway takes from config.
 *
 * This used to hand over four keys and silently drop the rest: the schema
 * accepted `sendChunkRetries`, `allowCdnHosts`, `longPollTimeoutMs` and eight
 * more, `apply()` never passed them on, and the gateway fell back to its own
 * defaults — so editing any of them looked accepted and did nothing. The list
 * below is derived from the gateway's own schema, and the config-surface test
 * asserts the two stay in step.
 */
const GATEWAY_KEYS = [
  'baseUrl', 'cdnBaseUrl', 'token', 'accountId',
  'longPollTimeoutMs', 'apiTimeoutMs', 'pollIdleDelayMs', 'qrPollIntervalMs',
  'retryDelayMs', 'backoffDelayMs', 'maxConsecutiveFailures', 'sessionExpiredPauseMs',
  'sendChunkRetries', 'sendChunkRetryDelayMs', 'rateLimitCircuitOpenMs',
  'rateLimitCircuitWindowMs', 'rateLimitCircuitThreshold', 'allowCdnHosts',
] as const

function extractGatewayConfig(config: Config): Record<string, unknown> {
  const source = config as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of GATEWAY_KEYS) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

export default { name, inject, Config, apply }
