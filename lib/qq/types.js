/**
 * QQ 官方机器人 API v2 的常量与线格式类型。
 *
 * 只收录单聊网关要用的部分；群聊、频道、富媒体的字段先留类型占位，等用到再加。
 * 每个数值都来自官方文档，整理笔记不随仓库发布，其中「不确定项」一节列了文档没写清、
 * 需要实测的地方 —— 本文件不猜：拿不准的一律标 `TODO(实测)`，等真机验证后再定。
 *
 * @module @dsh-cowork/chatnode-wechat/qq/types
 */
/** 统一域名（2026-08-10 变更记录：所有接口调用域名统一为 api.bot.qq.com）。 */
export const QQ_API_BASE = 'https://api.bot.qq.com';
/** 换 access_token。 */
export const QQ_TOKEN_PATH = '/app/getAppAccessToken';
/** 拿 WebSocket 接入点。 */
export const QQ_GATEWAY_PATH = '/gateway';
/** 单聊发消息（被动回复必带 msg_id）。 */
export function qqC2CMessagesPath(userOpenid) {
    return `/v2/users/${encodeURIComponent(userOpenid)}/messages`;
}
/**
 * 事件位掩码。
 *
 * `GROUP_AND_C2C_EVENT` 同时覆盖**单聊与群聊**：intents 层面分不开，只能靠事件
 * 的 `t` 字段过滤。只做单聊时这就是全部所需。
 */
export const QQ_INTENT_GROUP_AND_C2C = 1 << 25; // 33554432
export const QQ_INTENT_INTERACTION = 1 << 26; // 67108864
/** WebSocket opcode。没有 3/4/5/8。 */
export const QQ_OP = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
};
/** 官方默认心跳间隔（毫秒），HELLO 会给实际值。 */
export const QQ_DEFAULT_HEARTBEAT_MS = 45_000;
/** 提前多久换 token：到期前 60 秒内请求会拿到新 token。 */
export const QQ_TOKEN_REFRESH_MARGIN_MS = 60_000;
/** 消息类型：0 = 文本。 */
export const QQ_MSG_TYPE_TEXT = 0;
/** 单聊被动回复：每条用户消息最多回 4 次（群聊 5 次）。 */
export const QQ_C2C_PASSIVE_REPLY_LIMIT = 4;
/** 单聊事件名。 */
export const QQ_EVENT_C2C_MESSAGE = 'C2C_MESSAGE_CREATE';
/** 群聊事件名（本阶段不处理，留作过滤用）。 */
export const QQ_EVENT_GROUP_AT_MESSAGE = 'GROUP_AT_MESSAGE_CREATE';
export const QQ_EVENT_GROUP_MESSAGE = 'GROUP_MESSAGE_CREATE';
/** 官方错误码里与网关最相关的几个（完整表见调研笔记第 8 节）。 */
export const QQ_ERRCODE = {
    /** 被动回复时间或次数超限。 */
    PASSIVE_REPLY_EXCEEDED: 40034128,
    /** 消息（被动回复窗口）已过期。 */
    MESSAGE_EXPIRED: 40034005,
    /** 相同的 msg_id + msg_seq 被去重。 */
    DUPLICATE_MESSAGE: 40054005,
};
//# sourceMappingURL=types.js.map