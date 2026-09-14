/**
 * QQ 官方机器人网关（单聊）。
 *
 * 与微信网关平级：它把 QQ 平台接成节点认识的那副样子 —— 注册 `ctx.qq` 服务、
 * 发出 `qq/message|status|error|fatal`，入站事件被翻译成节点一直在用的线格式，
 * 于是 `node/` 那 7 千多行（白名单、会话、命令、记忆、审批、提醒、台账）一行都不用改。
 *
 * 本阶段只做**单聊文本往返**：鉴权、WebSocket 常驻、收 `C2C_MESSAGE_CREATE`、
 * 被动回复。群聊、富媒体、主动消息配额留到后续阶段 —— 相关方法现在就存在，
 * 但明确返回"尚未支持"，而不是假装成功。
 *
 * 协议要点（数值来自官方文档，见调研笔记）：
 * - 连上先收 HELLO(op 10) 拿 heartbeat_interval，再 IDENTIFY(op 2)；
 * - 断线重连用 RESUME(op 6) 带 session_id + seq，不要重发 IDENTIFY；
 * - op 9 表示会话失效：清掉 session_id 重新 IDENTIFY；
 * - intents 里 `GROUP_AND_C2C_EVENT`(1<<25) 同时覆盖群聊与单聊，**分不开**，
 *   所以必须靠事件的 `t` 字段过滤。
 *
 * @module @dsh-cowork/chatnode-wechat/qq
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type GatewayStatus } from '../gateway/types.ts';
import { type QqSendOutcome } from './client.ts';
/** 插件配置。`allowFrom` 是 user_openid 白名单，与微信侧同理：没有它就等于对所有人开放。 */
export interface Config {
    /** QQ 开放平台的 AppID。缺省时从 DSH 凭据里取（见 start()）。 */
    appId?: string;
    /** AppSecret，只走 DSH 凭据，不写进 profile。 */
    clientSecret?: string;
    /** 允许驱动 agent 的 user_openid 列表。 */
    allowFrom?: string[];
    /** 覆盖接口域名（沙箱或测试用假服务器）。 */
    baseUrl?: string;
    /** 事件位掩码；默认只要 `GROUP_AND_C2C_EVENT`（单聊与群聊共用这一位）。 */
    intents?: number;
    /** 重连基础退避（毫秒）。 */
    reconnectDelayMs?: number;
    /** 单次 HTTP 请求超时（毫秒）。 */
    apiTimeoutMs?: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    appId: z<string, string>;
    clientSecret: z<string, string>;
    allowFrom: z<string[], string[]>;
    baseUrl: z<string, string>;
    intents: z<number, number>;
    reconnectDelayMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
}>, Schemastery.ObjectT<{
    appId: z<string, string>;
    clientSecret: z<string, string>;
    allowFrom: z<string[], string[]>;
    baseUrl: z<string, string>;
    intents: z<number, number>;
    reconnectDelayMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
}>>;
type ResolvedConfig = Required<Omit<Config, 'appId' | 'clientSecret' | 'baseUrl'>> & {
    appId: string;
    clientSecret: string;
    baseUrl: string;
};
/** 服务面：与微信网关同名同签名，节点只认这一层。 */
export declare class QqGateway extends Service {
    static Config: z<Schemastery.ObjectS<{
        appId: z<string, string>;
        clientSecret: z<string, string>;
        allowFrom: z<string[], string[]>;
        baseUrl: z<string, string>;
        intents: z<number, number>;
        reconnectDelayMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        appId: z<string, string>;
        clientSecret: z<string, string>;
        allowFrom: z<string[], string[]>;
        baseUrl: z<string, string>;
        intents: z<number, number>;
        reconnectDelayMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
    }>>;
    readonly c: ResolvedConfig;
    private api;
    private socket;
    private statusValue;
    private stopRequested;
    private heartbeat;
    private reconnectTimer;
    /** 鉴权被拒后的重试定时器（见 scheduleIdentify）。 */
    private identifyTimer;
    /** 连续鉴权失败次数：用来让重试间隔递增，而不是每 500ms 打一次。 */
    private authFailures;
    /** 最近一次 READY 的时刻：op 9 紧跟其后通常意味着会话被别的实例抢走。 */
    private readyAt;
    /** 连续「刚 READY 就 op 9」的次数。 */
    private supersededCount;
    private reconnectAttempts;
    /** 下行序列号：心跳要带上"收到的最后一条"的 s，首帧传 null。 */
    private lastSeq;
    /** 断线重连用；op 9 时清掉。 */
    private sessionId;
    /** 已用过的被动回复次数，按入站消息 id 计。 */
    private readonly replyBudget;
    /** 每条入站消息对应的 msg_id，用于被动回复。 */
    private readonly lastMsgId;
    /**
     * 入站事件去重：官方文档明确「相同 msg_id 可能多次推送，请结合 msg_seq 去重」。
     * 没有这张表，一次重推就是一条多余的回复。按时间戳裁剪，容量因此有界。
     */
    private readonly seen;
    /** 去重窗口：短到不会吞掉"用户真的又发了一次"，长到足以覆盖一次重推。 */
    private readonly dedupWindowMs;
    constructor(ctx: Context, config: Config);
    get status(): GatewayStatus;
    private setStatus;
    /**
     * 把连接状态写成一个可读文件。
     *
     * 为什么需要它：插件的 `ctx.logger` 输出在这套宿主里落不到任何能事后翻看的文件，
     * 而台账只在**出错**时才写一行。于是「连上了并空闲」与「根本没连」这两种状态
     * 长得一模一样 —— 实测时这是致命的盲区。状态文件放在 $DSH_HOME/qq-test/ 下，
     * 与微信那份彻底隔离。
     */
    private writeStatus;
    /** 诊断日志：只写 best-effort，日志本身出问题不能影响桥。 */
    private log;
    private report;
    /** 解析凭据并开始连接。没有凭据就保持 idle —— 绝不半死不活地连。 */
    start(): Promise<void>;
    stop(): Promise<void>;
    private clearHeartbeat;
    private connect;
    private scheduleReconnect;
    private handlePayload;
    private handlePayloadInner;
    private startHeartbeat;
    private identify;
    /**
     * 稍微延迟再重新鉴权。
     *
     * 一个**永远**被拒的鉴权（token 过期、AppID 被停用）如果立刻重试，就是一个没有间隔的
     * 忙循环；这一点在 op 9 上尤其致命 —— 那次环路实测能在 500ms 内打出两千多次请求。
     * 所以退避是递增的，成功 READY 后清零。
     */
    private scheduleIdentify;
    private send;
    private handleDispatch;
    /**
     * 是否见过这条消息（并记下它）。
     *
     * 去重是**回复侧**的需要：官方会重推同一条事件，而重推在节点那边看起来就是"用户又说了一遍"。
     */
    private isDuplicate;
    /**
     * 按时间戳裁掉过期的去重记录。
     *
     * 三张表都按"入站消息"增长，不裁剪就是一条稳定的内存泄漏 —— 长跑的桥不该按月吃内存。
     * 每条消息顺手裁一次，代价是 O(已记录条数)，而窗口只有 5 分钟，实际规模很小。
     */
    private pruneState;
    private handleC2CMessage;
    /**
     * 发文本。
     *
     * 优先走**被动回复**（带最近一条入站消息的 `msg_id`）：单聊被动窗口 60 分钟、
     * 每条最多 4 次，超出后官方直接报 `40034128`。所以这里维护一份"这条消息回了几次"
     * 的预算，用满之后改为**主动消息**并在台账里留痕 —— 悄悄失败是这个项目最不想要的
     * 结果（`/problems` 就是为它建的）。
     */
    sendText(to: string, text: string, clientId?: string): Promise<QqSendOutcome>;
    /**
     * 图片：阶段③。
     *
     * 现在明确回"尚未支持"，而不是静默返回成功 —— 上层会把它当作发送失败上报，
     * 于是"还没做"和"真的坏了"在台账里长得不一样。
     */
    sendImage(to: string, filePath: string): Promise<QqSendOutcome>;
    sendFile(to: string, filePath: string, fileName?: string): Promise<QqSendOutcome>;
    /** QQ 官方接口没有"正在输入"，这项能力在这里是空操作（如实降级，而不是报错）。 */
    sendTyping(to: string, status: 1 | 2): Promise<void>;
    /**
     * 这个平台**能做什么**，由网关自己声明（节点不再靠猜）。
     *
     * - 媒体：官方接口要按"上传准备 → 分片上传 → 完成"三步走，阶段③才实现，所以这里
     *   如实声明做不到 —— 于是 `generate_image`/`speak` 会在**花钱之前**就拒绝，
     *   而不是生成完了才发现发不出去。
     * - 回复预算：单聊被动窗口对每条入站消息最多回 4 条（超出报 `40034128`），第 5 条
     *   起降级为主动消息（有配额、用户可关闭）。带着这个数字，节点才能把长回答**合并**
     *   进预算里，而不是让尾部气泡悄悄变成受配额限制的主动消息。
     */
    get capabilities(): {
        media: boolean;
        voice: boolean;
        replyBudgetPerInbound: number;
    };
    /** 入站媒体下载：阶段③。现在返回 null —— 上层的语义是"拿不到字节"，会如实上报。 */
    downloadImage(item: unknown): Promise<{
        bytes: Uint8Array;
        mediaType: 'image/png';
    } | null>;
    downloadVoice(item: unknown): Promise<Uint8Array | null>;
    downloadAttachment(item: unknown): Promise<{
        bytes: Uint8Array;
        fileName?: string;
    } | null>;
}
declare const _default: {
    name: string;
    Config: z<Schemastery.ObjectS<{
        appId: z<string, string>;
        clientSecret: z<string, string>;
        allowFrom: z<string[], string[]>;
        baseUrl: z<string, string>;
        intents: z<number, number>;
        reconnectDelayMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        appId: z<string, string>;
        clientSecret: z<string, string>;
        allowFrom: z<string[], string[]>;
        baseUrl: z<string, string>;
        intents: z<number, number>;
        reconnectDelayMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
    }>>;
    QqGateway: typeof QqGateway;
};
export default _default;
//# sourceMappingURL=index.d.ts.map