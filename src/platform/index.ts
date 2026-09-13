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

import type { Context } from '@deepseek-ai/cordis'
import type { GatewayStatus, SendResult } from '../gateway/index.ts'
import type { InboundMessage } from '../gateway/types.ts'
import type { RasterImageMediaType } from '../gateway/media.ts'

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
    'qq/message'(message: InboundMessage): void
    'qq/status'(status: GatewayStatus): void
    'qq/error'(error: Error): void
    'qq/fatal'(error: Error): void
  }
}

/** Chat platforms this bridge can speak. */
export const PLATFORM_IDS = ['wechat', 'qq'] as const

export type PlatformId = (typeof PLATFORM_IDS)[number]

/** True for a value that names a platform we can actually mount. */
export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value)
}

/**
 * The service a platform's gateway registers, plus the events it emits.
 *
 * Both come from the same id on purpose: a gateway is mounted under `ctx.qq` and
 * emits `qq/message`, so a node configured for `qq` needs no per-platform
 * wiring — it reads one id and everything else follows.
 */
export interface PlatformEvents {
  message: 'wechat/message' | 'qq/message'
  error: 'wechat/error' | 'qq/error'
  fatal: 'wechat/fatal' | 'qq/fatal'
  status: 'wechat/status' | 'qq/status'
}

/**
 * Literal unions rather than a template string on purpose: cordis types `on()`
 * against its `Events` interface, and a plain `string` would force every call
 * site to cast. Both platforms declare the same payload shapes, so the union
 * stays assignable.
 */
export function platformEvents(id: PlatformId): PlatformEvents {
  return id === 'qq'
    ? { message: 'qq/message', error: 'qq/error', fatal: 'qq/fatal', status: 'qq/status' }
    : { message: 'wechat/message', error: 'wechat/error', fatal: 'wechat/fatal', status: 'wechat/status' }
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
  readonly accountId?: string
  sendText(to: string, text: string, clientId?: string): Promise<SendResult>
  sendImage(to: string, filePath: string): Promise<SendResult>
  sendFile(to: string, filePath: string, fileName?: string): Promise<SendResult>
  /** Cosmetic; platforms without a typing indicator no-op here. */
  sendTyping(to: string, status: 1 | 2): Promise<void>
  downloadImage(item: unknown): Promise<{ bytes: Uint8Array; mediaType: RasterImageMediaType } | null>
  downloadVoice(item: unknown): Promise<Uint8Array | null>
  downloadAttachment(item: unknown): Promise<{ bytes: Uint8Array; fileName?: string } | null>
}

/**
 * The active platform's service, or undefined while its gateway is not mounted.
 *
 * Callers treat `undefined` as "the platform is not available right now" (the
 * plugin may simply not be mounted in this profile) — never as "send anyway".
 */
export function chatService(ctx: Context, id: PlatformId): ChatPlatform | undefined {
  return ctx.get(id as never) as ChatPlatform | undefined
}
