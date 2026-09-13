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
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatConversationNode } from './core.ts';
/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export declare function normalizeMarkdownBlocks(content: string): string;
/** Split content into markdown blocks, keeping fenced code blocks intact. */
export declare function splitMarkdownBlocks(content: string): string[];
/** Split assistant text into WeChat delivery units (≤max each). */
export declare function splitForWechat(content: string, max?: number): string[];
/** Extract the visible text of an assistant message. */
export declare function textOfAssistantMessage(message: AssistantMessage): string;
/** One-line progress summary derived from the session log (cheap, replayable). */
export declare function digestLine(session: Session, badge?: string): string;
/** Convert markdown (model output) into a WeChat-friendly plain rendering.
 *  WeChat renders no markdown, so fences, emphasis markers, table pipes, and
 *  ATX headings would show as raw punctuation. This strips the syntax while
 *  keeping readable structure: code becomes an indented block, tables become
 *  aligned rows, headings get blank-line separation, and inline emphasis /
 *  code / links lose their markers.
 */
export declare function markdownToWechat(content: string): string;
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
export declare function sendTextToPeer(node: WechatConversationNode, text: string): Promise<boolean>;
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session, so switching sessions mid-flight is
 * safe (per-session digest state is keyed by session id).
 */
export declare function attachSessionOutbound(node: WechatConversationNode): () => void;
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
export declare function sanitizeAssistantText(text: string): {
    text: string;
    echoed: boolean;
};
//# sourceMappingURL=outbound.d.ts.map