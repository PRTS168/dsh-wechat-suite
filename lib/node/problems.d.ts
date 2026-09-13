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
/** Append-only problem log (one line per occurrence). */
export declare const PROBLEM_FILE = "wechat-problems.log";
/** Rotate once the log passes this size; one previous file is kept. */
export declare const PROBLEM_LOG_LIMIT_BYTES: number;
/** Distinct problems kept in memory for `/problems`. */
export declare const PROBLEM_MEMORY_LIMIT = 50;
/** How many occurrences of one signature the memory keeps counting. */
export declare const PROBLEM_OCCURRENCE_CAP = 9999;
/** Default location of the problem log. */
export declare function defaultProblemFile(): string;
/** One distinct problem, with how often and how recently it fired. */
export interface ProblemRecord {
    /** Stable category, e.g. `inbound/media`, `model`, `memory`, `gateway`. */
    kind: string;
    /** Human-readable one-liner (already unwrapped from `cause` chains). */
    message: string;
    /** Extra context: session id, path, peer… */
    detail: string;
    count: number;
    firstAt: string;
    lastAt: string;
    /** Whether the owner was told about it in WeChat. */
    notified: boolean;
}
export interface ProblemOptions {
    /** Extra context stored with the problem (session, path, message id…). */
    detail?: string;
    /**
     * Tell the owner in WeChat. Default true for problems he would otherwise
     * experience as silence; pass false for noise like a transient retry that a
     * later attempt already covered.
     */
    notify?: boolean;
}
export interface ProblemReporterOptions {
    file?: string;
    /** Clock override for tests. */
    now?: () => Date;
    /** Same signature is announced at most once per this window. */
    notifyWindowMs?: number;
    /** Hard ceiling on WeChat notices per hour, whatever happens. */
    maxNoticesPerHour?: number;
    /** Deliver one notice to the owner (wired to `sendTextToPeer`). */
    notify?: (text: string) => void;
    /** Extra sink for the host logger. */
    logger?: (level: 'warn' | 'error', text: string) => void;
}
/**
 * Collects failures without ever failing itself.
 *
 * One instance lives on the node (`node.problems`) so the whole bridge shares
 * one ledger; modules that cannot reach the node take it as an optional field.
 */
export declare class ProblemReporter {
    readonly file: string;
    private readonly now;
    private readonly notifyWindowMs;
    private readonly maxNoticesPerHour;
    private notifyOwner;
    private logger;
    private readonly records;
    private readonly lastNoticeAt;
    private noticeTimes;
    private lastRotateCheck;
    constructor(options?: ProblemReporterOptions);
    /** Wire the WeChat notice channel once the node is ready. */
    setNotifier(notify: ((text: string) => void) | undefined): void;
    /** Wire the host logger. */
    setLogger(logger: ((level: 'warn' | 'error', text: string) => void) | undefined): void;
    /**
     * Record one failure. Returns the roll-up row so callers can log it too.
     *
     * `error` may be anything: an Error, a rejection reason, or a plain string
     * (some host paths reject with objects), and all of them come out readable.
     */
    report(kind: string, error: unknown, options?: ProblemOptions): ProblemRecord;
    /** Newest-first snapshot of the distinct problems seen. */
    recent(limit?: number): ProblemRecord[];
    /** Problems last seen within `withinMs` (used by `/status`). */
    recentCount(withinMs: number): number;
    /** Total occurrences recorded since the process started. */
    total(): number;
    /** Forget the in-memory roll-up (the log file stays). */
    clear(): void;
    /**
     * One notice per signature per window, plus an hourly ceiling.
     *
     * The ceiling is what keeps a broken dependency from becoming a flood: the
     * owner should learn about a problem once, not once per message.
     */
    private buildNotice;
    /** Append one line, rotating first when the log has grown past the cap. */
    private append;
    private rotateIfNeeded;
    /** Keep the roll-up bounded; the oldest row is the one that goes. */
    private trimRecords;
}
/**
 * Human-readable `/problems` answer.
 *
 * Kept pure so the wording is testable without a filesystem or a bridge.
 */
export declare function formatProblems(reporter: ProblemReporter, limit?: number): string;
/** One-line summary for `/status`, or null when there is nothing to say. */
export declare function problemsSummary(reporter: ProblemReporter, withinMs?: number): string | null;
//# sourceMappingURL=problems.d.ts.map