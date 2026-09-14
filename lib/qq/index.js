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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { ITEM_TEXT } from "../gateway/types.js";
import { describeFetchError, QqApiClient } from "./client.js";
import { QQ_C2C_PASSIVE_REPLY_LIMIT, QQ_ERRCODE, QQ_DEFAULT_HEARTBEAT_MS, QQ_EVENT_C2C_MESSAGE, QQ_INTENT_GROUP_AND_C2C, QQ_OP, } from "./types.js";
export const Config = z.object({
    appId: z.string().default(''),
    clientSecret: z.string().default(''),
    allowFrom: z.array(z.string()).default([]),
    baseUrl: z.string().default(''),
    intents: z.number().default(QQ_INTENT_GROUP_AND_C2C),
    reconnectDelayMs: z.number().default(3_000),
    apiTimeoutMs: z.number().default(15_000),
});
/** 鉴权连续失败到几次就不再安静重试（对齐微信侧对不自愈故障的处置）。 */
const MAX_AUTH_FAILURES = 3;
/** 服务面：与微信网关同名同签名，节点只认这一层。 */
export class QqGateway extends Service {
    static Config = Config;
    c;
    api;
    socket;
    statusValue = 'idle';
    stopRequested = false;
    heartbeat;
    reconnectTimer;
    /** 鉴权被拒后的重试定时器（见 scheduleIdentify）。 */
    identifyTimer;
    /** 连续鉴权失败次数：用来让重试间隔递增，而不是每 500ms 打一次。 */
    authFailures = 0;
    /** 最近一次 READY 的时刻：op 9 紧跟其后通常意味着会话被别的实例抢走。 */
    readyAt = 0;
    /** 连续「刚 READY 就 op 9」的次数。 */
    supersededCount = 0;
    reconnectAttempts = 0;
    /** 下行序列号：心跳要带上"收到的最后一条"的 s，首帧传 null。 */
    lastSeq = null;
    /** 断线重连用；op 9 时清掉。 */
    sessionId;
    /** 已用过的被动回复次数，按入站消息 id 计。 */
    replyBudget = new Map();
    /** 每条入站消息对应的 msg_id，用于被动回复。 */
    lastMsgId = new Map();
    /**
     * 入站事件去重：官方文档明确「相同 msg_id 可能多次推送，请结合 msg_seq 去重」。
     * 没有这张表，一次重推就是一条多余的回复。按时间戳裁剪，容量因此有界。
     */
    seen = new Map();
    /** 去重窗口：短到不会吞掉"用户真的又发了一次"，长到足以覆盖一次重推。 */
    dedupWindowMs = 5 * 60_000;
    constructor(ctx, config) {
        super(ctx, 'qq');
        // 不假设 schemastery schema 一定跑过：测试与脚本会直接 new 出这个类，那时
        // 可选字段是空的。缺省值在这里补一次，胜在每个使用点各自 `??` 一遍 ——
        // 漏掉任何一处就是线上一个 undefined 崩溃。
        this.c = {
            ...config,
            allowFrom: config.allowFrom ?? [],
            intents: config.intents ?? QQ_INTENT_GROUP_AND_C2C,
            reconnectDelayMs: config.reconnectDelayMs ?? 3_000,
            apiTimeoutMs: config.apiTimeoutMs ?? 15_000,
        };
        ctx.effect(() => () => { void this.stop(); });
    }
    // -------------------------------------------------------------------------
    // 状态与日志
    // -------------------------------------------------------------------------
    get status() {
        return this.statusValue;
    }
    setStatus(status) {
        if (this.statusValue === status)
            return;
        this.statusValue = status;
        this.ctx.emit('qq/status', status);
    }
    /**
     * 把连接状态写成一个可读文件。
     *
     * 为什么需要它：插件的 `ctx.logger` 输出在这套宿主里落不到任何能事后翻看的文件，
     * 而台账只在**出错**时才写一行。于是「连上了并空闲」与「根本没连」这两种状态
     * 长得一模一样 —— 实测时这是致命的盲区。状态文件放在 $DSH_HOME/qq-test/ 下，
     * 与微信那份彻底隔离。
     */
    writeStatus(patch) {
        try {
            const home = process.env.DSH_HOME;
            if (!home)
                return;
            const file = join(home, 'qq-test', 'gateway-status.json');
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...patch }, null, 2), 'utf8');
        }
        catch {
            // 状态文件写不进去不该影响网关本身。
        }
    }
    /** 诊断日志：只写 best-effort，日志本身出问题不能影响桥。 */
    log(message) {
        try {
            this.ctx.logger?.info?.('[dsh-chatnode-wechat/qq] %s', message);
        }
        catch { /* 日志尽力而为 */ }
    }
    report(error) {
        this.ctx.emit('qq/error', error instanceof Error ? error : new Error(String(error)));
    }
    // -------------------------------------------------------------------------
    // 生命周期
    // -------------------------------------------------------------------------
    /** 解析凭据并开始连接。没有凭据就保持 idle —— 绝不半死不活地连。 */
    async start() {
        // 凭据来源两处：profile 里显式写（方便测试与自查），或宿主凭据服务
        // （`QQ_BOT_APP_ID` / `QQ_BOT_CLIENT_SECRET`，与微信侧同一套路）。
        const readFailure = (key) => (error) => {
            this.report(new Error(`读取凭据 ${key} 失败：${error instanceof Error ? error.message : String(error)}`));
        };
        const appId = this.c.appId || await readCredential(this.ctx, 'QQ_BOT_APP_ID', readFailure('QQ_BOT_APP_ID'));
        const clientSecret = this.c.clientSecret
            || await readCredential(this.ctx, 'QQ_BOT_CLIENT_SECRET', readFailure('QQ_BOT_CLIENT_SECRET'));
        if (!appId || !clientSecret) {
            this.setStatus('idle');
            this.writeStatus({ state: 'idle', reason: '缺少 AppID/AppSecret' });
            // idle 也要上报：本站最可能的"全断"就是凭据没就位，而它与"今天很安静"在
            // 任何界面上都长得一样（见 report() 与节点侧的 gateway/status 处置）。
            this.report(new Error('没有 AppID/AppSecret 凭据，QQ 网关保持空闲（不会收发任何消息）'));
            this.log('没有 AppID/AppSecret 凭据，网关保持空闲（写进 DSH 凭据 QQ_BOT_APP_ID / QQ_BOT_CLIENT_SECRET，或在配置里填）');
            return;
        }
        this.writeStatus({ state: 'starting', appId });
        this.api = new QqApiClient({
            appId,
            clientSecret,
            ...(this.c.baseUrl ? { baseUrl: this.c.baseUrl } : {}),
            timeoutMs: this.c.apiTimeoutMs,
        });
        this.stopRequested = false;
        await this.connect();
    }
    async stop() {
        this.stopRequested = true;
        this.clearHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.identifyTimer) {
            clearTimeout(this.identifyTimer);
            this.identifyTimer = undefined;
        }
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            try {
                socket.close();
            }
            catch { /* 已经关了 */ }
        }
        this.setStatus('idle');
    }
    clearHeartbeat() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
    }
    // -------------------------------------------------------------------------
    // WebSocket：连接 → HELLO → IDENTIFY/RESUME → 心跳 → 事件
    // -------------------------------------------------------------------------
    async connect() {
        if (!this.api || this.stopRequested)
            return;
        this.setStatus(this.sessionId ? 'reconnecting' : 'starting');
        let url;
        let token;
        try {
            token = `QQBot ${await this.api.accessToken()}`;
            url = await this.api.gatewayUrl();
        }
        catch (error) {
            this.report(new Error(`拿接入点失败：${describeFetchError(error)}`));
            this.scheduleReconnect();
            return;
        }
        // 这两个 await 期间插件可能已经被卸载（热重载）。若不在这里重新确认，连接会
        // 在 stop() 之后才建立，而且再也没人关它 —— 那正是微信侧 403 那一类事故的形状：
        // 旧实例的连接与新实例重叠。
        if (this.stopRequested)
            return;
        // 拿到接入点 = token 与网络都通了，这一步值得落盘：实测时它就是第一个正面证据。
        this.writeStatus({ state: 'connecting', gatewayUrl: url });
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            this.log(`WebSocket 已连接：${url}`);
        });
        socket.addEventListener('message', (event) => {
            this.handlePayload(event.data, token);
        });
        socket.addEventListener('error', () => {
            // 浏览器风格的 WebSocket 只在 error 事件里给一个空对象，详细信息在随后的
            // close 里；这里不报错，避免每个网络抖动都变成一条台账。
        });
        socket.addEventListener('close', (event) => {
            this.clearHeartbeat();
            if (this.stopRequested)
                return;
            // 4004/4008 之类的鉴权类关闭没有重连价值，但仍然交给退避重连：
            // 人工修好凭据后不该还要重启宿主。
            this.writeStatus({ state: 'disconnected', code: event.code, sessionId: this.sessionId });
            this.log(`WebSocket 断开（code=${event.code}），准备重连`);
            this.setStatus('reconnecting');
            this.scheduleReconnect();
        });
    }
    scheduleReconnect() {
        if (this.stopRequested || this.reconnectTimer)
            return;
        // 指数退避但有上限：掉线期间不要变成请求风暴，人工修好后又要能自动回来。
        const delay = Math.min(this.c.reconnectDelayMs * 2 ** this.reconnectAttempts, 60_000);
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }
    handlePayload(raw, token) {
        try {
            this.handlePayloadInner(raw, token);
        }
        catch (error) {
            // 事件监听器里逃出去的异常在这个宿主里是**致命**的：未处理的 rejection 会被当成
            // 致命加载失败，整个进程退出（2026-09-12 我们的插件就是这么把 DSH 打死的）。
            // 一帧畸形数据不该有这个权力 —— 记一笔，连接照常活着。
            this.report(new Error(`处理下行帧时抛错：${error instanceof Error ? error.message : String(error)}`));
        }
    }
    handlePayloadInner(raw, token) {
        let payload;
        try {
            payload = JSON.parse(String(raw));
        }
        catch {
            this.report(new Error('QQ 下行不是合法 JSON，已忽略这一帧'));
            return;
        }
        if (typeof payload.s === 'number')
            this.lastSeq = payload.s;
        switch (payload.op) {
            case QQ_OP.HELLO: {
                const interval = payload.d?.heartbeat_interval;
                this.startHeartbeat(typeof interval === 'number' && interval > 0 ? interval : QQ_DEFAULT_HEARTBEAT_MS);
                this.identify(token);
                return;
            }
            case QQ_OP.HEARTBEAT_ACK:
                return;
            case QQ_OP.RECONNECT: {
                this.log('服务端要求重连');
                try {
                    this.socket?.close();
                }
                catch { /* ignore */ }
                return;
            }
            case QQ_OP.INVALID_SESSION: {
                // op 9 的含义是「**上一次鉴权没被接受**」，无论那次是 IDENTIFY 还是
                // RESUME。所以这里必须丢掉会话、重新 IDENTIFY：如果按 `d===true` 保留
                // session_id，紧接着的 identify() 会再发一次 RESUME，服务端再回 op 9 ——
                // 实测这条环路能在 500ms 内刷出 2312 次 RESUME，CPU 直接跑满。
                // 官方文档里 `d=true` 是「这个会话还有救」，不是「原地无限重试」。
                this.sessionId = undefined;
                this.lastSeq = null;
                const resumable = payload.d === true;
                // 「刚 READY 就被判无效」是**另一个监听者抢走了会话**的典型症状：QQ 一个机器人
                // 同时只有一个监听者。微信侧的对应症状是 iLink 的 403 独占锁，两边的处置一样 ——
                // 大声说出来、停止打转，而不是安静地无限重连。
                const justReady = Date.now() - this.readyAt < 10_000;
                this.supersededCount = justReady ? this.supersededCount + 1 : 0;
                if (this.supersededCount >= 2) {
                    this.ctx.emit('qq/fatal', new Error('QQ 长连刚建立就被判为无效（op 9，连续 2 次）：通常意味着有第二个实例正在用同一个机器人' +
                        '（另一个进程、另一台机器，或同一 profile 里挂了两份）。QQ 一个机器人同时只允许一个监听者，' +
                        '请停掉多余的那个。已停止重连。'));
                    this.setStatus('error');
                    this.stopRequested = true;
                    try {
                        this.socket?.close();
                    }
                    catch { /* 已经关了 */ }
                    return;
                }
                this.log(`会话失效（可恢复=${resumable}，连续第 ${this.authFailures + 1} 次）→ 丢弃会话，稍后重新鉴权`);
                // 退避而不是立刻重发：一个永远被拒的鉴权（例如 token 过期）不该变成忙循环。
                this.scheduleIdentify(token);
                return;
            }
            case QQ_OP.DISPATCH:
                this.handleDispatch(payload);
                return;
            default:
                this.log(`收到未处理的 op=${payload.op}`);
        }
    }
    startHeartbeat(intervalMs) {
        this.clearHeartbeat();
        this.heartbeat = setInterval(() => {
            // d 是"收到的最后一条事件的 s"，首帧为 null。
            this.send({ op: QQ_OP.HEARTBEAT, d: this.lastSeq });
        }, intervalMs);
        this.heartbeat.unref?.();
    }
    identify(token) {
        if (this.sessionId) {
            this.send({
                op: QQ_OP.RESUME,
                d: { token, session_id: this.sessionId, seq: this.lastSeq },
            });
            return;
        }
        this.send({
            op: QQ_OP.IDENTIFY,
            d: {
                token,
                intents: this.c.intents,
                shard: [0, 1],
                properties: { $os: process.platform, $browser: 'dsh-chatnode-wechat', $device: 'dsh-chatnode-wechat' },
            },
        });
    }
    /**
     * 稍微延迟再重新鉴权。
     *
     * 一个**永远**被拒的鉴权（token 过期、AppID 被停用）如果立刻重试，就是一个没有间隔的
     * 忙循环；这一点在 op 9 上尤其致命 —— 那次环路实测能在 500ms 内打出两千多次请求。
     * 所以退避是递增的，成功 READY 后清零。
     */
    scheduleIdentify(token, delayMs = 500) {
        if (this.identifyTimer)
            clearTimeout(this.identifyTimer);
        this.authFailures += 1;
        // 连续失败到上限就不再安静重试：token 过期、AppID 被停用这类问题不会自愈，继续重连
        // 只会让日志安静地变长。微信侧对同类「不自愈」故障（iLink 独占锁 403）也是直接致命
        // 并停轮询 —— 两个平台的处置保持一致，人才不用为平台记两套规则。
        if (this.authFailures > MAX_AUTH_FAILURES) {
            this.ctx.emit('qq/fatal', new Error(`鉴权连续失败 ${this.authFailures - 1} 次（连接被服务端判为无效），已停止重连：` +
                '通常是 AppID/AppSecret 不对，或机器人被停用。修好凭据后重启宿主即可；' +
                '若凭据无误，请检查是否有第二个实例在用同一个机器人。'));
            this.setStatus('error');
            this.stopRequested = true;
            try {
                this.socket?.close();
            }
            catch { /* 已经关了 */ }
            return;
        }
        const delay = Math.min(delayMs * 2 ** (this.authFailures - 1), 60_000);
        this.identifyTimer = setTimeout(() => {
            this.identifyTimer = undefined;
            if (!this.stopRequested)
                this.identify(token);
        }, delay);
        this.identifyTimer.unref?.();
    }
    send(payload) {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1)
            return;
        try {
            socket.send(JSON.stringify(payload));
        }
        catch (error) {
            this.report(new Error(`下发 WS 帧失败：${describeFetchError(error)}`));
        }
    }
    handleDispatch(payload) {
        switch (payload.t) {
            case 'READY': {
                const ready = payload.d;
                this.sessionId = ready?.session_id;
                this.authFailures = 0;
                this.supersededCount = 0;
                this.readyAt = Date.now();
                this.writeStatus({ state: 'connected', sessionId: this.sessionId, bot: ready?.user?.username });
                this.setStatus('connected');
                this.log(`已鉴权（bot=${ready?.user?.username ?? '?'}），intents=${this.c.intents}`);
                return;
            }
            case 'RESUMED':
                this.setStatus('connected');
                this.log('会话已恢复，事件补发完成');
                return;
            case QQ_EVENT_C2C_MESSAGE:
                this.handleC2CMessage(payload.d);
                return;
            default:
                // intents 分不开单聊与群聊，所以群聊事件也会送到这里 —— 本阶段明确忽略，
                // 而不是当成单聊处理。
                return;
        }
    }
    /**
     * 是否见过这条消息（并记下它）。
     *
     * 去重是**回复侧**的需要：官方会重推同一条事件，而重推在节点那边看起来就是"用户又说了一遍"。
     */
    isDuplicate(messageId) {
        const now = Date.now();
        if (this.seen.has(messageId))
            return true;
        this.seen.set(messageId, now);
        return false;
    }
    /**
     * 按时间戳裁掉过期的去重记录。
     *
     * 三张表都按"入站消息"增长，不裁剪就是一条稳定的内存泄漏 —— 长跑的桥不该按月吃内存。
     * 每条消息顺手裁一次，代价是 O(已记录条数)，而窗口只有 5 分钟，实际规模很小。
     */
    pruneState() {
        const floor = Date.now() - this.dedupWindowMs;
        for (const [id, at] of this.seen) {
            if (at < floor)
                this.seen.delete(id);
        }
        // 被动回复额度与"最后一条消息"都只对仍在窗口内的消息有意义。
        for (const id of this.replyBudget.keys()) {
            if (!this.seen.has(id))
                this.replyBudget.delete(id);
        }
        for (const [sender, id] of this.lastMsgId) {
            if (!this.seen.has(id))
                this.lastMsgId.delete(sender);
        }
    }
    handleC2CMessage(d) {
        const sender = d?.author?.user_openid ?? d?.author?.id ?? '';
        if (!sender) {
            // 从前这里是裸 return：字段结构与预期不符时，一整类事件无声消失。
            this.report(new Error('收到一条没有发送者的 QQ 事件，已忽略（字段结构与预期不符）'));
            return;
        }
        const content = (d?.content ?? '').trim();
        if (!content) {
            // 单聊里的图片/富媒体事件 content 为空。从前同样是裸 return —— 用户说"我发图了"，
            // 桥这边像这条消息从没来过，连一句"暂不支持"都到不了他手上（媒体在阶段③）。
            this.report(new Error(`收到暂不支持的 QQ 消息（无文本内容）：sender=${sender}，可能是图片或富媒体`));
            return;
        }
        const messageId = d?.id ?? '';
        if (messageId && this.isDuplicate(messageId))
            return;
        if (this.c.allowFrom.length > 0 && !this.c.allowFrom.includes(sender)) {
            // 与微信侧同一姿态：非白名单消息记一笔、忽略，绝不喂给模型。
            //
            // 但这里**不只写日志**：QQ 的 user_openid 是 per-AppID 的，绑定前你不知道自己
            // 的 openid 是什么，而插件日志到不了宿主日志。所以写进问题台账 —— `/problems`
            // 与管理台诊断页会直接显示它，绑定的第一步因此有了着落。
            this.report(new Error(`忽略了一条非白名单的 QQ 消息：sender=${sender}。若这是你自己，把这个 openid 加进 allowFrom 即可。`));
            return;
        }
        if (messageId) {
            this.lastMsgId.set(sender, messageId);
            this.replyBudget.set(messageId, 0);
        }
        this.pruneState();
        const inbound = {
            from_user_id: sender,
            to_user_id: this.c.appId,
            ...(messageId ? { message_id: messageId } : {}),
            msg_type: 1,
            item_list: [{ type: ITEM_TEXT, text_item: { text: content } }],
            // QQ 的时间戳是 RFC3339 字符串，节点不读它，但留着便于排查。
            ...(d?.timestamp ? { create_time: d.timestamp } : {}),
        };
        this.ctx.emit('qq/message', inbound);
    }
    // -------------------------------------------------------------------------
    // 服务面（与微信网关同名同签名）
    // -------------------------------------------------------------------------
    /**
     * 发文本。
     *
     * 优先走**被动回复**（带最近一条入站消息的 `msg_id`）：单聊被动窗口 60 分钟、
     * 每条最多 4 次，超出后官方直接报 `40034128`。所以这里维护一份"这条消息回了几次"
     * 的预算，用满之后改为**主动消息**并在台账里留痕 —— 悄悄失败是这个项目最不想要的
     * 结果（`/problems` 就是为它建的）。
     */
    async sendText(to, text, clientId) {
        void clientId;
        if (!this.api)
            return { success: false, error: 'QQ 网关未配置（缺 AppID/AppSecret）' };
        const msgId = this.lastMsgId.get(to);
        const used = msgId ? (this.replyBudget.get(msgId) ?? 0) : 0;
        const passive = msgId !== undefined && used < QQ_C2C_PASSIVE_REPLY_LIMIT;
        if (msgId && !passive) {
            this.report(new Error(`被动回复额度用尽（${used}/${QQ_C2C_PASSIVE_REPLY_LIMIT}），这条改为主动消息；` +
                'QQ 对主动消息有配额且用户可关闭接收'));
        }
        const outcome = await this.api.sendC2CText(to, text, passive
            ? { msgId, msgSeq: used + 1 }
            : {});
        if (outcome.success && passive && msgId)
            this.replyBudget.set(msgId, used + 1);
        // 被动回复被官方拒了（窗口过期 40034005 / 次数超限 40034128）：这是**用户的答复**，
        // 不能就这么没了。退回主动消息再试一次，并把降级这件事留在台账里 —— 主动消息有配额
        // 且用户可以在客户端关闭接收，所以它可能也失败，但那时的失败是"如实失败"。
        const passiveRejected = !outcome.success
            && passive
            && (outcome.errcode === QQ_ERRCODE.MESSAGE_EXPIRED || outcome.errcode === QQ_ERRCODE.PASSIVE_REPLY_EXCEEDED);
        if (passiveRejected) {
            if (msgId)
                this.replyBudget.set(msgId, QQ_C2C_PASSIVE_REPLY_LIMIT);
            this.report(new Error(`被动回复被拒（errcode ${outcome.errcode}，窗口过期或超次），改走主动消息重试`));
            return this.api.sendC2CText(to, text, {});
        }
        return outcome;
    }
    /**
     * 图片：阶段③。
     *
     * 现在明确回"尚未支持"，而不是静默返回成功 —— 上层会把它当作发送失败上报，
     * 于是"还没做"和"真的坏了"在台账里长得不一样。
     */
    async sendImage(to, filePath) {
        void to;
        void filePath;
        return { success: false, error: 'QQ 网关暂不支持发送图片（阶段③：按官方三步上传流程实现）' };
    }
    async sendFile(to, filePath, fileName) {
        void to;
        void filePath;
        void fileName;
        return { success: false, error: 'QQ 网关暂不支持发送文件（阶段③：按官方三步上传流程实现）' };
    }
    /** QQ 官方接口没有"正在输入"，这项能力在这里是空操作（如实降级，而不是报错）。 */
    async sendTyping(to, status) {
        void to;
        void status;
    }
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
    get capabilities() {
        return { media: false, voice: false, replyBudgetPerInbound: QQ_C2C_PASSIVE_REPLY_LIMIT };
    }
    /** 入站媒体下载：阶段③。现在返回 null —— 上层的语义是"拿不到字节"，会如实上报。 */
    async downloadImage(item) {
        void item;
        return null;
    }
    async downloadVoice(item) {
        void item;
        return null;
    }
    async downloadAttachment(item) {
        void item;
        return null;
    }
}
/**
 * 从 DSH 凭据服务里读一个值。
 *
 * 与微信侧**同一套** API：`credentials.resolve(credentialRef('NAME'))`，而且它是
 * 异步的。凭据只从宿主凭据服务或 profile 来，绝不写进 patch。
 *
 * 这里踩过一次：第一版凭印象写成 `ctx.get('credentials').get(key)`，那样永远返回
 * 空串 —— 网关会安静地"保持空闲"，而人看不出为什么。这类静默失效正是本项目最想
 * 消灭的东西，所以字段名写进注释，谁都能对。
 */
async function readCredential(ctx, key, onError) {
    try {
        const credentials = ctx.get('credentials');
        if (!credentials?.resolve)
            return '';
        const value = await credentials.resolve(credentialRef(key));
        return typeof value === 'string' ? value : '';
    }
    catch (error) {
        // "读凭据失败"与"没配这个凭据"是两件事：从前都变成空串，于是启动时状态文件
        // 写"缺少 AppID/AppSecret"——归因错误，人会拿着错线索去反复填配置。分开报。
        onError?.(error);
        return '';
    }
}
export default { name: 'dsh-chatnode-wechat/qq', Config, QqGateway };
//# sourceMappingURL=index.js.map