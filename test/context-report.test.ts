/**
 * `/context` is the owner's only window into how full the conversation is, so
 * the arithmetic behind it is pinned here: the numbers come from the host's
 * projection cache, and a report that quietly reads the wrong row would be
 * worse than no report at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_COMPACTION,
  formatContextReport,
  formatTokens,
  readCompactionPolicy,
  readContextUsage,
  readTurnCount,
} from '../src/node/context-report.ts'

/** The real shape the host writes for one WeChat session (values sampled live). */
const LIVE_ROW = {
  version: 5,
  record: {
    rows: {
      contextPressure: { ver: 4, seq: 2322, val: { contextWindow: 1000000, pressureTokens: 15947, surfaceTokens: 3547, sampledSurfaceTokens: 3386 } },
      contextBreakdown: { ver: 2, seq: 2322, val: { systemTokens: 2055, toolsTokens: 9262, messageTokens: 3547 } },
      sessionStats: { ver: 1, seq: 2322, val: { turns: 1, steps: 6 } },
    },
  },
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ctx-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
}

function writeProjection(home: string, sessionId: string, doc: unknown): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(doc), 'utf8')
}

test('token counts are rendered the way a person reads them', () => {
  assert.equal(formatTokens(3547), '3547')
  assert.equal(formatTokens(9999), '9999')
  assert.equal(formatTokens(15947), '1.6 万')
  assert.equal(formatTokens(1_000_000), '100 万')
  assert.equal(formatTokens(800_000), '80 万')
  assert.equal(formatTokens(Number.NaN), '?')
})

test('usage is read from the host projection rows, not guessed', () => {
  withHome((home) => {
    writeProjection(home, 'wechat-a', LIVE_ROW)
    const usage = readContextUsage('wechat-a')!
    assert.equal(usage.contextWindow, 1_000_000)
    assert.equal(usage.pressureTokens, 15947)
    assert.equal(usage.messageTokens, 3547)
    assert.equal(usage.toolsTokens, 9262)
    assert.equal(readTurnCount('wechat-a'), 1)
  })
})

test('a missing or corrupt projection degrades to "no data", never throws', () => {
  withHome((home) => {
    assert.equal(readContextUsage('wechat-missing'), undefined)
    assert.equal(readTurnCount('wechat-missing'), undefined)
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wechat-broken.json'), '{not json', 'utf8')
    assert.equal(readContextUsage('wechat-broken'), undefined)
    // A file with rows but none of the expected ones is still "no data".
    writeProjection(home, 'wechat-empty', { version: 5, record: { rows: {} } })
    assert.equal(readContextUsage('wechat-empty'), undefined)
  })
})

test('the report states the real window, the split, and when compaction fires', () => {
  const text = formatContextReport({
    sessionId: 'wechat-a',
    turns: 1,
    usage: readContextUsageFromRow(LIVE_ROW),
    memoryFacts: 3,
    compaction: { ...DEFAULT_COMPACTION, source: 'default' },
  })
  assert.match(text, /已用 1\.6 万 \/ 100 万（1\.6%）/)
  assert.match(text, /对话 3547 · 工具 9262 · 系统 2055/)
  // 0.8 × 1,000,000 — the number that decides whether the owner ever sees a
  // compaction at all.
  assert.match(text, /到 80 万 才自动触发（80%）/)
  assert.match(text, /最近约 16 万 token 的对话原样保留/)
  assert.match(text, /长期记忆：3 条/)
})

test('the report says so when the host has not measured the session yet', () => {
  const text = formatContextReport({ sessionId: 'wechat-a', memoryFacts: 0 })
  assert.match(text, /宿主还没记录这个会话的用量/)
  assert.match(text, /长期记忆：0 条/)
  assert.doesNotMatch(text, /压缩/)
})

test('compaction ratios come from the preset when it states them', () => {
  withHome((home) => {
    const dir = join(home, '.agent-presets', 'wechat')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent.cordis.yml'),
      ['- id: compaction', '  config:', '    - id: compaction-basic', '      name: "@deepseek-ai/dsh-compaction-basic"', '      config:', '        thresholdRatio: 0.75', '        retainRatio: 0.25', ''].join('\n'),
      'utf8',
    )
    const policy = readCompactionPolicy('wechat')!
    assert.equal(policy.source, 'preset')
    assert.equal(policy.thresholdRatio, 0.75)
    assert.equal(policy.retainRatio, 0.25)
  })
})

test('a preset that configures nothing reports the plugin defaults as defaults', () => {
  withHome((home) => {
    const dir = join(home, '.agent-presets', 'wechat')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), '- id: compaction-basic\n  name: "@deepseek-ai/dsh-compaction-basic"\n', 'utf8')
    const policy = readCompactionPolicy('wechat')!
    assert.equal(policy.source, 'default')
    assert.equal(policy.thresholdRatio, DEFAULT_COMPACTION.thresholdRatio)
    assert.equal(policy.retainRatio, DEFAULT_COMPACTION.retainRatio)
  })
})

test('a missing preset file leaves the report honest rather than invented', () => {
  withHome(() => {
    assert.equal(readCompactionPolicy('nope'), undefined)
    const text = formatContextReport({
      sessionId: 'wechat-a',
      usage: { contextWindow: 1_000_000, pressureTokens: 15_947 },
      memoryFacts: 1,
    })
    assert.doesNotMatch(text, /压缩/)
    assert.match(text, /长期记忆：1 条/)
  })
})

/** Helper: run the real reader over an in-memory row without touching disk. */
function readContextUsageFromRow(row: { record: { rows: Record<string, { val: unknown }> } }) {
  return withHome((home) => {
    writeProjection(home, 'wechat-a', row)
    return readContextUsage('wechat-a')
  })
}
