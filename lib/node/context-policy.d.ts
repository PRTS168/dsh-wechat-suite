/**
 * Context-management policy for the WeChat conversation.
 *
 * The bridge used to have exactly one behaviour: the conversation grows until a
 * human types `/new`. That is how a single WeChat session accumulated 60 turns
 * and ~3000 events by 2026-09-12 — and a long, chat-shaped transcript is where
 * the model started autocompleting its own "next user message" (it fabricated
 * `[发送于 …] 视频呢？发个` and obeyed it).
 *
 * This module is the decision half of the fix: `rotationReason()` answers "should
 * this conversation be rotated now, and why", from signals the node can read
 * without new host APIs. The policy itself is JSON so the standalone admin page
 * (admin/server.ts) can switch schemes without a schema change per knob:
 *
 *   {"scheme":"rotate-turns","turns":20,"idleOnly":true,"announce":true,"handoff":true}
 *
 * Schemes: manual | rotate-turns | rotate-turns+handoff | rotate-pressure | daily
 *
 * @module @dsh-cowork/chatnode-wechat/node/context-policy
 */
export declare const POLICY_SCHEMES: readonly ["manual", "rotate-turns", "rotate-turns+handoff", "rotate-pressure", "rotate-tokens", "daily"];
export type PolicyScheme = (typeof POLICY_SCHEMES)[number];
export interface ContextPolicy {
    scheme: PolicyScheme;
    /** rotate-turns / rotate-turns+handoff: rotate once this many turns completed. */
    turns?: number;
    /** rotate-pressure: fraction of `CONTEXT_WINDOW_CHARS` that triggers rotation. */
    pressureRatio?: number;
    /**
     * rotate-tokens: rotate once the session's context reaches this many tokens.
     * Free-form. Read from the DSH session projection when it is available (real
     * numbers, see `contextPressure.surfaceTokens`), and from the character proxy
     * otherwise — the reason line says which one fired.
     */
    tokenBudget?: number;
    /** daily: rotate when the gap since the last activity reaches this many hours. */
    idleHours?: number;
    /** Carry a handoff note into the new session (no extra model call). */
    handoff?: boolean;
    /** Say so in the chat when a rotation happens. */
    announce?: boolean;
    /** Never rotate while a turn is open (only meaningful with the guard below). */
    idleOnly?: boolean;
}
/** Defaults for every knob; `manual` keeps today's behaviour. */
export declare const DEFAULT_POLICY: ContextPolicy;
/**
 * Characters per token used when only the character proxy is available.
 *
 * Deliberately conservative for mixed Chinese/English (Chinese runs closer to
 * 1.5 chars/token, English to 4): under-counting the context would let a session
 * grow past its budget. The token scheme prefers real projection numbers and
 * only lands here when they cannot be read.
 */
export declare const CHARS_PER_TOKEN = 2;
/**
 * Context-size proxy that needs no host projection API.
 *
 * `rotate-pressure` compares the serialized size of the session's events against
 * this budget. It is deliberately a *proxy*: the real window is measured by the
 * model adapter, but event bytes are what the bridge can read from the same
 * `snapshotEvents()` call it already uses, on every host version. 400k characters
 * is roughly a 100k-token mixed Chinese/English conversation.
 */
export declare const CONTEXT_WINDOW_CHARS = 400000;
/** Parse the JSON policy out of config; anything unusable degrades to manual. */
export declare function parseContextPolicy(raw: string | undefined | null): ContextPolicy;
export interface RotationSignals {
    /** Completed turns in the active session. */
    turns: number;
    /** Serialized size of the session's events (context proxy). */
    contextChars: number;
    /** Minutes since the last completed turn (or session creation). */
    idleMinutes: number;
    /** A turn is currently open — rotating now would tear it in half. */
    turnOpen: boolean;
    /**
     * Real context size in tokens, when the host's session projection could be
     * read. Absent means "unknown" — the token scheme then falls back to the
     * character proxy and says so in its reason.
     */
    contextTokens?: number;
}
/**
 * Why the active conversation should be rotated, or undefined to keep it.
 * Pure: same inputs, same answer; the node does the acting.
 */
export declare function rotationReason(policy: ContextPolicy, signals: RotationSignals): string | undefined;
/**
 * Minimal structural view of a session event.
 *
 * `data` stays `unknown` on purpose: the host's `SessionEvent` is a large union
 * (every event type carries its own payload), so a narrower field list here
 * would make the real events unassignable. The readers below narrow it.
 */
interface EventLike {
    type?: string;
    time?: number;
    data?: unknown;
}
/**
 * Rotation signals from a session's events.
 *
 * Both knobs read the SAME `snapshotEvents()` call the bridge already makes, so
 * this works on every host version it supports — no projection API, no token
 * meter. `contextChars` is an estimate (message text plus a fixed allowance per
 * non-message event), which is why the pressure scheme documents itself as a
 * proxy rather than a meter.
 */
export declare function signalsFromEvents(events: readonly EventLike[], now?: Date): RotationSignals;
/** User/assistant lines worth carrying into a handoff note (oldest first). */
export declare function transcriptFromEvents(events: readonly EventLike[]): TranscriptLine[];
/** Opening fence of an automatic handoff note (deliberately NOT the user fence). */
export declare const HANDOFF_OPEN = "<<<\u4F1A\u8BDD\u4EA4\u63A5\u6458\u8981\u00B7\u975E\u7528\u6237\u6307\u4EE4>>>";
/** Closing fence of a handoff note. */
export declare const HANDOFF_CLOSE = "\u4F1A\u8BDD\u4EA4\u63A5\u6458\u8981\u7ED3\u675F";
export interface TranscriptLine {
    role: 'user' | 'assistant';
    text: string;
}
/**
 * Build the handoff note carried into the rotated session.
 *
 * Deliberately deterministic — no extra model call, no extra latency, and the
 * same history always yields the same note. It is fenced with its OWN markers
 * (not the user fence), and says so, so the persona's hard rules classify it as
 * background rather than as an instruction: a rotation must never look like the
 * owner asking for something.
 */
export declare function buildHandoff(lines: TranscriptLine[], reason: string, options?: {
    maxMessages?: number;
}): string;
export {};
//# sourceMappingURL=context-policy.d.ts.map