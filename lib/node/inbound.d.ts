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
/** Whether a message is a group/room message (MVP: not supported). */
export declare function isGroupMessage(message: InboundMessage, accountId: string): boolean;
/** Extract the visible text of an inbound message (text + voice transcription). */
export declare function extractText(message: InboundMessage): string;
/** Handle one inbound iLink message. */
export declare function handleInbound(node: WechatConversationNode, message: InboundMessage): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map