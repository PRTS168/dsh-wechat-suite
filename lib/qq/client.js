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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { QQ_API_BASE, QQ_GATEWAY_PATH, QQ_MSG_TYPE_TEXT, QQ_TOKEN_PATH, QQ_TOKEN_REFRESH_MARGIN_MS, qqC2CMessagesPath, } from "./types.js";
/**
 * 换一条**全新连接**重发同一个请求。
 *
 * 与微信侧同一套思路，而且是被真实事故教出来的：连接池在代理/网络抖动之后会整体失效，
 * 此后每次复用都是同一个坏结果，而**新连接是好的**（那次 18 分钟发不出消息，进程内
 * 重试 96 次全败、重启进程瞬间恢复）。QQ 的事件通道是 WebSocket，但 REST 侧同样走
 * 连接池，所以同样的病会同样地发作。
 *
 * `agent: false` 让这次请求自带走自己的 agent：不经连接池，也不受宿主全局
 * dispatcher（系统代理）影响。
 */
function directPostJson(url, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const send = url.startsWith('https:') ? httpsRequest : httpRequest;
        const payload = Buffer.from(body, 'utf8');
        const request = send(url, { method: 'POST', agent: false, headers: { ...headers, 'Content-Length': String(payload.byteLength) } }, (response) => {
            const chunks = [];
            response.on('error', reject);
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error(`direct request timed out after ${timeoutMs}ms`)));
        request.on('error', reject);
        request.end(payload);
    });
}
/**
 * 把 `fetch failed` 背后的真实原因挖出来。
 *
 * undici 把所有传输失败都报成一句 `TypeError: fetch failed`，真正的原因
 * （ENOTFOUND / ECONNREFUSED / TLS / 超时）藏在 `cause` 里；不解开它，日志里
 * 就只剩一句没有信息量的话。
 */
export function describeFetchError(error) {
    if (!(error instanceof Error))
        return String(error);
    const parts = [error.message];
    const cause = error.cause;
    if (cause instanceof Error) {
        if (cause.message && cause.message !== error.message)
            parts.push(cause.message);
        const code = cause.code;
        if (typeof code === 'string' && code && !parts.join(' ').includes(code))
            parts.push(code);
    }
    return parts.join(' / ');
}
export class QqApiClient {
    token;
    /**
     * 连接池疑似中毒时置位；**下一次**请求改走新建连接。
     *
     * 刻意是"换路"而不是"立刻重发"：发消息不保证幂等，重发会产生重复气泡。失败当前这一条，
     * 让后续请求换条路走，最多只多花调用方自己那一次重试 —— 与微信侧完全同一套取舍。
     */
    preferDirectConnection = false;
    /**
     * 显式字段 + 构造函数里赋值，而不是 TypeScript 的"参数属性"（`constructor(private
     * readonly opts: …)`）：后者在 Node 的类型擦除模式下会直接抛
     * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，而本仓库的测试就是 `node --test test/*.test.ts`
     * 跑 `.ts` 源码 —— 用了参数属性，任何 import 这个文件的测试都会在加载阶段崩掉。
     */
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /** 连接池当前是否被判定为不可信（测试用）。 */
    get usesFreshConnections() {
        return this.preferDirectConnection;
    }
    get base() {
        return (this.opts.baseUrl ?? QQ_API_BASE).replace(/\/+$/, '');
    }
    async request(path, init) {
        const { json, ...rest } = init;
        const timeoutMs = this.opts.timeoutMs ?? 15_000;
        const url = `${this.base}${path}`;
        // 不设 Content-Length：undici 会按字符串 body 自己算，自己算的那个头正是 iLink 侧
        // `invalid content-length header` 的来源。
        const body = json === undefined ? undefined : JSON.stringify(json);
        const headers = {
            ...(json === undefined ? {} : { 'content-type': 'application/json' }),
            ...(rest.headers ?? {}),
        };
        const viaFetch = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await (this.opts.fetchImpl ?? fetch)(url, {
                    ...rest,
                    headers,
                    ...(body === undefined ? {} : { body }),
                    signal: controller.signal,
                });
                const text = await response.text();
                if (!response.ok)
                    throw new Error(`QQ API ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
                return text;
            }
            finally {
                clearTimeout(timer);
            }
        };
        const viaDirect = async () => {
            if (body === undefined)
                throw new Error('direct path needs a body');
            const out = await directPostJson(url, body, headers, timeoutMs);
            if (out.status < 200 || out.status >= 300) {
                throw new Error(`QQ API ${path} HTTP ${out.status}: ${out.body.slice(0, 200)}`);
            }
            return out.body;
        };
        if (this.preferDirectConnection) {
            try {
                const text = await viaDirect();
                this.preferDirectConnection = false;
                return JSON.parse(text);
            }
            catch (error) {
                // 服务端答复了（HTTP 层错误）说明连接是好的，不再换路。
                if (error instanceof Error && /HTTP \d/.test(error.message))
                    throw error;
            }
        }
        try {
            const text = await viaFetch();
            this.preferDirectConnection = false;
            return JSON.parse(text);
        }
        catch (error) {
            if (error instanceof Error && /HTTP \d/.test(error.message))
                throw error;
            // 传输层失败：把池子标记为不可信，下一次请求换新连接。若本次是 GET 之外的
            // 请求（发消息），绝不在这里重发 —— 见 preferDirectConnection 的说明。
            this.preferDirectConnection = true;
            throw error;
        }
    }
    /**
     * 当前的 access_token。
     *
     * 官方语义：有效期内重复请求返回**同一个** token；到期前 60 秒内请求会给新的。
     * 所以缓存按 `expires_in` 计时，提前 QQ_TOKEN_REFRESH_MARGIN_MS 失效。
     */
    async accessToken() {
        if (this.token && Date.now() < this.token.expiresAt)
            return this.token.value;
        const raw = await this.request(QQ_TOKEN_PATH, {
            method: 'POST',
            json: { appId: this.opts.appId, clientSecret: this.opts.clientSecret },
        });
        const value = raw.access_token;
        if (!value)
            throw new Error('QQ API 没有返回 access_token（检查 appId / clientSecret）');
        // expires_in 官方示例是字符串，字段声明却是数字：两种都收。
        const seconds = Number(raw.expires_in ?? 7200);
        const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 7_200_000;
        this.token = { value, expiresAt: Date.now() + Math.max(0, ttl - QQ_TOKEN_REFRESH_MARGIN_MS) };
        return value;
    }
    /** WebSocket 接入点。 */
    async gatewayUrl() {
        const raw = await this.request(QQ_GATEWAY_PATH, {
            method: 'GET',
            headers: { authorization: `QQBot ${await this.accessToken()}` },
        });
        if (!raw.url)
            throw new Error('QQ API 没有返回 WebSocket 接入点');
        return raw.url;
    }
    /**
     * 发一条单聊文本。
     *
     * 带 `msgId` 就是**被动回复**（对某条用户消息的回答），单聊窗口 60 分钟、每条最多
     * 4 次；不带就是**主动消息**，受配额与用户开关限制。同一条消息的多次回复必须递增
     * `msgSeq`，否则会被官方按 `msg_id + msg_seq` 去重。
     */
    async sendC2CText(userOpenid, content, opts = {}) {
        try {
            const raw = await this.request(qqC2CMessagesPath(userOpenid), {
                method: 'POST',
                headers: { authorization: `QQBot ${await this.accessToken()}` },
                json: {
                    content,
                    msg_type: QQ_MSG_TYPE_TEXT,
                    ...(opts.msgId === undefined ? {} : { msg_id: opts.msgId }),
                    ...(opts.msgSeq === undefined ? {} : { msg_seq: opts.msgSeq }),
                },
            });
            if (raw.errcode !== undefined && raw.errcode !== 0) {
                return { success: false, error: raw.message ?? `errcode ${raw.errcode}`, errcode: raw.errcode };
            }
            return { success: true, messageId: raw.id };
        }
        catch (error) {
            return { success: false, error: describeFetchError(error) };
        }
    }
}
//# sourceMappingURL=client.js.map