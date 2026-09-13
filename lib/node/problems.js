/**
 * The problem ledger: every failure the bridge swallows leaves a trace.
 *
 * The bridge has one hard rule — nothing may throw into the host — and that rule
 * used to be implemented as "return undefined and say nothing". A swallowed
 * failure then looked exactly like a quiet day: the owner waited for an answer
 * that was never coming, and nothing anywhere recorded why. The rule is right;
 * the silence was not. So every caught failure now goes through here, which:
 *
 *   1. appends one line to `$DSH_HOME/wechat-problems.log` (append-only, rotated
 *      at a size cap so a failing loop cannot fill the disk),
 *   2. keeps a bounded in-memory roll-up so `/problems` can show what has been
 *      going wrong and how often,
 *   3. tells the owner in WeChat — but only for failures he would otherwise
 *      experience as "nothing happened", at most once per signature per window,
 *      with an hourly ceiling. A trace must not turn one broken night into forty
 *      apologetic bubbles.
 *
 * Everything here is best-effort by construction: reporting a problem can never
 * itself become one.
 *
 * @module @dsh-cowork/chatnode-wechat/node/problems
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeError } from "./net.js";
/** Append-only problem log (one line per occurrence). */
export const PROBLEM_FILE = 'wechat-problems.log';
/** Rotate once the log passes this size; one previous file is kept. */
export const PROBLEM_LOG_LIMIT_BYTES = 256 * 1024;
/** Distinct problems kept in memory for `/problems`. */
export const PROBLEM_MEMORY_LIMIT = 50;
/** How many occurrences of one signature the memory keeps counting. */
export const PROBLEM_OCCURRENCE_CAP = 9_999;
/** Default location of the problem log. */
export function defaultProblemFile() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), PROBLEM_FILE);
}
/** Same failure seen twice should read as one problem, not two. */
function signature(kind, message) {
    return `${kind}::${message.replace(/\d+/g, '#').slice(0, 200)}`;
}
/**
 * Collects failures without ever failing itself.
 *
 * One instance lives on the node (`node.problems`) so the whole bridge shares
 * one ledger; modules that cannot reach the node take it as an optional field.
 */
export class ProblemReporter {
    file;
    now;
    notifyWindowMs;
    maxNoticesPerHour;
    notifyOwner;
    logger;
    records = new Map();
    lastNoticeAt = new Map();
    noticeTimes = [];
    lastRotateCheck = 0;
    constructor(options = {}) {
        this.file = options.file ?? defaultProblemFile();
        this.now = options.now ?? (() => new Date());
        this.notifyWindowMs = options.notifyWindowMs ?? 10 * 60 * 1000;
        this.maxNoticesPerHour = options.maxNoticesPerHour ?? 6;
        this.notifyOwner = options.notify;
        this.logger = options.logger;
    }
    /** Wire the WeChat notice channel once the node is ready. */
    setNotifier(notify) {
        this.notifyOwner = notify;
    }
    /** Wire the host logger. */
    setLogger(logger) {
        this.logger = logger;
    }
    /**
     * Record one failure. Returns the roll-up row so callers can log it too.
     *
     * `error` may be anything: an Error, a rejection reason, or a plain string
     * (some host paths reject with objects), and all of them come out readable.
     */
    report(kind, error, options = {}) {
        const at = this.now();
        const iso = at.toISOString();
        const message = describeError(error);
        const detail = (options.detail ?? '').replace(/\s+/g, ' ').trim();
        const key = signature(kind, message);
        let record = this.records.get(key);
        if (!record) {
            record = { kind, message, detail, count: 0, firstAt: iso, lastAt: iso, notified: false };
            this.records.set(key, record);
            this.trimRecords();
        }
        record.count = Math.min(record.count + 1, PROBLEM_OCCURRENCE_CAP);
        record.lastAt = iso;
        if (detail)
            record.detail = detail;
        const line = `${iso} [${kind}] ${message}${detail ? ` | ${detail}` : ''}${record.count > 1 ? ` | #${record.count}` : ''}`;
        this.append(line);
        try {
            this.logger?.('warn', `[dsh-chatnode-wechat] ${kind}: ${message}${detail ? ` (${detail})` : ''}`);
        }
        catch {
            // A logger that throws is not worth a second failure.
        }
        if (options.notify === false)
            return record;
        const notice = this.buildNotice(record);
        if (!notice)
            return record;
        record.notified = true;
        this.append(`${iso} [${kind}] 已告知主人：${notice.replace(/\s+/g, ' ')}`);
        try {
            this.notifyOwner?.(notice);
        }
        catch {
            // The notice channel is down; the ledger above is the durable trace.
        }
        return record;
    }
    /** Newest-first snapshot of the distinct problems seen. */
    recent(limit = 10) {
        return [...this.records.values()]
            .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
            .slice(0, Math.max(0, limit))
            .map((record) => ({ ...record }));
    }
    /** Problems last seen within `withinMs` (used by `/status`). */
    recentCount(withinMs) {
        const since = this.now().getTime() - withinMs;
        return [...this.records.values()].filter((record) => new Date(record.lastAt).getTime() >= since).length;
    }
    /** Total occurrences recorded since the process started. */
    total() {
        let sum = 0;
        for (const record of this.records.values())
            sum += record.count;
        return sum;
    }
    /** Forget the in-memory roll-up (the log file stays). */
    clear() {
        this.records.clear();
        this.lastNoticeAt.clear();
        this.noticeTimes = [];
    }
    /**
     * One notice per signature per window, plus an hourly ceiling.
     *
     * The ceiling is what keeps a broken dependency from becoming a flood: the
     * owner should learn about a problem once, not once per message.
     */
    buildNotice(record) {
        const now = this.now().getTime();
        const key = signature(record.kind, record.message);
        const last = this.lastNoticeAt.get(key) ?? 0;
        if (now - last < this.notifyWindowMs)
            return null;
        this.noticeTimes = this.noticeTimes.filter((time) => now - time < 60 * 60 * 1000);
        if (this.noticeTimes.length >= this.maxNoticesPerHour)
            return null;
        this.lastNoticeAt.set(key, now);
        this.noticeTimes.push(now);
        const repeat = record.count > 1 ? `（第 ${record.count} 次）` : '';
        return `⚠️ 出了点问题：${record.message}${repeat}\n已记下来，发 /problems 可以看。`;
    }
    /** Append one line, rotating first when the log has grown past the cap. */
    append(line) {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            this.rotateIfNeeded();
            appendFileSync(this.file, `${line}\n`, 'utf8');
        }
        catch {
            // Diagnostics are best effort; the in-memory roll-up survives.
        }
    }
    rotateIfNeeded() {
        const now = this.now().getTime();
        // statSync on every line would be wasteful; once a minute is plenty.
        if (now - this.lastRotateCheck < 60_000)
            return;
        this.lastRotateCheck = now;
        try {
            if (!existsSync(this.file))
                return;
            if (statSync(this.file).size < PROBLEM_LOG_LIMIT_BYTES)
                return;
            renameSync(this.file, `${this.file}.1`);
        }
        catch {
            // A failed rotation must not stop the write that follows.
        }
    }
    /** Keep the roll-up bounded; the oldest row is the one that goes. */
    trimRecords() {
        while (this.records.size > PROBLEM_MEMORY_LIMIT) {
            const oldest = [...this.records.entries()].sort((a, b) => (a[1].lastAt < b[1].lastAt ? -1 : 1))[0];
            if (!oldest)
                return;
            this.records.delete(oldest[0]);
        }
    }
}
/**
 * Human-readable `/problems` answer.
 *
 * Kept pure so the wording is testable without a filesystem or a bridge.
 */
export function formatProblems(reporter, limit = 8) {
    const rows = reporter.recent(limit);
    if (rows.length === 0)
        return '✅ 最近没有记录到问题。';
    const lines = rows.map((row, index) => {
        const when = row.lastAt.slice(11, 16);
        const detail = row.detail ? `（${row.detail}）` : '';
        return `${index + 1}. [${row.kind}] ${row.message}${detail}${row.count > 1 ? ` ×${row.count}` : ''} · 最近 ${when}`;
    });
    return [`🩺 最近的问题（共 ${reporter.total()} 次）`, ...lines, `日志：${reporter.file}`].join('\n');
}
/** One-line summary for `/status`, or null when there is nothing to say. */
export function problemsSummary(reporter, withinMs = 24 * 60 * 60 * 1000) {
    const count = reporter.recentCount(withinMs);
    if (count === 0)
        return null;
    return `⚠️ 最近 24 小时有 ${count} 类问题（/problems 看详情）`;
}
//# sourceMappingURL=problems.js.map