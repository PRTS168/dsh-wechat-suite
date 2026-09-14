/**
 * QQ 官方机器人的**扫码绑定**流程。
 *
 * 这不是我在官方文档里找到的东西，而是照搬 AstrBot 4.26.3 的
 * `astrbot/core/platform/sources/qqofficial/login_registration.py`：
 * 新版 QQ 机器人平台（`q.qq.com/qbot`）给"自建 / 第三方 agent 服务"发的凭证，
 * 走的是这个 openclaw 绑定流程 —— 扫码确认之后，平台才把 AppID 与**加密的**
 * AppSecret 交给你。
 *
 * 三步：
 *   1. 本地生成一个 32 字节 AES-256 密钥（base64），连同请求发给
 *      `POST /lite/create_bind_task`，拿回 task_id；
 *   2. 把 `…/qqbot/openclaw/connect.html?task_id=…` 交给用户打开/扫码；
 *   3. 轮询 `POST /lite/poll_bind_result`，status=2 时用那把密钥
 *      （AES-256-GCM，密文布局 = 12B nonce + ciphertext + 16B tag）解出 AppSecret。
 *
 * 密钥只在本地生成、本地使用，全程不出机器。
 *
 * @module @dsh-cowork/chatnode-wechat/qq/binding
 */
/** 绑定接口的默认主机（AstrBot 里也是这个默认值）。 */
export declare const QQ_BIND_HOST = "q.qq.com";
/** 绑定任务状态：0 无 / 1 待确认 / 2 完成 / 3 过期。 */
export declare const BIND_STATUS: {
    readonly NONE: 0;
    readonly PENDING: 1;
    readonly COMPLETED: 2;
    readonly EXPIRED: 3;
};
export interface BindTask {
    taskId: string;
    /** 交给用户打开/扫码的地址。 */
    connectUrl: string;
    /** 本地生成、只在本机使用的 AES-256 密钥（base64）。 */
    bindKey: string;
    /** 官方建议的轮询间隔（秒）。 */
    intervalSec: number;
}
export type BindPollResult = {
    status: 'pending';
    raw: number;
} | {
    status: 'expired';
    raw: number;
    message: string;
} | {
    status: 'completed';
    raw: number;
    appId: string;
    appSecret: string;
} | {
    status: 'error';
    raw: number;
    message: string;
};
/**
 * 用绑定密钥解开平台返回的 AppSecret。
 *
 * 密文布局照抄 AstrBot：base64( nonce(12) || ciphertext || tag(16) )。
 * 解开失败一律抛错 —— 拿不到真凭证时绝不能返回一个像凭证的东西。
 */
export declare function decryptBindSecret(encryptedSecret: string, bindKey: string): string;
/** 第一步：建绑定任务，拿 task_id 与给用户打开的地址。 */
export declare function createBindTask(opts?: {
    host?: string;
    timeoutMs?: number;
}): Promise<BindTask>;
/** 第三步：轮询一次绑定结果。 */
export declare function pollBindResult(opts: {
    taskId: string;
    bindKey: string;
    host?: string;
    timeoutMs?: number;
}): Promise<BindPollResult>;
//# sourceMappingURL=binding.d.ts.map