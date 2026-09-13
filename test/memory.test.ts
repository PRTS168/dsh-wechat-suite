/**
 * Long-term memory tests.
 *
 * Everything here runs against a temporary directory: the service under test
 * must never touch the real `$DSH_HOME`, and a failure must never escape as a
 * throw (it runs next to the live bridge).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import {
  MEMORY_CLOSE,
  MEMORY_LIMIT_CHARS,
  MEMORY_OPEN,
  MEMORY_SEED,
  MemoryService,
  applyPatch,
  consolidationPrompt,
  ensureMemory,
  extractUtterances,
  factCount,
  memoryBriefing,
  parsePatch,
  readMemory,
  writeMemory,
} from '../src/node/memory.ts'
import { USER_MESSAGE_OPEN, wrapUserMessage } from '../src/node/inbound.ts'

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-memory-'))
  return { dir, file: join(dir, 'MEMORY.md') }
}

/** One inbound session event holding a fenced user message. */
const userEvent = (text: string, at = '2026-09-12 21:00') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text: wrapUserMessage(text, new Date(2026, 8, 12, 21, 0)) }] },
  at,
})

/** The model's own text, which must never become a fact about the owner. */
const assistantEvent = (text: string) => ({ type: 'assistant/message', data: { content: [{ type: 'text', text }] } })

test('a missing file is seeded with the section skeleton', () => {
  const { dir, file } = tempFile()
  try {
    const text = ensureMemory(file)
    assert.equal(text, MEMORY_SEED)
    for (const section of ['关于主人', '偏好与习惯', '常用设备与环境', '待办与承诺', '重要决定', '已过期']) {
      assert.match(text, new RegExp(`## ${section}`))
    }
    assert.equal(readMemory(file), MEMORY_SEED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyPatch adds, updates and expires facts inside their sections', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const first = applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    assert.deepEqual([first.added, first.updated, first.expired], [1, 0, 0])

    const second = applyPatch(file, { add: [{ section: '偏好与习惯', text: '不喜欢长篇回复' }] }, 'test')
    assert.equal(second.added, 1)
    // Re-adding the same fact is a no-op, not a duplicate.
    const third = applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    assert.equal(third.added, 0)

    const fourth = applyPatch(file, { update: [{ from: '主人在示例市', to: '主人常住在示例市' }] }, 'test')
    assert.equal(fourth.updated, 1)
    const text = readMemory(file)
    assert.match(text, /主人常住在示例市/)
    assert.doesNotMatch(text, /- 主人在示例市（/)

    const fifth = applyPatch(file, { expire: ['主人常住在示例市'] }, 'test')
    assert.equal(fifth.expired, 1)
    const after = readMemory(file)
    assert.match(after, /## 已过期/)
    assert.match(after, /主人常住在示例市（作废 /)
    // The fact left its original section.
    const about = after.slice(after.indexOf('## 关于主人'), after.indexOf('## 偏好与习惯'))
    assert.doesNotMatch(about, /示例市/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown sections and unmatched updates are reported, never guessed', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const result = applyPatch(
      file,
      { add: [{ section: '不存在的节', text: '随便一条' }], update: [{ from: '没这条', to: '改一下' }] },
      'test',
    )
    assert.equal(result.added + result.updated + result.expired, 0)
    assert.equal(result.skipped.length, 2)
    assert.doesNotMatch(readMemory(file), /随便一条/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the audit log records what changed and why', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '重要决定', text: '上下文改为一条会话到底' }] }, 'unit-test')
    const log = readFileSync(join(dir, 'memory-log.md'), 'utf8')
    assert.match(log, /\+1 ~0 -0/)
    assert.match(log, /origin=unit-test/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write that would exceed the cap is refused, not truncated', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const huge = 'x'.repeat(MEMORY_LIMIT_CHARS + 10)
    const result = applyPatch(file, { add: [{ section: '关于主人', text: huge }] }, 'test')
    assert.equal(result.added, 0)
    assert.match(result.skipped.join('\n'), /超过 \d+ 字符上限/)
    assert.ok(readMemory(file).length <= MEMORY_LIMIT_CHARS)
    // The refusal says WHY: an IO failure reported as "over the limit" sends
    // whoever reads the log looking in the wrong place.
    assert.equal(writeMemory(file, huge).reason, 'cap')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-UTF-8 hand edit is refused instead of being baked into mojibake', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    // A GBK editor rewrote the fact line: decoding those bytes as UTF-8 yields
    // U+FFFD, and writing our version back would destroy the original bytes.
    const gbkFact = Buffer.from([0xd6, 0xf7, 0xc8, 0xcb, 0xd4, 0xda, 0xcb, 0xe7, 0xbb, 0xaf])
    const head = readMemory(file).replace('- '.repeat(0), '') // keep the seed intact
    writeFileSync(file, Buffer.concat([Buffer.from(`${head}`, 'utf8'), Buffer.from('- ', 'utf8'), gbkFact, Buffer.from('\n', 'utf8')]))
    const before = readFileSync(file)
    const result = applyPatch(file, { add: [{ section: '偏好与习惯', text: '不要 Emoji' }] }, 'test')
    assert.equal(result.added, 0)
    assert.match(result.skipped.join('\n'), /UTF-8/)
    assert.deepEqual(readFileSync(file), before, '原始字节一个都不能动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused write leaves no temp file behind and reports the real reason', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    // A directory where the temp file must go makes every write fail with IO,
    // not with the character cap.
    mkdirSync(`${file}.tmp-${process.pid}`, { recursive: true })
    const written = writeMemory(file, '# 记忆\n\n## 关于主人\n- 主人在示例市（2026-01-01）\n')
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'io')
    assert.ok(written.detail)
    rmSync(`${file}.tmp-${process.pid}`, { recursive: true, force: true })
    assert.equal(writeMemory(file, '# 记忆\n').ok, true, '恢复后可写')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an update matches one whole fact, never a substring of several', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { add: [{ section: '偏好与习惯', text: '主人喜欢短回复' }] }, 'test')
    applyPatch(file, { add: [{ section: '常用设备与环境', text: '主人的电脑是 Windows' }] }, 'test')

    // The model sending a fragment must NOT rewrite everything containing it.
    const vague = applyPatch(file, { update: [{ from: '主人', to: '主人叫张三' }] }, 'test')
    assert.equal(vague.updated, 0)
    assert.equal(vague.skipped.length, 1)
    const text = readMemory(file)
    assert.match(text, /主人在示例市/)
    assert.match(text, /主人喜欢短回复/)
    assert.match(text, /主人的电脑是 Windows/)
    assert.doesNotMatch(text, /张三/)

    // The full text of one fact still updates exactly that fact.
    const exact = applyPatch(file, { update: [{ from: '主人在示例市', to: '主人常住在示例市' }] }, 'test')
    assert.equal(exact.updated, 1)
    assert.match(readMemory(file), /主人常住在示例市/)
    assert.match(readMemory(file), /主人喜欢短回复/, '别的事实不受牵连')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('headings, guidance and 已过期 entries can never be rewritten or retired', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { add: [{ section: '关于主人', text: '主人养了猫' }] }, 'test')
    applyPatch(file, { expire: ['主人养了猫'] }, 'test')

    const onHeading = applyPatch(file, { update: [{ from: '关于主人', to: '被改名了' }] }, 'test')
    assert.equal(onHeading.updated, 0)
    const onGuidance = applyPatch(file, { update: [{ from: '这个文件是跨会话的长期记忆', to: 'x' }] }, 'test')
    assert.equal(onGuidance.updated, 0)
    // The expired entry is bookkeeping: matching it would write the new value
    // into 已过期, where it is never injected again.
    const onExpired = applyPatch(file, { update: [{ from: '主人养了猫', to: '主人养了狗' }] }, 'test')
    assert.equal(onExpired.updated, 0)
    const expireExpired = applyPatch(file, { expire: ['主人养了猫'] }, 'test')
    assert.equal(expireExpired.expired, 0)

    const text = readMemory(file)
    assert.match(text, /## 关于主人\n/)
    assert.match(text, /## 已过期\n- 主人养了猫（作废 /)
    assert.match(text, /\n\n## 偏好与习惯/, '标题之间的空行还在')
    assert.ok(!/被改名了|x（/.test(text))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expire reports the facts it retired, not the number of entries it was given', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { add: [{ section: '偏好与习惯', text: '不要 Emoji' }] }, 'test')
    const result = applyPatch(file, { expire: ['主人在示例市', '主人在示例市'] }, 'test')
    assert.equal(result.expired, 1, '同一条事实的重复副本只算作废一条')
    const text = readMemory(file)
    assert.equal((text.match(/作废/g) ?? []).length, 1)
    assert.equal((text.match(/主人在示例市/g) ?? []).length, 1, '只留 已过期 里的那条')
    assert.equal((text.match(/不要 Emoji/g) ?? []).length, 1, '别的事实没被带走')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hand-written * or indented fact is both visible and retirable', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    writeFileSync(
      file,
      '# 长期记忆\n\n> 说明\n\n## 关于主人\n\n* 主人在示例市（2026-01-01）\n  - 主人养了猫\n\n## 偏好与习惯\n\n',
      'utf8',
    )
    const briefing = memoryBriefing(file)!
    assert.match(briefing, /主人在示例市/)
    assert.match(briefing, /主人养了猫/)
    assert.equal(factCount(file), 2)
    assert.equal(applyPatch(file, { expire: ['主人养了猫'] }, 'test').expired, 1)
    assert.equal(factCount(file), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a model reply with the right field names but wrong types changes nothing destructive', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const before = readMemory(file)
    // `{"add":42}` parsed fine and then threw "42 is not iterable", which threw
    // away the whole consolidation. It must simply be an empty patch.
    assert.deepEqual(parsePatch('{"add":42,"update":{"from":"a"},"expire":[1,"主人在示例市"]}'), {
      add: [],
      update: [],
      expire: ['主人在示例市'],
    })
    const patch = parsePatch('{"add":42,"update":{"from":"a"},"expire":{"x":1}}')!
    const result = applyPatch(file, patch, 'test')
    assert.equal(result.expired, 0)
    assert.equal(readMemory(file), before, '什么都没有变')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the briefing is fenced as background and drops the file guidance header', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const briefing = memoryBriefing(file)
    assert.ok(briefing)
    assert.ok(briefing!.startsWith(MEMORY_OPEN))
    assert.ok(briefing!.endsWith(MEMORY_CLOSE))
    assert.match(briefing!, /主人在示例市/)
    assert.doesNotMatch(briefing!, /这个文件是跨会话的长期记忆/)
    assert.match(briefing!, /不是本条消息的要求/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty memory injects nothing: no shape without facts', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    // A freshly seeded file is headings only. Shipping it would spend context on
    // every message and hand the model a memory shape with nothing in it.
    assert.equal(memoryBriefing(file), null)

    // Only an expired entry is still nothing worth injecting.
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { expire: ['主人在示例市'] }, 'test')
    assert.equal(memoryBriefing(file), null, '已过期 不进入上下文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the briefing carries only the sections that hold facts', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '偏好与习惯', text: '不喜欢长篇回复' }] }, 'test')
    const briefing = memoryBriefing(file)!
    assert.match(briefing, /## 偏好与习惯\n- 不喜欢长篇回复/)
    assert.doesNotMatch(briefing, /## 关于主人/, '空小节不注入')
    assert.doesNotMatch(briefing, /## 待办与承诺/, '空小节不注入')
    assert.doesNotMatch(briefing, /## 已过期/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fact stamped with a date is still recognised as a duplicate', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const first = applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    assert.equal(first.added, 1)
    // The stored line carries `（date）`; the model repeats the bare sentence.
    const again = applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    assert.equal(again.added, 0)
    assert.equal(again.skipped.length, 0, '重复是正常结果，不是错误')
    assert.equal((readMemory(file).match(/主人在示例市/g) ?? []).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an update collapses duplicate copies of the old fact, an expire retires them', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    // A hand-edited file can hold the same fact in two sections.
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    applyPatch(file, { add: [{ section: '常用设备与环境', text: '主人在示例市' }] }, 'test')
    assert.equal((readMemory(file).match(/主人在示例市/g) ?? []).length, 2)

    const updated = applyPatch(file, { update: [{ from: '主人在示例市', to: '主人常住在示例市' }] }, 'test')
    assert.equal(updated.updated, 1)
    const afterUpdate = readMemory(file)
    assert.equal((afterUpdate.match(/主人在示例市/g) ?? []).length, 0, '旧事实不留残影')
    assert.equal((afterUpdate.match(/主人常住在示例市/g) ?? []).length, 1, '改完只留一条，不复制')

    const expired = applyPatch(file, { expire: ['主人常住在示例市'] }, 'test')
    assert.equal(expired.expired, 1)
    const after = readMemory(file)
    assert.match(after, /## 已过期\n- 主人常住在示例市（作废 /)
    assert.equal((after.match(/主人常住在示例市/g) ?? []).length, 1, '只剩 已过期 里的作废记录')
    assert.equal((after.match(/作废/g) ?? []).length, 1)
    assert.equal(memoryBriefing(file), null, '作废后不再注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes keep the blank line before the next heading and use the local date', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const text = readMemory(file)
    assert.match(text, new RegExp(`- 主人在示例市（${stamp}）`), '本地日历日期，不是 UTC')
    assert.match(text, /\n\n## 偏好与习惯/, '小节之间的空行没被吃掉')
    assert.ok(!/\n{3,}/.test(text), '也不该堆出多余空行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only fenced user messages become candidate facts', () => {
  const events = [
    userEvent('我在示例市，别用 Emoji'),
    assistantEvent('好的主人，我记住了'),
    { type: 'user/message', data: { content: [{ type: 'text', text: '会话交接摘要：上一会话已轮换' }] } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: '{}' } },
    userEvent('另外我不喜欢长篇'),
  ]
  const utterances = extractUtterances(events as unknown[])
  assert.equal(utterances.length, 2)
  assert.match(utterances[0]!.text, /我在示例市/)
  assert.match(utterances[1]!.text, /不喜欢长篇/)
  assert.match(utterances[0]!.at, /^2026-09-12 21:00$/)
})

test('parsePatch tolerates prose and code fences, rejects nonsense', () => {
  const wrapped = '好的，这是结果：\n```json\n{"add":[{"section":"关于主人","text":"x"}]}\n```\n完事'
  assert.deepEqual(parsePatch(wrapped)?.add?.[0]?.text, 'x')
  assert.equal(parsePatch('我不知道该说什么'), null)
  assert.equal(parsePatch('{ 不是 json'), null)
})

test('the consolidation prompt states the sections and the rules', () => {
  const prompt = consolidationPrompt('- [2026-09-12 21:00] 我在示例市', MEMORY_SEED)
  assert.match(prompt, /关于主人 \/ 偏好与习惯 \/ 常用设备与环境 \/ 待办与承诺 \/ 重要决定/)
  assert.match(prompt, /不写密码、token、API key/)
  assert.match(prompt, /我在示例市/)
})

test('normalize handles a model reply that carries prose around the JSON', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const patch = parsePatch('给你：\n{"add":[{"section":"偏好与习惯","text":"爱喝奶茶"}]}\n就这些')
    assert.ok(patch)
    const result = applyPatch(file, patch!, 'test')
    assert.equal(result.added, 1)
    assert.match(readMemory(file), /爱喝奶茶/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the service: injection cadence and the consolidation run ────────────────

function serviceWithLlm(reply: string | null, file: string, options: { injectEvery?: number; failTimes?: number } = {}) {
  const ctx = new Context()
  let calls = 0
  const llm = {
    stream: async function* () {
      calls += 1
      if (options.failTimes && calls <= options.failTimes) throw new Error('provider exploded')
      if (reply === null) return
      yield { type: 'text-delta', index: 0, text: reply }
    },
  }
  ctx.provide('llm', llm as never)
  const service = new MemoryService(ctx, { file, injectEvery: options.injectEvery ?? 10, consolidateAt: '' })
  return { service, calls: () => calls }
}

const fakeSession = (events: unknown[]) =>
  ({ id: 'wechat-test', snapshotEvents: () => events }) as never

test('the briefing is injected on the first message, then only on change or interval', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const { service } = serviceWithLlm(null, file, { injectEvery: 3 })

    assert.ok(service.briefing('wechat-a'), 'first message carries it')
    assert.equal(service.briefing('wechat-a'), null, 'second message does not')
    // Third message hits the interval (injectEvery = 3).
    assert.ok(service.briefing('wechat-a'), 'the interval message carries it')
    assert.equal(service.briefing('wechat-a'), null, 'and the one after it does not')
    // A change injects immediately, regardless of the counter.
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '偏好与习惯', text: '喜欢短回复' }] }, 'test')
    assert.ok(service.briefing('wechat-a'), 'changed content carries it')
    // A different session starts its own count.
    assert.ok(service.briefing('wechat-b'), 'new session carries it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the daily run skips a day with no new messages instead of re-reading itself', async () => {
  const { dir, file } = tempFile()
  const ctx = new Context()
  let calls = 0
  const llm = {
    stream: async function* () {
      calls += 1
      yield { type: 'text-delta', index: 0, text: '{"add":[{"section":"关于主人","text":"主人在示例市"}]}' }
    },
  }
  ctx.provide('llm', llm as never)
  // A movable clock: the idle guard must not be what makes the second run a no-op.
  let clock = new Date('2026-09-13T23:00:00')
  const service = new MemoryService(ctx, {
    file,
    injectEvery: 10,
    consolidateAt: '',
    idleMs: 60_000,
    now: () => clock,
  })
  const timer = service as unknown as { onTimer(): Promise<void> }
  try {
    ensureMemory(file)
    const events = Array.from({ length: 6 }, (_, i) => userEvent(`第 ${i} 条：我在示例市`))
    service.sessionProvider = () => fakeSession(events)
    service.routeProvider = () => ({ provider: 'p', model: 'm' })

    // Two messages arrive, then the timer fires a while later.
    service.briefing('wechat-a')
    service.briefing('wechat-a')
    clock = new Date('2026-09-14T04:30:00')
    await timer.onTimer()
    assert.equal(calls, 1, 'first run reads the conversation')
    assert.match(readMemory(file), /主人在示例市/)

    // Nothing said since. A second run must cost nothing: re-reading the same
    // conversation cannot add a fact, and gives the model a chance to drop one.
    await timer.onTimer()
    assert.equal(calls, 1, 'no second model call')
    assert.match(readMemory(file), /主人在示例市/, '记忆没被动过')

    // A new message makes the next run worthwhile again.
    service.briefing('wechat-a')
    clock = new Date('2026-09-15T04:30:00')
    await timer.onTimer()
    assert.equal(calls, 2, 'new messages re-enable the run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('consolidation applies what the session model returns', async () => {
  const { dir, file } = tempFile()
  const reply = '{"add":[{"section":"关于主人","text":"主人在示例市"},{"section":"偏好与习惯","text":"不要 Emoji"}]}'
  const { service, calls } = serviceWithLlm(reply, file)
  try {
    ensureMemory(file)
    const events = Array.from({ length: 6 }, (_, i) => userEvent(`第 ${i} 条：我在示例市，别用 Emoji`))
    const report = await service.consolidateNow(fakeSession(events), { provider: 'p', model: 'm' }, 'test')
    assert.equal(report.ran, true)
    assert.equal(report.added, 2)
    assert.equal(calls(), 1)
    const text = readMemory(file)
    assert.match(text, /主人在示例市/)
    assert.match(text, /不要 Emoji/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('consolidation skips a quiet day instead of paying for a model call', async () => {
  const { dir, file } = tempFile()
  const { service, calls } = serviceWithLlm('{"add":[]}', file)
  try {
    ensureMemory(file)
    const report = await service.consolidateNow(fakeSession([userEvent('就一句')]), { provider: 'p', model: 'm' }, 'test')
    assert.equal(report.ran, false)
    assert.equal(calls(), 0, 'no model call for a single utterance')
    assert.match(report.reason, /1 < 5/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing model is retried once and then reported, never thrown', async () => {
  const { dir, file } = tempFile()
  const { service, calls } = serviceWithLlm('{"add":[]}', file, { failTimes: 5 })
  try {
    ensureMemory(file)
    const events = Array.from({ length: 6 }, (_, i) => userEvent(`第 ${i} 条`))
    const report = await service.consolidateNow(fakeSession(events), { provider: 'p', model: 'm' }, 'test')
    assert.equal(report.ran, false)
    assert.equal(calls(), 2, 'exactly one retry')
    assert.match(report.reason, /provider exploded/)
    const log = readFileSync(join(dir, 'memory-log.md'), 'utf8')
    assert.match(log, /整理异常/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unparsable model reply changes nothing and is logged', async () => {
  const { dir, file } = tempFile()
  const { service } = serviceWithLlm('我不知道', file)
  try {
    ensureMemory(file)
    const before = readMemory(file)
    const events = Array.from({ length: 6 }, (_, i) => userEvent(`第 ${i} 条`))
    const report = await service.consolidateNow(fakeSession(events), { provider: 'p', model: 'm' }, 'test')
    assert.equal(report.ran, false)
    assert.match(report.reason, /unparsable/)
    assert.equal(readMemory(file), before)
    assert.match(readFileSync(join(dir, 'memory-log.md'), 'utf8'), /不是 JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('consolidation without a session or route reports instead of failing', async () => {
  const { dir, file } = tempFile()
  const { service } = serviceWithLlm('{"add":[]}', file)
  try {
    const noSession = await service.consolidateNow(undefined, { provider: 'p', model: 'm' }, 'test')
    assert.equal(noSession.ran, false)
    assert.match(noSession.reason, /no session or model route/)
    const noRoute = await service.consolidateNow(fakeSession([userEvent('x')]), undefined, 'test')
    assert.equal(noRoute.ran, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a night that fails stays retryable instead of being forgotten', async () => {
  const { dir, file } = tempFile()
  const ctx = new Context()
  let calls = 0
  const llm = {
    stream: async function* () {
      calls += 1
      throw new Error('provider exploded')
    },
  }
  ctx.provide('llm', llm as never)
  let clock = new Date('2026-09-13T23:00:00')
  const service = new MemoryService(ctx, { file, consolidateAt: '', idleMs: 60_000, now: () => clock })
  const timer = service as unknown as { onTimer(): Promise<void> }
  try {
    ensureMemory(file)
    const events = Array.from({ length: 6 }, (_, i) => userEvent(`第 ${i} 条：我在示例市`))
    service.sessionProvider = () => fakeSession(events)
    service.routeProvider = () => ({ provider: 'p', model: 'm' })
    service.briefing('wechat-a')

    clock = new Date('2026-09-14T04:30:00')
    await timer.onTimer()
    const afterFirst = calls
    assert.ok(afterFirst > 0, '确实尝试过')
    // Both attempts inside the run failed, so the day is NOT marked as done:
    // advancing the cursor here is what turns one bad night into a silently
    // forgotten day.
    clock = new Date('2026-09-15T04:30:00')
    await timer.onTimer()
    assert.ok(calls > afterFirst, '第二天还会再试一次')
    assert.match(readFileSync(join(dir, 'memory-log.md'), 'utf8'), /保持可重试/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a nonsense consolidation time disables the timer and says so', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    for (const bad of ['99:99', '25:00', '04:99', '4:5', '每天']) {
      const ctx = new Context()
      ctx.provide('llm', { stream: async function* () {} } as never)
      const service = new MemoryService(ctx, { file, consolidateAt: bad })
      const timerOf = service as unknown as { timer?: unknown }
      service.start()
      assert.equal(timerOf.timer, undefined, `${bad} 不该被 setHours 悄悄进位后照样跑`)
      service.stop()
    }
    const log = readFileSync(join(dir, 'memory-log.md'), 'utf8')
    assert.match(log, /99:99/)
    assert.match(log, /不是合法时间/)

    // A real time still arms, and an empty value means "off" without a warning.
    const ctx = new Context()
    ctx.provide('llm', { stream: async function* () {} } as never)
    const armed = new MemoryService(ctx, { file, consolidateAt: '4:30' })
    const armedTimer = armed as unknown as { timer?: unknown }
    armed.start()
    assert.ok(armedTimer.timer, '4:30 归一化成 04:30 后要真的挂上')
    armed.stop()
    const off = new MemoryService(ctx, { file, consolidateAt: '' })
    const offTimer = off as unknown as { timer?: unknown }
    off.start()
    assert.equal(offTimer.timer, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start, stop, start arms the timer again', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    const ctx = new Context()
    ctx.provide('llm', { stream: async function* () {} } as never)
    const service = new MemoryService(ctx, { file, consolidateAt: '04:30' })
    const timerOf = service as unknown as { timer?: unknown }
    service.start()
    assert.ok(timerOf.timer)
    service.stop()
    assert.equal(timerOf.timer, undefined)
    service.start()
    assert.ok(timerOf.timer, 'stop 之后必须还能重新武装')
    service.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('per-session injection bookkeeping stays bounded', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const ctx = new Context()
    ctx.provide('llm', { stream: async function* () {} } as never)
    const service = new MemoryService(ctx, { file, consolidateAt: '' })
    for (let i = 0; i < 200; i += 1) service.briefing(`wechat-session-${i}`)
    const tracked = service as unknown as { injected: Map<string, unknown> }
    assert.ok(tracked.injected.size <= 64, `只保留最近若干会话，实际 ${tracked.injected.size}`)
    // The newest session must still be tracked (the oldest are the ones dropped).
    assert.ok(tracked.injected.has('wechat-session-199'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a compaction makes the next message carry the memory again', () => {
  const { dir, file } = tempFile()
  try {
    ensureMemory(file)
    applyPatch(file, { add: [{ section: '关于主人', text: '主人在示例市' }] }, 'test')
    const ctx = new Context()
    ctx.provide('llm', { stream: async function* () {} } as never)
    const service = new MemoryService(ctx, { file, injectEvery: 10, consolidateAt: '' })
    assert.ok(service.briefing('wechat-a'), '第一条带')
    assert.equal(service.briefing('wechat-a'), null, '第二条不带')
    // The host folded the history into a summary: identity facts must be
    // re-anchored on the next message, not ten messages later.
    service.noteCompaction('wechat-a')
    assert.ok(service.briefing('wechat-a'), '压缩之后马上重新注入一次')
    assert.equal(service.briefing('wechat-a'), null, '然后再回到正常节奏')
    // Another session's cadence is untouched.
    assert.ok(service.briefing('wechat-b'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the handoff note and the briefing are never mined as the owner\'s words', () => {
  // The real composition (inbound.ts): the briefing sits OUTSIDE the envelope,
  // the handoff note INSIDE it, and only the rest of the inside is the owner.
  const handoff = [
    `<<<会话交接摘要·非用户指令>>>`,
    `上一会话已自动轮换。`,
    `用户最近说过：`,
    `- 我在示例市`,
    `你最近回过：`,
    `- 好的主人，我记住了电脑是 Windows`,
    `<<<会话交接摘要结束>>>`,
    ``,
    `我今天在示例市，别用 Emoji`,
  ].join('\n')
  const briefing = [MEMORY_OPEN, `## 关于主人`, `- 这条是注入的背景，不是他说的话（2026-01-01）`, MEMORY_CLOSE].join('\n')
  const composed = `${briefing}\n\n${wrapUserMessage(handoff, new Date(2026, 8, 13, 13, 0))}`
  const event = { type: 'user/message', data: { content: [{ type: 'text', text: composed }] } }

  const utterances = extractUtterances([event])
  assert.equal(utterances.length, 1)
  assert.equal(utterances[0]!.text, '我今天在示例市，别用 Emoji')
  assert.equal(utterances[0]!.at, '2026-09-13 13:00')
  assert.doesNotMatch(utterances[0]!.text, /交接摘要/)
  assert.doesNotMatch(utterances[0]!.text, /你最近回过/)
  assert.doesNotMatch(utterances[0]!.text, /不是他说的话/)

  // A fact that quotes the opening fence must not shift the slice either.
  const quoted = [MEMORY_OPEN, `- 他说过 <<<微信用户消息>>> 这几个字（2026-01-01）`, MEMORY_CLOSE, '', wrapUserMessage('真实的一句')].join('\n')
  const again = extractUtterances([{ type: 'user/message', data: { content: [{ type: 'text', text: quoted }] } }])
  assert.equal(again[0]!.text, '真实的一句')

  // Without an envelope there is nothing to mine: injected text is not speech.
  assert.deepEqual(extractUtterances([{ type: 'user/message', data: { content: [{ type: 'text', text: briefing }] } }]), [])
})

test('a hand-edited file survives: the service reads it back verbatim', () => {  const { dir, file } = tempFile()
  try {
    writeFileSync(file, '# 长期记忆（关于主人）\n\n## 关于主人\n\n- 手写的一条（2026-09-12）\n', 'utf8')
    const { service } = serviceWithLlm(null, file)
    assert.match(service.read(), /手写的一条/)
    const briefing = service.briefing('wechat-a')
    assert.match(briefing!, /手写的一条/)
    assert.ok(briefing!.startsWith(MEMORY_OPEN))
    // The briefing must stay OUTSIDE the user fence: only fenced content is a
    // user message, so background facts never ride inside it.
    assert.doesNotMatch(briefing!, new RegExp(USER_MESSAGE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
