/**
 * 平台隔离的回归测试：会话命名空间 + 默认落盘位置。
 *
 * 背景（2026-09-13 审计发现）：全桥的"这个会话是我的吗"只靠 id 前缀判断，而前缀
 * 写死成 `wechat-`，`newSessionId()` 也写死同一前缀。两个平台共用同一个 `$DSH_HOME`
 * （profile 只是它的子目录）时，QQ profile 会**领养微信的磁盘会话**并接着写下去 ——
 * QQ 用户的消息落进微信那段历史，回复还带着微信的上下文；反向同样成立。落盘位置
 * 也一样：记忆、提醒、台账、审批轨迹全部是 `wechat-*`，两边互相污染。
 *
 * 这组测试钉住三件事：
 *   1. 命名空间只有一个来源（前缀不再散落在七处硬编码里）；
 *   2. 微信侧的历史名字**逐字不变**（线上 profile 的文件就在那里，不能搬）；
 *   3. QQ 认不出、也选不中微信的会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platformNamespace } from '../src/platform/index.ts'
import { selectNewestSession, selectNewestWechat } from '../src/node/core.ts'
import { defaultProblemFile } from '../src/node/problems.ts'
import { defaultMemoryFile } from '../src/node/memory.ts'
import { defaultReminderFile } from '../src/node/reminders.ts'

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('平台命名空间只有一个来源', () => {
  assert.equal(platformNamespace('wechat'), 'wechat-')
  assert.equal(platformNamespace('qq'), 'qq-')
})

test('会话所有权判断不再散落硬编码：源码里不该再有 startsWith(\'wechat-\')', () => {
  // 这一条是这次审计的核心教训：七处各自硬编码同一个前缀，改一处漏一处就会让
  // /sessions 变空、/use 失效、出站整段不推、审批全部委托 —— 全都静默。
  const offenders = sourceFiles(SRC_DIR)
    .filter((file) => readFileSync(file, 'utf8').includes("startsWith('wechat-')"))
    .map((file) => file.slice(SRC_DIR.length).replace(/\\/g, '/'))
  assert.deepEqual(offenders, [], '请改用 node.sessionPrefix() / isOwnSessionId()')
})

test('默认落盘位置按平台分开，且微信侧保持历史名字', () => {
  // 微信侧不能变：线上 profile 的台账、记忆、提醒就在这里，搬走等于把它们丢掉。
  assert.ok(defaultProblemFile('wechat').endsWith('wechat-problems.log'))
  assert.ok(defaultMemoryFile('wechat').endsWith(join('wechat-memory', 'MEMORY.md')))
  assert.ok(defaultReminderFile('wechat').endsWith('wechat-reminders.json'))
  // QQ 侧必须分开，否则两边的失败与事实会混在一起。
  assert.ok(defaultProblemFile('qq').endsWith('qq-problems.log'))
  assert.ok(defaultMemoryFile('qq').endsWith(join('qq-memory', 'MEMORY.md')))
  assert.ok(defaultReminderFile('qq').endsWith('qq-reminders.json'))
  assert.notEqual(defaultProblemFile('qq'), defaultProblemFile('wechat'))
  assert.notEqual(defaultMemoryFile('qq'), defaultMemoryFile('wechat'))
})

test('QQ 不会认领微信的磁盘会话（反之亦然）', () => {
  const mixed = [
    { header: { id: 'wechat-old', createdAt: 1_000 }, revision: 'r' },
    { header: { id: 'qq-new', createdAt: 2_000 }, revision: 'r' },
  ] as never

  assert.equal(selectNewestSession(mixed, platformNamespace('qq'))?.id, 'qq-new')
  assert.equal(selectNewestSession(mixed, platformNamespace('wechat'))?.id, 'wechat-old')

  // 最要命的一种：磁盘上只有微信会话时，QQ 必须**选不出来**（从前它会选中并续写）。
  const onlyWechat = [{ header: { id: 'wechat-a', createdAt: 5 }, revision: 'r' }] as never
  assert.equal(selectNewestSession(onlyWechat, platformNamespace('qq')), undefined)
  assert.equal(selectNewestWechat(onlyWechat)?.id, 'wechat-a')
})
