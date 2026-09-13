/**
 * The problem ledger is what turns "it silently did nothing" into something the
 * owner can look up, so its contract is pinned here: nothing throws, repeated
 * failures collapse into one row with a count, and the WeChat notice is rate
 * limited rather than fired per message.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROBLEM_LOG_LIMIT_BYTES,
  ProblemReporter,
  formatProblems,
  problemsSummary,
} from '../src/node/problems.ts'

function tempDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-problems-'))
  return { dir, file: join(dir, 'wechat-problems.log') }
}

function fixedClock(start = new Date('2026-09-13T12:00:00Z')) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

test('a swallowed failure leaves a line, a roll-up row, and a log entry', () => {
  const { dir, file } = tempDir()
  const logged: string[] = []
  try {
    const reporter = new ProblemReporter({ file, notify: () => {}, logger: (_level, text) => logged.push(text) })
    const record = reporter.report('inbound/media', new Error('fetch failed'), { detail: 'msg-1' })
    assert.equal(record.kind, 'inbound/media')
    assert.equal(record.count, 1)
    assert.equal(record.detail, 'msg-1')

    const log = readFileSync(file, 'utf8')
    assert.match(log, /\[inbound\/media\] fetch failed \| msg-1/)
    assert.match(log, /已告知主人/)
    assert.equal(logged.length, 1)
    assert.match(logged[0]!, /inbound\/media: fetch failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the cause chain is unwrapped, because "fetch failed" alone is useless', () => {
  const { dir, file } = tempDir()
  try {
    const reporter = new ProblemReporter({ file, notify: () => {} })
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' })
    const record = reporter.report('model', new Error('fetch failed', { cause }))
    assert.match(record.message, /ECONNREFUSED/)
    // Non-Error rejection reasons must not become "[object Object]".
    assert.match(reporter.report('model', 'plain string reason').message, /plain string reason/)
    assert.match(reporter.report('model', { weird: true }).message, /object/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same failure twice is one problem with a count, not two problems', () => {
  const { dir, file } = tempDir()
  try {
    const reporter = new ProblemReporter({ file, notify: () => {} })
    reporter.report('gateway', new Error('send failed for message 12345'))
    reporter.report('gateway', new Error('send failed for message 99999'))
    const rows = reporter.recent()
    assert.equal(rows.length, 1, '数字不同但形状相同 → 同一类问题')
    assert.equal(rows[0]!.count, 2)
    assert.equal(reporter.total(), 2)
    const log = readFileSync(file, 'utf8').trim().split('\n')
    const occurrences = log.filter((line) => line.includes('[gateway]') && !line.includes('已告知主人'))
    assert.equal(occurrences.length, 2, '每一次发生都留一行')
    assert.match(occurrences[1]!, /#2/)

    reporter.report('gateway', new Error('a completely different failure'))
    assert.equal(reporter.recent().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the owner is told once, not once per message', () => {
  const { dir, file } = tempDir()
  const clock = fixedClock()
  const notices: string[] = []
  try {
    const reporter = new ProblemReporter({
      file,
      now: clock.now,
      notifyWindowMs: 10 * 60 * 1000,
      maxNoticesPerHour: 3,
      notify: (text) => notices.push(text),
    })
    reporter.report('inbound/media', new Error('download failed'))
    reporter.report('inbound/media', new Error('download failed'))
    reporter.report('inbound/media', new Error('download failed'))
    assert.equal(notices.length, 1, '同一个问题只打扰一次')
    assert.match(notices[0]!, /出了点问题/)
    assert.match(notices[0]!, /\/problems/)

    clock.advance(11 * 60 * 1000)
    reporter.report('inbound/media', new Error('download failed'))
    assert.equal(notices.length, 2, '过了窗口可以再提醒一次')
    assert.match(notices[1]!, /第 4 次/)

    // The hourly ceiling holds even across different problems.
    clock.advance(60_000)
    reporter.report('model', new Error('provider 500'))
    reporter.report('outbound', new Error('send failed'))
    assert.equal(notices.length, 3, '一小时最多 3 条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a transient failure can be recorded without bothering the owner', () => {
  const { dir, file } = tempDir()
  const notices: string[] = []
  try {
    const reporter = new ProblemReporter({ file, notify: (text) => notices.push(text) })
    const record = reporter.report('inbound/voice', new Error('transcribe timed out'), { notify: false })
    assert.equal(record.notified, false)
    assert.equal(notices.length, 0)
    assert.match(readFileSync(file, 'utf8'), /transcribe timed out/)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /已告知主人/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the log rotates instead of growing without bound', () => {
  const { dir, file } = tempDir()
  const clock = fixedClock()
  try {
    const reporter = new ProblemReporter({ file, now: clock.now, notify: () => {} })
    reporter.report('boot', new Error('first'))
    // A failing loop can write a lot; the cap must keep exactly one previous file.
    writeFileSync(file, 'x'.repeat(PROBLEM_LOG_LIMIT_BYTES + 1), 'utf8')
    clock.advance(61_000)
    reporter.report('boot', new Error('after rotation'))
    assert.ok(statSync(`${file}.1`).size > PROBLEM_LOG_LIMIT_BYTES, '旧日志被留档')
    const current = readFileSync(file, 'utf8')
    assert.match(current, /after rotation/)
    assert.ok(current.length < PROBLEM_LOG_LIMIT_BYTES)
    // Rotation must not run on every single line (that would be a stat per write).
    assert.equal(reporter.recent().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reporter that cannot write still keeps counting, and never throws', () => {
  const { dir, file } = tempDir()
  try {
    // A directory where the log file should be: every write fails.
    mkdirSync(file, { recursive: true })
    const reporter = new ProblemReporter({ file, notify: () => {} })
    const record = reporter.report('disk', new Error('no space left on device'))
    assert.equal(record.count, 1)
    assert.equal(reporter.recent().length, 1)
    assert.match(formatProblems(reporter), /no space left on device/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a notice channel that explodes does not become a second problem', () => {
  const { dir, file } = tempDir()
  try {
    const reporter = new ProblemReporter({
      file,
      notify: () => {
        throw new Error('wechat is down too')
      },
    })
    const record = reporter.report('outbound', new Error('send failed'))
    assert.equal(record.notified, true)
    assert.match(readFileSync(file, 'utf8'), /send failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/problems reads the roll-up, and /status only speaks up when it matters', () => {
  const { dir, file } = tempDir()
  const clock = fixedClock()
  try {
    const reporter = new ProblemReporter({ file, now: clock.now, notify: () => {} })
    assert.equal(formatProblems(reporter), '✅ 最近没有记录到问题。')
    assert.equal(problemsSummary(reporter), null)

    reporter.report('inbound/media', new Error('video download failed'), { detail: 'msg-7' })
    reporter.report('inbound/media', new Error('video download failed'))
    const text = formatProblems(reporter)
    assert.match(text, /🩺 最近的问题（共 2 次）/)
    assert.match(text, /\[inbound\/media\] video download failed（msg-7） ×2/)
    assert.match(text, /日志：/)
    assert.match(problemsSummary(reporter)!, /最近 24 小时有 1 类问题/)

    // A problem older than the window no longer shows up in /status.
    clock.advance(25 * 60 * 60 * 1000)
    assert.equal(problemsSummary(reporter), null)
    assert.equal(formatProblems(reporter).includes('×2'), true, '但 /problems 仍查得到')

    reporter.clear()
    assert.equal(formatProblems(reporter), '✅ 最近没有记录到问题。')
    assert.match(readFileSync(file, 'utf8'), /video download failed/, '清空列表不动日志')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the roll-up itself is bounded', () => {
  const { dir, file } = tempDir()
  try {
    const reporter = new ProblemReporter({ file, notify: () => {} })
    for (let i = 0; i < 200; i += 1) reporter.report('bulk', new Error(`failure ${i}`))
    assert.ok(reporter.recent(1000).length <= 50, `内存里的问题条目要有上限，实际 ${reporter.recent(1000).length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
