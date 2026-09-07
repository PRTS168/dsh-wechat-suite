/**
 * Reminder-store tests: persistence round-trip, scheduling, due delivery, and
 * cancel — no WeChat account needed (a stub `wechat` service records sends).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ReminderStore } from '../src/node/reminders.ts'

/** Collects sent messages instead of talking to WeChat. */
function makeCtx(): { ctx: Context; sent: Array<{ to: string; text: string }> } {
  const sent: Array<{ to: string; text: string }> = []
  const ctx = new Context()
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('wechat', {
    accountId: 'bot',
    cdnBaseUrl: '',
    async sendText(to: string, text: string) {
      sent.push({ to, text })
      return { success: true }
    },
  })
  return { ctx, sent }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('reminder persists to file and survives store recreation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rem-'))
  const file = join(dir, 'reminders.json')
  try {
    const { ctx } = makeCtx()
    const store = new ReminderStore(ctx, file)
    await store.start()
    await store.add({ at: Date.now() + 60_000, text: '喝水', peerId: 'wxid_allow1' })
    store.stop()

    // Recreate the store from the same file → the reminder must come back.
    const store2 = new ReminderStore(ctx, file)
    await store2.start()
    const list = store2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.text, '喝水')
    assert.equal(list[0]!.peerId, 'wxid_allow1')
    store2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('due reminder is delivered to its peer and removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rem-'))
  const file = join(dir, 'reminders.json')
  try {
    const { ctx, sent } = makeCtx()
    const store = new ReminderStore(ctx, file)
    await store.start()
    await store.add({ delayMs: 120, text: '吃药', peerId: 'wxid_allow1' })
    await sleep(400)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.to, 'wxid_allow1')
    assert.ok(sent[0]!.text.includes('吃药'))
    assert.equal(store.list().length, 0)
    store.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancel removes a pending reminder without delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rem-'))
  const file = join(dir, 'reminders.json')
  try {
    const { ctx, sent } = makeCtx()
    const store = new ReminderStore(ctx, file)
    await store.start()
    const r = await store.add({ delayMs: 200, text: '开会', peerId: 'wxid_allow1' })
    const ok = await store.remove(r.id)
    assert.equal(ok, true)
    await sleep(350)
    assert.equal(sent.length, 0)
    assert.equal(store.list().length, 0)
    store.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('past-due reminders loaded on boot are delivered once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rem-'))
  const file = join(dir, 'reminders.json')
  try {
    // Simulate a reminder that was persisted before a shutdown and came due
    // while the process was down: write the file directly (add() refuses past
    // times by design).
    const { ctx: ctx0 } = makeCtx()
    const seed = new ReminderStore(ctx0, file)
    await seed.start()
    const r = await seed.add({ at: Date.now() + 60_000, text: '补发', peerId: 'wxid_allow1' })
    seed.stop()
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { reminders: Array<{ id: string; at: number; text: string; peerId: string; createdAt: number }> }
    raw.reminders[0]!.at = Date.now() - 5000 // rewind into the past
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(raw))

    const { ctx: ctx2, sent } = makeCtx()
    const store2 = new ReminderStore(ctx2, file)
    await store2.start()
    await sleep(200)
    assert.equal(sent.length, 1)
    assert.ok(sent[0]!.text.includes('补发'))
    store2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
