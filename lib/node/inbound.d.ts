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
import { type InboundMessage } from '../gateway/types.ts';
import type { WechatConversationNode } from './core.ts';
/** Opening fence of one inbound user message handed to the model. */
export declare const USER_MESSAGE_OPEN = "<<<\u5FAE\u4FE1\u7528\u6237\u6D88\u606F>>>";
/** Label inside the closing fence (the send time rides along with it). */
export declare const USER_MESSAGE_CLOSE = "\u5FAE\u4FE1\u7528\u6237\u6D88\u606F\u7ED3\u675F";
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
export declare function wrapUserMessage(content: string, date?: Date): string;
/** Whether a message is a group/room message (MVP: not supported). */
export declare function isGroupMessage(message: InboundMessage, accountId: string): boolean;
/** Extract the visible text of an inbound message (text + voice transcription). */
export declare function extractText(message: InboundMessage): string;
/** Rotate the OCR diagnostics past this size, keeping one previous file. */
export declare const OCR_LOG_LIMIT_BYTES: number;
/** Handle one inbound iLink message. */
export declare function handleInbound(node: WechatConversationNode, message: InboundMessage): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map