/** What the host measured for one session. All fields optional on purpose. */
export interface ContextUsage {
    /** The model's context window in tokens. */
    contextWindow?: number;
    /** Everything the next request will carry (system + tools + messages). */
    pressureTokens?: number;
    /** The live message surface only. */
    surfaceTokens?: number;
    /** System prompt tokens, when the host breaks the total down. */
    systemTokens?: number;
    /** Tool catalog tokens. */
    toolsTokens?: number;
    /** Message tokens (same measure as {@link surfaceTokens}). */
    messageTokens?: number;
}
/** Compaction settings, as far as the preset states them. */
export interface CompactionPolicy {
    thresholdRatio: number;
    retainRatio: number;
    /** `preset` = read from the preset file, `default` = the plugin's own default. */
    source: 'preset' | 'default';
}
/**
 * The compaction defaults of `@deepseek-ai/dsh-compaction-basic`. Used when a
 * preset mounts the row without a `config:` block (which is what the plugin
 * itself would do), so the report can still state a real trigger point instead
 * of hand-waving — and labels it as a default so it never claims precision the
 * preset does not have.
 */
export declare const DEFAULT_COMPACTION: Omit<CompactionPolicy, 'source'>;
export declare function dshHome(): string;
/** Raw projection rows for one session, or undefined when unavailable. */
export declare function readContextUsage(sessionId: string): ContextUsage | undefined;
/** How many turns the session has recorded, when the projection says. */
export declare function readTurnCount(sessionId: string): number | undefined;
/**
 * The compaction ratios in force, read from the agent preset the bridge runs.
 *
 * A preset that mounts `compaction-basic` without a `config:` block is running
 * the plugin defaults, which is the normal case here — hence the `source` field
 * so the report can say which of the two it is instead of implying precision it
 * does not have.
 */
export declare function readCompactionPolicy(presetId: string): CompactionPolicy | undefined;
/** `1_000_000` → `100 万`, `15947` → `1.6 万`, `800_000` → `80 万`, `3547` → `3547`. */
export declare function formatTokens(value: number): string;
export interface ContextReportInput {
    sessionId: string;
    turns?: number;
    usage?: ContextUsage;
    /** Facts currently in long-term memory. */
    memoryFacts: number;
    compaction?: CompactionPolicy;
}
/**
 * The report the owner sees for `/context`.
 *
 * Kept in one place, and pure, so the wording (and the arithmetic behind it) can
 * be tested without a host, a session, or a projection file.
 */
export declare function formatContextReport(input: ContextReportInput): string;
//# sourceMappingURL=context-report.d.ts.map