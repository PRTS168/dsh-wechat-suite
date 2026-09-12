/**
 * Context-management policy: parsing, the rotation decision, and the handoff note.
 *
 * The behaviour these tests protect: a WeChat conversation must stop growing
 * forever by default-on policy, but must NEVER be rotated mid-turn, and a
 * rotation must never look like the owner asking for something (the handoff goes
 * out behind its own fence, not the user fence — the persona's hard rules treat
 * only `<<<微信用户消息>>>…` as an instruction).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTEXT_WINDOW_CHARS,
  DEFAULT_POLICY,
  HANDOFF_CLOSE,
  HANDOFF_OPEN,
  buildHandoff,
  parseContextPolicy,
  rotationReason,
  signalsFromEvents,
  transcriptFromEvents,
} from '../src/node/context-policy.ts'
import { USER_MESSAGE_CLOSE, USER_MESSAGE_OPEN } from '../src/node/inbound.ts'

const signals = (over: Partial<Parameters<typeof rotationReason>[1]> = {}) => ({
  turns: 0,
  contextChars: 0,
  idleMinutes: 0,
  turnOpen: false,
  ...over,
})

// ── parsing ─────────────────────────────────────────────────────────────────

test('an absent or empty policy stays manual', () => {
  assert.equal(parseContextPolicy(undefined).scheme, 'manual')
  assert.equal(parseContextPolicy('').scheme, 'manual')
  assert.equal(parseContextPolicy('   ').scheme, 'manual')
})

test('malformed JSON and unknown schemes degrade to manual instead of throwing', () => {
  assert.equal(parseContextPolicy('{not json').scheme, 'manual')
  assert.equal(parseContextPolicy('{"scheme":"rotate-everything"}').scheme, 'manual')
  assert.equal(parseContextPolicy('{"scheme":"rotate-turns"}').scheme, 'rotate-turns')
})

test('knobs are sanitized, and defaults fill the gaps', () => {
  const p = parseContextPolicy('{"scheme":"rotate-turns"}')
  assert.deepEqual({ turns: p.turns, idleOnly: p.idleOnly }, { turns: DEFAULT_POLICY.turns, idleOnly: true })
  assert.equal(parseContextPolicy('{"scheme":"rotate-turns","turns":0}').turns, DEFAULT_POLICY.turns)
  assert.equal(parseContextPolicy('{"scheme":"rotate-turns","turns":-5}').turns, DEFAULT_POLICY.turns)
  assert.equal(parseContextPolicy('{"scheme":"rotate-pressure","pressureRatio":7}').pressureRatio, DEFAULT_POLICY.pressureRatio)
  assert.equal(parseContextPolicy('{"scheme":"daily","idleHours":0}').idleHours, DEFAULT_POLICY.idleHours)
})

// ── the decision ────────────────────────────────────────────────────────────

test('manual never rotates, whatever the signals say', () => {
  const policy = parseContextPolicy('{"scheme":"manual"}')
  assert.equal(rotationReason(policy, signals({ turns: 999, contextChars: 10_000_000 })), undefined)
})

test('rotate-turns fires exactly at the threshold', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-turns","turns":20}')
  assert.equal(rotationReason(policy, signals({ turns: 19 })), undefined)
  assert.match(String(rotationReason(policy, signals({ turns: 20 }))), /轮次 20 ≥ 20/)
})

test('rotate-turns+handoff uses the same trigger as rotate-turns', () => {
  const a = parseContextPolicy('{"scheme":"rotate-turns","turns":5}')
  const b = parseContextPolicy('{"scheme":"rotate-turns+handoff","turns":5,"handoff":true}')
  assert.equal(rotationReason(a, signals({ turns: 5 })), rotationReason(b, signals({ turns: 5 })))
  assert.equal(b.handoff, true)
})

test('an open turn defers rotation (idleOnly defaults to on)', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-turns","turns":1}')
  assert.equal(rotationReason(policy, signals({ turns: 5, turnOpen: true })), undefined)
  const aggressive = parseContextPolicy('{"scheme":"rotate-turns","turns":1,"idleOnly":false}')
  assert.ok(rotationReason(aggressive, signals({ turns: 5, turnOpen: true })))
})

test('rotate-pressure fires on the context proxy, not on turns', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-pressure","pressureRatio":0.6}')
  const budget = CONTEXT_WINDOW_CHARS * 0.6
  assert.equal(rotationReason(policy, signals({ turns: 500, contextChars: budget - 1 })), undefined)
  assert.match(String(rotationReason(policy, signals({ contextChars: budget }))), /上下文约/)
})

test('daily fires on the idle gap', () => {
  const policy = parseContextPolicy('{"scheme":"daily","idleHours":8}')
  assert.equal(rotationReason(policy, signals({ idleMinutes: 8 * 60 - 1 })), undefined)
  assert.match(String(rotationReason(policy, signals({ idleMinutes: 8 * 60 }))), /距上次活跃 8\.0 小时/)
})

// ── rotate-tokens: the free-form token budget ───────────────────────────────

test('rotate-tokens fires on real projection tokens when they are available', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-tokens","tokenBudget":50000}')
  assert.equal(rotationReason(policy, signals({ contextTokens: 49_999 })), undefined)
  assert.match(String(rotationReason(policy, signals({ contextTokens: 50_000 }))), /上下文 50,000 tokens ≥ 预算 50,000/)
})

test('rotate-tokens falls back to the character proxy and says so', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-tokens","tokenBudget":1000}')
  // 2000 chars ÷ 2 chars-per-token = 1000 tokens → exactly at budget; the reason
  // must admit the number is an estimate rather than a measurement.
  assert.match(String(rotationReason(policy, signals({ contextChars: 2000 }))), /估算/)
  assert.equal(rotationReason(policy, signals({ contextChars: 1998 })), undefined)
})

test('the token budget is free-form but bounded below', () => {
  assert.equal(parseContextPolicy('{"scheme":"rotate-tokens","tokenBudget":250000}').tokenBudget, 250_000)
  assert.equal(parseContextPolicy('{"scheme":"rotate-tokens","tokenBudget":12}').tokenBudget, DEFAULT_POLICY.tokenBudget)
  assert.equal(parseContextPolicy('{"scheme":"rotate-tokens"}').tokenBudget, DEFAULT_POLICY.tokenBudget)
})

test('rotate-tokens also honours the idle guard', () => {
  const policy = parseContextPolicy('{"scheme":"rotate-tokens","tokenBudget":1000}')
  assert.equal(rotationReason(policy, signals({ contextTokens: 5000, turnOpen: true })), undefined)
})

// ── signals from real event shapes ──────────────────────────────────────────

test('signals count completed turns and detect an open one', () => {
  const events = [
    { type: 'session', time: 1_000, data: {} },
    { type: 'turn/start', time: 2_000, data: { turn: 1 } },
    { type: 'assistant/message', time: 2_100, data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', time: 2_200, data: { reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 3_000, data: { turn: 2 } },
  ]
  const s = signalsFromEvents(events, new Date(3_100))
  assert.equal(s.turns, 1)
  assert.equal(s.turnOpen, true)
  assert.ok(s.contextChars > 'hello'.length, 'message text contributes to the proxy')
  assert.ok(s.idleMinutes >= 0)
})

test('signals tolerate foreign event payloads', () => {
  const s = signalsFromEvents([{ type: 'agent-preset/selected', time: 5, data: { agentPreset: 'wechat' } }], new Date(5))
  assert.equal(s.turns, 0)
  assert.equal(s.turnOpen, false)
  assert.equal(s.contextChars, 120)
})

// ── handoff note ────────────────────────────────────────────────────────────

const transcript = [
  { role: 'user' as const, text: '帮我看看灯的档位' },
  { role: 'assistant' as const, text: '现在是 3 档。' },
  { role: 'user' as const, text: '把它调到 1 档' },
  { role: 'assistant' as const, text: '已经调到 1 档了喵。' },
]

test('the handoff states why it happened and that it is not an instruction', () => {
  const note = buildHandoff(transcript, '轮次 20 ≥ 20')
  assert.ok(note.startsWith(HANDOFF_OPEN))
  assert.ok(note.includes(HANDOFF_CLOSE))
  assert.ok(note.includes('轮次 20 ≥ 20'))
  assert.ok(/不是用户的新指令/.test(note))
  assert.ok(/有疑问就先问用户/.test(note))
})

test('the handoff quotes recent lines and honours maxMessages', () => {
  const note = buildHandoff(transcript, 'r', { maxMessages: 2 })
  assert.ok(note.includes('把它调到 1 档'))
  assert.ok(!note.includes('帮我看看灯的档位'), 'older lines are dropped beyond maxMessages')
})

test('the handoff never carries the USER fence (so it cannot read as a user turn)', () => {
  const note = buildHandoff(transcript, 'r')
  assert.ok(!note.includes(USER_MESSAGE_OPEN))
  assert.ok(!note.includes(USER_MESSAGE_CLOSE))
})

test('an empty transcript still produces a usable note', () => {
  const note = buildHandoff([], '轮次 20 ≥ 20')
  assert.ok(note.includes('没有可摘录的对话内容'))
  assert.ok(note.startsWith(HANDOFF_OPEN) && note.includes(HANDOFF_CLOSE))
})

test('transcriptFromEvents reads user and assistant text and strips the envelope', () => {
  const events = [
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: `${USER_MESSAGE_OPEN}\n你好\n<<<${USER_MESSAGE_CLOSE}｜发送于 2026-09-12 14:20>>>` }] } },
    { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '在的喵' }] } } },
    { type: 'turn/end', time: 3, data: {} },
  ]
  const lines = transcriptFromEvents(events)
  assert.deepEqual(lines, [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在的喵' },
  ])
})

test('transcriptFromEvents also strips the legacy [发送于 …] prefix', () => {
  const lines = transcriptFromEvents([
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '[发送于 2026-09-12 14:20] 老格式的消息' }] } },
  ])
  assert.deepEqual(lines, [{ role: 'user', text: '老格式的消息' }])
})
