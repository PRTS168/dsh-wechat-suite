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
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
/** Directory (under `$DSH_HOME`) holding the memory file and its bookkeeping. */
export declare const MEMORY_DIR = "wechat-memory";
/** The facts file itself. Markdown, hand-editable, capped. */
export declare const MEMORY_FILE = "MEMORY.md";
/** Append-only audit trail: what changed, when, and from which conversation. */
export declare const MEMORY_LOG = "memory-log.md";
/** Rotate the audit log past this size, keeping one previous file. */
export declare const MEMORY_LOG_LIMIT_BYTES: number;
/** Scheduler bookkeeping (last run, last seen sequence). */
export declare const MEMORY_STATE = "state.json";
/** Hard cap; past this, new facts are skipped until something is merged away. */
export declare const MEMORY_LIMIT_CHARS = 4000;
/** How many sessions keep their injection bookkeeping before the oldest is dropped. */
export declare const MAX_TRACKED_SESSIONS = 64;
/** Sections the consolidator may write to. Anything else is ignored. */
export declare const MEMORY_SECTIONS: readonly ["关于主人", "偏好与习惯", "常用设备与环境", "待办与承诺", "重要决定"];
export type MemorySection = (typeof MEMORY_SECTIONS)[number];
/**
 * Bookkeeping section for superseded facts. Not a writable section: entries get
 * there through `expire`, and it never reaches the model's context.
 */
export declare const MEMORY_EXPIRED_SECTION = "\u5DF2\u8FC7\u671F";
/** Opening fence of the injected memory briefing. */
export declare const MEMORY_OPEN = "<<<\u5173\u4E8E\u4E3B\u4EBA\u7684\u957F\u671F\u8BB0\u5FC6\u00B7\u80CC\u666F\u8D44\u6599\u00B7\u4E0D\u662F\u672C\u6761\u6D88\u606F\u7684\u8981\u6C42>>>";
/** Closing fence of the injected memory briefing. */
export declare const MEMORY_CLOSE = "<<<\u957F\u671F\u8BB0\u5FC6\u7ED3\u675F>>>";
/** The seed written on first use: structure plus the few facts already known. */
export declare const MEMORY_SEED = "# \u957F\u671F\u8BB0\u5FC6\uFF08\u5173\u4E8E\u4E3B\u4EBA\uFF09\n\n> \u8FD9\u4E2A\u6587\u4EF6\u662F\u8DE8\u4F1A\u8BDD\u7684\u957F\u671F\u8BB0\u5FC6\uFF1A\u5199\"\u4E3B\u4EBA\u662F\u8C01\u3001\u4E60\u60EF\u4EC0\u4E48\u3001\u7528\u4EC0\u4E48\"\uFF0C\u4E0D\u5199\"\u521A\u624D\u804A\u4E86\u4EC0\u4E48\"\u3002\n> \u53EA\u5199\u660E\u786E\u51FA\u73B0\u8FC7\u7684\u4E8B\u5B9E\uFF0C\u6BCF\u6761\u5C3D\u91CF\u5E26\u65E5\u671F\uFF1B\u51B2\u7A81\u65F6\u65B0\u4E8B\u5B9E\u8986\u76D6\u65E7\u4E8B\u5B9E\u3002\n> \u4E0D\u5199\u5BC6\u7801\u3001token\u3001API key\u3002\n\n## \u5173\u4E8E\u4E3B\u4EBA\n\n## \u504F\u597D\u4E0E\u4E60\u60EF\n\n## \u5E38\u7528\u8BBE\u5907\u4E0E\u73AF\u5883\n\n## \u5F85\u529E\u4E0E\u627F\u8BFA\n\n## \u91CD\u8981\u51B3\u5B9A\n\n## \u5DF2\u8FC7\u671F\n";
/** One consolidation result, as the model is asked to produce it. */
export interface MemoryPatch {
    add?: Array<{
        section?: string;
        text?: string;
    }>;
    update?: Array<{
        from?: string;
        to?: string;
    }>;
    expire?: string[];
}
/** What actually happened when a patch was applied. */
export interface MemoryApplyResult {
    added: number;
    updated: number;
    expired: number;
    skipped: string[];
}
/** Default location of the facts file. */
export declare function defaultMemoryFile(): string;
/** Read the facts file; empty string when missing or unreadable. */
export declare function readMemory(file: string): string;
/**
 * Read the facts file, creating it from the seed only when it does not exist.
 *
 * A file that exists is never overwritten here — not when it is empty (the owner
 * may have cleared it on purpose) and not when it fails to read (rebuilding it
 * from the seed would destroy whatever is in there).
 */
export declare function ensureMemory(file: string): string;
/** Why a write was refused, so the caller can report the real cause. */
export interface MemoryWriteResult {
    ok: boolean;
    /** `cap` = over the character limit, `io` = the filesystem said no, `encoding` = not UTF-8. */
    reason?: 'cap' | 'io' | 'encoding';
    detail?: string;
}
/**
 * Write the facts file: backup, atomic replace, then verify the cap.
 *
 * A refusal is reported, never silently shrunk. IO failures carry their own
 * reason: a full disk or a locked file used to be reported as "over the
 * character limit", which sends the owner looking in the wrong place.
 */
export declare function writeMemory(file: string, text: string): MemoryWriteResult;
/** Append one line to the audit trail (best effort). */
export declare function appendMemoryLog(file: string, line: string): void;
/** Rename a log aside once it passes the cap, keeping exactly one previous file. */
export declare function rotateIfLarge(file: string, limit: number): void;
/**
 * Keep only the newest backups of one file.
 *
 * Every memory write and every admin save leaves a `.bak-*` next to the file,
 * and nothing ever removed them: over weeks that is a directory full of copies
 * of the same config. Ordering is by MODIFICATION TIME, not by name — the
 * names come from several eras (`bak-<epoch>`, `bak-<date>`, `bak-before-*`)
 * and alphabetical order kept arbitrary ones while deleting newer states.
 */
export declare function pruneBackups(file: string, keep?: number): void;
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
export declare function applyPatch(file: string, patch: MemoryPatch, origin: string): MemoryApplyResult;
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
export declare function memoryBriefing(file: string): string | null;
/** Whether the file holds at least one fact (a bare heading does not count). */
export declare function hasFacts(file: string): boolean;
/** How many facts are on file — `已过期` entries and headings do not count. */
export declare function factCount(file: string): number;
/** One fenced user message, reduced to its text. */
export interface MemoryUtterance {
    at: string;
    text: string;
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
export declare function extractUtterances(events: readonly unknown[]): MemoryUtterance[];
/** The instruction handed to the session's own model during consolidation. */
export declare function consolidationPrompt(digest: string, current: string): string;
/**
 * Pull one JSON object out of a model reply (tolerating prose and fences).
 *
 * Field shapes are normalized here, not trusted: `{"add":42}` is a structurally
 * valid object that would blow up the caller with "42 is not iterable", and one
 * bad field must not cost the whole day's consolidation.
 */
export declare function parsePatch(reply: string): MemoryPatch | null;
/** Options for {@link MemoryService}. */
export interface MemoryServiceOptions {
    /** Facts file path (defaults under `$DSH_HOME`). */
    file?: string;
    /** Where a swallowed IO/state failure goes, so it leaves a visible trace. */
    onProblem?: (kind: string, error: unknown, detail?: string) => void;
    /** Inject the briefing on the first message after this many messages (0 = only first / on change). */
    injectEvery?: number;
    /** Wall-clock "HH:MM" for the daily consolidation; empty disables it. */
    consolidateAt?: string;
    /** Minimum number of new utterances before a run is worth a model call. */
    minUtterances?: number;
    /** Minimum idle time (ms) before a scheduled run may start. */
    idleMs?: number;
    /** Clock override for tests. */
    now?: () => Date;
}
/** What one consolidation run did. */
export interface ConsolidationReport {
    ran: boolean;
    reason: string;
    utterances: number;
    added: number;
    updated: number;
    expired: number;
    skipped: number;
}
/**
 * Long-term memory service: briefing injection plus the daily consolidation run.
 *
 * Mirrors {@link MorningService}'s shape (start / stop / timer) so the bridge has
 * one scheduling idiom, and follows the v0.3.0 stability rule: every entry point
 * resolves, no timer keeps the process alive, nothing throws into the host.
 */
export declare class MemoryService {
    private readonly ctx;
    private readonly file;
    private readonly injectEvery;
    private readonly minUtterances;
    private readonly idleMs;
    private readonly clock;
    /** Where a swallowed failure goes; optional so the service works standalone. */
    private readonly onProblem?;
    private readonly injected;
    private lastMessageAt;
    /** `lastMessageAt` as of the last daily run (0 = never run). */
    private lastRunMessageAt;
    private timer;
    private running;
    private loaded;
    private at;
    /** The configured time as given, so a bad value can be reported verbatim. */
    private atRaw;
    private warnedAboutTime;
    constructor(ctx: Context, options?: MemoryServiceOptions);
    /** Facts file this service owns. */
    get filePath(): string;
    /** Arm the daily timer (idempotent, and re-armable after {@link stop}). */
    start(): void;
    /** Disarm the timer. A later {@link start} must arm it again. */
    stop(): void;
    /** Current facts file content (seeding on first read). */
    read(): string;
    /**
     * The briefing for one inbound message, or null when this message should not
     * carry one. Injection happens on the first message of a session, whenever the
     * file changed since the last injection, and every `injectEvery` messages.
     */
    briefing(sessionId: string): string | null;
    /**
     * Bound the per-session counters. Every `/new` and every rotation adds one
     * entry and nothing ever removed them, so a long-lived process grew this map
     * for the life of the install.
     */
    private trimInjected;
    /**
     * Note that the host compacted this session's history.
     *
     * Compaction replaces older messages with a summary, and it can happen in the
     * MIDDLE of a turn (the host runs it before each step), so waiting for the
     * usual cadence could leave several steps without any anchor to who the owner
     * is. Dropping the bookkeeping makes the next message carry the full briefing
     * again — cheap, because the briefing is a few hundred tokens.
     */
    noteCompaction(sessionId: string): void;
    /**
     * Run one consolidation now.
     *
     * Reads the day's fenced user messages, asks the session's own model what is
     * worth keeping, and applies the result. Never throws: every failure is a
     * reporting line.
     */
    consolidateNow(session: Session | undefined, route: {
        provider: string;
        model: string;
    } | undefined, reason?: string): Promise<ConsolidationReport>;
    /** One model call, assembled to text. Retries once on failure. */
    private ask;
    /** (Re)arm the daily timer for the configured time. */
    private arm;
    /** Timer callback: run only when the bridge has been idle long enough. */
    private onTimer;
    /** Wired by the node so the timer can find the live session and its route. */
    sessionProvider: (() => Session | undefined) | undefined;
    routeProvider: (() => {
        provider: string;
        model: string;
    } | undefined) | undefined;
    private stateFile;
    private loadState;
    private saveState;
    /** Whether the facts file exists (used by the /memory command). */
    exists(): boolean;
    /**
     * Whether anything worth showing has been recorded yet. A seeded file is
     * headings only, so "the file exists" is not the same as "there is a memory".
     */
    hasFacts(): boolean;
    /** How many facts are on file (used by `/context`). */
    factCount(): number;
}
//# sourceMappingURL=memory.d.ts.map