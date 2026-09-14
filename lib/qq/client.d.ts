/**
 * QQ 官方机器人 API v2 的 REST 客户端：换 token、拿接入点、发单聊消息。
 *
 * 只做三件事，其余交给上层：
 * - 缓存 access_token（有效期内重复请求返回同一个，所以缓存是必须的；
 *   到期前 60 秒内重取，见 QQ_TOKEN_REFRESH_MARGIN_MS）；
 * - 把传输层的失败翻译成人能读的一句话（`fetch failed` 本身没有信息量）；
 * - 把 iLink 那边学到的教训照搬过来：**不自己算 Content-Length**，交给 undici。
 *
 * 刻意不做运行时的官方 SDK 依赖：调研结论是那个包只有三个版本号、无公开仓库、
 * 且默认域名已与文档分叉（见笔记第 9 节）。协议本身很简单，自己写更可控。
 *
 * @module @dsh-cowork/chatnode-wechat/qq/client
 */
export interface QqApiOptions {
    appId: string;
    clientSecret: string;
    /** 覆盖接口域名（沙箱或测试用假服务器）。 */
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
export interface QqSendOutcome {
    success: boolean;
    /** 失败时的原因；成功时不填。 */
    error?: string;
    /** 官方错误码，便于上层区分"被动回复超限"与"消息过期"。 */
    errcode?: number;
    /** 成功时官方返回的消息 id。 */
    messageId?: string;
}
/**
 * 把 `fetch failed` 背后的真实原因挖出来。
 *
 * undici 把所有传输失败都报成一句 `TypeError: fetch failed`，真正的原因
 * （ENOTFOUND / ECONNREFUSED / TLS / 超时）藏在 `cause` 里；不解开它，日志里
 * 就只剩一句没有信息量的话。
 */
export declare function describeFetchError(error: unknown): string;
export declare class QqApiClient {
    private token;
    /**
     * 连接池疑似中毒时置位；**下一次**请求改走新建连接。
     *
     * 刻意是"换路"而不是"立刻重发"：发消息不保证幂等，重发会产生重复气泡。失败当前这一条，
     * 让后续请求换条路走，最多只多花调用方自己那一次重试 —— 与微信侧完全同一套取舍。
     */
    private preferDirectConnection;
    /**
     * 显式字段 + 构造函数里赋值，而不是 TypeScript 的"参数属性"（`constructor(private
     * readonly opts: …)`）：后者在 Node 的类型擦除模式下会直接抛
     * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，而本仓库的测试就是 `node --test test/*.test.ts`
     * 跑 `.ts` 源码 —— 用了参数属性，任何 import 这个文件的测试都会在加载阶段崩掉。
     */
    private readonly opts;
    constructor(opts: QqApiOptions);
    /** 连接池当前是否被判定为不可信（测试用）。 */
    get usesFreshConnections(): boolean;
    private get base();
    private request;
    /**
     * 当前的 access_token。
     *
     * 官方语义：有效期内重复请求返回**同一个** token；到期前 60 秒内请求会给新的。
     * 所以缓存按 `expires_in` 计时，提前 QQ_TOKEN_REFRESH_MARGIN_MS 失效。
     */
    accessToken(): Promise<string>;
    /** WebSocket 接入点。 */
    gatewayUrl(): Promise<string>;
    /**
     * 发一条单聊文本。
     *
     * 带 `msgId` 就是**被动回复**（对某条用户消息的回答），单聊窗口 60 分钟、每条最多
     * 4 次；不带就是**主动消息**，受配额与用户开关限制。同一条消息的多次回复必须递增
     * `msgSeq`，否则会被官方按 `msg_id + msg_seq` 去重。
     */
    sendC2CText(userOpenid: string, content: string, opts?: {
        msgId?: string;
        msgSeq?: number;
    }): Promise<QqSendOutcome>;
}
//# sourceMappingURL=client.d.ts.map