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

import { createDecipheriv, randomBytes } from 'node:crypto'

/** 绑定接口的默认主机（AstrBot 里也是这个默认值）。 */
export const QQ_BIND_HOST = 'q.qq.com'

/** 绑定任务状态：0 无 / 1 待确认 / 2 完成 / 3 过期。 */
export const BIND_STATUS = {
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
} as const

export interface BindTask {
  taskId: string
  /** 交给用户打开/扫码的地址。 */
  connectUrl: string
  /** 本地生成、只在本机使用的 AES-256 密钥（base64）。 */
  bindKey: string
  /** 官方建议的轮询间隔（秒）。 */
  intervalSec: number
}

export type BindPollResult =
  | { status: 'pending'; raw: number }
  | { status: 'expired'; raw: number; message: string }
  | { status: 'completed'; raw: number; appId: string; appSecret: string }
  | { status: 'error'; raw: number; message: string }

/** 响应信封：retcode 非 0 即失败。 */
interface BindEnvelope {
  retcode?: number | string
  msg?: string
  message?: string
  data?: Record<string, unknown>
}

function hostOf(host?: string): string {
  const trimmed = (host ?? QQ_BIND_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return trimmed || QQ_BIND_HOST
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<BindEnvelope> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`绑定接口 HTTP ${response.status}: ${text.slice(0, 200)}`)
    const data = JSON.parse(text) as BindEnvelope
    const retcode = data.retcode
    if (retcode !== undefined && retcode !== null && String(retcode) !== '0') {
      throw new Error(String(data.msg ?? data.message ?? '绑定接口返回失败'))
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用绑定密钥解开平台返回的 AppSecret。
 *
 * 密文布局照抄 AstrBot：base64( nonce(12) || ciphertext || tag(16) )。
 * 解开失败一律抛错 —— 拿不到真凭证时绝不能返回一个像凭证的东西。
 */
export function decryptBindSecret(encryptedSecret: string, bindKey: string): string {
  const key = Buffer.from(bindKey, 'base64')
  const raw = Buffer.from(encryptedSecret, 'base64')
  if (key.byteLength !== 32) throw new Error('绑定密钥格式异常：需要 32 字节 AES-256 密钥')
  if (raw.byteLength <= 28) throw new Error('凭证密文格式异常：太短')
  const nonce = raw.subarray(0, 12)
  const tag = raw.subarray(raw.byteLength - 16)
  const ciphertext = raw.subarray(12, raw.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 第一步：建绑定任务，拿 task_id 与给用户打开的地址。 */
export async function createBindTask(opts: { host?: string; timeoutMs?: number } = {}): Promise<BindTask> {
  const host = hostOf(opts.host)
  const bindKey = randomBytes(32).toString('base64')
  const data = await postJson(`https://${host}/lite/create_bind_task`, { key: bindKey }, opts.timeoutMs ?? 10_000)
  const payload = (data.data ?? {}) as Record<string, unknown>
  const taskId = String(payload.task_id ?? '').trim()
  if (!taskId) throw new Error('绑定任务响应缺少 task_id')
  return {
    taskId,
    bindKey,
    connectUrl: `https://${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`,
    intervalSec: 2,
  }
}

/** 第三步：轮询一次绑定结果。 */
export async function pollBindResult(
  opts: { taskId: string; bindKey: string; host?: string; timeoutMs?: number },
): Promise<BindPollResult> {
  if (!opts.taskId) throw new Error('缺少 task_id')
  if (!opts.bindKey) throw new Error('缺少 bind_key')
  const host = hostOf(opts.host)
  const data = await postJson(
    `https://${host}/lite/poll_bind_result`,
    { task_id: opts.taskId },
    opts.timeoutMs ?? 10_000,
  )
  const payload = (data.data ?? {}) as Record<string, unknown>
  const raw = Number(payload.status ?? BIND_STATUS.NONE)

  if (raw === BIND_STATUS.COMPLETED) {
    const appId = String(payload.bot_appid ?? '').trim()
    const encrypted = String(payload.bot_encrypt_secret ?? '').trim()
    if (!appId || !encrypted) {
      return { status: 'error', raw, message: '扫码成功但没有返回完整的机器人凭证' }
    }
    try {
      return { status: 'completed', raw, appId, appSecret: decryptBindSecret(encrypted, opts.bindKey) }
    } catch (error) {
      return { status: 'error', raw, message: error instanceof Error ? error.message : String(error) }
    }
  }
  if (raw === BIND_STATUS.EXPIRED) {
    return { status: 'expired', raw, message: '二维码已过期，请重新发起绑定' }
  }
  return { status: 'pending', raw }
}
