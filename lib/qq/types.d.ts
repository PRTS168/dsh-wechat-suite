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
export declare const QQ_API_BASE = "https://api.bot.qq.com";
/** 换 access_token。 */
export declare const QQ_TOKEN_PATH = "/app/getAppAccessToken";
/** 拿 WebSocket 接入点。 */
export declare const QQ_GATEWAY_PATH = "/gateway";
/** 单聊发消息（被动回复必带 msg_id）。 */
export declare function qqC2CMessagesPath(userOpenid: string): string;
/**
 * 事件位掩码。
 *
 * `GROUP_AND_C2C_EVENT` 同时覆盖**单聊与群聊**：intents 层面分不开，只能靠事件
 * 的 `t` 字段过滤。只做单聊时这就是全部所需。
 */
export declare const QQ_INTENT_GROUP_AND_C2C: number;
export declare const QQ_INTENT_INTERACTION: number;
/** WebSocket opcode。没有 3/4/5/8。 */
export declare const QQ_OP: {
    readonly DISPATCH: 0;
    readonly HEARTBEAT: 1;
    readonly IDENTIFY: 2;
    readonly RESUME: 6;
    readonly RECONNECT: 7;
    readonly INVALID_SESSION: 9;
    readonly HELLO: 10;
    readonly HEARTBEAT_ACK: 11;
};
/** 官方默认心跳间隔（毫秒），HELLO 会给实际值。 */
export declare const QQ_DEFAULT_HEARTBEAT_MS = 45000;
/** 提前多久换 token：到期前 60 秒内请求会拿到新 token。 */
export declare const QQ_TOKEN_REFRESH_MARGIN_MS = 60000;
/** 消息类型：0 = 文本。 */
export declare const QQ_MSG_TYPE_TEXT = 0;
/** 单聊被动回复：每条用户消息最多回 4 次（群聊 5 次）。 */
export declare const QQ_C2C_PASSIVE_REPLY_LIMIT = 4;
/** 单聊事件名。 */
export declare const QQ_EVENT_C2C_MESSAGE = "C2C_MESSAGE_CREATE";
/** 群聊事件名（本阶段不处理，留作过滤用）。 */
export declare const QQ_EVENT_GROUP_AT_MESSAGE = "GROUP_AT_MESSAGE_CREATE";
export declare const QQ_EVENT_GROUP_MESSAGE = "GROUP_MESSAGE_CREATE";
/** 换 token 的响应。`expires_in` 官方示例是字符串，字段声明却是数字。 */
export interface QqAccessTokenResponse {
    access_token?: string;
    expires_in?: number | string;
}
/** `/gateway` 的响应。 */
export interface QqGatewayResponse {
    url?: string;
    shards?: number;
    session_start_limit?: {
        total?: number;
        remaining?: number;
        reset_after?: number;
        max_concurrency?: number;
    };
}
/** 下行通用信封。 */
export interface QqPayload<T = unknown> {
    id?: string;
    op: number;
    d?: T;
    s?: number;
    t?: string;
}
/** HELLO 的 d。 */
export interface QqHello {
    heartbeat_interval?: number;
}
/** READY 的 d；`session_id` 必须持久化，断线重连靠它 Resume。 */
export interface QqReady {
    session_id?: string;
    user?: {
        id?: string;
        username?: string;
        bot?: boolean;
    };
    shard?: [number, number];
}
/** 单聊消息事件的 d。 */
export interface QqC2CMessageEvent {
    id?: string;
    content?: string;
    /** RFC3339 字符串（如 "2026-07-21T10:00:00+08:00"），没有毫秒字段。 */
    timestamp?: string;
    author?: {
        /** per-AppID 的唯一用户标识；白名单里存的就是它。 */
        user_openid?: string;
        id?: string;
    };
}
/** 发消息请求体。 */
export interface QqSendMessageBody {
    content: string;
    msg_type: number;
    /** 被动回复必带：来自事件的 d.id。 */
    msg_id?: string;
    /** 同一条 msg_id 下的第几次回复；相同的 msg_id+msg_seq 会被去重。 */
    msg_seq?: number;
}
/** 发消息响应（失败时 errcode 有值）。 */
export interface QqSendMessageResponse {
    id?: string;
    timestamp?: number | string;
    errcode?: number;
    message?: string;
}
/** 官方错误码里与网关最相关的几个（完整表见调研笔记第 8 节）。 */
export declare const QQ_ERRCODE: {
    /** 被动回复时间或次数超限。 */
    readonly PASSIVE_REPLY_EXCEEDED: 40034128;
    /** 消息（被动回复窗口）已过期。 */
    readonly MESSAGE_EXPIRED: 40034005;
    /** 相同的 msg_id + msg_seq 被去重。 */
    readonly DUPLICATE_MESSAGE: 40054005;
};
//# sourceMappingURL=types.d.ts.map