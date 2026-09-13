/**
 * Long-term memory: a small, human-readable facts file that outlives one session.
 *
 * Three layers, deliberately separate:
 *
 *   persona  — who she is (a preset, changes rarely)
 *   memory   — who the owner is: name he likes, city, habits, devices, decisions
 *              (this module, appended to over time)
 *   session  — what was just talked about (the host's own context compaction)
 *
 * The file is plain Markdown so it can be read and edited by hand, and it is
 * injected as labelled background — never as an instruction. Consolidation runs
 * on a daily timer (the bridge's own "sleep-time compute"): it reads only the
 * fenced user messages of the day, asks the *session's own model* what is worth
 * keeping, and applies the result. Everything here is best-effort: a failure is
 * logged and forgotten, never thrown, because this code runs next to the live
 * bridge.
 *
 * @module @dsh-cowork/chatnode-wechat/node/memory
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { USER_MESSAGE_CLOSE, USER_MESSAGE_OPEN } from "./inbound.js";
import { describeError } from "./net.js";
/** Directory (under `$DSH_HOME`) holding the memory file and its bookkeeping. */
export const MEMORY_DIR = 'wechat-memory';
/** The facts file itself. Markdown, hand-editable, capped. */
export const MEMORY_FILE = 'MEMORY.md';
/** Append-only audit trail: what changed, when, and from which conversation. */
export const MEMORY_LOG = 'memory-log.md';
/** Rotate the audit log past this size, keeping one previous file. */
export const MEMORY_LOG_LIMIT_BYTES = 256 * 1024;
/** Scheduler bookkeeping (last run, last seen sequence). */
export const MEMORY_STATE = 'state.json';
/** Hard cap; past this, new facts are skipped until something is merged away. */
export const MEMORY_LIMIT_CHARS = 4000;
/** How many sessions keep their injection bookkeeping before the oldest is dropped. */
export const MAX_TRACKED_SESSIONS = 64;
/** Sections the consolidator may write to. Anything else is ignored. */
export const MEMORY_SECTIONS = [
    '关于主人',
    '偏好与习惯',
    '常用设备与环境',
    '待办与承诺',
    '重要决定',
];
/**
 * Bookkeeping section for superseded facts. Not a writable section: entries get
 * there through `expire`, and it never reaches the model's context.
 */
export const MEMORY_EXPIRED_SECTION = '已过期';
/** Opening fence of the injected memory briefing. */
export const MEMORY_OPEN = '<<<关于主人的长期记忆·背景资料·不是本条消息的要求>>>';
/** Closing fence of the injected memory briefing. */
export const MEMORY_CLOSE = '<<<长期记忆结束>>>';
/** The seed written on first use: structure plus the few facts already known. */
export const MEMORY_SEED = `# 长期记忆（关于主人）

> 这个文件是跨会话的长期记忆：写"主人是谁、习惯什么、用什么"，不写"刚才聊了什么"。
> 只写明确出现过的事实，每条尽量带日期；冲突时新事实覆盖旧事实。
> 不写密码、token、API key。

## 关于主人

## 偏好与习惯

## 常用设备与环境

## 待办与承诺

## 重要决定

## 已过期
`;
/** Default location of the facts file. */
export function defaultMemoryFile() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), MEMORY_DIR, MEMORY_FILE);
}
/** Read the facts file; empty string when missing or unreadable. */
export function readMemory(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
/** Whether an existing file can actually be read back (permissions, locks). */
function isReadable(file) {
    try {
        readFileSync(file);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Read the facts file, creating it from the seed only when it does not exist.
 *
 * A file that exists is never overwritten here — not when it is empty (the owner
 * may have cleared it on purpose) and not when it fails to read (rebuilding it
 * from the seed would destroy whatever is in there).
 */
export function ensureMemory(file) {
    if (existsSync(file))
        return readMemory(file);
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, MEMORY_SEED, 'utf8');
    }
    catch {
        // Read-only location: fall back to the in-memory seed for this call.
        return MEMORY_SEED;
    }
    return MEMORY_SEED;
}
/** Timestamp used for backups and log lines (milliseconds: two writes in the
 *  same second must not overwrite each other's backup). */
function stamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${ms}`;
}
/**
 * Write the facts file: backup, atomic replace, then verify the cap.
 *
 * A refusal is reported, never silently shrunk. IO failures carry their own
 * reason: a full disk or a locked file used to be reported as "over the
 * character limit", which sends the owner looking in the wrong place.
 */
export function writeMemory(file, text) {
    const existing = readMemory(file);
    if (text.length > MEMORY_LIMIT_CHARS && text.length >= existing.length)
        return { ok: false, reason: 'cap' };
    // A hand-edited file in GBK, or any other non-UTF-8 encoding, decodes to
    // U+FFFD. Writing our version back would persist those replacement characters
    // and destroy the original bytes for good.
    if (existing.includes('\uFFFD')) {
        return { ok: false, reason: 'encoding', detail: '记忆文件不是 UTF-8，请先转存为 UTF-8' };
    }
    const temp = `${file}.tmp-${process.pid}`;
    try {
        mkdirSync(dirname(file), { recursive: true });
        if (existing) {
            try {
                copyFileSync(file, `${file}.bak-${stamp()}`);
                pruneBackups(file, 5);
            }
            catch {
                // A missing backup must not block the write.
            }
        }
        writeFileSync(temp, text, 'utf8');
        renameSync(temp, file);
        return { ok: true };
    }
    catch (error) {
        try {
            rmSync(temp, { force: true });
        }
        catch {
            // Nothing else to do about a temp file we cannot remove.
        }
        return { ok: false, reason: 'io', detail: error instanceof Error ? error.message : String(error) };
    }
}
/** Append one line to the audit trail (best effort). */
export function appendMemoryLog(file, line) {
    try {
        const log = join(dirname(file), MEMORY_LOG);
        rotateIfLarge(log, MEMORY_LOG_LIMIT_BYTES);
        appendFileSync(log, `${new Date().toISOString()} ${line}\n`, 'utf8');
    }
    catch {
        // Diagnostics are best effort by definition.
    }
}
/** Rename a log aside once it passes the cap, keeping exactly one previous file. */
export function rotateIfLarge(file, limit) {
    try {
        if (!existsSync(file))
            return;
        if (statSync(file).size < limit)
            return;
        renameSync(file, `${file}.1`);
    }
    catch {
        // A failed rotation must not stop the write that follows.
    }
}
/**
 * Keep only the newest backups of one file.
 *
 * Every memory write and every admin save leaves a `.bak-*` next to the file,
 * and nothing ever removed them: over weeks that is a directory full of copies
 * of the same config. Ordering is by MODIFICATION TIME, not by name — the
 * names come from several eras (`bak-<epoch>`, `bak-<date>`, `bak-before-*`)
 * and alphabetical order kept arbitrary ones while deleting newer states.
 */
export function pruneBackups(file, keep = 5) {
    try {
        const dir = dirname(file);
        const prefix = `${basename(file)}.bak-`;
        const rows = [];
        for (const name of readdirSync(dir)) {
            if (!name.startsWith(prefix))
                continue;
            try {
                const stat = statSync(join(dir, name));
                if (!stat.isFile())
                    continue;
                rows.push({ name, at: stat.mtimeMs });
            }
            catch {
                // Unreadable entry: leave it alone rather than guessing its age.
            }
        }
        rows.sort((a, b) => a.at - b.at);
        for (const row of rows.slice(0, -keep)) {
            try {
                rmSync(join(dir, row.name), { force: true });
            }
            catch {
                // A backup we cannot remove is not worth failing a write over.
            }
        }
    }
    catch {
        // Best effort by definition.
    }
}
/**
 * Whether a line is a fact: `- text` or `* text`, possibly indented.
 *
 * One definition for the whole module — the briefing must show exactly the
 * lines that `expire` can retire, or a hand-edited `* fact` becomes both
 * invisible to the model and deletable by the consolidator.
 */
function isFactLine(line) {
    return /^\s*[-*]\s+\S/.test(line);
}
/**
 * Normalize one bullet line: single line, trimmed, no leading dash.
 *
 * The indent has to go with the marker: an indented `  - fact` would otherwise
 * keep its ` - ` prefix and never compare equal to the same fact written flat,
 * so `expire` could not retire a line the briefing was happily showing.
 */
function bullet(text) {
    return text.replace(/\s+/g, ' ').replace(/^\s*[-*]\s*/, '').trim();
}
/**
 * Local calendar date, never UTC: a UTC stamp reads "tomorrow" for every local
 * time after 16:00 in UTC+8, which is exactly when the owner is still chatting.
 */
function localDate(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
/**
 * Validate a wall-clock `HH:MM`.
 *
 * `setHours` carries silently over nonsense: `99:99` would fire four days out
 * and `4:5` never matches the shape at all, quietly disabling the whole feature.
 * Anything that is not a real time is treated as "off", and says so in the log.
 */
function normalizeTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match)
        return '';
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59)
        return '';
    return `${String(hours).padStart(2, '0')}:${match[2]}`;
}
/**
 * One stored bullet reduced to the fact itself, dropping the trailing
 * `（date）` / `（作废 date）` marker so a fact already on file is recognised as
 * the same fact instead of being appended again.
 */
function factText(line) {
    return bullet(line).replace(/（(?:作废 )?\d{4}-\d{2}-\d{2}）$/, '').trim();
}
/**
 * Normalize a value the model sent so it compares like a stored fact.
 *
 * The consolidator is shown the file, dates and all, so it happily echoes
 * `主人在示例市（2026-09-13）` back as `from`/`text`; without this the same fact
 * would never match itself and would pile up with a second date appended.
 */
function normalizeFact(value) {
    return factText(String(value ?? ''));
}
/**
 * Every fact line that sits in a WRITABLE section.
 *
 * Headings, the file's `>` guidance and everything under `已过期` are excluded:
 * the consolidator matches on text, and a substring match against the whole file
 * once let `update from: 关于主人` turn the section heading itself into a bullet,
 * which orphaned that section's facts and stopped them being injected at all.
 */
function factIndex(lines) {
    const refs = [];
    let section = null;
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('## ')) {
            const name = trimmed.slice(3).trim();
            section = MEMORY_SECTIONS.includes(name) ? name : null;
            return;
        }
        if (!section || !isFactLine(line))
            return;
        refs.push({ index, section, text: factText(line) });
    });
    return refs;
}
/** Locate one section's body range (line indexes, end exclusive). */
function sectionRange(lines, section) {
    const heading = `## ${section}`;
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith('## ')) {
            end = i;
            break;
        }
    }
    return { start: start + 1, end };
}
/**
 * Apply a consolidation patch to the facts file.
 *
 * `add` appends a bullet to its named section, `update` rewrites the fact that
 * matches `from` **exactly**, `expire` moves a fact to the 已过期 section.
 * Anything that does not fit the shape (unknown section, missing text, no
 * match, ambiguous match) is reported in `skipped` rather than guessed at.
 *
 * Matching is exact on purpose. A substring match reads well until the model
 * sends the fragment `主人`, at which point one "update" rewrites every fact
 * that happens to contain it and deletes the rest without a trace. Exact
 * equality also makes collapsing true duplicates safe: every line that matches
 * one exact string *is* the same fact.
 */
export function applyPatch(file, patch, origin) {
    const result = { added: 0, updated: 0, expired: 0, skipped: [] };
    // An existing file that cannot be read must not be replaced by a rebuilt one:
    // a permissions problem would silently wipe the memory it failed to load.
    if (existsSync(file) && !isReadable(file)) {
        appendMemoryLog(file, `拒绝写入：文件存在但读不出来（origin=${origin}）`);
        return { ...result, skipped: [...result.skipped, '记忆文件存在但读不出来，本次不改动'] };
    }
    let text = ensureMemory(file);
    const today = localDate();
    for (const entry of patch.add ?? []) {
        const section = String(entry?.section ?? '').trim();
        const value = normalizeFact(entry?.text);
        if (!value)
            continue;
        if (!MEMORY_SECTIONS.includes(section)) {
            result.skipped.push(`未知小节「${section}」: ${value}`);
            continue;
        }
        const lines = text.split('\n');
        const range = sectionRange(lines, section);
        if (!range) {
            result.skipped.push(`小节缺失「${section}」: ${value}`);
            continue;
        }
        // Compare facts without their date marker, or the same fact is re-appended
        // on every run (it could never equal the bare text).
        if (factIndex(lines).some((ref) => ref.section === section && ref.text === value))
            continue;
        // Insert before the section's trailing blank lines so the heading that
        // follows keeps its blank line.
        let insertAt = range.end;
        while (insertAt > range.start && lines[insertAt - 1].trim() === '')
            insertAt -= 1;
        lines.splice(insertAt, 0, `- ${value}（${today}）`);
        text = lines.join('\n');
        result.added += 1;
    }
    for (const entry of patch.update ?? []) {
        const from = normalizeFact(entry?.from);
        const to = bullet(String(entry?.to ?? ''));
        if (!from || !to)
            continue;
        const lines = text.split('\n');
        const matches = factIndex(lines).filter((ref) => ref.text === from);
        if (matches.length === 0) {
            result.skipped.push(`找不到待更新事实: ${from}`);
            continue;
        }
        lines[matches[0].index] = `- ${to}（${today}）`;
        // Every match carries the identical text, so these are duplicates of one
        // fact (a hand-edited file can hold it twice); the update supersedes them.
        for (const ref of matches.slice(1).reverse())
            lines.splice(ref.index, 1);
        text = lines.join('\n');
        result.updated += 1;
    }
    for (const raw of patch.expire ?? []) {
        const value = normalizeFact(raw);
        if (!value)
            continue;
        const lines = text.split('\n');
        const matches = factIndex(lines).filter((ref) => ref.text === value);
        if (matches.length === 0) {
            result.skipped.push(`找不到待过期事实: ${value}`);
            continue;
        }
        const retired = [...new Set(matches.map((ref) => ref.text))];
        for (const ref of matches.slice().reverse())
            lines.splice(ref.index, 1);
        const range = sectionRange(lines, MEMORY_EXPIRED_SECTION);
        const block = retired.map((fact) => `- ${fact}（作废 ${today}）`);
        if (range) {
            let insertAt = range.end;
            while (insertAt > range.start && lines[insertAt - 1].trim() === '')
                insertAt -= 1;
            lines.splice(insertAt, 0, ...block);
        }
        else {
            lines.push(`## ${MEMORY_EXPIRED_SECTION}`, ...block, '');
        }
        text = lines.join('\n');
        // Count the facts retired, not the number of patch entries that asked.
        result.expired += retired.length;
    }
    if (result.added + result.updated + result.expired > 0) {
        const written = writeMemory(file, text);
        if (!written.ok) {
            const why = written.reason === 'cap'
                ? `超过 ${MEMORY_LIMIT_CHARS} 字符上限`
                : `写入失败（${written.detail ?? '未知原因'}）`;
            appendMemoryLog(file, `拒绝写入：${why}（origin=${origin}）`);
            return { ...result, added: 0, updated: 0, expired: 0, skipped: [...result.skipped, `${why}，已丢弃本次改动`] };
        }
        appendMemoryLog(file, `+${result.added} ~${result.updated} -${result.expired}（origin=${origin}）` +
            (result.skipped.length > 0 ? ` skipped=${result.skipped.length}` : ''));
    }
    return result;
}
/**
 * Wrap the facts file as labelled background for the model.
 *
 * Only sections that actually hold facts are shipped: a fresh file (headings
 * and nothing else) must not inject an empty briefing, both because it wastes
 * context on every message and because handing the model a memory shape with
 * no content in it invites it to invent the content. The `已过期` bookkeeping
 * section stays out too — it exists so a later consolidation does not re-add a
 * dead fact, and the live conversation has no use for it.
 */
export function memoryBriefing(file) {
    const blocks = factBlocks(readMemory(file));
    if (blocks.length === 0)
        return null;
    return `${MEMORY_OPEN}\n${blocks.map((block) => block.join('\n')).join('\n\n')}\n${MEMORY_CLOSE}`;
}
/** Whether the file holds at least one fact (a bare heading does not count). */
export function hasFacts(file) {
    return factBlocks(readMemory(file)).length > 0;
}
/** How many facts are on file — `已过期` entries and headings do not count. */
export function factCount(file) {
    return factBlocks(readMemory(file)).reduce((total, block) => total + block.length - 1, 0);
}
/** `[[heading, ...fact lines], …]` for every section that holds facts. */
function factBlocks(text) {
    const blocks = [];
    let heading = null;
    let facts = [];
    const flush = () => {
        if (heading && facts.length > 0)
            blocks.push([heading, ...facts]);
        heading = null;
        facts = [];
    };
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (line.startsWith('> ') || line.startsWith('# '))
            continue; // title + the file's own guidance
        if (line.startsWith('## ')) {
            flush();
            heading = line === `## ${MEMORY_EXPIRED_SECTION}` ? null : line;
            continue;
        }
        if (heading && isFactLine(line))
            facts.push(line.trim());
    }
    flush();
    return blocks;
}
/**
 * Extract the owner's own words from session events.
 *
 * Only content inside the inbound envelope counts: everything else in a session
 * (the model's own text, tool output, injected briefings) is not a fact about
 * the owner, and letting it through is how a memory file ends up poisoned.
 *
 * Two things ride in the SAME text block as the envelope and must be cut out
 * first, because both read like the owner speaking:
 *   - the handoff note the bridge prepends when a session rotates, which quotes
 *     the assistant's own last replies ("你最近回过：…");
 *   - the memory briefing, which the bridge prepends outside the fence.
 * The envelope is also located from the LAST opening marker: anything before it
 * is background, and a fact that happens to quote a marker must not be able to
 * shift the slice into the briefing.
 */
export function extractUtterances(events) {
    const out = [];
    // The closing marker is `<<<微信用户消息结束｜发送于 …>>>`; matching the whole
    // shape (rather than searching for the bare word) is what keeps the envelope's
    // own `<<<` out of the captured text — it used to end every fact with "<<".
    const envelope = new RegExp(`${escapeRegExp(USER_MESSAGE_OPEN)}\\n([\\s\\S]*?)\\n<<<${escapeRegExp(USER_MESSAGE_CLOSE)}｜发送于\\s*([0-9-]+ [0-9:]+)>>>`, 'g');
    for (const raw of events) {
        const event = raw;
        if (event?.type !== 'user/message')
            continue;
        const blocks = Array.isArray(event.data?.content) ? event.data?.content : [];
        const text = stripBackground(blocks
            .filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n'));
        // The LAST envelope wins: anything before it is background this bridge (or
        // the host) prepended, never the owner speaking.
        const found = [...text.matchAll(envelope)];
        const last = found.at(-1);
        if (!last)
            continue;
        const body = (last[1] ?? '').trim();
        if (body)
            out.push({ at: last[2] ?? '', text: body });
    }
    return out;
}
/** Remove the bridge's own fenced background blocks from a message body. */
function stripBackground(text) {
    return text
        .replace(new RegExp(`${escapeRegExp(MEMORY_OPEN)}[\\s\\S]*?${escapeRegExp(MEMORY_CLOSE)}`, 'g'), '')
        .replace(/<<<会话交接摘要[^>]*>>>[\s\S]*?<<<会话交接摘要结束>>>/g, '');
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** The instruction handed to the session's own model during consolidation. */
export function consolidationPrompt(digest, current) {
    return [
        '你在维护一份关于"主人"的长期记忆文件。下面是这份文件的当前内容，以及今天他亲口说过的话。',
        '',
        '任务：只挑出**他明确说过的、长期有效的事实**，输出严格 JSON（不要任何解释、不要代码围栏）：',
        '{"add":[{"section":"小节","text":"事实"}],"update":[{"from":"旧事实片段","to":"新事实"}],"expire":["不再成立的事实片段"]}',
        '',
        `小节只能从这几个里选：${MEMORY_SECTIONS.join(' / ')}`,
        '规则：',
        '- 只记录他本人说过的事实（称呼、所在地、作息、偏好、忌讳、设备与路径、承诺与待办、重要决定）。',
        '- 不写密码、token、API key、一次性安排、闲聊情绪、你自己说过的话。',
        '- 已经记过的不要重复 add；有变化用 update；不再成立用 expire。',
        '- 没有值得记的就输出 {"add":[],"update":[],"expire":[]}。',
        '- `from` 和 `expire` 里的文字必须是文件里那一条的**完整内容**（不含行首的 `- ` 和末尾的日期括号），不要只给关键词；对不上就什么都别改。',
        `- \`${MEMORY_EXPIRED_SECTION}\` 那一节只是作废台账，不要 update 或 expire 里面的条目。`,
        '',
        '=== 当前记忆文件 ===',
        current || '(空)',
        '',
        '=== 今天他说过的话 ===',
        digest || '(今天没有新消息)',
    ].join('\n');
}
/**
 * Pull one JSON object out of a model reply (tolerating prose and fences).
 *
 * Field shapes are normalized here, not trusted: `{"add":42}` is a structurally
 * valid object that would blow up the caller with "42 is not iterable", and one
 * bad field must not cost the whole day's consolidation.
 */
export function parsePatch(reply) {
    const cleaned = reply.replace(/```[a-z]*\n?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (parsed === null || typeof parsed !== 'object')
            return null;
        const patch = {
            add: Array.isArray(parsed.add) ? parsed.add : [],
            update: Array.isArray(parsed.update) ? parsed.update : [],
            expire: Array.isArray(parsed.expire) ? parsed.expire.filter((item) => typeof item === 'string') : [],
        };
        return patch;
    }
    catch {
        return null;
    }
}
/**
 * Long-term memory service: briefing injection plus the daily consolidation run.
 *
 * Mirrors {@link MorningService}'s shape (start / stop / timer) so the bridge has
 * one scheduling idiom, and follows the v0.3.0 stability rule: every entry point
 * resolves, no timer keeps the process alive, nothing throws into the host.
 */
export class MemoryService {
    ctx;
    file;
    injectEvery;
    minUtterances;
    idleMs;
    clock;
    /** Where a swallowed failure goes; optional so the service works standalone. */
    onProblem;
    injected = new Map();
    lastMessageAt = 0;
    /** `lastMessageAt` as of the last daily run (0 = never run). */
    lastRunMessageAt = 0;
    timer;
    running = false;
    loaded = false;
    at = '';
    /** The configured time as given, so a bad value can be reported verbatim. */
    atRaw = '';
    warnedAboutTime = false;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.file = options.file ?? defaultMemoryFile();
        this.injectEvery = options.injectEvery ?? 10;
        this.minUtterances = options.minUtterances ?? 5;
        this.idleMs = options.idleMs ?? 2 * 60 * 60 * 1000;
        this.clock = options.now ?? (() => new Date());
        this.onProblem = options.onProblem;
        this.atRaw = options.consolidateAt ?? '04:30';
        this.at = normalizeTime(this.atRaw);
        this.loadState();
    }
    /** Facts file this service owns. */
    get filePath() {
        return this.file;
    }
    /** Arm the daily timer (idempotent, and re-armable after {@link stop}). */
    start() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            ensureMemory(this.file);
            if (!existsSync(this.file)) {
                // Seeding silently failed (read-only home, missing directory): every
                // later consolidation would write into the void.
                this.onProblem?.('memory/seed', new Error(`记忆文件建不出来：${this.file}`));
            }
        }
        catch (error) {
            this.onProblem?.('memory/seed', error, `file=${this.file}`);
        }
        this.arm();
    }
    /** Disarm the timer. A later {@link start} must arm it again. */
    stop() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.loaded = false;
    }
    /** Current facts file content (seeding on first read). */
    read() {
        return ensureMemory(this.file);
    }
    /**
     * The briefing for one inbound message, or null when this message should not
     * carry one. Injection happens on the first message of a session, whenever the
     * file changed since the last injection, and every `injectEvery` messages.
     */
    briefing(sessionId) {
        this.lastMessageAt = this.clock().getTime();
        const text = ensureMemory(this.file).trim();
        if (!text)
            return null;
        const hash = createHash('sha1').update(text).digest('hex');
        const seen = this.injected.get(sessionId) ?? { count: 0, hash: '' };
        const count = seen.count + 1;
        const changed = seen.hash !== hash;
        const first = count === 1;
        const periodic = this.injectEvery > 0 && count % this.injectEvery === 0;
        if (!first && !changed && !periodic) {
            // Keep the count, keep the old hash: the next change still injects.
            this.injected.set(sessionId, { count, hash: seen.hash });
            this.trimInjected();
            return null;
        }
        this.injected.set(sessionId, { count, hash });
        this.trimInjected();
        return memoryBriefing(this.file);
    }
    /**
     * Bound the per-session counters. Every `/new` and every rotation adds one
     * entry and nothing ever removed them, so a long-lived process grew this map
     * for the life of the install.
     */
    trimInjected() {
        while (this.injected.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.injected.keys().next();
            if (oldest.done)
                return;
            this.injected.delete(oldest.value);
        }
    }
    /**
     * Note that the host compacted this session's history.
     *
     * Compaction replaces older messages with a summary, and it can happen in the
     * MIDDLE of a turn (the host runs it before each step), so waiting for the
     * usual cadence could leave several steps without any anchor to who the owner
     * is. Dropping the bookkeeping makes the next message carry the full briefing
     * again — cheap, because the briefing is a few hundred tokens.
     */
    noteCompaction(sessionId) {
        this.injected.set(sessionId, { count: 0, hash: '' });
        this.trimInjected();
        appendMemoryLog(this.file, `上下文被压缩，下一条消息重新注入长期记忆（session=${sessionId}）`);
    }
    /**
     * Run one consolidation now.
     *
     * Reads the day's fenced user messages, asks the session's own model what is
     * worth keeping, and applies the result. Never throws: every failure is a
     * reporting line.
     */
    async consolidateNow(session, route, reason = 'manual') {
        const report = { ran: false, reason, utterances: 0, added: 0, updated: 0, expired: 0, skipped: 0 };
        if (this.running)
            return { ...report, reason: `${reason}: already running` };
        if (!session || !route)
            return { ...report, reason: `${reason}: no session or model route` };
        const llm = this.ctx.get('llm');
        if (!llm?.stream)
            return { ...report, reason: `${reason}: llm service unavailable` };
        this.running = true;
        try {
            const utterances = extractUtterances(session.snapshotEvents());
            const digest = utterances
                .slice(-80)
                .map((item) => `- ${item.at ? `[${item.at}] ` : ''}${item.text.slice(0, 400)}`)
                .join('\n');
            report.utterances = utterances.length;
            if (utterances.length < this.minUtterances)
                return { ...report, reason: `${reason}: ${utterances.length} < ${this.minUtterances} utterances` };
            const text = await this.ask(llm, route, session, consolidationPrompt(digest, this.read()));
            const patch = parsePatch(text);
            if (!patch) {
                appendMemoryLog(this.file, `整理失败：模型输出不是 JSON（origin=${reason}）`);
                return { ...report, reason: `${reason}: unparsable model reply` };
            }
            const applied = applyPatch(this.file, patch, reason);
            this.saveState();
            return {
                ...report,
                ran: true,
                added: applied.added,
                updated: applied.updated,
                expired: applied.expired,
                skipped: applied.skipped.length,
            };
        }
        catch (error) {
            appendMemoryLog(this.file, `整理异常：${describeError(error)}（origin=${reason}）`);
            return { ...report, reason: `${reason}: ${describeError(error)}` };
        }
        finally {
            this.running = false;
        }
    }
    /** One model call, assembled to text. Retries once on failure. */
    async ask(llm, route, session, prompt) {
        let lastError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const assembler = new BlockAssembler();
                const options = {
                    provider: route.provider,
                    model: route.model,
                    messages: [
                        createUserMessage({
                            content: [{ type: 'text', text: prompt }],
                            source: { kind: 'plugin', plugin: 'dsh-chatnode-wechat' },
                        }),
                    ],
                    maxTokens: 1024,
                    sessionId: session.id,
                };
                for await (const chunk of llm.stream(options))
                    assembler.push(chunk);
                const text = assembler
                    .blocks()
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text ?? '')
                    .join('\n')
                    .trim();
                if (text)
                    return text;
                lastError = new Error('empty model reply');
            }
            catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    /** (Re)arm the daily timer for the configured time. */
    arm() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.at) {
            if (this.atRaw.trim() && !this.warnedAboutTime) {
                this.warnedAboutTime = true;
                appendMemoryLog(this.file, `整理时间「${this.atRaw}」不是合法时间，已关闭每日整理（origin=config）`);
            }
            return;
        }
        const [h, m] = this.at.split(':').map(Number);
        const now = this.clock();
        const next = new Date(now);
        next.setHours(h, m, 0, 0);
        if (next.getTime() <= now.getTime())
            next.setDate(next.getDate() + 1);
        const delay = Math.min(next.getTime() - now.getTime(), 2_147_000_000);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.onTimer();
            this.arm();
        }, delay);
        this.timer.unref?.();
    }
    /** Timer callback: run only when the bridge has been idle long enough. */
    async onTimer() {
        try {
            const idleFor = this.clock().getTime() - this.lastMessageAt;
            if (this.lastMessageAt > 0 && idleFor < this.idleMs)
                return;
            // Nothing said since the last run: asking the model to re-read the same
            // conversation buys nothing and risks it "tidying" a good fact away.
            if (this.lastRunMessageAt > 0 && this.lastMessageAt <= this.lastRunMessageAt) {
                appendMemoryLog(this.file, '定时整理跳过：这次运行前没有新消息（origin=daily）');
                return;
            }
            const session = this.sessionProvider?.();
            const route = this.routeProvider?.();
            const attempted = this.lastMessageAt;
            const report = await this.consolidateNow(session, route, 'daily');
            // Advance the cursor only when the day was actually folded in. A failed
            // model call or a refused write must stay retryable: marking it done here
            // is what turns one bad night into a permanently forgotten day.
            if (report.ran) {
                this.lastRunMessageAt = attempted;
                this.saveState();
            }
            else {
                appendMemoryLog(this.file, `定时整理未完成，保持可重试：${report.reason}`);
            }
        }
        catch (error) {
            appendMemoryLog(this.file, `定时整理异常：${describeError(error)}`);
        }
    }
    /** Wired by the node so the timer can find the live session and its route. */
    sessionProvider;
    routeProvider;
    stateFile() {
        return join(dirname(this.file), MEMORY_STATE);
    }
    loadState() {
        try {
            const raw = readFileSync(this.stateFile(), 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.lastMessageAt)
                this.lastMessageAt = Number(new Date(parsed.lastMessageAt)) || 0;
            if (parsed.lastRunMessageAt)
                this.lastRunMessageAt = Number(new Date(parsed.lastRunMessageAt)) || 0;
        }
        catch (error) {
            // A missing state file is normal; anything else means the cursor was lost
            // and the next daily run will re-read the same conversation.
            if (error.code !== 'ENOENT')
                this.onProblem?.('memory/state', error, `file=${this.stateFile()}`);
        }
    }
    saveState() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const state = {
                lastRunAt: this.clock().toISOString(),
                ...(this.lastMessageAt > 0 ? { lastMessageAt: new Date(this.lastMessageAt).toISOString() } : {}),
                ...(this.lastRunMessageAt > 0 ? { lastRunMessageAt: new Date(this.lastRunMessageAt).toISOString() } : {}),
            };
            writeFileSync(this.stateFile(), JSON.stringify(state, null, 2), 'utf8');
        }
        catch (error) {
            this.onProblem?.('memory/state', error, `file=${this.stateFile()}`);
        }
    }
    /** Whether the facts file exists (used by the /memory command). */
    exists() {
        return existsSync(this.file);
    }
    /**
     * Whether anything worth showing has been recorded yet. A seeded file is
     * headings only, so "the file exists" is not the same as "there is a memory".
     */
    hasFacts() {
        return hasFacts(this.file);
    }
    /** How many facts are on file (used by `/context`). */
    factCount() {
        return factCount(this.file);
    }
}
//# sourceMappingURL=memory.js.map