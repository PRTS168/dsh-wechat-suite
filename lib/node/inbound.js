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
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ITEM_TEXT, ITEM_VOICE, ITEM_IMAGE, ITEM_FILE, ITEM_VIDEO } from "../gateway/types.js";
import { imageExt } from "../gateway/media.js";
import { ocrImage } from "./ocr.js";
import { transcribeSpeech } from "./stt.js";
import { routeCommand, routePickerReply } from "./commands.js";
import { sendTextToPeer } from "./outbound.js";
import { buildImageBlock, parseRoute, resolveImageDelivery, routeKey, } from "./vision.js";
/**
 * Local wall-clock stamp ("YYYY-MM-DD HH:mm") attached to inbound user
 * messages so the agent always knows when a message was sent — useful for
 * time-of-day questions, "just now" vs "yesterday" context and reminder
 * scheduling. Server-local time (the machine running the bridge).
 */
function sendStamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
/** Opening fence of one inbound user message handed to the model. */
export const USER_MESSAGE_OPEN = '<<<微信用户消息>>>';
/** Label inside the closing fence (the send time rides along with it). */
export const USER_MESSAGE_CLOSE = '微信用户消息结束';
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
export function wrapUserMessage(content, date = new Date()) {
    return `${USER_MESSAGE_OPEN}\n${content}\n<<<${USER_MESSAGE_CLOSE}｜发送于 ${sendStamp(date)}>>>`;
}
/** Wrap content handed to the model with the message send/receive time. */
function stampLine(content) {
    return wrapUserMessage(content);
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
function withHandoff(node, content) {
    const note = node.consumeHandoff();
    return note ? `${note}\n\n${content}` : content;
}
/** Whether a message is a group/room message (MVP: not supported). */
export function isGroupMessage(message, accountId) {
    const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim();
    if (roomId)
        return true;
    const toUserId = String(message.to_user_id ?? '').trim();
    const sender = String(message.from_user_id ?? '').trim();
    return Boolean(toUserId && accountId && toUserId !== accountId && message.msg_type === 1);
}
/** Extract the visible text of an inbound message (text + voice transcription). */
export function extractText(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    for (const item of items) {
        if (item?.type === ITEM_TEXT) {
            const text = String(item.text_item?.text ?? '');
            if (text.trim())
                return text;
        }
    }
    for (const item of items) {
        if (item?.type === ITEM_VOICE) {
            const voiceText = String(item.voice_item?.text ?? '');
            if (voiceText.trim()) {
                // WeChat supplied its own transcription (no downloadable audio in this
                // item); keep the voice origin visible so the model can distinguish it.
                return `[语音转写]\n${voiceText}`;
            }
        }
    }
    return '';
}
/** Whether the message carries a voice item with downloadable audio. */
function hasDownloadableVoice(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    return items.some((item) => item?.type === ITEM_VOICE && item.voice_item?.media && (item.voice_item.media.encrypt_query_param || item.voice_item.media.full_url));
}
/** First image item in a message, or null. */
function extractImageItem(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    for (const item of items) {
        if (item?.type === ITEM_IMAGE && item.image_item?.media)
            return item;
    }
    return null;
}
/** First downloadable file/video item in a message, or null. */
function extractAttachment(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    for (const item of items) {
        const media = item.file_item?.media ?? item.video_item?.media;
        if (media && (media.encrypt_query_param || media.full_url)) {
            return { item, kind: item.type === ITEM_VIDEO ? 'video' : 'file' };
        }
    }
    return null;
}
/** Directory inbound images are saved to (configurable, defaults under $DSH_HOME). */
function inboundMediaDir(node) {
    return node.config.mediaDir
        ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'attachments', 'wechat');
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
async function reportMediaFailure(node, kind, reason) {
    node.ctx.logger?.warn?.('[dsh-chatnode-wechat] %s inbound dropped: %s', kind, reason);
    const notice = {
        image: '❌ 图片下载失败，请重试。',
        file: '❌ 文件下载失败，请重试。',
        video: '❌ 视频下载失败，请重试。',
        unsupported: `❌ 这条消息暂时无法处理（${reason}）。`,
    };
    await sendTextToPeer(node, notice[kind]);
}
/**
 * Handle an image-only message: download + decrypt, persist to disk, then hand
 * the file path to the active agent so its `read_image`/vision tool can decode
 * it (the default model is text-only and reads images by path, not inline).
 */
async function handleInboundImage(node, sender, message) {
    const imageItem = extractImageItem(message);
    if (!imageItem)
        return;
    // The peer must be known BEFORE anything can fail: `sendTextToPeer` is a no-op
    // without a peer id, so a failure notice issued earlier simply vanished —
    // which is how "❌ 图片下载失败，请重试。" never reached anyone.
    node.peerId = sender;
    let downloaded;
    try {
        downloaded = await node.ctx.wechat.downloadImage(imageItem);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] image download failed from %s: %s', sender, error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, '❌ 图片下载失败，请重试。');
        return;
    }
    if (!downloaded) {
        await reportMediaFailure(node, 'image', 'downloadImage returned no bytes');
        return;
    }
    const dir = inboundMediaDir(node);
    try {
        await mkdir(dir, { recursive: true });
    }
    catch {
        // directory may already exist; writeFile below still reports real failures
    }
    const name = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${imageExt(downloaded.mediaType)}`;
    const absPath = join(dir, name);
    try {
        await writeFile(absPath, downloaded.bytes);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] image save failed: %s', error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, '❌ 图片保存失败，请重试。');
        return;
    }
    const ready = await node.ensureWechatTarget();
    const agent = ready ? node.activeAgent() : undefined;
    if (!agent) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。');
        return;
    }
    // How this picture reaches the model: a real image block for a multimodal
    // route, or DeepSeek-OCR text for a text-only one. `imageInput` picks the
    // policy; the routed model's own declared modalities decide the rest.
    const decision = await resolveImageDelivery({
        mode: node.imageInputMode(),
        llm: node.ctx.get('llm'),
        chatRoute: node.currentModelRoute(),
        configuredRoute: parseRoute(node.config.imageInputModel),
    });
    // An image-only message carries no text of its own, so give the model a line
    // to act on — otherwise a vision model sees a picture with no instruction.
    const userText = extractText(message).trim();
    const lead = userText || '（用户发来一张图片，没有附带文字）';
    let imageBlock;
    if (decision.mode === 'native' && decision.route) {
        try {
            imageBlock = await buildImageBlock(node.ctx.get('attachments'), { data: downloaded.bytes, mediaType: downloaded.mediaType, name });
            node.ctx.logger?.info?.('[dsh-chatnode-wechat] native image -> %s (%s)', routeKey(decision.route.provider, decision.route.model), decision.reason);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            node.ctx.logger?.warn?.('[dsh-chatnode-wechat] native image block failed, falling back to OCR: %s', reason);
            imageBlock = undefined;
        }
    }
    // OCR text path. Used when the policy says so, when the route cannot take
    // images, or when building the block above failed.
    let ocrText;
    if (imageBlock === undefined && node.config.ocrApiKey) {
        try {
            ocrText = await ocrImage({
                apiKey: node.config.ocrApiKey,
                model: node.config.ocrModel,
                baseUrl: node.config.ocrBaseUrl,
            }, downloaded.bytes);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            node.ctx.logger?.warn?.('[dsh-chatnode-wechat] DeepSeek-OCR failed: %s', reason);
            try {
                await appendFile(join(inboundMediaDir(node), 'ocr-error.log'), `${new Date().toISOString()} ${absPath}: ${reason}\n`);
            }
            catch {
                // best-effort
            }
            await sendTextToPeer(node, `⚠️ 图片已收到，但 OCR 识别失败：${reason.slice(0, 200)}`);
            ocrText = undefined;
        }
    }
    // Keep the on-disk path in both modes: the session log stays replayable and
    // the agent can re-read the file later (the model reads images by path when
    // its route cannot take inline ones).
    const ocrSection = ocrText?.trim()
        ? `\n\n【OCR 识别结果】\n${ocrText.trim()}`
        : '';
    const layoutNote = imageBlock
        ? ''
        : '\n\n【图片交付】当前模型未接收原生图片，以上为其磁盘路径（可用读图工具查看）。';
    const text = stampLine(withHandoff(node, `[微信图片] ${absPath}\n${lead}${ocrSection}${layoutNote}`));
    const content = imageBlock
        ? [{ type: 'text', text }, imageBlock]
        : [{ type: 'text', text }];
    const messageValue = createUserMessage({
        content,
        source: { kind: 'user' },
    });
    agent.followup(messageValue);
    await node.ctx.wechat.sendTyping(sender, 1).catch(() => { });
}
/**
 * Handle a voice message that carries downloadable audio (no WeChat-supplied
 * transcription): download → SiliconFlow ASR → hand `[语音转写]` text to the
 * agent. When STT is not configured, the note degrades to a short notice
 * instead of being silently dropped.
 */
async function handleInboundVoice(node, sender, message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    const voice = items.find((item) => item?.type === ITEM_VOICE && item.voice_item?.media);
    if (!voice)
        return;
    const apiKey = node.config.sttApiKey ?? node.config.ocrApiKey;
    if (!apiKey) {
        await sendTextToPeer(node, '🎙 收到语音，但未配置语音转写（sttApiKey）。');
        return;
    }
    node.peerId = sender;
    await sendTextToPeer(node, '🎙 正在听…');
    let bytes = null;
    try {
        bytes = await node.ctx.wechat.downloadVoice(voice);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] voice download failed: %s', error instanceof Error ? error.message : String(error));
    }
    if (!bytes || bytes.length === 0) {
        await sendTextToPeer(node, '❌ 语音下载失败，请重试。');
        return;
    }
    let transcribed = '';
    try {
        transcribed = await transcribeSpeech({ apiKey, model: node.config.sttModel }, bytes);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] ASR failed: %s', error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, `❌ 语音转写失败：${error instanceof Error ? error.message.slice(0, 150) : String(error)}`);
        return;
    }
    if (!transcribed.trim()) {
        await sendTextToPeer(node, '⚠️ 没听清内容，请再说一次？');
        return;
    }
    const ready = await node.ensureWechatTarget();
    const agent = ready ? node.activeAgent() : undefined;
    if (!agent) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。');
        return;
    }
    const messageValue = createUserMessage({
        content: [{ type: 'text', text: stampLine(withHandoff(node, `[语音转写]\n${transcribed.trim()}`)) }],
        source: { kind: 'user' },
    });
    agent.followup(messageValue);
    await node.ctx.wechat.sendTyping(sender, 1).catch(() => { });
}
/**
 * Handle a file/video message with downloadable media: decrypt → persist →
 * hand the path (plus the original file name when provided) to the agent.
 * Generic documents and mp4 clips can't be decoded by a text model, but the
 * bridge stores them under mediaDir so the agent (or a future tool) can reach
 * them; WeChat is told the file was received so the exchange feels complete.
 */
async function handleInboundFile(node, sender, message, kind) {
    // Set the peer FIRST: every failure below reports through sendTextToPeer,
    // which is a no-op when no peer is known.
    node.peerId = sender;
    const found = extractAttachment(message);
    if (!found) {
        // Called with no usable payload (an item whose media block is missing both
        // the encrypted query param and a plain URL). Nothing was downloaded and
        // nothing reached the model — say so instead of vanishing.
        await reportMediaFailure(node, kind, 'the item carries no downloadable media');
        return;
    }
    let downloaded;
    try {
        downloaded = await node.ctx.wechat.downloadAttachment(found.item);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] attachment download failed: %s', error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, kind === 'video' ? '❌ 视频下载失败，请重试。' : '❌ 文件下载失败，请重试。');
        return;
    }
    if (!downloaded) {
        await reportMediaFailure(node, kind, 'downloadAttachment returned no bytes');
        return;
    }
    const dir = inboundMediaDir(node);
    try {
        await mkdir(dir, { recursive: true });
    }
    catch {
        // directory may already exist; writeFile below still reports real failures
    }
    // Pick a safe on-disk extension: prefer the wire file name, else a default.
    const wireName = downloaded.fileName?.trim();
    const base = wireName
        ? wireName.split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_')
        : '';
    let ext = '';
    if (base) {
        const dot = base.lastIndexOf('.');
        if (dot > 0 && base.length - dot <= 10)
            ext = base.slice(dot);
    }
    if (!ext)
        ext = kind === 'video' ? '.mp4' : '.bin';
    const name = `wechat-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const absPath = join(dir, name);
    try {
        await writeFile(absPath, downloaded.bytes);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] attachment save failed: %s', error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, kind === 'video' ? '❌ 视频保存失败，请重试。' : '❌ 文件保存失败，请重试。');
        return;
    }
    const ready = await node.ensureWechatTarget();
    const agent = ready ? node.activeAgent() : undefined;
    if (!agent) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。');
        return;
    }
    const label = kind === 'video' ? '[微信视频]' : '[微信文件]';
    const nameNote = wireName ? `（${wireName}）` : '';
    const messageValue = createUserMessage({
        content: [{ type: 'text', text: stampLine(withHandoff(node, `${label} ${absPath}${nameNote}`)) }],
        source: { kind: 'user' },
    });
    agent.followup(messageValue);
    await node.ctx.wechat.sendTyping(sender, 1).catch(() => { });
}
/** Handle one inbound iLink message. */
export async function handleInbound(node, message) {
    const sender = String(message.from_user_id ?? '').trim();
    if (!sender)
        return;
    // ---- allowlist gate: the security boundary ------------------------------
    if (!node.isAllowed(sender)) {
        node.ctx.logger?.info?.('[dsh-chatnode-wechat] ignoring message from non-allowlisted sender %s (never fed to the model)', sender);
        return;
    }
    if (isGroupMessage(message, node.gatewayAccountId)) {
        node.ctx.logger?.info?.('[dsh-chatnode-wechat] ignoring group message from %s (MVP: no group support)', sender);
        return;
    }
    const text = extractText(message);
    if (!text.trim()) {
        // No usable text: prefer STT on a downloadable voice note, then images,
        // then file/video attachments.
        if (hasDownloadableVoice(message)) {
            await handleInboundVoice(node, sender, message);
            return;
        }
        if (extractImageItem(message)) {
            await handleInboundImage(node, sender, message);
            return;
        }
        const att = extractAttachment(message);
        if (att) {
            await handleInboundFile(node, sender, message, att.kind);
            return;
        }
        // Media-only message that yielded no usable payload: it carried items, but
        // none of them is a voice note, image, file or video this bridge can fetch.
        // Silence here is how a dropped message becomes invisible — so report the
        // item types on both planes instead (sticker/location/card messages land
        // here, and the reply tells the sender why nothing happened).
        const itemTypes = (Array.isArray(message.item_list) ? message.item_list : [])
            .map((item) => item?.type)
            .filter((type) => typeof type === 'number');
        if (itemTypes.length > 0) {
            // The peer is not known yet on this branch (the text path sets it later),
            // and sendTextToPeer is a no-op without one — set it before reporting.
            node.peerId = sender;
            await reportMediaFailure(node, 'unsupported', `类型 ${[...new Set(itemTypes)].join(', ')}`);
        }
        else {
            node.ctx.logger?.info?.('[dsh-chatnode-wechat] ignoring empty message from %s', sender);
        }
        return;
    }
    node.peerId = sender;
    // ---- local command handling ---------------------------------------------
    if (await routeCommand(node, text))
        return;
    // ---- two-step picker replies (/model, /perm): a bare number while a menu
    // is open selects that option and is never fed to the model.
    if (await routePickerReply(node, text))
        return;
    // ---- route to the active agent ------------------------------------------
    // The bridge must only ever talk to a WeChat session. A restart strands the
    // live agent, and a shared SessionStore with the Web GUI can leave the
    // bridge pointing at a web session — ensureWechatTarget corrects both.
    const ready = await node.ensureWechatTarget();
    const agent = ready ? node.activeAgent() : undefined;
    if (!agent) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。');
        return;
    }
    const messageValue = createUserMessage({
        content: [{ type: 'text', text: stampLine(withHandoff(node, text)) }],
        source: { kind: 'user' },
    });
    agent.followup(messageValue);
    await node.ctx.wechat.sendTyping(sender, 1).catch(() => { });
}
//# sourceMappingURL=inbound.js.map