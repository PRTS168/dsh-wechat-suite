/**
 * 测试用的假 QQ 官方机器人服务器（单聊文本往返）。
 *
 * 和 fake-ilink-server.ts 是同一个理由：CI 里没有 QQ 开放平台账号，但这条链路上
 * 真正会坏的地方全是协议细节 —— token 缓存有没有生效、HELLO→心跳有没有跑起来、
 * 掉线后 Resume 有没有带对 session_id、被动回复第 5 次有没有被拒、相同 msg_seq
 * 有没有被去重。这些只有让**真实客户端**（src/qq/）对着一个会"按规矩出错"的
 * 服务端跑一遍才看得见，所以这里做的是可编程、可断言的假服务端，不是几个打桩函数。
 *
 * 零依赖：HTTP 用 node:http，WebSocket 服务端按 RFC6455 自己实现（握手 + 帧编解码），
 * 刻意不引 `ws` —— 测试环境的依赖越少，"测试跑不起来"就越不可能是依赖问题。
 * 客户端一侧用 Node ≥22 自带的全局 WebSocket（src/qq/index.ts 也是这么连的）。
 *
 * @module @dsh-cowork/chatnode-wechat/test/fake-qq-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  QQ_C2C_PASSIVE_REPLY_LIMIT,
  QQ_ERRCODE,
  QQ_EVENT_C2C_MESSAGE,
  QQ_OP,
  type QqSendMessageResponse,
} from '../src/qq/types.ts'

/** RFC6455 的握手魔术字符串；拼错的表现是"连接直接失败且没有任何提示"。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 官网给的接入点路径（带尾斜杠）。 */
const WS_PATH = '/websocket/'

/** READY 里机器人自己的 QQ 号；测试只需要它是个稳定字符串。 */
const BOT_ID = '10000'

/** 假 token 的有效期，和官方文档一致：字符串形式的 7200 秒。 */
const TOKEN_EXPIRES_IN = '7200'

/** 一次完整的 WS 帧。本项目不支持分片，所以没有 continuation 这一路。 */
interface WsFrame {
  opcode: number
  payload: Buffer
}

/**
 * 协议错误：客户端发了本项目明确不打算支持的东西。
 *
 * 带 closeCode 是为了让上层直接用它回一个说明了原因的 close 帧，而不是一律 1002 ——
 * 排查的时候"为什么断开"比"断开了"值钱得多。
 */
class WsProtocolError extends Error {
  readonly closeCode: number

  constructor(message: string, closeCode = 1002) {
    super(message)
    this.closeCode = closeCode
  }
}

/**
 * RFC6455 服务端侧的最小帧解析器。
 *
 * 只走一条路径：**客户端掩码 + 单帧 + 文本**。真实客户端（Node 内置 WebSocket）
 * 对单聊这种小载荷不会分片，也不会开压缩（我们在握手响应里没协商任何扩展），
 * 所以遇到分片帧或 RSV 位就直接按协议错误关闭：写一个永远跑不到的拼装缓冲区，
 * 只会给后来人制造"这里支持分片"的错觉。
 */
class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  /** 喂原始字节，返回这一批里已经凑齐的帧（可能 0 个，也可能多个）。 */
  push(chunk: Buffer): WsFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: WsFrame[] = []
    for (;;) {
      const frame = this.take()
      if (!frame) return frames
      frames.push(frame)
    }
  }

  /**
   * 尝试从缓冲区头部取一帧；不足一帧就原样留着等下一批字节。
   *
   * TCP 不保证"一帧一次到达"，所以长度、掩码键、载荷都按"够了再取"处理 ——
   * 只看第一个包的实现会在长消息上偶发失败，而且极难复现。
   */
  private take(): WsFrame | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const b0 = buf[0]!
    const b1 = buf[1]!
    if ((b0 & 0x70) !== 0) throw new WsProtocolError('RSV 位非 0：我们没有协商任何扩展')
    if ((b0 & 0x80) === 0) throw new WsProtocolError('不支持分片帧', 1003)
    const opcode = b0 & 0x0f
    if (opcode === 0x0) throw new WsProtocolError('不支持延续帧', 1003)
    const masked = (b1 & 0x80) !== 0
    // RFC6455：客户端到服务端的帧必须掩码，不掩码就是协议错误。
    if (!masked) throw new WsProtocolError('客户端帧未掩码')

    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < 4) return null
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return null
      const declared = buf.readBigUInt64BE(2)
      if (declared > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WsProtocolError('载荷长度超出可表示范围', 1009)
      }
      length = Number(declared)
      offset = 10
    }

    if (buf.length < offset + 4) return null
    const maskKey = buf.subarray(offset, offset + 4)
    offset += 4
    if (buf.length < offset + length) return null

    const payload = unmask(buf.subarray(offset, offset + length), maskKey)
    this.buffer = buf.subarray(offset + length)
    return { opcode, payload }
  }
}

/** WS 连接级状态；会话状态（sessionId/seq）不在这里，见 startFakeQqServer。 */
interface WsConn {
  socket: Socket
  reader: FrameReader
  /** 是否已经完成 IDENTIFY/RESUME：没鉴权就推事件是无意义的。 */
  identified: boolean
  closing: boolean
}

export interface FakeQqServer {
  /** HTTP 基址，例如 http://127.0.0.1:34567 */
  readonly url: string
  /** WebSocket 接入点，例如 ws://127.0.0.1:34567/websocket/ */
  readonly wsUrl: string
  /** 收到的换 token 请求次数（用于断言 token 缓存生效）。 */
  readonly authRequests: number
  readonly identifyCount: number
  readonly resumeCount: number
  readonly heartbeats: number
  /** 心跳里收到过的 seq 值（首个应为 null）。 */
  readonly heartbeatSeqs: Array<number | null>
  /** 已发送的消息，按顺序。 */
  readonly sent: Array<{ openid: string; content: string; msgId?: string; msgSeq?: number; active: boolean }>
  /** 给某个用户推一条单聊消息。 */
  pushC2CMessage(opts: { openid: string; content: string; id?: string }): void
  /** 推一条任意事件（用于断言"群聊事件必须被忽略"这类契约）。 */
  pushDispatch(t: string, d: unknown, id?: string): void
  /** 让服务端从此拒绝一切 IDENTIFY（用于测不自愈的鉴权故障）。 */
  setRejectIdentify(value: boolean): void
  /** 向当前连接下发 op 9，模拟会话被另一个监听者抢走。 */
  supersedeSession(): void
  /** 粗暴断开当前 WebSocket 连接（用于测 Resume）。 */
  dropConnection(): void
  close(): Promise<void>
}

/** 原样读出请求体；保持和 fake-ilink-server.ts 一致的写法。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 读 JSON 请求体；空体当 `{}`，解析不出来返回 null 交给上层回 400。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    // 数组和字面量都不是协议里的请求体，按非法处理而不是硬塞进对象。
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 业务错误：官方这两条错误码是**从响应体里读**的，HTTP 状态仍然是 200
 * （src/qq/client.ts 先看 `response.ok`，再看 `raw.errcode`）。
 * 这里如果回 4xx/5xx，客户端会走到"HTTP 错误"分支，测试就断言不到错误码了。
 */
function bizError(res: ServerResponse, errcode: number, message: string): void {
  json(res, 200, { errcode, message } satisfies { errcode: number; message: string })
}

/** 服务端 → 客户端：按 RFC6455 不加掩码，且总是 FIN。 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** 按掩码键还原载荷；4 字节键循环使用。 */
function unmask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i]! ^ maskKey[i % 4]!
  }
  return out
}

/**
 * RFC3339 且**不带毫秒**。
 *
 * 官方事件里的 timestamp 就是这个形状（如 2026-07-21T10:00:00+08:00）。
 * 客户端如果拿它做字符串断言，多出来的 `.123` 会让断言失败；如果拿它进
 * `new Date()`，时区偏移又必须是对的 —— 所以这里按本地时区如实生成，
 * 而不是硬编码一个 +08:00。
 */
function rfc3339NoMs(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 启动一个假 QQ 服务器，监听 127.0.0.1 的随机端口。 */
export async function startFakeQqServer(opts?: {
  appId?: string
  clientSecret?: string
  /** HELLO 里给的心跳间隔，测试里设小一点（默认 50ms）。 */
  heartbeatIntervalMs?: number
  /** 单聊被动回复上限，默认 4。 */
  passiveReplyLimit?: number
}): Promise<FakeQqServer> {
  const appId = opts?.appId ?? 'fake-app-id'
  const clientSecret = opts?.clientSecret ?? 'fake-client-secret'
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 50
  // 默认值直接取 src 里的常量：如果哪天官方把上限改了，假服务器跟着改，
  // 而不是留下一份只有测试还在相信的旧数字。
  const passiveReplyLimit = opts?.passiveReplyLimit ?? QQ_C2C_PASSIVE_REPLY_LIMIT

  // 每次启动换一个 token：写死的话"客户端到底有没有缓存 token"这条断言会变成假阳性。
  const accessToken = `fake-access-${randomUUID()}`

  let authRequests = 0
  let identifyCount = 0
  /** 测试开关：为 true 时连凭据正确的 IDENTIFY 也拒（模拟 AppID 被停用这类不自愈故障）。 */
  let rejectIdentify = false
  let resumeCount = 0
  let heartbeats = 0
  const heartbeatSeqs: Array<number | null> = []
  const sent: Array<{ openid: string; content: string; msgId?: string; msgSeq?: number; active: boolean }> = []

  /** 已经用过的 msg_id + msg_seq：官方按这个组合去重。 */
  const repliedKeys = new Set<string>()
  /** 每条入站消息已经用掉的被动回复次数。 */
  const repliedCounts = new Map<string, number>()

  // 会话状态刻意放在连接之外：dropConnection() 之后客户端还要拿同一个 session_id
  // 来 Resume，所以它必须活得比 socket 长。
  let sessionId: string | null = null
  /** 下行序号 s；READY 从 1 开始，事件递增。 */
  let seq = 0
  const live = new Set<WsConn>()

  /** token 的两种错法（前缀不对 / 值不对）在客户端眼里必须是同一个结果。 */
  const tokenMatches = (value: unknown): boolean =>
    typeof value === 'string' &&
    value.startsWith('QQBot ') &&
    value.slice('QQBot '.length) === accessToken

  const writeFrame = (conn: WsConn, opcode: number, payload: Buffer): void => {
    if (conn.socket.destroyed) return
    conn.socket.write(encodeFrame(opcode, payload))
  }

  const sendJson = (conn: WsConn, payload: unknown): void => {
    writeFrame(conn, 0x1, Buffer.from(JSON.stringify(payload), 'utf8'))
  }

  /**
   * 走正常关闭握手：回一个 close 帧再结束 socket。
   *
   * 兜底定时器是必须的 —— 对端如果不回 close 帧，socket 会一直挂着，
   * 测试里的 `await server.close()` 就永远不返回。
   */
  const closeConn = (conn: WsConn, code: number, reason: string): void => {
    if (conn.closing) return
    conn.closing = true
    const reasonBytes = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    writeFrame(conn, 0x8, payload)
    const timer = setTimeout(() => conn.socket.destroy(), 200)
    timer.unref?.()
    conn.socket.once('close', () => clearTimeout(timer))
    conn.socket.end()
  }

  const activeConn = (): WsConn | undefined => {
    let found: WsConn | undefined
    // Set 保持插入顺序，所以最后一个未被销毁的就是最新连接。
    for (const conn of live) {
      if (!conn.socket.destroyed) found = conn
    }
    return found
  }

  /** 处理一条已经解好掩码的文本帧：这就是整个下行协议的状态机。 */
  const handleText = (conn: WsConn, text: string): void => {
    let parsed: { op?: unknown; d?: unknown }
    try {
      parsed = JSON.parse(text) as { op?: unknown; d?: unknown }
    } catch {
      // 真实网关遇到非法帧也是丢弃。这里同样只丢这一帧、不踢连接：
      // 把客户端一个无关的小 bug 放大成"连接被断开"只会让排查变难。
      return
    }
    const op = typeof parsed.op === 'number' ? parsed.op : -1
    const d = (parsed.d ?? {}) as Record<string, unknown>

    switch (op) {
      case QQ_OP.HEARTBEAT: {
        heartbeats += 1
        // 心跳的 d 直接就是 seq 或 null，不是对象；首个心跳按协议应为 null。
        heartbeatSeqs.push(typeof parsed.d === 'number' ? parsed.d : null)
        sendJson(conn, { op: QQ_OP.HEARTBEAT_ACK })
        return
      }

      case QQ_OP.IDENTIFY: {
        identifyCount += 1
        if (!tokenMatches(d.token)) {
          // d=false：会话不可恢复，客户端必须清掉 session_id 重新 IDENTIFY。
          sendJson(conn, { op: QQ_OP.INVALID_SESSION, d: false })
          closeConn(conn, 1008, 'invalid token')
          return
        }
        if (rejectIdentify) {
          // 测试用：凭据本身没错，但服务端持续拒绝鉴权（AppID 被停用、机器人下线）。
          // 这是"不自愈"故障的形态 —— 网关必须大声报错后停止重连，而不是安静地无限重试。
          sendJson(conn, { op: QQ_OP.INVALID_SESSION, d: false })
          closeConn(conn, 1008, 'identify rejected')
          return
        }
        sessionId = randomUUID()
        seq = 1
        conn.identified = true
        sendJson(conn, {
          op: QQ_OP.DISPATCH,
          s: seq,
          t: 'READY',
          d: {
            version: 1,
            session_id: sessionId,
            user: { id: BOT_ID, username: 'fake-bot', bot: true },
            shard: [0, 0],
          },
        })
        return
      }

      case QQ_OP.RESUME: {
        resumeCount += 1
        if (!tokenMatches(d.token)) {
          sendJson(conn, { op: QQ_OP.INVALID_SESSION, d: false })
          closeConn(conn, 1008, 'invalid token')
          return
        }
        if (sessionId === null || d.session_id !== sessionId) {
          // d=true 在官方语义里是"这次 Resume 失败，但会话还在"。
          // 这里同时把服务端会话作废，是因为契约要求"session_id 不匹配时必须重新
          // IDENTIFY"：不作废的话，客户端拿着那个错 id 再 Resume 一次我们还得再拒，
          // 而作废之后走 IDENTIFY 一定能拿到干净的新会话。
          sessionId = null
          conn.identified = false
          sendJson(conn, { op: QQ_OP.INVALID_SESSION, d: true })
          return
        }
        // 补发从客户端上报的 seq 往下接，这样客户端的心跳里带的 seq 不会倒退。
        const resumeSeq = typeof d.seq === 'number' ? d.seq : 0
        seq = resumeSeq + 1
        conn.identified = true
        sendJson(conn, { op: QQ_OP.DISPATCH, s: seq, t: 'RESUMED', d: {} })
        return
      }

      default:
        // 心跳应答、未知 op 都不需要服务端动作；静默忽略比报错更接近线上行为。
        return
    }
  }

  const handleIncoming = (conn: WsConn, chunk: Buffer): void => {
    let frames: WsFrame[]
    try {
      frames = conn.reader.push(chunk)
    } catch (error) {
      const code = error instanceof WsProtocolError ? error.closeCode : 1002
      const reason = error instanceof Error ? error.message : 'protocol error'
      closeConn(conn, code, reason)
      return
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case 0x1:
          handleText(conn, frame.payload.toString('utf8'))
          break
        case 0x9:
          // ping 必须原样回 pong（RFC6455 要求载荷一致）。
          writeFrame(conn, 0xa, frame.payload)
          break
        case 0xa:
          // pong 是我们自己没发过的 ping 的应答，测试里不断言，忽略。
          break
        case 0x8: {
          // 对端主动关闭：回一个 close 完成挥手。1005/1006 是保留值，不能回。
          const peerCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000
          const echo = peerCode >= 1000 && peerCode <= 4999 && peerCode !== 1005 && peerCode !== 1006
            ? peerCode
            : 1000
          closeConn(conn, echo, '')
          break
        }
        default:
          closeConn(conn, 1003, `不支持的 opcode ${frame.opcode}`)
          break
      }
    }
  }

  /** 发消息路由：被动回复上限 + msg_id/msg_seq 去重，都在这里。 */
  const handleSendMessage = async (
    req: IncomingMessage,
    res: ServerResponse,
    openid: string,
  ): Promise<void> => {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, 400, { errcode: 400, message: '请求体不是合法 JSON' })
      return
    }
    const content = typeof body.content === 'string' ? body.content : ''
    const msgId = typeof body.msg_id === 'string' && body.msg_id ? body.msg_id : undefined
    const msgSeq = typeof body.msg_seq === 'number' ? body.msg_seq : undefined
    // 不带 msg_id = 主动消息：不占用被动额度，也不参与去重。
    const active = msgId === undefined

    if (msgId !== undefined) {
      // msg_seq 缺省按官方语义视为 1：否则"同一条消息连发两次且都不带 seq"
      // 会被当成两次成功回复，而线上那第二次是会被去重掉的。
      const key = `${msgId}\u0000${msgSeq ?? 1}`
      if (repliedKeys.has(key)) {
        bizError(res, QQ_ERRCODE.DUPLICATE_MESSAGE, '相同的 msg_id + msg_seq，已被去重')
        return
      }
      const used = repliedCounts.get(msgId) ?? 0
      if (used >= passiveReplyLimit) {
        bizError(
          res,
          QQ_ERRCODE.PASSIVE_REPLY_EXCEEDED,
          `被动回复次数已达上限（同一条 msg_id 最多 ${passiveReplyLimit} 次）`,
        )
        return
      }
      repliedKeys.add(key)
      repliedCounts.set(msgId, used + 1)
    }

    // 只有真正受理的消息才进 sent：字段名是"已发送的消息"，
    // 被拒的那次从上层的返回值里看，混进来会让 `sent.length` 这类断言全是错的。
    const record: { openid: string; content: string; msgId?: string; msgSeq?: number; active: boolean } = {
      openid,
      content,
      active,
    }
    if (msgId !== undefined) record.msgId = msgId
    if (msgSeq !== undefined) record.msgSeq = msgSeq
    sent.push(record)

    const reply: QqSendMessageResponse = { id: randomUUID(), timestamp: rfc3339NoMs(new Date()) }
    json(res, 200, reply)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'POST' && path === '/app/getAppAccessToken') {
      authRequests += 1
      const body = await readJsonBody(req)
      if (body === null || body.appId !== appId || body.clientSecret !== clientSecret) {
        // 凭据不对不能回 200 + 空 token：客户端那边会退化成"没有返回 access_token"，
        // 看不出到底是凭据错了还是平台抽风。
        json(res, 401, { code: 100007, message: 'appId 或 clientSecret 不正确' })
        return
      }
      // expires_in 是**字符串**，这是官方响应的真实形状。
      json(res, 200, { access_token: accessToken, expires_in: TOKEN_EXPIRES_IN })
      return
    }

    if (req.method === 'GET' && path === '/gateway') {
      // 只回 url：线上响应还有 shards/session_start_limit，但契约里这个端点就是
      // `{"url": ...}`，多塞字段会让 `deepStrictEqual(res.body, { url })` 这类断言失败。
      json(res, 200, { url: wsUrl })
      return
    }

    const messageMatch = /^\/v2\/users\/([^/]+)\/messages$/.exec(path)
    if (req.method === 'POST' && messageMatch) {
      await handleSendMessage(req, res, decodeURIComponent(messageMatch[1]!))
      return
    }

    json(res, 404, { errcode: 404, message: `假 QQ 服务器没有这条路由：${req.method} ${path}` })
  }

  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假 QQ 服务器没能绑定端口')
  const url = `http://127.0.0.1:${address.port}`
  const wsUrl = `ws://127.0.0.1:${address.port}${WS_PATH}`

  server.on('request', (req, res) => {
    // 处理器是 async 的：不兜住的话一次未处理的 reject 会把整个测试进程带走。
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      json(res, 500, { errcode: 500, message: error instanceof Error ? error.message : String(error) })
    })
  })

  server.on('upgrade', (req: IncomingMessage, rawSocket: Duplex, head: Buffer) => {
    // Node 把 upgrade 的 socket 声明成 Duplex，实际给的是 net.Socket；
    // 下面要用 setNoDelay，所以在这里收窄一次。
    const socket = rawSocket as Socket
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    // 只认 /websocket（尾斜杠可有可无：有的客户端会把它规范化掉）。
    if (!path.startsWith('/websocket')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
    )

    const conn: WsConn = { socket, reader: new FrameReader(), identified: false, closing: false }
    live.add(conn)
    // 心跳间隔只有 HELLO 能给，而客户端在收到它之前不会发任何东西，
    // 所以 HELLO 必须由服务端先发。
    sendJson(conn, { op: QQ_OP.HELLO, d: { heartbeat_interval: heartbeatIntervalMs } })

    // Node 可能已经把客户端的抢跑字节放进了 head，不能丢。
    if (head.length > 0) handleIncoming(conn, head)
    socket.on('data', (chunk: Buffer) => handleIncoming(conn, chunk))
    // 必须挂 error：连接被粗暴掐断时 Socket 会 emit error，
    // 没人接就是一次未捕获异常，整个测试进程会挂掉。
    socket.on('error', () => { /* 断开是测试的正常路径，不是错误 */ })
    socket.on('close', () => live.delete(conn))
  })

  return {
    url,
    wsUrl,
    get authRequests() {
      return authRequests
    },
    get identifyCount() {
      return identifyCount
    },
    get resumeCount() {
      return resumeCount
    },
    get heartbeats() {
      return heartbeats
    },
    heartbeatSeqs,
    sent,

    pushC2CMessage(opts: { openid: string; content: string; id?: string }): void {
      const conn = activeConn()
      // 没有可用连接时静默丢弃：推送和连接的时序在测试里天然有竞争，
      // 这里抛异常会把"晚了一步"变成随机失败，而不是让调用方去 waitFor。
      if (!conn || !conn.identified) return
      seq += 1
      sendJson(conn, {
        id: randomUUID(),
        op: QQ_OP.DISPATCH,
        s: seq,
        t: QQ_EVENT_C2C_MESSAGE,
        d: {
          id: opts.id ?? randomUUID(),
          content: opts.content,
          timestamp: rfc3339NoMs(new Date()),
          author: { user_openid: opts.openid, id: opts.openid },
        },
      })
    },

    /**
     * 推一条任意事件。
     *
     * 加这个入口是因为"单聊与群聊共用同一个 intent 位、只能靠事件名过滤"是一条
     * 真实契约：网关必须忽略群聊事件，而这件事只有推一条群聊事件才测得出来。
     */
    pushDispatch(t: string, d: unknown, id?: string): void {
      const conn = activeConn()
      if (!conn || !conn.identified) return
      seq += 1
      sendJson(conn, { id: id ?? randomUUID(), op: QQ_OP.DISPATCH, s: seq, t, d })
    },

    setRejectIdentify(value: boolean): void {
      rejectIdentify = value
    },

    supersedeSession(): void {
      const conn = activeConn()
      if (!conn || !conn.identified) return
      sendJson(conn, { op: QQ_OP.INVALID_SESSION, d: true })
    },

    dropConnection(): void {
      // 直接 destroy，而不是走 close 握手：握手会让客户端认为"服务端要求正常断开"，
      // 而我们要测的是网络掉线后那条 Resume 路径。
      const conn = activeConn()
      if (conn) conn.socket.destroy()
    },

    close(): Promise<void> {
      for (const conn of live) conn.socket.destroy()
      live.clear()
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // fetch 的连接池会让 server.close() 一直等下去，所以主动清干净。
        server.closeAllConnections()
      })
    },
  }
}
