/**
 * iLink wire protocol constants and schemas.
 *
 * Reconstructed from the hermes-agent native WeChat channel
 * (`gateway/platforms/weixin.py`, MIT) and verified against recorded
 * transcripts in `test/fixtures/`. Tencent publishes no docs for this
 * gateway — treat every field as best-effort and re-record fixtures before
 * refactors (see README "Protocol opacity").
 *
 * @module @dsh-cowork/chatnode-wechat/gateway/types
 */

/** Primary iLink gateway host. */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** CDN used for encrypted media transfer. */
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** Static app identity the bot gateway expects. */
export const ILINK_APP_ID = 'bot'
/** Channel version reported inside `base_info`. */
export const CHANNEL_VERSION = '2.2.0'
/** `iLink-App-ClientVersion` — (2 << 16) | (2 << 8) | 0. */
export const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0

export const EP_GET_UPDATES = 'ilink/bot/getupdates'
export const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
export const EP_SEND_TYPING = 'ilink/bot/sendtyping'
export const EP_GET_CONFIG = 'ilink/bot/getconfig'
export const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl'
export const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode'
export const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status'

/** Long-poll window for getUpdates (server may suggest a different value). */
export const LONG_POLL_TIMEOUT_MS = 35_000
export const API_TIMEOUT_MS = 15_000
export const CONFIG_TIMEOUT_MS = 10_000
export const QR_TIMEOUT_MS = 35_000
/** WeChat client-level cap for one text bubble; outbound chunks must fit. */
export const MAX_MESSAGE_CHARS = 2000

/** item_list item kinds. */
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

/** Media type ids for getuploadurl — a SEPARATE numbering from ITEM_* kinds
 *  (mirrors the astrbot/hermes weixin adapters): image=1, video=2, file=3. */
export const MEDIA_IMAGE = 1
export const MEDIA_VIDEO = 2
export const MEDIA_FILE = 3

export const MSG_TYPE_USER = 1
export const MSG_TYPE_BOT = 2
export const MSG_STATE_FINISH = 2

export const TYPING_START = 1
export const TYPING_STOP = 2

/** iLink session-expired error code (both `ret` and `errcode` slots). */
export const SESSION_EXPIRED_ERRCODE = -14
/**
 * iLink frequency-limit error code. `ret`/`errcode` -2 with errmsg
 * "unknown error" is a STALE-SESSION signal instead (see
 * {@link isStaleSessionRet}).
 */
export const RATE_LIMIT_ERRCODE = -2

/** Dedup TTL for inbound message ids (seconds). */
export const MESSAGE_DEDUP_TTL_SECONDS = 300

/**
 * How long a payload-identity dedup entry lives, for messages iLink delivers
 * without a `message_id`.
 *
 * The observed redelivery gap is 6–9 seconds, so 30s catches it comfortably while
 * still letting someone deliberately repeat a short line ("你好") later on.
 */
export const CONTENT_DEDUP_TTL_SECONDS = 30

/**
 * Payload identity for a message that carries no `message_id`.
 *
 * Built from the sender plus, per item, its kind, its visible text (including
 * WeChat's own voice transcription) and its media pointer. A redelivery of the
 * same message reproduces this string exactly; anything the user genuinely types
 * again looks the same to us too — hence the short TTL rather than a longer one.
 *
 * Returns undefined when the payload holds nothing identifying, in which case the
 * message is passed through rather than guessed at.
 */
export function inboundContentKey(message: InboundMessage): string | undefined {
  const sender = String(message.from_user_id ?? '')
  const items = Array.isArray(message.item_list) ? message.item_list : []
  const parts: string[] = []
  let identifying = false
  for (const raw of items) {
    const item = raw as Record<string, any>
    const text = String(item?.text_item?.text ?? item?.voice_item?.text ?? '').trim()
    const media = item?.file_item?.media ?? item?.video_item?.media ?? item?.image_item?.media ?? item?.voice_item?.media
    const pointer = String(media?.encrypt_query_param ?? media?.full_url ?? '').trim()
    // An item's TYPE is not an identity: a text item with no text, or a file item
    // with no pointer, must not manufacture one — we would then dedup two
    // genuinely different messages against each other.
    if (text || pointer) identifying = true
    parts.push(`${String(item?.type ?? '?')}:${text}:${pointer}`)
  }
  if (!identifying) return undefined
  return `${sender}|${parts.join('|')}`
}

/** Whether an iLink error tuple means the session went stale, not rate-limited. */
export function isStaleSessionRet(
  ret: number | undefined,
  errcode: number | undefined,
  errmsg: string | undefined,
): boolean {
  if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) return false
  return (errmsg ?? '').toLowerCase() === 'unknown error'
}

// ---------------------------------------------------------------------------
// Wire schemas + plain parsed types. Every wire field is optional (the server
// omits fields liberally); consumers read defensively with `?? fallback`.
// ---------------------------------------------------------------------------

/** A media reference inside an item (CDN query param + AES key). */
export interface WireMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
  [key: string]: unknown
}

/** One element of an inbound message's `item_list`. */
export interface WireItem {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string; media?: WireMedia }
  image_item?: { media?: WireMedia; aeskey?: string }
  video_item?: { media?: WireMedia }
  file_item?: { file_name?: string; media?: WireMedia }
  ref_msg?: { title?: string; message_item?: unknown }
  [key: string]: unknown
}

/** One inbound iLink message as delivered by getUpdates. */
export interface InboundMessage {
  from_user_id?: string
  to_user_id?: string
  message_id?: string
  msg_type?: number
  context_token?: string
  room_id?: string
  chat_room_id?: string
  item_list?: WireItem[]
  [key: string]: unknown
}

/** getUpdates response envelope. */
export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  get_updates_buf?: string
  longpolling_timeout_ms?: number
  msgs?: InboundMessage[]
  [key: string]: unknown
}

/** sendmessage response envelope. */
export interface SendMessageResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  [key: string]: unknown
}

/** get_bot_qrcode response. */
export interface QrCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
  [key: string]: unknown
}

/** get_qrcode_status response. */
export interface QrStatusResponse {
  status?: string
  redirect_host?: string
  ilink_bot_id?: string
  bot_token?: string
  baseurl?: string
  ilink_user_id?: string
  [key: string]: unknown
}

/** getconfig response (typing ticket). */
export interface GetConfigResponse {
  typing_ticket?: string
  [key: string]: unknown
}

/** Credentials produced by a successful QR login. */
export interface WechatCredentials {
  /** iLink bot account id (also the poller's own `from_user_id`). */
  accountId: string
  /** Bearer token for the bot session. */
  token: string
  /** Gateway base url (may be redirected to a regional host). */
  baseUrl: string
  /** The bot's own ilink user id when the server reports one. */
  userId?: string
}

/** QR login lifecycle statuses surfaced to a caller. */
export type QrLoginStatus = 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'
