/**
 * Inbound bridge: iLink messages → DSH conversation events.
 *
 * Policy enforced here (the security boundary of the bundle):
 * - only `allowFrom` senders are ever routed to the model; everyone else is
 *   logged and ignored (a prompt-injection front door otherwise);
 * - group messages are ignored in MVP (iLink bot identities usually cannot
 *   join ordinary groups anyway — see README risks);
 * - text is extracted from `text_item` (and `voice_item.text` transcription
 *   when WeChat supplied no downloadable audio);
 * - commands are handled locally; everything else becomes a user message on
 *   the active agent via `agent.followup`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/inbound
 */

import { writeFile, mkdir, appendFile } from 'node:fs/promises'
import { existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { ITEM_TEXT, ITEM_VOICE, ITEM_IMAGE, ITEM_VIDEO, type InboundMessage, type WireItem } from '../gateway/types.ts'
import { imageExt } from '../gateway/media.ts'
import { ocrImage } from './ocr.ts'
import { transcribeSpeech } from './stt.ts'
import type { WechatConversationNode } from './core.ts'
import { routeCommand, routePickerReply } from './commands.ts'
import { sendTextToPeer } from './outbound.ts'
import { isPlatformId, platformLabel, userFence, type ChatPlatform, type PlatformId } from '../platform/index.ts'
import {
  buildImageBlock,
  parseRoute,
  resolveImageDelivery,
  routeKey,
  type ImageAttachmentSaver,
  type LlmModelCatalog,
} from './vision.ts'

/**
 * Local wall-clock stamp ("YYYY-MM-DD HH:mm") attached to inbound user
 * messages so the agent always knows when a message was sent — useful for
 * time-of-day questions, "just now" vs "yesterday" context and reminder
 * scheduling. Server-local time (the machine running the bridge).
 */
function sendStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

/** Opening fence of one inbound user message handed to the model (WeChat wording). */
export const USER_MESSAGE_OPEN = userFence('wechat').open

/** Label inside the closing fence (the send time rides along with it). */
export const USER_MESSAGE_CLOSE = userFence('wechat').close

/** Re-exported from the platform seam: every platform's markers (readers accept all). */
export { USER_MESSAGE_CLOSE_ANY, USER_MESSAGE_OPEN_ANY } from '../platform/index.ts'

/**
 * Wrap content handed to the model in an explicit user-message fence.
 *
 * Why a fence instead of the old `[发送于 YYYY-MM-DD HH:mm]\n<text>` prefix line:
 * that prefix was a *speaker marker* in a chat-shaped transcript, so the model
 * autocompleted "the next speaker line" with it. On 2026-09-12 it wrote
 * `[发送于 2026-09-12 14:20] 视频呢？发个` INSIDE its own turn — an instruction the
 * user never sent, carrying a timestamp 80 seconds in the future — and then
 * obeyed it, creating and sending a video nobody had asked for.
 *
 * A delimited block does not look like the next turn, and moving the time to the
 * CLOSING marker leaves a fabricated user turn with no leading pattern to
 * continue. The persona preset carries the matching hard rules (only the last
 * real user message is an instruction; a future-stamped or self-written "user
 * message" never is).
 */
export function wrapUserMessage(content: string, date = new Date(), platform: PlatformId = 'wechat'): string {
  const fence = userFence(platform)
  return `${fence.open}\n${content}\n<<<${fence.close}｜发送于 ${sendStamp(date)}>>>`
}

/**
 * Build the model-facing text for one inbound message: the long-term memory
 * briefing (when one is due) OUTSIDE the user fence, then the envelope itself.
 *
 * The briefing stays outside deliberately — the persona's hard rule is that only
 * fenced content counts as a user message, so background facts must not ride
 * inside it.
 *
 * `platform` is the **source** channel of this message, not the node's primary:
 * the fence is how the model (and the persona's rules) can tell which channel the
 * owner is speaking from.
 */
function wrapForModel(node: WechatConversationNode, content: string, platform: PlatformId): string {
  // 记忆简报走的是同一条"用户消息之前附背景块"的路，不另开注入通道。
  const brief = node.memoryPreamble()
  const wrapped = wrapUserMessage(content, new Date(), platform)
  // 渠道与能力告知（放在围栏外，和记忆简报同一位置：它是背景事实，不是主人的话）。
  return [brief, channelNotice(node, platform), wrapped].filter(Boolean).join('\n\n')
}

/**
 * 告诉模型这条消息来自哪条渠道、该渠道**能不能收图片/语音**。
 *
 * 两条渠道的能力并不一样（QQ 官方接口现在还发不了图片与语音）。不说明的话，模型会照着
 * 微信那边的成功经验去发图，然后撞墙；而"撞墙"的表现是一句英文报错，从主人那边看就是
 * "它突然不会发图了"。
 *
 * 只描述事实，不下命令：真正的拦截在工具侧（目标平台不支持时在生成之前拒绝），
 * 这里只是让它**不用白跑一趟**。
 */
function channelNotice(node: WechatConversationNode, platform: PlatformId): string {
  const label = platformLabel(platform)
  const caps = node.capabilitiesFor(platform)
  const lacks: string[] = []
  if (caps?.media === false) lacks.push('图片与文件')
  if (caps?.voice === false) lacks.push('语音')
  const total = node.platforms?.length ?? 1
  if (lacks.length === 0) {
    // 单平台时连这一行都不加：保持微信侧输出与从前逐字一致。
    return total > 1 ? `【这条来自 ${label}】` : ''
  }
  return `【这条来自 ${label}；${label} 目前收不到${lacks.join('、')}，别用发图/语音工具，改用文字或链接】`
}

/**
 * Attach a pending rotation handoff (once) in front of an inbound message.
 *
 * The note was never meant to be its own turn: submitting it as the new session's
 * prompt made the agent answer the rotation itself (a fresh-session greeting). It now
 * rides on the owner's next message instead — one turn, no extra bubble — and it
 * keeps its own fence, so the persona's hard rules still treat it as background
 * rather than as an instruction.
 */
function withHandoff(node: WechatConversationNode, content: string): string {
  const note = node.consumeHandoff()
  return note ? `${note}\n\n${content}` : content
}

/**
 * Whether a message is a group/room message (MVP: not supported).
 *
 * `accountId` must be the **receiving** channel's own id (see
 * `gatewayAccountOn`): the test is "the message was addressed to somebody other
 * than the account that got it", and passing another platform's id turns every
 * message of the second channel into a "group" message that is dropped in
 * silence.
 */
export function isGroupMessage(message: InboundMessage, accountId: string): boolean {
  const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim()
  if (roomId) return true
  const toUserId = String(message.to_user_id ?? '').trim()
  return Boolean(toUserId && accountId && toUserId !== accountId && message.msg_type === 1)
}

// ---------------------------------------------------------------------------
// Source-platform plumbing
//
// The three helpers below are the seam between "a message arrived on platform P"
// and the node's per-platform bookkeeping. Each checks for the real node's method
// before using it: the media tests drive this module with a light stand-in that
// has only the single-platform surface (`peerId`, `chat`, `isAllowed`), and a
// missing method must degrade to the single-platform behaviour, never crash the
// one path whose whole job is to answer.
// ---------------------------------------------------------------------------

/** Whether a sender may drive the agent on the platform the message arrived on. */
function isAllowedOn(node: WechatConversationNode, platform: PlatformId, sender: string): boolean {
  if (typeof node.isAllowedFor === 'function') return node.isAllowedFor(platform, sender)
  return node.isAllowed(sender)
}

/** The gateway the message arrived on — downloads go through **that** one. */
function chatOn(node: WechatConversationNode, platform: PlatformId): ChatPlatform | undefined {
  if (typeof node.chatFor === 'function') return node.chatFor(platform)
  return node.chat
}

/**
 * The account id of the platform this message arrived on, for group detection.
 *
 * It must be the source channel's own id: a QQ message carries the QQ AppID in
 * `to_user_id`, and comparing that against WeChat's account id would classify
 * every QQ single-chat message as a group message and drop it without a word.
 */
function gatewayAccountOn(node: WechatConversationNode, platform: PlatformId): string {
  if (typeof node.gatewayAccountIdFor === 'function') return node.gatewayAccountIdFor(platform)
  return node.gatewayAccountId
}

/** Remember where this message came from (see `core.noteInboundTarget`). */
function noteInbound(node: WechatConversationNode, platform: PlatformId, sender: string): void {
  if (typeof node.noteInboundTarget === 'function') node.noteInboundTarget(platform, sender)
  else node.peerId = sender
}

/**
 * Hand one inbound message to the agent, binding its platform as the outbound
 * target of the turn that starts here.
 *
 * A turn's replies are asynchronous, so the binding must happen exactly when the
 * turn starts and be released at `turn/end`. If submitting throws, the binding is
 * taken back: that turn never started, so nothing would ever release it, and the
 * stale head would answer the *next* message on the wrong channel.
 */
function submitTurn(
  node: WechatConversationNode,
  platform: PlatformId,
  sender: string,
  submit: () => void,
): void {
  const tracked = typeof node.beginTurnTarget === 'function'
  if (tracked) node.beginTurnTarget(platform, sender)
  try {
    submit()
  } catch (error) {
    if (tracked) node.dropTurnTarget()
    throw error
  }
}

/** Extract the visible text of an inbound message (text + voice transcription). */
export function extractText(message: InboundMessage): string {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? '')
      if (text.trim()) return text
    }
  }
  for (const item of items) {
    if (item?.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText.trim()) {
        // WeChat supplied its own transcription (no downloadable audio in this
        // item); keep the voice origin visible so the model can distinguish it.
        return `[语音转写]\n${voiceText}`
      }
    }
  }
  return ''
}

/** Whether the message carries a voice item with downloadable audio. */
function hasDownloadableVoice(message: InboundMessage): boolean {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  return items.some((item) => item?.type === ITEM_VOICE && item.voice_item?.media && (item.voice_item.media.encrypt_query_param || item.voice_item.media.full_url))
}

/** First image item in a message, or null. */
function extractImageItem(message: InboundMessage): WireItem | null {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === ITEM_IMAGE && item.image_item?.media) return item
  }
  return null
}

/** First downloadable file/video item in a message, or null. */
function extractAttachment(message: InboundMessage): { item: WireItem; kind: 'file' | 'video' } | null {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    const media = item.file_item?.media ?? item.video_item?.media
    if (media && (media.encrypt_query_param || media.full_url)) {
      return { item, kind: item.type === ITEM_VIDEO ? 'video' : 'file' }
    }
  }
  return null
}

/** Directory inbound media is saved to (configurable, defaults under $DSH_HOME).
 *  Namespaced by the **source** platform: with both channels mounted, WeChat
 *  pictures and QQ pictures stay in separate drawers. */
function inboundMediaDir(node: WechatConversationNode, platform: PlatformId): string {
  return node.config.mediaDir
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'attachments', platform)
}

/** Rotate the OCR diagnostics past this size, keeping one previous file. */
export const OCR_LOG_LIMIT_BYTES = 256 * 1024

/** Rename a log aside once it passes the cap, keeping one previous file. */
function rotateIfLarge(path: string, limit: number): void {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < limit) return
    renameSync(path, `${path}.1`)
  } catch {
    // A failed rotation must not stop the write that follows.
  }
}

/**
 * Report a dropped inbound media message on BOTH planes: a host log line for
 * whoever operates the bridge, and a WeChat line for whoever sent it.
 *
 * Why this exists: the download paths used to `return` silently when the gateway
 * produced no bytes — nothing on disk, nothing in the log, nothing in the chat.
 * That is indistinguishable from "the message never arrived", and it is exactly
 * the gap that made a fabricated "inbound video failed to land" report
 * impossible to refute from the outside. Every failure that drops media now
 * says so, in the log and in the conversation.
 */
async function reportMediaFailure(
  node: WechatConversationNode,
  kind: 'image' | 'file' | 'video' | 'unsupported',
  reason: string,
): Promise<void> {
  node.ctx.logger?.warn?.('[dsh-chatnode-wechat] %s inbound dropped: %s', kind, reason)
  // 上面那句注释写的是"两个平面"，但本宿主的 logger 落不到任何能事后翻看的文件 ——
  // 于是少了台账这一面：单条失败用户还能看到一句"请重试"，而"最近所有图片都没进来"
  // 这种批量故障在 /problems 与管理台诊断页上完全看不出来，运维无从判断。
  // （可选访问只为测试替身：真实节点的 problems 在构造时就必然存在。）
  node.problems?.report(`inbound/${kind}`, new Error(reason), { notify: false, detail: 'media dropped' })
  const notice: Record<'image' | 'file' | 'video' | 'unsupported', string> = {
    image: '❌ 图片下载失败，请重试。',
    file: '❌ 文件下载失败，请重试。',
    video: '❌ 视频下载失败，请重试。',
    unsupported: `❌ 这条消息暂时无法处理（${reason}）。`,
  }
  await sendTextToPeer(node, notice[kind])
}

/**
 * Handle an image-only message: download + decrypt, persist to disk, then hand
 * the file path to the active agent so its `read_image`/vision tool can decode
 * it (the default model is text-only and reads images by path, not inline).
 */
async function handleInboundImage(
  node: WechatConversationNode,
  platform: PlatformId,
  sender: string,
  message: InboundMessage,
): Promise<void> {
  const imageItem = extractImageItem(message)
  if (!imageItem) return

  // The peer must be known BEFORE anything can fail: `sendTextToPeer` resolves
  // its destination from the node, and a failure notice issued earlier simply
  // vanished — which is how "❌ 图片下载失败，请重试。" never reached anyone.
  noteInbound(node, platform, sender)

  let downloaded: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' } | null
  try {
    downloaded = (await chatOn(node, platform)?.downloadImage(imageItem)) ?? null
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] image download failed from %s: %s',
      sender, error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, '❌ 图片下载失败，请重试。')
    return
  }
  if (!downloaded) {
    await reportMediaFailure(node, 'image', 'downloadImage returned no bytes')
    return
  }

  const dir = inboundMediaDir(node, platform)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // directory may already exist; writeFile below still reports real failures
  }
  const name = `${platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${imageExt(downloaded.mediaType)}`
  const absPath = join(dir, name)
  try {
    await writeFile(absPath, downloaded.bytes)
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] image save failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, '❌ 图片保存失败，请重试。')
    return
  }

  const ready = await node.ensureWechatTarget()
  const agent = ready ? node.activeAgent() : undefined
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }

  // How this picture reaches the model: a real image block for a multimodal
  // route, or DeepSeek-OCR text for a text-only one. `imageInput` picks the
  // policy; the routed model's own declared modalities decide the rest.
  const decision = await resolveImageDelivery({
    mode: node.imageInputMode(),
    llm: node.ctx.get('llm') as LlmModelCatalog | undefined,
    chatRoute: node.currentModelRoute(),
    configuredRoute: parseRoute(node.config.imageInputModel),
    // A vision route that cannot be listed must not look like one that has no
    // image support.
    onProblem: (kind, error, detail) => node.problems.report(kind, error, detail === undefined ? { notify: false } : { notify: false, detail }),
  })

  // An image-only message carries no text of its own, so give the model a line
  // to act on — otherwise a vision model sees a picture with no instruction.
  const userText = extractText(message).trim()
  const lead = userText || '（用户发来一张图片，没有附带文字）'

  let imageBlock: ContentBlock | undefined
  if (decision.mode === 'native' && decision.route) {
    try {
      imageBlock = await buildImageBlock(
        node.ctx.get('attachments') as ImageAttachmentSaver | undefined,
        { data: downloaded.bytes, mediaType: downloaded.mediaType, name },
      )
      node.ctx.logger?.info?.('[dsh-chatnode-wechat] native image -> %s (%s)', routeKey(decision.route.provider, decision.route.model), decision.reason)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      node.ctx.logger?.warn?.('[dsh-chatnode-wechat] native image block failed, falling back to OCR: %s', reason)
      imageBlock = undefined
    }
  }

  // OCR text path. Used when the policy says so, when the route cannot take
  // images, or when building the block above failed.
  let ocrText: string | undefined
  if (imageBlock === undefined && node.config.ocrApiKey) {
    try {
      ocrText = await ocrImage(
        {
          apiKey: node.config.ocrApiKey,
          model: node.config.ocrModel,
          baseUrl: node.config.ocrBaseUrl,
        },
        downloaded.bytes,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      node.ctx.logger?.warn?.('[dsh-chatnode-wechat] DeepSeek-OCR failed: %s', reason)
      node.problems.report('inbound/ocr', error, { notify: false, detail: `image=${absPath}` })
      try {
        const log = join(inboundMediaDir(node, platform), 'ocr-error.log')
        rotateIfLarge(log, OCR_LOG_LIMIT_BYTES)
        await appendFile(log, `${new Date().toISOString()} ${absPath}: ${reason}\n`)
      } catch {
        // best-effort
      }
      await sendTextToPeer(node, `⚠️ 图片已收到，但 OCR 识别失败：${reason.slice(0, 200)}`)
      ocrText = undefined
    }
  }

  // Keep the on-disk path in both modes: the session log stays replayable and
  // the agent can re-read the file later (the model reads images by path when
  // its route cannot take inline ones).
  const ocrSection = ocrText?.trim()
    ? `\n\n【OCR 识别结果】\n${ocrText.trim()}`
    : ''
  const layoutNote = imageBlock
    ? ''
    : '\n\n【图片交付】当前模型未接收原生图片，以上为其磁盘路径（可用读图工具查看）。'
  const text = wrapForModel(node, withHandoff(node, `[${platformLabel(platform)}图片] ${absPath}\n${lead}${ocrSection}${layoutNote}`), platform)

  const content: ContentBlock[] = imageBlock
    ? [{ type: 'text', text }, imageBlock]
    : [{ type: 'text', text }]

  const messageValue = createUserMessage({
    content,
    source: { kind: 'user' },
  })
  submitTurn(node, platform, sender, () => agent.followup(messageValue))
  await chatOn(node, platform)?.sendTyping(sender, 1).catch(() => {})
}

/**
 * Handle a voice message that carries downloadable audio (no WeChat-supplied
 * transcription): download → SiliconFlow ASR → hand `[语音转写]` text to the
 * agent. When STT is not configured, the note degrades to a short notice
 * instead of being silently dropped.
 */
async function handleInboundVoice(
  node: WechatConversationNode,
  platform: PlatformId,
  sender: string,
  message: InboundMessage,
): Promise<void> {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  const voice = items.find((item) => item?.type === ITEM_VOICE && item.voice_item?.media)
  if (!voice) return

  const apiKey = node.config.sttApiKey ?? node.config.ocrApiKey
  if (!apiKey) {
    await sendTextToPeer(node, '🎙 收到语音，但未配置语音转写（sttApiKey）。')
    return
  }

  noteInbound(node, platform, sender)
  await sendTextToPeer(node, '🎙 正在听…')
  let bytes: Uint8Array | null = null
  try {
    bytes = (await chatOn(node, platform)?.downloadVoice(voice)) ?? null
  } catch (error) {
    node.ctx.logger?.warn?.('[dsh-chatnode-wechat] voice download failed: %s', error instanceof Error ? error.message : String(error))
  }
  if (!bytes || bytes.length === 0) {
    await sendTextToPeer(node, '❌ 语音下载失败，请重试。')
    return
  }

  let transcribed = ''
  try {
    transcribed = await transcribeSpeech(
      // One SiliconFlow-compatible base url for every media service, instead of
      // a hard-coded host per module: a self-hosted or mirrored endpoint that
      // OCR can reach should be reachable for ASR too.
      { apiKey, model: node.config.sttModel, baseUrl: node.config.ocrBaseUrl },
      bytes,
    )
  } catch (error) {
    node.ctx.logger?.warn?.('[dsh-chatnode-wechat] ASR failed: %s', error instanceof Error ? error.message : String(error))
    node.problems.report('inbound/voice', error, { detail: `sender=${sender}` })
    await sendTextToPeer(node, `❌ 语音转写失败：${error instanceof Error ? error.message.slice(0, 150) : String(error)}`)
    return
  }
  if (!transcribed.trim()) {
    await sendTextToPeer(node, '⚠️ 没听清内容，请再说一次？')
    return
  }

  const ready = await node.ensureWechatTarget()
  const agent = ready ? node.activeAgent() : undefined
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }
  const messageValue = createUserMessage({
    content: [{ type: 'text', text: wrapForModel(node, withHandoff(node, `[语音转写]\n${transcribed.trim()}`), platform) }],
    source: { kind: 'user' },
  })
  submitTurn(node, platform, sender, () => agent.followup(messageValue))
  await chatOn(node, platform)?.sendTyping(sender, 1).catch(() => {})
}

/**
 * Handle a file/video message with downloadable media: decrypt → persist →
 * hand the path (plus the original file name when provided) to the agent.
 * Generic documents and mp4 clips can't be decoded by a text model, but the
 * bridge stores them under mediaDir so the agent (or a future tool) can reach
 * them; WeChat is told the file was received so the exchange feels complete.
 */
async function handleInboundFile(
  node: WechatConversationNode,
  platform: PlatformId,
  sender: string,
  message: InboundMessage,
  kind: 'file' | 'video',
): Promise<void> {
  // Record the source FIRST: every failure below reports through sendTextToPeer,
  // which has no destination until the node knows who spoke.
  noteInbound(node, platform, sender)
  const found = extractAttachment(message)
  if (!found) {
    // Called with no usable payload (an item whose media block is missing both
    // the encrypted query param and a plain URL). Nothing was downloaded and
    // nothing reached the model — say so instead of vanishing.
    await reportMediaFailure(node, kind, 'the item carries no downloadable media')
    return
  }

  let downloaded: { bytes: Uint8Array; fileName?: string } | null
  try {
    downloaded = (await chatOn(node, platform)?.downloadAttachment(found.item)) ?? null
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] attachment download failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, kind === 'video' ? '❌ 视频下载失败，请重试。' : '❌ 文件下载失败，请重试。')
    return
  }
  if (!downloaded) {
    await reportMediaFailure(node, kind, 'downloadAttachment returned no bytes')
    return
  }

  const dir = inboundMediaDir(node, platform)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // directory may already exist; writeFile below still reports real failures
  }
  // Pick a safe on-disk extension: prefer the wire file name, else a default.
  const wireName = downloaded.fileName?.trim()
  const base = wireName
    ? wireName.split(/[\\/]/).pop()!.replace(/[^\w.\- ]+/g, '_')
    : ''
  let ext = ''
  if (base) {
    const dot = base.lastIndexOf('.')
    if (dot > 0 && base.length - dot <= 10) ext = base.slice(dot)
  }
  if (!ext) ext = kind === 'video' ? '.mp4' : '.bin'
  const name = `${platform}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  const absPath = join(dir, name)
  try {
    await writeFile(absPath, downloaded.bytes)
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] attachment save failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, kind === 'video' ? '❌ 视频保存失败，请重试。' : '❌ 文件保存失败，请重试。')
    return
  }

  const ready = await node.ensureWechatTarget()
  const agent = ready ? node.activeAgent() : undefined
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }
  const label = kind === 'video' ? `[${platformLabel(platform)}视频]` : `[${platformLabel(platform)}文件]`
  const nameNote = wireName ? `（${wireName}）` : ''
  const messageValue = createUserMessage({
    content: [{ type: 'text', text: wrapForModel(node, withHandoff(node, `${label} ${absPath}${nameNote}`), platform) }],
    source: { kind: 'user' },
  })
  submitTurn(node, platform, sender, () => agent.followup(messageValue))
  await chatOn(node, platform)?.sendTyping(sender, 1).catch(() => {})
}

/**
 * Handle one inbound message.
 *
 * `platform` is the channel it arrived on. A profile may mount both platforms and
 * passes each message's own id, so this one function decides everything
 * downstream: which allowlist to check, which fence to use, which gateway to
 * download from, and which platform the answer goes back to. It defaults to the
 * node's own platform, which is what a single-platform profile (and the older
 * tests that call it directly) always meant.
 */
export async function handleInbound(
  node: WechatConversationNode,
  message: InboundMessage,
  platform: PlatformId = node.platform,
): Promise<void> {
  const source: PlatformId = isPlatformId(platform) ? platform : 'wechat'
  const sender = String(message.from_user_id ?? '').trim()
  if (!sender) return

  // ---- allowlist gate: the security boundary ------------------------------
  if (!isAllowedOn(node, source, sender)) {
    // 与 QQ 侧同一姿态（见 src/qq/index.ts 的白名单分支）：非白名单投递**必须留痕**。
    // 这里曾经只写 ctx.logger，而本宿主的 logger 落不到任何能事后翻看的文件 —— 于是
    // allowFrom 里只要有一个过期 id（QQ 的 user_openid 是 per-AppID 的，绑定前必然
    // 过期一次），主人的每条消息都会被丢掉，台账却干干净净，从外面看与"网关死了"
    // 完全同形，而且会把人引去查网关 —— 真正的问题在配置。
    // 每个平台各有一份名单，所以要指出是哪一条渠道的名单挡了它。
    const where = node.platforms.length > 1 ? `${source} 的名单（allowFromByPlatform.${source} 或 allowFrom）` : 'allowFrom'
    node.problems.report('inbound/allowlist', new Error(
      `忽略了一条非白名单消息：sender=${sender}。若这是你自己，把这个 id 加进 ${where} 即可。`,
    ), { notify: false, detail: `platform=${source}` })
    node.ctx.logger?.info?.(
      '[dsh-chatnode-wechat] ignoring non-allowlisted %s message from %s (never fed to the model)',
      source,
      sender,
    )
    return
  }
  if (isGroupMessage(message, gatewayAccountOn(node, source))) {
    node.ctx.logger?.info?.(
      '[dsh-chatnode-wechat] ignoring %s group message from %s (MVP: no group support)',
      source,
      sender,
    )
    return
  }

  const text = extractText(message)
  if (!text.trim()) {
    // No usable text: prefer STT on a downloadable voice note, then images,
    // then file/video attachments.
    if (hasDownloadableVoice(message)) {
      await handleInboundVoice(node, source, sender, message)
      return
    }
    if (extractImageItem(message)) {
      await handleInboundImage(node, source, sender, message)
      return
    }
    const att = extractAttachment(message)
    if (att) {
      await handleInboundFile(node, source, sender, message, att.kind)
      return
    }
    // Media-only message that yielded no usable payload: it carried items, but
    // none of them is a voice note, image, file or video this bridge can fetch.
    // Silence here is how a dropped message becomes invisible — so report the
    // item types on both planes instead (sticker/location/card messages land
    // here, and the reply tells the sender why nothing happened).
    const itemTypes = (Array.isArray(message.item_list) ? message.item_list : [])
      .map((item) => item?.type)
      .filter((type): type is number => typeof type === 'number')
    if (itemTypes.length > 0) {
      // Nothing before this point recorded who spoke, and the notice below has
      // no destination without a peer — record it before reporting.
      noteInbound(node, source, sender)
      await reportMediaFailure(node, 'unsupported', `类型 ${[...new Set(itemTypes)].join(', ')}`)
    } else {
      node.ctx.logger?.info?.('[dsh-chatnode-wechat] ignoring empty message from %s', sender)
    }
    return
  }

  noteInbound(node, source, sender)

  // ---- local command handling ---------------------------------------------
  if (await routeCommand(node, text)) return

  // ---- two-step picker replies (/model, /perm): a bare number while a menu
  // is open selects that option and is never fed to the model.
  if (await routePickerReply(node, text)) return

  // ---- route to the active agent ------------------------------------------
  // The bridge must only ever talk to a WeChat session. A restart strands the
  // live agent, and a shared SessionStore with the Web GUI can leave the
  // bridge pointing at a web session — ensureWechatTarget corrects both.
  const ready = await node.ensureWechatTarget()
  const agent = ready ? node.activeAgent() : undefined
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }

  const messageValue = createUserMessage({
    content: [{ type: 'text', text: wrapForModel(node, withHandoff(node, text), source) }],
    source: { kind: 'user' },
  })
  submitTurn(node, source, sender, () => agent.followup(messageValue))
  await chatOn(node, source)?.sendTyping(sender, 1).catch(() => {})
}
