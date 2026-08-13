/**
 * WechatConversationNode — the orchestration state behind the
 * `wechat-conversation-node` plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 *
 * @module @dsh-cowork/chatnode-wechat/node/core
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { attachApprovalBridge } from "./approvals.js";
import { attachSessionOutbound, sendTextToPeer } from "./outbound.js";
import { handleInbound } from "./inbound.js";
import { listSessions, newSessionId } from "./commands.js";
export class WechatConversationNode {
    /** The active session the WeChat user drives. */
    activeSessionId = null;
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId = null;
    pending = new Map();
    approvalCounter = 0;
    disposers = [];
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
            throw new Error('dsh-chatnode-wechat: allowFrom is REQUIRED and must list at least one WeChat sender id. ' +
                'An agent that accepts instructions from any WeChat contact is a prompt-injection front door.');
        }
        this.disposers.push(attachSessionOutbound(this));
        this.disposers.push(attachApprovalBridge(this));
        this.ctx.on('wechat/message', (message) => {
            void handleInbound(this, message);
        });
        this.pickDefaultSession();
    }
    /** The active session, if any. */
    activeSession() {
        if (!this.activeSessionId)
            return undefined;
        return this.ctx.sessions.get(this.activeSessionId);
    }
    /** The agent driving the active session, if any. */
    activeAgent() {
        const session = this.activeSession();
        if (!session)
            return undefined;
        return this.ctx.agents.get(session.id);
    }
    /** Whether this node drives the given agent (its session is active). */
    ownsAgent(agent) {
        return this.activeSessionId !== null && agent.session.id === this.activeSessionId;
    }
    /** Whether a sender is allowlisted. */
    isAllowed(senderId) {
        return this.config.allowFrom.includes(senderId);
    }
    /** The gateway's own account id (used for group detection). */
    get gatewayAccountId() {
        return this.ctx.wechat.accountId;
    }
    /** Switch the active session and reply confirmation to the peer. */
    setActiveSession(session) {
        this.activeSessionId = session.id;
    }
    /** Pick the most recent session as the default (zero-config targeting). */
    pickDefaultSession() {
        const sessions = listSessions(this);
        if (sessions.length > 0)
            this.activeSessionId = sessions[0].id;
    }
    /** Create a fresh agent+session via the agent factory and make it active. */
    async createSession(prompt) {
        const sessionId = newSessionId(this);
        const meta = {};
        if (this.config.cwd)
            meta.cwd = this.config.cwd;
        if (this.config.agentPreset)
            meta.agentPreset = this.config.agentPreset;
        try {
            const handle = await this.ctx.agents.create({
                sessionId,
                meta,
                agentOptions: {
                    ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
                    ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
                },
            });
            this.activeSessionId = handle.agent.session.id;
            if (prompt) {
                handle.agent.followup(createUserMessage({
                    content: [{ type: 'text', text: prompt }],
                    source: { kind: 'user' },
                }));
            }
            await sendTextToPeer(this, `✅ 已创建新会话 ${handle.agent.session.id}${prompt ? '，开始处理…' : '（无初始提示词）'}`);
        }
        catch (error) {
            await sendTextToPeer(this, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // -------------------------------------------------------------------------
    // Pending approvals
    // -------------------------------------------------------------------------
    nextApprovalNumber() {
        this.approvalCounter += 1;
        return this.approvalCounter;
    }
    registerApproval(number, approval) {
        this.pending.set(number, approval);
    }
    clearApproval(number) {
        const entry = this.pending.get(number);
        if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(number);
        }
    }
    /**
     * Resolve a pending approval from a WeChat reply. `/yes` and `/no` answer
     * the most recent pending request; bare `1`/`2` only while exactly one is
     * pending (1 = allow, 2 = reject). Returns false when the text is not an
     * approval reply.
     */
    resolveApproval(text) {
        const entries = [...this.pending.entries()];
        if (entries.length === 0)
            return false;
        const outcome = text === '/yes' ? 'allowed-once'
            : text === '/no' ? 'rejected'
                : undefined;
        if (outcome) {
            const [number, entry] = entries[entries.length - 1];
            this.clearApproval(number);
            entry.resolve(outcome);
            return true;
        }
        if ((text === '1' || text === '2') && entries.length === 1) {
            const [number, entry] = entries[0];
            this.clearApproval(number);
            entry.resolve(text === '1' ? 'allowed-once' : 'rejected');
            return true;
        }
        return false;
    }
    /** Tear down all registered listeners (called on plugin dispose). */
    dispose() {
        for (const disposer of this.disposers)
            disposer();
        this.disposers = [];
        for (const number of [...this.pending.keys()])
            this.clearApproval(number);
    }
}
//# sourceMappingURL=core.js.map