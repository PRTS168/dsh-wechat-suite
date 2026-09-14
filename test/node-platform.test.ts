/**
 * 平台无关性的回归测试：节点插件必须能挂在 **qq** 上。
 *
 * 背景（2026-09-13 实测踩到）：节点的静态 `inject` 里写着 `'wechat'`。cordis 把
 * `inject` 当**等待门**——列出的服务不出现，插件就整个不被应用。QQ profile 挂的是
 * `ctx.qq`，`ctx.wechat` 永远不存在，于是节点从未启动：网关照常连上、帧照常收到，
 * 但 `qq/message` 与 `qq/error` 都没有听众 —— 收不到回复、台账一行不写、提醒不响，
 * 从外面看就像是"网关死了"。而网关自己的状态文件仍然写着 connected。
 *
 * 这组测试只提供 `qq` 服务（不提供 `wechat`），断言节点**确实被挂载并工作**：
 * 入站命令能通过 qq 平台回出去，网关的报错能落进台账。
 *
 * 它们跑在真实的 cordis 上下文里，而不是桩：这一整类"插件根本没挂载"的问题，
 * 用桩是测不出来的。
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { wechatConversationNode } from '../src/node/index.ts'
import type { InboundMessage } from '../src/gateway/types.ts'

/** 最小可用的 qq 平台服务：只记录被要求发出去的东西。 */
class FakeQqPlatform extends Service {
  readonly sent: { to: string; text: string }[] = []
  readonly accountId = 'qq-bot-fake'

  constructor(ctx: Context) {
    super(ctx, 'qq')
  }

  async sendText(to: string, text: string): Promise<{ success: boolean }> {
    this.sent.push({ to, text })
    return { success: true }
  }

  async sendImage(): Promise<{ success: boolean }> {
    return { success: true }
  }

  async sendFile(): Promise<{ success: boolean }> {
    return { success: true }
  }

  async sendTyping(): Promise<void> {
    // 单聊没有输入中状态，和真实 QQ 网关一样空实现。
  }

  async downloadImage(): Promise<null> {
    return null
  }

  async downloadVoice(): Promise<null> {
    return null
  }

  async downloadAttachment(): Promise<null> {
    return null
  }
}

const OPENID = 'OPENID-ALLOWED-0001'

let ctx: Context | undefined
let scratch: string | undefined
let mounted: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const fiber of mounted) {
    try {
      await fiber.dispose()
    } catch {
      // 拆不干净不该让别的用例失败。
    }
  }
  mounted = []
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
  ctx = undefined
})

function scratchDir(): string {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-node-platform-test-'))
  return scratch
}

/** 挂一个只提供 qq 服务的上下文，并按 QQ profile 的形状挂上节点。 */
async function mountOnQq(options: { allowFrom?: string[] } = {}): Promise<{
  ctx: Context
  qq: FakeQqPlatform
  problemFile: string
}> {
  const dir = scratchDir()
  const problemFile = join(dir, 'problems.log')
  const root = new Context()
  ctx = root

  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  await root.plugin(ApprovalService)
  // dsh-tools 自己 inject 了 systemPrompt；缺它 tools 不加载，节点也会跟着被挂起。
  await root.plugin(SessionProjection)
  await root.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(FakeQqPlatform)
  const qq = root.get('qq') as unknown as FakeQqPlatform

  // 挂载完成的可靠信号：节点在构造时就把工具注册进 ctx.tools。`apply()` 里用
  // `ctx.inject` 等平台服务，回调是异步落地的 —— 不等它就开始发事件，测的会是
  // "事件发得比订阅早"，而不是被测的行为。
  const registered: string[] = []
  const registry = root.tools as unknown as { register: (definition: unknown) => () => void }
  const original = registry.register.bind(registry)
  registry.register = (definition: unknown) => {
    const named = definition as { name?: string }
    if (named?.name) registered.push(named.name)
    return original(definition)
  }

  mounted.push(
    root.plugin(wechatConversationNode, {
      platform: 'qq',
      allowFrom: options.allowFrom ?? [OPENID],
      // 一个测试进程绝不能写进任何真实 profile：每个落盘位置都指向临时目录。
      problemFile,
      memoryFile: join(dir, 'MEMORY.md'),
      memoryConsolidateTime: '',
      reminderFile: join(dir, 'reminders.json'),
      morningFile: join(dir, 'morning.json'),
      mediaDir: join(dir, 'media'),
      digestIntervalSec: 0,
      sendChunkDelayMs: 1,
    }) as unknown as { dispose: () => Promise<void> },
  )
  await waitFor(() => registered.length > 0)
  return { ctx: root, qq, problemFile }
}

function textMessage(text: string, from = OPENID): InboundMessage {
  return {
    from_user_id: from,
    to_user_id: 'qq-bot-fake',
    message_id: `qq-msg-${Math.random().toString(36).slice(2)}`,
    msg_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('condition not met within timeout')
}

test('节点插件不会把某个平台写进 inject —— 否则另一个平台永远不会被挂载', () => {
  const declared = (wechatConversationNode.inject ?? []) as string[]
  assert.ok(
    !declared.includes('wechat') && !declared.includes('qq'),
    `inject 里不能出现平台服务名（现在是 ${JSON.stringify(declared)}）：它会把节点永久锁在另一个平台上`,
  )
})

test('platform=qq 时节点确实被挂载：入站命令能经 qq 平台回出去', async () => {
  const { ctx: root, qq } = await mountOnQq()

  root.emit('qq/message', textMessage('/help'))

  await waitFor(() => qq.sent.length > 0)
  assert.equal(qq.sent[0]!.to, OPENID)
  assert.ok(qq.sent[0]!.text.length > 0, '命令必须有回复内容')
})

test('platform=qq 时网关的报错会落进台账（这就是之前"一片死寂"的盲区）', async () => {
  const { ctx: root, problemFile } = await mountOnQq()

  root.emit('qq/error', new Error('自检用的网关报错'))

  await waitFor(() => existsSync(problemFile) && readFileSync(problemFile, 'utf8').includes('自检用的网关报错'))
})

test('platform=qq 时非白名单来客不会被喂给模型，也不会收到任何回复', async () => {
  const { ctx: root, qq } = await mountOnQq({ allowFrom: [OPENID] })

  root.emit('qq/message', textMessage('/help', 'OPENID-STRANGER-9999'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(qq.sent, [])
})
