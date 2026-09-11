/**
 * 会话显示标签：微信状态消息里统一携带的「名称 + id」前缀。
 *
 * 优先级：`sessionTitle` 服务的最新真实标题（与 Web 侧边栏一致，含用户
 * 手动重命名）→ 首条用户消息的前 24 字回退标签。会话 id 始终保留，便于
 * 在 Web GUI 中唯一定位对应会话。
 *
 * @module @dsh-cowork/chatnode-wechat/node/labels
 */
/** 首条用户消息的前 24 字，作为标题尚未生成时的回退标签。 */
export function firstPromptLabel(session) {
    // `session.events` 在 DSH 0.1.5 被移除，改为显式快照 API：
    // snapshotEvents() 返回全量不可变快照（ownEvents() 只给当前会话自有事件，
    // 不含 fork 继承的前缀）。
    for (const event of session.snapshotEvents()) {
        if (event.type === 'user/message') {
            const blocks = event.data.content;
            const text = blocks
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join(' ')
                .trim();
            if (text)
                return text.length > 24 ? `${text.slice(0, 24)}…` : text;
        }
    }
    return '(空会话)';
}
/** 会话名称：真实标题优先，标题未生成（或服务不可用）时回退首条消息标签。 */
export function sessionName(node, session) {
    // 用 ctx.get() 而不是 ctx.sessionTitle：该服务是可选的（不进 inject），
    // 而 cordis 的代理属性访问对未注入的服务会抛
    // "cannot get property ... without inject"，ctx.get() 则返回 undefined。
    const service = node.ctx.get('sessionTitle');
    const title = service?.get(session)?.title;
    if (title)
        return title;
    return firstPromptLabel(session);
}
/** 状态消息统一前缀：`【名称 · id】`，名称与 id 均不省略。 */
export function sessionBadge(node, session) {
    return `【${sessionName(node, session)} · ${session.id}】`;
}
//# sourceMappingURL=labels.js.map