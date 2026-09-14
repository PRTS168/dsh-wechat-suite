/**
 * QQ 网关的端到端测试：真插件 + 假 QQ 服务器，全程 loopback，不触网。
 *
 * 假服务器自己实现了 RFC6455 服务端（零依赖），因此这里跑的是真实链路：握手、
 * HELLO、IDENTIFY、心跳、事件下发、被动回复与额度、断线 Resume —— 只有 QQ 那台
 * 服务器是假的。
 *
 * 覆盖的每一条都对应一个真实约束，而不是"顺手测一下"：
 * - 单聊与群聊共用同一个 intent 位，**分不开**，所以必须靠事件名过滤；
 * - 被动回复每条用户消息最多 4 次，用满之后官方直接报错，所以网关要有预算；
 * - 断线重连走 RESUME，重发 IDENTIFY 会丢掉补发的事件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import { QqGateway, type Config as QqConfig } from '../src/qq/index.ts'
import { QqApiClient } from '../src/qq/client.ts'
import { QQ_EVENT_GROUP_AT_MESSAGE, QQ_INTENT_GROUP_AND_C2C } from '../src/qq/types.ts'
import { startFakeQqServer, type FakeQqServer } from './fake-qq-server.ts'

interface Harness {
  server: FakeQqServer
  ctx: Context
  gateway: QqGateway
  messages: Array<Record<string, unknown>>
  errors: Error[]
  statuses: string[]
}

const APP_ID = 'app-test'
const SECRET = 'secret-test'
const OPENID = 'OPENID-TEST-1'

async function harness(config: Partial<QqConfig> = {}): Promise<Harness> {
  const server = await startFakeQqServer({ appId: APP_ID, clientSecret: SECRET, heartbeatIntervalMs: 40 })
  const ctx = new Context()
  const messages: Array<Record<string, unknown>> = []
  const errors: Error[] = []
  const statuses: string[] = []
  ctx.on('qq/message' as never, ((m: Record<string, unknown>) => messages.push(m)) as never)
  ctx.on('qq/error' as never, ((e: Error) => errors.push(e)) as never)
  ctx.on('qq/status' as never, ((s: string) => statuses.push(s)) as never)
  const gateway = new QqGateway(ctx, {
    appId: APP_ID,
    clientSecret: SECRET,
    baseUrl: server.url,
    intents: QQ_INTENT_GROUP_AND_C2C,
    reconnectDelayMs: 30,
    ...config,
  } as QqConfig)
  return { server, ctx, gateway, messages, errors, statuses }
}

async function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('等待超时')
}

test('鉴权、心跳与状态：连上就 READY，token 只换一次', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })

  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  assert.equal(h.server.identifyCount, 1, '一次连接只鉴权一次')
  assert.equal(h.server.authRequests, 1, 'access_token 必须缓存：有效期内重复取不该再打服务器')

  await waitFor(() => h.server.heartbeats >= 2)
  assert.ok(h.server.heartbeatSeqs.every((s) => typeof s === 'number'), '心跳必须带上最后收到的事件序号')
  assert.ok(h.statuses.includes('connected'))
})

test('入站单聊事件被翻译成节点认识的线格式', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  h.server.pushC2CMessage({ openid: OPENID, content: '你好，机器人', id: 'MSG-1' })
  await waitFor(() => h.messages.length === 1)

  const m = h.messages[0]!
  assert.equal(m.from_user_id, OPENID, '白名单与回复都按 user_openid 定位')
  assert.equal(m.message_id, 'MSG-1', 'message_id 同时是去重键与被动回复的 msg_id')
  assert.equal(m.msg_type, 1)
  const item = (m.item_list as Array<{ type: number; text_item?: { text?: string } }>)[0]!
  assert.equal(item.text_item?.text, '你好，机器人')
})

test('非白名单用户被丢弃，绝不给模型', async (t) => {
  const h = await harness({ allowFrom: [OPENID] })
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  h.server.pushC2CMessage({ openid: 'OPENID-INTRUDER', content: '帮我删库', id: 'MSG-X' })
  h.server.pushC2CMessage({ openid: OPENID, content: '这句才是我的', id: 'MSG-Y' })
  await waitFor(() => h.messages.length === 1)
  assert.equal(h.messages[0]!.from_user_id, OPENID)
})

test('同一条事件被重推只算一条：官方明确会重推', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  h.server.pushC2CMessage({ openid: OPENID, content: '同一条', id: 'MSG-DUP' })
  await waitFor(() => h.messages.length === 1)
  h.server.pushC2CMessage({ openid: OPENID, content: '同一条', id: 'MSG-DUP' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.messages.length, 1, '重推不能变成"用户又说了一遍"')
})

test('群聊事件被忽略：intents 分不开单聊与群聊，只能靠事件名过滤', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  // 同一个 intent 位下群聊事件也会送到这里；本阶段明确不做群聊。
  h.server.pushDispatch(QQ_EVENT_GROUP_AT_MESSAGE, { id: 'G-1', content: '@机器人 你好', author: { member_openid: 'M-1' } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.messages.length, 0, '群聊消息不能落进单聊链路')
})

test('被动回复：前 4 条带 msg_id，第 5 条转主动消息并留痕', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  h.server.pushC2CMessage({ openid: OPENID, content: '在吗', id: 'MSG-BUDGET' })
  await waitFor(() => h.messages.length === 1)

  for (let i = 1; i <= 5; i++) {
    const outcome = await h.gateway.sendText(OPENID, `第 ${i} 条`)
    assert.equal(outcome.success, true, `第 ${i} 条应当发出`)
  }
  const sent = h.server.sent.filter((s) => s.openid === OPENID)
  assert.equal(sent.length, 5)
  assert.equal(sent.slice(0, 4).every((s) => s.msgId === 'MSG-BUDGET' && !s.active), true, '前 4 条是被动回复')
  assert.equal(sent[4]!.active, true, '第 5 条必须转主动消息，而不是撞官方的额度墙')
  assert.ok(
    h.errors.some((e) => e.message.includes('被动回复额度用尽')),
    '额度用尽这件事必须留在台账里 —— 悄悄降级是这个项目最不想要的结果',
  )
})

test('传输层失败后，下一次请求换走新建连接（与微信侧同一套兜底）', async (t) => {
  // 连接池中毒是真实事故的形态：池子里的每条连接都坏，而**新连接是好的**。
  // 假服务器永远正常应答，测不到这条路径，所以这里注入一个永远失败的 fetch 来模拟。
  const server = await startFakeQqServer({ appId: APP_ID, clientSecret: SECRET })
  t.after(async () => { await server.close() })

  const brokenFetch = (() => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  const client = new QqApiClient({
    appId: APP_ID,
    clientSecret: SECRET,
    baseUrl: server.url,
    fetchImpl: brokenFetch,
  })

  await assert.rejects(() => client.accessToken(), /fetch failed/)
  assert.equal(client.usesFreshConnections, true, '传输失败后应把连接池标记为不可信')

  // 第二次：池子还是坏的，新连接是好的。
  const token = await client.accessToken()
  assert.equal(typeof token, 'string')
  assert.ok(token.length > 0, '第二次必须走新建连接并成功')
  assert.equal(client.usesFreshConnections, false, '成功之后回到常规路径')
  assert.equal(server.authRequests, 1, '换连接重放的报文与原来一致，所以只算一次换 token')
})

test('鉴权被持续拒绝：大声报错并停止重连，不安静地无限重试', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  // 凭据没错，是服务端持续拒绝鉴权 —— AppID 被停用、机器人下线都属于这一类，
  // 它们不会自愈，所以"退避重试到天荒地老"是错的处置。
  h.server.setRejectIdentify(true)

  const fatals: Error[] = []
  h.ctx.on('qq/fatal' as never, ((e: Error) => fatals.push(e)) as never)

  await h.gateway.start()
  await waitFor(() => fatals.length > 0, 15_000)
  assert.match(fatals[0]!.message, /鉴权连续失败/)
  assert.match(fatals[0]!.message, /AppID\/AppSecret|停用/, '要告诉人怎么修，而不只是说坏了')
  assert.equal(h.gateway.status, 'error')

  const attempts = h.server.identifyCount
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(h.server.identifyCount, attempts, '报致命之后不许再试：否则它只是换了个方式刷日志')
})

test('刚 READY 就被判会话无效：识别为第二个实例，而不是安静重连', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })

  const fatals: Error[] = []
  h.ctx.on('qq/fatal' as never, ((e: Error) => fatals.push(e)) as never)

  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')

  // QQ 一个机器人同时只有一个监听者；会话被抢走时服务端就下发 op 9。
  // 微信侧的对应症状是 iLink 的 403 独占锁，处置必须一样：说出来、停下来。
  //
  // 踢的时机必须落在"刚 READY"之后：假服务器对尚未鉴权的连接会忽略这次调用，所以这里
  // 循环重试直到出现致命 —— 否则测的是"踢空了"，而不是网关的判断。
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && fatals.length === 0) {
    h.server.supersedeSession()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  assert.ok(fatals.length > 0, '连续两次「刚 READY 就被判无效」必须报致命')
  assert.match(fatals[0]!.message, /第二个实例|只允许一个监听者/)
  assert.equal(h.gateway.status, 'error')
})

test('掉线重连走 RESUME，而不是重新 IDENTIFY', async (t) => {
  const h = await harness()
  t.after(async () => { await h.gateway.stop(); await h.server.close() })
  await h.gateway.start()
  await waitFor(() => h.gateway.status === 'connected')
  h.server.pushC2CMessage({ openid: OPENID, content: '断线前', id: 'MSG-A' })
  await waitFor(() => h.messages.length === 1)

  h.server.dropConnection()
  await waitFor(() => h.server.resumeCount === 1)
  assert.equal(h.server.identifyCount, 1, '重连不该再发一次 IDENTIFY：那会丢掉补发的事件')

  await waitFor(() => h.gateway.status === 'connected')
  h.server.pushC2CMessage({ openid: OPENID, content: '恢复之后还能收', id: 'MSG-B' })
  await waitFor(() => h.messages.length === 2)
})
