/**
 * Outbound bridge: session events → WeChat messages.
 *
 * The conversation node never mirrors every tool call. It emits a small
 * digest vocabulary from the append-only session log:
 *
 * - task started   (`user/message` / `turn/start`)
 * - heartbeat      (one line every `digestIntervalSec` while a turn is open)
 * - assistant text (`assistant/message` — the real payload, chunked)
 * - finished/error (`turn/end`)
 *
 * Long assistant text is chunked to WeChat bubble size (2000 chars) with a
 * throttle between bubbles, mirroring the hermes-agent reference splitting.
 *
 * @module @dsh-cowork/chatnode-wechat/node/outbound
 */
import { MAX_MESSAGE_CHARS } from "../gateway/types.js";
import { sessionBadge } from "./labels.js";
// ---------------------------------------------------------------------------
// Chunking (port of hermes-agent `_split_text_for_weixin_delivery`, compact)
// ---------------------------------------------------------------------------
const FENCE_RE = /^```([^\n`]*)\s*$/;
/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export function normalizeMarkdownBlocks(content) {
    const lines = content.split('\n');
    const out = [];
    let blankRun = 0;
    let inCode = false;
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (FENCE_RE.test(line.trim())) {
            inCode = !inCode;
            out.push(line);
            blankRun = 0;
            continue;
        }
        if (inCode) {
            out.push(line);
            continue;
        }
        if (!line.trim()) {
            blankRun += 1;
            if (blankRun <= 1)
                out.push('');
            continue;
        }
        blankRun = 0;
        out.push(line);
    }
    return out.join('\n').trim();
}
/** Split content into markdown blocks, keeping fenced code blocks intact. */
export function splitMarkdownBlocks(content) {
    const blocks = [];
    let current = [];
    let inCode = false;
    const flush = () => {
        const block = current.join('\n').trim();
        if (block)
            blocks.push(block);
        current = [];
    };
    for (const raw of content.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (FENCE_RE.test(line.trim())) {
            if (!inCode && current.length)
                flush();
            current.push(line);
            inCode = !inCode;
            if (!inCode)
                flush();
            continue;
        }
        if (inCode) {
            current.push(line);
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();
    return blocks;
}
/** Split one oversized block into ≤max chunks (hard-truncating the tail). */
function hardSplit(text, max) {
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
        chunks.push(rest.slice(0, max));
        rest = rest.slice(max);
    }
    if (rest)
        chunks.push(rest);
    return chunks;
}
/** Greedy-pack markdown blocks into ≤max units. */
function packBlocks(blocks, max) {
    const units = [];
    let current = '';
    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= max) {
            current = candidate;
            continue;
        }
        if (current)
            units.push(current);
        if (block.length <= max) {
            current = block;
        }
        else {
            units.push(...hardSplit(block, max));
            current = '';
        }
    }
    if (current)
        units.push(current);
    return units;
}
/** Whether a block reads as a short chatty exchange worth separate bubbles. */
function shouldSplitShortChat(block) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2 || lines.length > 6)
        return false;
    if (lines[0].length <= 24 && /[:：]$/.test(lines[0].trim()))
        return false;
    return lines.every((l) => {
        const s = l.trim();
        if (!s)
            return false;
        if (s.length > 48)
            return false;
        if (s.startsWith(' ') || s.startsWith('\t'))
            return false;
        if (/^[>#*\-|【]/.test(s))
            return false;
        return true;
    });
}
/** Split assistant text into WeChat delivery units (≤max each). */
export function splitForWechat(content, max = MAX_MESSAGE_CHARS) {
    const normalized = normalizeMarkdownBlocks(content);
    if (!normalized)
        return [];
    if (normalized.length <= max) {
        if (shouldSplitShortChat(normalized)) {
            const units = splitMarkdownBlocks(normalized);
            return units.filter((u) => u.length <= max);
        }
        return [normalized];
    }
    return packBlocks(splitMarkdownBlocks(normalized), max);
}
/** Extract the visible text of an assistant message. */
export function textOfAssistantMessage(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
// ---------------------------------------------------------------------------
// Digest summary
// ---------------------------------------------------------------------------
/** One-line progress summary derived from the session log (cheap, replayable). */
export function digestLine(session, badge) {
    let turn = 0;
    let tools = 0;
    let lastTool;
    let inTurn = false;
    // `session.events` 在 DSH 0.1.5 被移除，改用全量不可变快照。
    for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') {
            turn = event.data.turn;
            inTurn = true;
            tools = 0;
            lastTool = undefined;
        }
        else if (event.type === 'turn/end') {
            inTurn = false;
        }
        else if (event.type === 'tool/call' && inTurn) {
            tools += 1;
            lastTool = event.data.name;
        }
    }
    const steps = tools > 0 ? `${tools} 个工具调用` : '思考中';
    const last = lastTool ? ` · 最近: ${lastTool}` : '';
    const prefix = badge ? `${badge} ` : '';
    return `${prefix}🔄 仍在处理中…（第 ${turn} 轮 · ${steps}${last}）`;
}
// ---------------------------------------------------------------------------
// Markdown → WeChat plain text
// ---------------------------------------------------------------------------
/** Convert markdown (model output) into a WeChat-friendly plain rendering.
 *  WeChat renders no markdown, so fences, emphasis markers, table pipes, and
 *  ATX headings would show as raw punctuation. This strips the syntax while
 *  keeping readable structure: code becomes an indented block, tables become
 *  aligned rows, headings get blank-line separation, and inline emphasis /
 *  code / links lose their markers.
 */
export function markdownToWechat(content) {
    const lines = content.split('\n');
    const out = [];
    let inFence = false;
    let fenceLang = '';
    let inTable = false;
    let tableSep = false;
    const pushTableRow = (row) => {
        const cells = row.map((c) => c.trim());
        out.push(cells.join(' | '));
    };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        const trimmed = line.trim();
        // Code fence toggling.
        const fenceMatch = /^```(.*)$/.exec(trimmed);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                fenceLang = fenceMatch[1].trim();
                out.push('');
                if (fenceLang)
                    out.push(`【${fenceLang}】`);
            }
            else {
                inFence = false;
                out.push('');
            }
            continue;
        }
        if (inFence) {
            out.push(`    ${line}`); // indent code for visual grouping
            continue;
        }
        // Table detection: a header row then a separator row of | --- |.
        const cellRow = trimmed.split('|');
        const looksLikeSep = /^:?-{2,}:?$/.test(cellRow.map((c) => c.trim()).join('|'));
        if (trimmed.startsWith('|') && trimmed.endsWith('|') && !looksLikeSep && cellRow.length >= 3) {
            if (!inTable) {
                inTable = true;
                tableSep = false;
                pushTableRow(cellRow.slice(1, -1));
            }
            else if (!tableSep) {
                tableSep = true; // skip the |---|---| separator row
            }
            else {
                pushTableRow(cellRow.slice(1, -1));
            }
            continue;
        }
        if (inTable) {
            inTable = false;
            tableSep = false;
            out.push('');
        }
        // Headings → blank-line separated bold-ish line.
        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
            if (out.length && out[out.length - 1] !== '')
                out.push('');
            const title = stripInline(heading[2]);
            out.push(`【${title}】`);
            out.push('');
            continue;
        }
        // Horizontal rule.
        if (/^(\s*([-*_])\s*){3,}$/.test(trimmed)) {
            out.push('—'.repeat(18));
            continue;
        }
        // Blockquote.
        if (trimmed.startsWith('>')) {
            out.push(stripInline(trimmed.replace(/^>\s?/, '')));
            continue;
        }
        // List items and everything else: strip inline marks, keep line.
        out.push(stripInline(line));
    }
    if (inTable)
        out.push('');
    // Collapse 3+ blank lines to one; strip lead/trail blanks.
    const result = [];
    let blank = 0;
    for (const l of out) {
        if (!l.trim()) {
            blank += 1;
            if (blank > 1)
                continue;
        }
        else {
            blank = 0;
        }
        result.push(l);
    }
    while (result.length && !result[result.length - 1].trim())
        result.pop();
    return result.join('\n').trim();
}
/** Strip inline markdown from one line: emphasis, code, links, images. */
function stripInline(line) {
    let s = line;
    // [text](url) → text (url) ; ![alt](url) → 图片: alt
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => `[图片: ${alt}]`);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        return url === text ? text : `${text}（${url}）`;
    });
    // **bold** / __bold__ → bold ; *italic* / _italic_ → italic ; ~~strike~~ → text
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');
    // *italic* / _italic_ → italic — tolerate following CJK punctuation
    // （、。，！？…) that a trailing `(?=\s|$)` would miss. Guard against
    // glob-ish `a*b*c`: require the content to be non-space and the opener not
    // preceded by an alphanumeric (so `x*y` stays put).
    s = s.replace(/(^|[^\w])\*([^\s*][^*\n]*)\*(?!\*)/g, '$1$2');
    s = s.replace(/(^|[^\w])_([^\s_][^_\n]*)_(?!_)/g, '$1$2');
    // inline code `x` → x
    s = s.replace(/`([^`]+)`/g, '$1');
    // leading list markers stay (readable in chat)
    return s;
}
// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
/**
 * Send text to the current peer, chunked and throttled.
 *
 * This is the single choke point for outbound chat traffic, and it is called
 * from eight places as `void sendTextToPeer(...)`. It therefore must NEVER
 * reject: a rejection from a fire-and-forget call is an unhandled rejection, and
 * the host treats those as fatal load failures (2026-09-12: a live patch reload
 * tore the scope down mid-await and "cannot get required service wechat in
 * inactive context" took the whole harness down into safe mode).
 *
 * So the service is read through `ctx.get()` — property access throws on a
 * torn-down context, `get()` returns undefined — and every remaining failure is
 * swallowed after a best-effort log.
 */
export async function sendTextToPeer(node, text) {
    const peer = node.peerId;
    if (!peer) {
        // No peer yet (nothing inbound since boot): a rotation notice or an admin
        // announcement goes nowhere. Recorded without bothering anyone, because
        // there is literally nobody to bother.
        node.problems.report('outbound', new Error('还没有收到过消息，这条没地方发'), { notify: false });
        return false;
    }
    const chunks = splitForWechat(text, node.config.maxMessageChars);
    if (chunks.length === 0)
        return false;
    let wechat;
    try {
        wechat = node.ctx.get('wechat');
    }
    catch (error) {
        node.problems.report('outbound', error, { notify: false });
        return false;
    }
    if (!wechat) {
        node.problems.report('outbound', new Error('网关服务不可用，消息发不出去'), { notify: false });
        return false;
    }
    let delivered = true;
    try {
        await wechat.sendTyping(peer, 1).catch(() => { });
        for (let i = 0; i < chunks.length; i++) {
            const result = await wechat.sendText(peer, chunks[i]);
            if (!result.success) {
                logQuietly(node, '[dsh-chatnode-wechat] outbound chunk %d/%d failed: %s', i + 1, chunks.length, result.error);
                // The owner is waiting for this bubble. If it did not go out he must be
                // able to find out why — silence here is indistinguishable from being
                // ignored.
                node.problems.report('outbound', new Error(result.error ?? 'sendText returned success=false'), {
                    detail: `chunk=${i + 1}/${chunks.length}`,
                });
                delivered = false;
                break;
            }
            if (i < chunks.length - 1 && node.config.sendChunkDelayMs > 0) {
                await sleep(node.config.sendChunkDelayMs);
            }
        }
    }
    catch (error) {
        logQuietly(node, '[dsh-chatnode-wechat] outbound send failed: %s', error instanceof Error ? error.message : String(error));
        node.problems.report('outbound', error);
        delivered = false;
    }
    finally {
        await wechat.sendTyping(peer, 2).catch(() => { });
    }
    return delivered;
}
/** Best-effort logging that cannot throw (the context may already be gone). */
function logQuietly(node, template, ...args) {
    try {
        node.ctx.get('logger')?.warn?.(template, ...args);
    }
    catch {
        // Nothing to log to; the caller is already handling a dead context.
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session, so switching sessions mid-flight is
 * safe (per-session digest state is keyed by session id).
 */
export function attachSessionOutbound(node) {
    const digestState = new Map();
    const stopHeartbeat = (state) => {
        if (state.heartbeat) {
            clearInterval(state.heartbeat);
            state.heartbeat = undefined;
        }
        state.heartbeating = false;
    };
    const startHeartbeat = (session, state) => {
        stopHeartbeat(state);
        if (node.config.digestIntervalSec <= 0)
            return false;
        state.heartbeat = setInterval(() => {
            void sendTextToPeer(node, digestLine(session, sessionBadge(node, session)));
        }, node.config.digestIntervalSec * 1000);
        state.heartbeat.unref?.();
        return true;
    };
    const isActive = (session) => String(session.id) === String(node.activeSessionId ?? '');
    /**
     * A session that is no longer the active one must still have its heartbeat
     * torn down.
     *
     * The active-session filter below returns early, and the old code returned
     * before reaching `turn/end` — so every `/new`, `/use` or admin switch left
     * behind a live interval pushing "🔄 仍在处理中" into WeChat forever. The
     * interval is keyed by session, so it can be stopped without knowing which
     * session is active now.
     */
    const retireIfAbandoned = (session) => {
        if (isActive(session))
            return;
        const state = digestState.get(session.id);
        if (state?.heartbeating) {
            stopHeartbeat(state);
            node.problems.report('outbound/heartbeat', new Error('会话已被切换，已停止它的心跳推送'), {
                notify: false,
                detail: `session=${String(session.id)}`,
            });
        }
    };
    const onEvent = (session, event) => {
        // Only ever bridge WeChat sessions: the host process runs the Web GUI
        // against the same SessionStore, and without this guard a web session's
        // events (matching an accidentally-web activeSessionId) would be pushed
        // to the WeChat peer.
        if (!String(session.id).startsWith('wechat-'))
            return;
        if (event.type === 'turn/end')
            retireIfAbandoned(session);
        if (!isActive(session)) {
            // An answer produced after the conversation moved on has nowhere to go.
            // Saying nothing about it is how "the assistant ignored me" happens with
            // no trace at all, so it is recorded (without bothering the owner: he is
            // the one who switched).
            if (event.type === 'assistant/message' && textOfAssistantMessage(event.data.message).trim()) {
                node.problems.report('outbound/abandoned', new Error('会话已切换，这条回复没有送达'), {
                    notify: false,
                    detail: `session=${String(session.id)}`,
                });
            }
            return;
        }
        const state = digestState.get(session.id) ?? { startedTurns: new Set(), heartbeating: false, sawText: false };
        digestState.set(session.id, state);
        if (event.type === 'turn/start') {
            const turn = event.data.turn;
            if (!state.startedTurns.has(turn)) {
                state.startedTurns.add(turn);
                // Bounded: a long-lived session starts a turn per message.
                if (state.startedTurns.size > 256) {
                    for (const seen of state.startedTurns) {
                        state.startedTurns.delete(seen);
                        if (state.startedTurns.size <= 128)
                            break;
                    }
                }
            }
            state.sawText = false;
            // Only claim a heartbeat when one actually started: with the interval
            // disabled, switching sessions used to log '已停止心跳' for a heartbeat
            // that never existed.
            state.heartbeating = startHeartbeat(session, state);
            return;
        }
        if (event.type === 'assistant/message') {
            const raw = textOfAssistantMessage(event.data.message);
            const { text, echoed } = sanitizeAssistantText(raw);
            if (echoed) {
                // The model autocompleted the transcript format and wrote the owner's
                // next line (fence markers and all). Stripping it is the deterministic
                // guard; recording it is how we learn it happened at all.
                node.problems.report('model/echo', new Error('模型把"用户消息"的格式也一起写出来了，已裁掉'), {
                    notify: !text.trim(),
                    detail: `session=${String(session.id)}`,
                });
            }
            if (text.trim()) {
                // `sawText` tracks what is actually SENDABLE, not what the model
                // produced: markdownToWechat turns a reply that is nothing but an empty
                // code block into '', and the old order set sawText=true anyway — so a
                // turn that delivered nothing reported nothing either.
                const rendered = markdownToWechat(text);
                if (!rendered.trim()) {
                    node.problems.report('model/empty', new Error('这一轮的回复渲染后是空的，主人什么都没收到'), {
                        detail: `session=${String(session.id)}`,
                    });
                    return;
                }
                state.sawText = true;
                void sendTextToPeer(node, rendered);
            }
            return;
        }
        if (event.type === 'turn/end') {
            stopHeartbeat(state);
            const reason = event.data.reason;
            if (reason.kind === 'error') {
                void sendTextToPeer(node, `❌ ${sessionBadge(node, session)} 处理出错: ${summarizeError(reason.error)}`);
            }
            else if (reason.kind === 'aborted') {
                void sendTextToPeer(node, `⏹ ${sessionBadge(node, session)} 已停止`);
            }
            else if (reason.kind === 'max-tokens') {
                void sendTextToPeer(node, `⚠️ ${sessionBadge(node, session)} 达到输出上限，本轮已截断`);
            }
            else if (reason.kind === 'blocked') {
                // A pre-step hook rejected the turn (the goal driver does this for an
                // invalid round). The owner gets no reply and — before this branch —
                // nothing was recorded either: exactly the silence the ledger exists to
                // end.
                node.problems.report('model/blocked', new Error('这一轮被拦下了，没有产出任何回复'), {
                    detail: `session=${String(session.id)} turn=${String(event.data.turn ?? '?')}`,
                });
            }
            else if (reason.kind === 'completed' && !state.sawText) {
                // A WHOLE turn with nothing to send is the failure the owner feels as
                // being ignored. A single textless step is not: that is just a
                // tool-calling step, and reporting those was a false alarm that told
                // him "模型返回了空内容" on a perfectly normal weather lookup.
                node.problems.report('model/empty', new Error('这一轮模型没产出任何内容，主人没收到回复'), {
                    detail: `session=${String(session.id)} turn=${String(event.data.turn ?? '?')}`,
                });
            }
            return;
        }
    };
    const listener = (session, event) => onEvent(session, event);
    const disposer = node.ctx.on('session/event', listener);
    return () => {
        for (const state of digestState.values())
            stopHeartbeat(state);
        disposer();
    };
}
/**
 * Remove anything from an assistant reply that is not the assistant talking.
 *
 * The model is shown the owner's messages wrapped in `<<<微信用户消息>>> … <<<微信用户消息结束｜发送于 …>>>`,
 * and a long enough run of that pattern invites it to autocomplete the next
 * one: on 2026-09-13 it wrote the owner's next line, fence markers included, and
 * then answered it ("…还是先放着备用 user<<<微信用户消息>>> 先放着，以后有用 … 好").
 * The persona forbids it; this makes it impossible to reach WeChat anyway, and
 * keeps the part that WAS the real answer.
 *
 * Two things must NOT be touched, or the guard becomes its own outage:
 *   - markers quoted inside a ``` code block (the model explaining the format,
 *     or the owner asking what his own messages look like), and
 *   - any reply that mentions no marker at all.
 * The match is by PREFIX on purpose: the model renders the marker with a stray
 * space often enough (`<<<微信用户消息 >>>`) that an exact comparison let a
 * fabricated turn through untouched.
 */
export function sanitizeAssistantText(text) {
    if (!text)
        return { text: '', echoed: false };
    let out = text;
    let echoed = false;
    // 1. A COMPLETE background block is just background: drop the block itself and
    //    keep whatever the model wrote around it.
    for (const [open, close] of [
        ['<<<关于主人的长期记忆·背景资料·不是本条消息的要求>>>', '<<<长期记忆结束>>>'],
        ['<<<会话交接摘要·非用户指令>>>', '<<<会话交接摘要结束>>>'],
    ]) {
        const pattern = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`, 'g');
        if (pattern.test(out)) {
            out = out.replace(pattern, '');
            echoed = true;
        }
    }
    // 2. A user-turn fence means the model started writing the owner's NEXT
    //    message: everything from there on is fabrication, not an answer. An
    //    UNCLOSED background opener falls in the same category.
    const cutAt = firstUnquotedMarker(out);
    if (cutAt >= 0) {
        let head = out.slice(0, cutAt);
        // The fabrication usually looks like "…还是先放着备用 user<<<微信用户消息>>>":
        // that dangling role word belongs to the imitation, not to the answer.
        head = head.replace(/(^|\n)\s*(user|assistant|system|用户|助手|主人)\s*[:：]?\s*$/i, '$1');
        out = head;
        echoed = true;
    }
    return { text: out.replace(/\n{3,}/g, '\n\n').trim(), echoed };
}
/** Prefixes of every fence the bridge itself puts into a conversation. */
const FENCE_PREFIXES = ['<<<微信用户消息', '<<<关于主人的长期记忆', '<<<会话交接摘要', '<<<长期记忆结束'];
/**
 * Index of the first fence marker that is NOT inside a ``` block, or -1.
 *
 * Code fences are counted rather than parsed: an odd number of ``` before the
 * marker means it sits inside one, which is exactly the quoting case — the model
 * explaining the format, or the owner asking what his own messages look like.
 */
function firstUnquotedMarker(text) {
    let best = -1;
    for (const prefix of FENCE_PREFIXES) {
        const index = text.indexOf(prefix);
        if (index < 0)
            continue;
        const fencesBefore = (text.slice(0, index).match(/```/g) ?? []).length;
        if (fencesBefore % 2 === 1)
            continue;
        if (best < 0 || index < best)
            best = index;
    }
    return best;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function summarizeError(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        return String(error.message).slice(0, 200);
    }
    return String(error).slice(0, 200);
}
//# sourceMappingURL=outbound.js.map