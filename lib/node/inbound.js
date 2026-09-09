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
/** Prefix content handed to the model with the message send/receive time. */
function stampLine(content) {
    return `[发送于 ${sendStamp()}]\n${content}`;
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
 * Handle an image-only message: download + decrypt, persist to disk, then hand
 * the file path to the active agent so its `read_image`/vision tool can decode
 * it (the default model is text-only and reads images by path, not inline).
 */
async function handleInboundImage(node, sender, message) {
    const imageItem = extractImageItem(message);
    if (!imageItem)
        return;
    let downloaded;
    try {
        downloaded = await node.ctx.wechat.downloadImage(imageItem);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] image download failed from %s: %s', sender, error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, '❌ 图片下载失败，请重试。');
        return;
    }
    if (!downloaded)
        return;
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
    node.peerId = sender;
    const ready = await node.ensureWechatTarget();
    const agent = ready ? node.activeAgent() : undefined;
    if (!agent) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。');
        return;
    }
    // DeepSeek-OCR (SiliconFlow): when an apiKey is configured, recognize the
    // image right away and hand the text to the agent so it can answer what is
    // in the picture. OCR failures surface the reason to the user (not silent).
    let ocrText;
    if (node.config.ocrApiKey) {
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
    const ocrSection = ocrText?.trim()
        ? `\n\n【OCR 识别结果】\n${ocrText.trim()}`
        : '';
    const messageValue = createUserMessage({
        content: [{
                type: 'text',
                text: stampLine(`[微信图片] ${absPath}${ocrSection}`),
            }],
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
        content: [{ type: 'text', text: stampLine(`[语音转写]\n${transcribed.trim()}`) }],
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
    const found = extractAttachment(message);
    if (!found)
        return;
    node.peerId = sender;
    let downloaded;
    try {
        downloaded = await node.ctx.wechat.downloadAttachment(found.item);
    }
    catch (error) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] attachment download failed: %s', error instanceof Error ? error.message : String(error));
        await sendTextToPeer(node, kind === 'video' ? '❌ 视频下载失败，请重试。' : '❌ 文件下载失败，请重试。');
        return;
    }
    if (!downloaded)
        return;
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
        content: [{ type: 'text', text: stampLine(`${label} ${absPath}${nameNote}`) }],
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
        content: [{ type: 'text', text: stampLine(text) }],
        source: { kind: 'user' },
    });
    agent.followup(messageValue);
    await node.ctx.wechat.sendTyping(sender, 1).catch(() => { });
}
//# sourceMappingURL=inbound.js.map