/**
 * Conversation-node tests: the full WeChat → DSH → WeChat loop against the
 * fake iLink server, with a real SessionStore + AgentRegistry + ApprovalService
 * and a stub agent. Covers the allowlist gate, inbound routing, commands,
 * session targeting, outbound digests, chunking, and the approval bridge.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
// Keep the bridge's approval diagnostics out of the real DSH home: these tests
// drive real approval requests through the answerer.
process.env.WECHAT_APPROVAL_TRACE ??= join(tmpdir(), 'wechat-approval-test.log')

import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, type AgentFactory } from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { WechatGateway } from '../src/gateway/index.ts'
import { WechatConversationNode, type NodeConfig, wechatConversationNode } from '../src/node/index.ts'
import { routeCommand } from '../src/node/commands.ts'
import { startFakeIlinkServer, mediaKey, type FakeIlinkServer } from './fake-ilink-server.ts'
import type { InboundMessage } from '../src/gateway/types.ts'
import { USER_MESSAGE_OPEN } from '../src/node/inbound.ts'
import { MEMORY_OPEN, applyPatch, ensureMemory } from '../src/node/memory.ts'
import { splitForWechat } from '../src/node/outbound.ts'

let server: FakeIlinkServer
let ctx: Context
let runtimeCtx: Context
let followedUp: ReturnType<typeof createUserMessage>[]
let cancelled: boolean
let createdSessions: string[]
let lastCreateOptions: Parameters<AgentFactory['createAgent']>[1] | undefined
/** Tool definitions the bridge registered during a test (the registry only exposes register). */
let capturedTools: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }>

function makeFakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    inbox: undefined,
    ctx,
    followup: (message) => {
      followedUp.push(message as never)
    },
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {
      cancelled = true
    },
    whenIdle: async () => {},
    runMaintenance: async () => {},
  } as unknown as Agent
}

/**
 * Minimal AgentFactory: mirrors the real dsh-agent-loop, which performs its
 * session work on its OWN runtime context (services must be injected there),
 * not on the owner context Cordis passes to the factory.
 */
const factory: AgentFactory = {
  async createAgent(ownerCtx, options) {
    lastCreateOptions = options
    const session = runtimeCtx.sessions.create(options.sessionId, { meta: options.meta })
    createdSessions.push(session.id)
    const agent = makeFakeAgent(session)
    const detach = runtimeCtx.agents.register(agent)
    return {
      agent,
      dispose: async () => {
        detach()
      },
    }
  },
  async resume() {
    throw new Error('resume is not implemented in tests')
  },
}

beforeEach(async () => {
  server = await startFakeIlinkServer()
  ctx = new Context()
  runtimeCtx = ctx
  followedUp = []
  cancelled = false
  createdSessions = []
  lastCreateOptions = undefined
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.agents.setFactory(factory)
  await ctx.plugin(ApprovalService)
  // DSH 0.1.5: dsh-session-title 依赖 sessionProjections，缺它则标题服务不加载
  // （inject 是等待门），因此 host 组合里的 dsh-session-projection 也要挂上，
  // 否则测不到"真实标题优先于首条消息回退"这条路径。
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Capture what the bridge registers: the registry's only public verb is
  // `register`, so a thin wrapper is the way to reach a tool's `execute`.
  capturedTools = []
  const registry = ctx.tools as unknown as { register: (definition: unknown) => () => void }
  const originalRegister = registry.register.bind(registry)
  registry.register = (definition: unknown) => {
    const named = definition as { name?: string; execute?: unknown }
    if (named?.name && typeof named.execute === 'function') {
      capturedTools.push(named as (typeof capturedTools)[number])
    }
    return originalRegister(definition)
  }
  await ctx.plugin(WechatGateway, {
    token: 'test-token',
    accountId: 'wxid_bot_fake',
    baseUrl: server.url,
    cdnBaseUrl: server.url,
    allowCdnHosts: ['127.0.0.1'],
    pollIdleDelayMs: 5,
    longPollTimeoutMs: 1000,
  })
  // seed one agent + session so zero-config targeting has something to pick
  const handle = await ctx.agents.create({
    sessionId: SessionId('wechat-testa'),
    agentOptions: { provider: 'test', model: 'test-model' },
  })
  activeHandle = handle
  await ctx.wechat.start()
})

let activeHandle: { agent: Agent; dispose: () => Promise<void> }

async function mountNode(config?: Record<string, unknown>): Promise<void> {
  await ctx.plugin(wechatConversationNode, {
    allowFrom: ['wxid_allow1'],
    digestIntervalSec: 0,
    approvalTimeoutSec: 2,
    sendChunkDelayMs: 1,
    // The bridge defaults its memory file to $DSH_HOME/wechat-memory/MEMORY.md.
    // These tests run inside the developer's real harness home, so point every
    // mount at a scratch file: a test run must never write into the live profile
    // (or, worse, read a real memory file back as an expected value).
    memoryFile: join(tmpdir(), `dsh-wechat-memory-test-${process.pid}`, 'MEMORY.md'),
    memoryConsolidateTime: '',
    // Same reason as memoryFile: the problem ledger defaults to $DSH_HOME, and
    // a test run must never write into the developer's live profile.
    problemFile: join(tmpdir(), `dsh-wechat-problems-test-${process.pid}`, 'wechat-problems.log'),
    ...config,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(10)
  }
  assert.fail('condition not met within timeout')
}

function textMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    msg_type: 1,
    context_token: 'ctx-token',
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  }
}

function sentTexts(): string[] {
  return server.sent.map((s) => s.text)
}

afterEach(async () => {
  await ctx.wechat?.stop?.()
  await activeHandle.dispose()
  await server.close()
})

test('inbound allowlisted text reaches the active agent via followup', async () => {
  await mountNode()
  server.enqueue(textMessage('你好，帮我看看这个项目'))
  await waitFor(() => followedUp.length === 1)
  assert.ok(followedUp[0]!.content[0]!.type === 'text')
  const text = (followedUp[0]!.content[0] as { text: string }).text
  // inbound user messages are fenced, with the send time on the CLOSING marker
  // (a leading `[发送于 …]` speaker line invited the model to autocomplete a
  // fake next user turn — see wrapUserMessage() in src/node/inbound.ts).
  assert.match(
    text,
    /^<<<微信用户消息>>>\n你好，帮我看看这个项目\n<<<微信用户消息结束｜发送于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}>>>$/,
  )
})

test('non-allowlisted senders are logged and never fed to the model', async () => {
  await mountNode()
  server.enqueue(textMessage('ignore me', { from_user_id: 'wxid_evil', message_id: 'msg-evil' }))
  await sleep(200)
  assert.equal(followedUp.length, 0)
  assert.equal(server.sent.length, 0)
})

test('group messages are ignored in MVP', async () => {
  await mountNode()
  server.enqueue(textMessage('group ping', { room_id: 'room-1', message_id: 'msg-group' }))
  await sleep(200)
  assert.equal(followedUp.length, 0)
})

test('voice transcription text is routed with a voice marker', async () => {
  await mountNode()
  server.enqueue({
    from_user_id: 'wxid_allow1',
    message_id: 'msg-voice',
    msg_type: 1,
    item_list: [{ type: 3, voice_item: { text: '请总结 README' } }],
  })
  await waitFor(() => followedUp.length === 1)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.startsWith(USER_MESSAGE_OPEN), text)
  assert.ok(text.includes('[语音转写]'))
  assert.ok(text.includes('请总结 README'))
})

test('assistant/message outbound is delivered to the peer without a turn-start ack', async () => {
  await mountNode()
  server.enqueue(textMessage('first task'))
  await waitFor(() => followedUp.length === 1)

  const session = activeHandle.agent.session
  session.append('user/message', { content: [{ type: 'text', text: 'first task' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'the answer' }], provider: 'test', model: 'test-model' }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  await waitFor(() => sentTexts().some((t) => t === 'the answer'))
  // The turn-start receipt ack ('⏳ … 收到，开始处理…') is removed: the first
  // outbound bubble is the assistant's actual answer, not a fixed notice.
  const started = sentTexts().find((t) => t.includes('收到，开始处理…'))
  assert.ok(!started, sentTexts().join('\n'))
  // outbound targets the allowlisted sender
  assert.ok(server.sent.some((s) => s.to === 'wxid_allow1' && s.text === 'the answer'))
})

test('turn error emits an error digest', async () => {
  await mountNode()
  server.enqueue(textMessage('boom task'))
  await waitFor(() => followedUp.length === 1)
  const session = activeHandle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'kaboom', code: 'TEST' } } })
  await waitFor(() => sentTexts().some((t) => t.includes('kaboom')))
})

test('long assistant text is chunked into ≤ maxMessageChars bubbles with throttle', async () => {
  await mountNode({ maxMessageChars: 200, sendChunkDelayMs: 1 })
  server.enqueue(textMessage('long task'))
  await waitFor(() => followedUp.length === 1)
  const long = 'x'.repeat(700)
  const session = activeHandle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: long }], provider: 'test', model: 'test-model' }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => sentTexts().some((t) => t.includes('xxx') && !t.startsWith('⏳')), 3000)
  await waitFor(() => sentTexts().filter((t) => t.includes('xxx')).length >= 4, 3000)
  const bubbles = sentTexts().filter((t) => t.includes('xxx'))
  assert.ok(bubbles.length >= 4, `expected ≥4 bubbles, got ${bubbles.length}`)
  for (const bubble of bubbles) assert.ok(bubble.length <= 200)
})

test('splitForWechat keeps fenced code blocks intact', () => {
  const content = '```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n\n之后一句解释。'
  const chunks = splitForWechat(content, 60)
  assert.ok(chunks.length >= 2)
  const code = chunks.find((c) => c.includes('```ts'))
  assert.ok(code, 'code block must be preserved as one unit')
})

test('/sessions lists numbered sessions and /use switches the active session', async () => {
  await mountNode()
  // create a second, more recent session
  const second = await ctx.agents.create({ sessionId: SessionId('wechat-testb') })
  server.enqueue(textMessage('/sessions'))
  await waitFor(() => sentTexts().some((t) => t.includes('会话列表')), 3000)
  const list = sentTexts().find((t) => t.includes('会话列表'))!
  assert.ok(list.includes('1.') && list.includes('2.'), list)
  assert.ok(list.includes('wechat-testb'))
  await second.dispose()
})

test('/sessions prefers the real session title over the first-prompt label', async () => {
  await mountNode()
  ctx.sessionTitle.rename(activeHandle.agent.session, '我的自定义标题')
  server.enqueue(textMessage('/sessions'))
  await waitFor(() => sentTexts().some((t) => t.includes('会话列表')), 3000)
  const list = sentTexts().find((t) => t.includes('会话列表'))!
  assert.ok(list.includes('我的自定义标题'), list)
  assert.ok(list.includes('wechat-testa'), list)
})

test('/status carries the real session title and keeps the session id', async () => {
  await mountNode()
  ctx.sessionTitle.rename(activeHandle.agent.session, '状态标题')
  server.enqueue(textMessage('/status'))
  await waitFor(() => sentTexts().some((t) => t.includes('状态标题') && t.includes('wechat-testa')), 3000)
})

test('/memory reports an empty file, then the facts once there are some', async () => {
  const memoryFile = join(tmpdir(), `dsh-wechat-memory-cmd-${Date.now()}`, 'MEMORY.md')
  await mountNode({ memoryFile })
  server.enqueue(textMessage('/memory'))
  await waitFor(() => sentTexts().some((t) => t.includes('长期记忆')), 3000)
  assert.ok(sentTexts().some((t) => t.includes('还是空的')), sentTexts().join('\n'))

  ensureMemory(memoryFile)
  applyPatch(memoryFile, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
  server.enqueue(textMessage('/memory'))
  await waitFor(() => sentTexts().some((t) => t.includes('主人在示例市')), 3000)
})

test('/context reports the host\'s own numbers for the active session', async () => {
  const memoryFile = join(tmpdir(), `dsh-wechat-memory-ctx-${Date.now()}`, 'MEMORY.md')
  await mountNode({ memoryFile })
  ensureMemory(memoryFile)
  applyPatch(memoryFile, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')

  // The host writes this file for the session; point the reader at a scratch
  // home so the test never reads (or writes) the developer's live profile.
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const projDir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(
    join(projDir, 'wechat-testa.json'),
    JSON.stringify({
      version: 5,
      record: {
        rows: {
          contextPressure: { ver: 4, seq: 1, val: { contextWindow: 1_000_000, pressureTokens: 15_947, surfaceTokens: 3547 } },
          contextBreakdown: { ver: 2, seq: 1, val: { systemTokens: 2055, toolsTokens: 9262, messageTokens: 3547 } },
          sessionStats: { ver: 1, seq: 1, val: { turns: 3 } },
        },
      },
    }),
    'utf8',
  )
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    server.enqueue(textMessage('/context'))
    await waitFor(() => sentTexts().some((t) => t.includes('上下文')), 3000)
    const reply = sentTexts().find((t) => t.includes('上下文'))!
    assert.match(reply, /wechat-testa/)
    assert.match(reply, /3 轮/)
    assert.match(reply, /已用 1\.6 万 \/ 100 万/)
    assert.match(reply, /工具 9262/)
    assert.match(reply, /长期记忆：1 条/)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})

test('the agent\'s problem ledger can be read from WeChat', async () => {
  const problemFile = join(tmpdir(), `dsh-wechat-problems-cmd-${Date.now()}`, 'wechat-problems.log')
  // Built directly rather than through the plugin mount: `/problems` is about
  // the ledger, and a direct node keeps the assertion on the reply text.
  const subject = new WechatConversationNode(ctx, {
    allowFrom: ['wxid_allow1'],
    maxMessageChars: 2000,
    problemFile,
  } as NodeConfig)
  try {
    subject.peerId = 'wxid_allow1'
    await routeCommand(subject, '/problems')
    await waitFor(() => sentTexts().some((t) => t.includes('最近没有记录到问题')), 3000)

    subject.problems.report('unit-test', new Error('模拟的一次失败'))
    await routeCommand(subject, '/problems')
    await waitFor(() => sentTexts().some((t) => t.includes('模拟的一次失败')), 3000)
    const reply = sentTexts().find((t) => t.includes('模拟的一次失败'))!
    assert.match(reply, /\[unit-test\]/)
    assert.match(reply, /日志：/)

    await routeCommand(subject, '/problems clear')
    await waitFor(() => sentTexts().some((t) => t.includes('已清空问题列表')), 3000)
    assert.equal(subject.problems.recent().length, 0)
  } finally {
    subject.dispose()
  }
})

test('/status reports gateway health, not just the session', async () => {
  const problemFile = join(tmpdir(), `dsh-wechat-problems-status-${Date.now()}`, 'wechat-problems.log')
  const subject = new WechatConversationNode(ctx, {
    allowFrom: ['wxid_allow1'],
    maxMessageChars: 2000,
    problemFile,
  } as NodeConfig)
  try {
    subject.peerId = 'wxid_allow1'
    subject.gatewayStatus = 'error'
    subject.gatewayStatusAt = new Date().toISOString()
    await routeCommand(subject, '/status')
    await waitFor(() => sentTexts().some((t) => t.includes('网关:')), 3000)
    const reply = sentTexts().find((t) => t.includes('网关:'))!
    assert.match(reply, /🔴 已停止/)

    // A healthy gateway says so instead of staying silent about it.
    subject.gatewayStatus = 'connected'
    await routeCommand(subject, '/status')
    await waitFor(() => sentTexts().some((t) => t.includes('🟢 在线')), 3000)
  } finally {
    subject.dispose()
  }
})

test('remember_fact really writes the fact down — "记下了" has to be true', async () => {
  const memoryFile = join(tmpdir(), `dsh-wechat-remember-${Date.now()}`, 'MEMORY.md')
  await mountNode({ memoryFile })

  const tool = capturedTools.find((t) => t.name === 'remember_fact')
  assert.ok(tool, `模型必须能看到这个工具，实际注册了：${capturedTools.map((t) => t.name).join(', ')}`)

  const first = String(await tool.execute({ text: '主人有两个邮箱：主 a@x.com、副 b@y.com', section: '关于主人' }))
  assert.match(first, /已写进长期记忆/)
  const onDisk = readFileSync(memoryFile, 'utf8')
  assert.match(onDisk, /主 a@x\.com/)
  assert.match(onDisk, /副 b@y\.com/)

  // Saying it twice must not duplicate it — and must not claim a write either.
  const again = String(await tool.execute({ text: '主人有两个邮箱：主 a@x.com、副 b@y.com' }))
  assert.match(again, /已经记过了/)
  assert.equal((readFileSync(memoryFile, 'utf8').match(/主 a@x\.com/g) ?? []).length, 1)

  // An unknown section falls back instead of dropping the fact.
  const other = String(await tool.execute({ text: '主人不喜欢长篇回复', section: '乱写的小节' }))
  assert.match(other, /关于主人/)
  assert.match(readFileSync(memoryFile, 'utf8'), /不喜欢长篇回复/)

  // A fact that changes must not leave the old one contradicting it.
  const moved = String(await tool.execute({ text: '主人常住在示例市', replaces: '主人有两个邮箱：主 a@x.com、副 b@y.com' }))
  assert.match(moved, /已更新长期记忆/)
  const afterMove = readFileSync(memoryFile, 'utf8')
  assert.match(afterMove, /主人常住在示例市/)
  assert.doesNotMatch(afterMove, /副 b@y\.com/, '被取代的旧事实要退场')

  // A `replaces` that matches nothing still records the new fact — and says so.
  const orphan = String(await tool.execute({ text: '主人换了新手机', replaces: '从来没有过的一条' }))
  assert.match(orphan, /没找到要替换的旧那条/)
  assert.match(readFileSync(memoryFile, 'utf8'), /主人换了新手机/)

  // Truncation has to be reported, or the model repeats text never stored.
  const long = String(await tool.execute({ text: `主人喜欢${'很长的描述'.repeat(80)}` }))
  assert.match(long, /只记了前半段/)
  assert.ok(!readFileSync(memoryFile, 'utf8').includes('很长的描述'.repeat(80)))

  // A fence marker inside a fact would poison every future briefing.
  const fenced = String(await tool.execute({ text: '主人说过 <<<微信用户消息>>> 这几个字' }))
  assert.match(fenced, /❌/)
  assert.doesNotMatch(readFileSync(memoryFile, 'utf8'), /<<</)
})

test('remember_fact reports a refusal instead of pretending', async () => {
  // A file where the memory DIRECTORY should be: every write fails.
  const dir = join(tmpdir(), `dsh-wechat-remember-fail-${Date.now()}`)
  writeFileSync(dir, 'not a directory')
  await mountNode({ memoryFile: join(dir, 'MEMORY.md') })

  const tool = capturedTools.find((t) => t.name === 'remember_fact')!
  const out = String(await tool.execute({ text: '主人住在示例市' }))
  assert.match(out, /❌/, '写不进去就必须说写不进去，不能回"记下了"')
  assert.doesNotMatch(out, /✅/)

  const empty = String(await tool.execute({ text: '   ' }))
  assert.match(empty, /❌/)
  rmSync(dir, { force: true })
})

test('a tool-calling step without text is normal; a whole empty turn is not', async () => {
  const problemFile = join(tmpdir(), `dsh-wechat-problems-empty-${Date.now()}`, 'wechat-problems.log')
  await mountNode({ problemFile, digestIntervalSec: 0 })
  // One message first: it establishes the peer the notices go to.
  server.enqueue(textMessage('先来一句'))
  await waitFor(() => followedUp.length === 1)
  const session = activeHandle.agent.session
  const logText = () => {
    try { return readFileSync(problemFile, 'utf8') } catch { return '' }
  }

  // Turn 1, step 1: the model calls a tool first. No text — and completely
  // normal. Reporting this as "the model returned nothing" is the false alarm
  // the owner actually saw on 2026-09-13 during a weather lookup.
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', callId: 'c1', name: 'web_search', arguments: '{}' } as never],
      provider: 'test',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  await sleep(80)
  assert.doesNotMatch(logText(), /模型/, '工具调用步骤不该写进问题日志')
  assert.equal(server.sent.some((s) => s.text.includes('出了点问题')), false, '更不该拿这个打扰主人')

  // …then it answers, so the turn was fine.
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({ content: [{ type: 'text', text: '查到了，今天小雨' }], provider: 'test', model: 'test-model' }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => sentTexts().some((t) => t === '查到了，今天小雨'), 3000)
  assert.doesNotMatch(logText(), /模型没产出任何内容/)

  // Turn 2: nothing came back at all. The owner is left waiting, so this one is
  // a real problem and must leave a trace (and a notice).
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await waitFor(() => /这一轮模型没产出任何内容/.test(logText()), 3000)
  await waitFor(() => server.sent.some((s) => s.text.includes('出了点问题')), 3000)
})

test('an echoed user turn never reaches WeChat', async () => {
  await mountNode({ digestIntervalSec: 0 })
  server.enqueue(textMessage('先来一句'))
  await waitFor(() => followedUp.length === 1)
  const session = activeHandle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      // The shape seen in production: the real answer, then the model writing
      // the owner's next message and answering it.
      content: [{ type: 'text', text: '记下了，主邮箱 a@b.com\n\nuser<<<微信用户消息>>>\n先放着\n<<<微信用户消息结束｜发送于 2026-09-13 14:15>>>\n\n好' }],
      provider: 'test',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => sentTexts().some((t) => t.includes('记下了')), 3000)
  const sent = server.sent.map((s) => s.text).join('\n')
  assert.match(sent, /记下了，主邮箱/)
  assert.doesNotMatch(sent, /微信用户消息/, '围栏标记不能出现在发给主人的气泡里')
  assert.doesNotMatch(sent, /先放着/, '主人自己那句话不能被当成助手的回复发出去')
})

test('a fact is injected as background, never inside the user fence', async () => {
  const memoryFile = join(tmpdir(), `dsh-wechat-memory-inject-${Date.now()}`, 'MEMORY.md')
  await mountNode({ memoryFile })
  ensureMemory(memoryFile)
  applyPatch(memoryFile, { add: [{ section: '偏好与习惯', text: '不喜欢长篇回复' }] }, 'test')

  server.enqueue(textMessage('在吗'))
  await waitFor(() => followedUp.length === 1)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.startsWith(MEMORY_OPEN), text)
  assert.match(text, /不喜欢长篇回复/)
  // The envelope is still the tail, and the fact stays OUTSIDE it: the persona's
  // rule is that only fenced content is a message from the owner.
  assert.match(text, /<<<微信用户消息结束｜发送于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}>>>$/)
  const inner = text.slice(text.indexOf(USER_MESSAGE_OPEN))
  assert.doesNotMatch(inner, /不喜欢长篇回复/, '记忆不能混进正文')
  assert.match(inner, /在吗/)
})

test('/new creates an agent+session and follows up the prompt', async () => {
  await mountNode()
  const before = createdSessions.length
  server.enqueue(textMessage('/new 写一个 hello world'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.equal(createdSessions.at(-1)!.startsWith('wechat-'), true)
  await waitFor(() => followedUp.length === 1)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.equal(text, '写一个 hello world')
  // the confirmation is delivered asynchronously after the followup
  await waitFor(() => sentTexts().some((t) => t.includes('已创建新会话')), 3000)
})

test('/new mounts the configured agent preset through the factory setup hook', async () => {
  let mountedId: string | undefined
  let mountedCtx: Context | undefined
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async (id: string) => ({ id }),
    mount: async (agentCtx: Context, id: string) => {
      mountedId = id
      mountedCtx = agentCtx
    },
  })
  await mountNode({ agentPreset: 'standard' })
  const before = createdSessions.length
  server.enqueue(textMessage('/new 测试预设挂载'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.ok(lastCreateOptions, 'createAgent must receive options')
  assert.equal(lastCreateOptions!.meta?.agentPreset, 'standard')
  assert.equal(typeof lastCreateOptions!.setup, 'function', 'a setup hook must mount the preset')
  await (lastCreateOptions!.setup as (agentCtx: Context) => Promise<void>)(ctx)
  assert.equal(mountedId, 'standard')
  assert.equal(mountedCtx, ctx)
})

test('/new without an agentPresets service keeps the legacy no-setup shape', async () => {
  await mountNode({ agentPreset: 'standard' })
  const before = createdSessions.length
  server.enqueue(textMessage('/new 无预设服务'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.ok(lastCreateOptions, 'createAgent must receive options')
  assert.equal(lastCreateOptions!.meta?.agentPreset, 'standard')
  assert.equal(lastCreateOptions!.setup, undefined)
})

test('/stop cancels the active agent', async () => {
  await mountNode()
  server.enqueue(textMessage('/stop'))
  await waitFor(() => cancelled === true, 3000)
  // the confirmation is delivered asynchronously after the cancel
  await waitFor(() => sentTexts().some((t) => t.includes('已请求停止')), 3000)
})

test('/status reports the active session', async () => {
  await mountNode()
  server.enqueue(textMessage('/status'))
  await waitFor(() => sentTexts().some((t) => t.includes('wechat-testa')), 3000)
})

test('no active session: plain text gets a hint, not a crash', async () => {
  await mountNode()
  await activeHandle.dispose()
  server.enqueue(textMessage('hi there'))
  await waitFor(() => sentTexts().some((t) => t.includes('没有活动会话')), 3000)
  assert.equal(followedUp.length, 0)
})

test('allowFrom missing throws at mount time (security gate)', async () => {
  const fiber = ctx.plugin(wechatConversationNode, { allowFrom: [] })
  await assert.rejects(fiber.await(), /allowFrom is REQUIRED/)
})

test('approval round trip: /yes grants allowed-once', async () => {
  await mountNode({ approvalTimeoutSec: 5 })
  server.enqueue(textMessage('approval task'))
  await waitFor(() => followedUp.length === 1)
  const agent = activeHandle.agent
  // open a turn so the approval seam accepts the request
  agent.session.append('turn/start', { turn: 2 })

  let outcome: string | undefined
  const pending = ctx.approval.request({
    agent,
    toolName: 'bash',
    reason: 'run a destructive command',
  }).then((o) => { outcome = o })

  await waitFor(() => sentTexts().some((t) => t.includes('需要你的确认')), 3000)
  server.enqueue(textMessage('/yes'))
  await pending
  assert.equal(outcome, 'allowed-once')
  await waitFor(() => sentTexts().some((t) => t.includes('✅ 已同意')), 3000)
})

test('approval timeout falls back to default deny', async () => {
  await mountNode({ approvalTimeoutSec: 1 })
  server.enqueue(textMessage('approval task 2'))
  await waitFor(() => followedUp.length === 1)
  const agent = activeHandle.agent
  agent.session.append('turn/start', { turn: 3 })
  const outcome = await ctx.approval.request({
    agent,
    toolName: 'bash',
    reason: 'timeout me',
  })
  assert.equal(outcome, 'rejected')
})

test('digest heartbeat emits a one-line summary while a turn runs', async () => {
  // The outer gateway must not race the nodeCtx gateway for the same fake
  // server queue — stop it and let the dedicated context drive this test.
  await ctx.wechat.stop()
  const nodeCtx = new Context()
  await nodeCtx.plugin(SessionStore)
  await nodeCtx.plugin(AgentRegistry)
  nodeCtx.agents.setFactory(factory)
  await nodeCtx.plugin(ApprovalService)
  await nodeCtx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await nodeCtx.plugin(SystemPrompt)
  await nodeCtx.plugin(ToolRuntime)
  await nodeCtx.plugin(WechatGateway, { token: 't', accountId: 'wxid_bot_fake', baseUrl: server.url, pollIdleDelayMs: 5 })
  // The factory creates sessions/agents in the CURRENT runtime context, so
  // point it at nodeCtx — otherwise appends would dispatch on the outer bus
  // and this node would never see them.
  runtimeCtx = nodeCtx
  const handle = await nodeCtx.agents.create({ sessionId: SessionId('wechat-testhb') })
  // Same guard as mountNode(): this mount builds its own context, so it must
  // point the memory file at scratch space too — the default lands in the real
  // $DSH_HOME, which is the developer's LIVE harness profile.
  await nodeCtx.plugin(wechatConversationNode, {
    allowFrom: ['wxid_allow1'],
    digestIntervalSec: 1,
    sendChunkDelayMs: 1,
    memoryFile: join(tmpdir(), `dsh-wechat-memory-hb-${process.pid}`, 'MEMORY.md'),
    memoryConsolidateTime: '',
    problemFile: join(tmpdir(), `dsh-wechat-problems-hb-${process.pid}`, 'wechat-problems.log'),
  })
  await nodeCtx.wechat.start()

  server.enqueue(textMessage('heartbeat task'))
  await waitFor(() => followedUp.length >= 1, 3000)
  const session = handle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' })
  await waitFor(() => sentTexts().some((t) => t.includes('仍在处理中')), 5000)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await handle.dispose()
  await nodeCtx.wechat.stop()
})

test('image-only message: download, save to mediaDir, route path to the agent', async () => {
  const mediaDir = join(tmpdir(), `dsh-wechat-media-${Date.now()}`)
  await mountNode({ mediaDir })
  // minimal PNG magic bytes — enough for media-type detection (not a decodable image)
  const plaintext = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const key = mediaKey()
  server.media.set('eqp-img-node', { key, plaintext })
  server.enqueue({
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: 'msg-img-node',
    msg_type: 1,
    context_token: 'ctx-img-node',
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'eqp-img-node',
          aes_key: Buffer.from(key).toString('base64'),
        },
      },
    }],
  })
  await waitFor(() => followedUp.length === 1, 3000)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.startsWith(USER_MESSAGE_OPEN), text)
  const match = /\[微信图片\]\s*(\S+)/.exec(text)
  assert.ok(match, `followup should carry an image path, got: ${text}`)
  const absPath = match![1]!
  assert.ok(absPath.endsWith('.png'), `expected .png path, got: ${absPath}`)
  assert.deepEqual([...readFileSync(absPath)], [...plaintext])
})

test('file message: download, save under mediaDir, route path + name to the agent', async () => {
  const mediaDir = join(tmpdir(), `dsh-wechat-media-${Date.now()}`)
  await mountNode({ mediaDir })
  const plaintext = new Uint8Array([...Buffer.from('hello from dsh wechat bridge', 'utf8')])
  const key = mediaKey()
  server.media.set('eqp-file-node', { key, plaintext })
  server.enqueue({
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: 'msg-file-node',
    msg_type: 1,
    context_token: 'ctx-file-node',
    item_list: [{
      type: 4,
      file_item: {
        file_name: '报告.pdf',
        media: {
          encrypt_query_param: 'eqp-file-node',
          aes_key: Buffer.from(key).toString('base64'),
        },
      },
    }],
  })
  await waitFor(() => followedUp.length === 1, 3000)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.startsWith(USER_MESSAGE_OPEN), text)
  assert.ok(text.includes('[微信文件]'), text)
  assert.ok(text.includes('（报告.pdf）'), text)
  const match = /\[微信文件\]\s*([^\s（]+)/.exec(text)
  assert.ok(match, `followup should carry a file path, got: ${text}`)
  const absPath = match![1]!
  assert.ok(absPath.endsWith('.pdf'), `expected .pdf path, got: ${absPath}`)
  assert.deepEqual([...readFileSync(absPath)], [...plaintext])
})

test('video message: download, save as mp4 under mediaDir, route path to the agent', async () => {
  const mediaDir = join(tmpdir(), `dsh-wechat-media-${Date.now()}`)
  await mountNode({ mediaDir })
  // mp4 "ftyp" magic prefix — enough for the kind default, not a decodable file
  const plaintext = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00])
  const key = mediaKey()
  server.media.set('eqp-video-node', { key, plaintext })
  server.enqueue({
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: 'msg-video-node',
    msg_type: 1,
    context_token: 'ctx-video-node',
    item_list: [{
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: 'eqp-video-node',
          aes_key: Buffer.from(key).toString('base64'),
        },
      },
    }],
  })
  await waitFor(() => followedUp.length === 1, 3000)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.startsWith(USER_MESSAGE_OPEN), text)
  assert.ok(text.includes('[微信视频]'), text)
  const match = /\[微信视频\]\s*(\S+)/.exec(text)
  assert.ok(match, `followup should carry a video path, got: ${text}`)
  const absPath = match![1]!
  assert.ok(absPath.endsWith('.mp4'), `expected .mp4 path, got: ${absPath}`)
  assert.deepEqual([...readFileSync(absPath)], [...plaintext])
})
