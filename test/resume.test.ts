/**
 * 会话恢复的持久化解析测试。
 *
 * DSH 0.1.5 把 `sessionPersistence.list()` 的元素改成 `SessionPersistenceSnapshot`
 * （身份在 `.header` 里），而桥原先按顶层 `id` 读取 —— `String(undefined)` 匹配不到
 * 任何会话，于是重启恢复**静默失败**：微信会话不会被 resume，`/sessions` 与 Web
 * 左栏（两者都只看活会话）都看不到它，上下文也不继承。
 * 这一组用例锁住两种形状都能解析。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectNewestWechat } from '../src/node/core.ts'

test('reads the 0.1.5 snapshot shape (identity under .header)', () => {
  const picked = selectNewestWechat([
    { header: { id: 'wechat-old', createdAt: 1_000 }, revision: 'r1' },
    { header: { id: 'wechat-new', createdAt: 3_000 }, revision: 'r2' },
    { header: { id: 'web-session', createdAt: 9_000 }, revision: 'r3' },
  ])
  assert.deepEqual(picked, { id: 'wechat-new', createdAt: 3_000 })
})

test('reads the legacy flat shape', () => {
  const picked = selectNewestWechat([
    { id: 'wechat-a', createdAt: 10 },
    { id: 'wechat-b', createdAt: 20 },
  ])
  assert.deepEqual(picked, { id: 'wechat-b', createdAt: 20 })
})

test('the old buggy read (top-level id on a snapshot) finds nothing', () => {
  // Reproduces the failure mode: with the snapshot shape, `h.id` is undefined.
  const snapshots = [{ header: { id: 'wechat-new', createdAt: 3_000 } }]
  const buggy = snapshots.filter((h) => String((h as { id?: string }).id).startsWith('wechat-'))
  assert.equal(buggy.length, 0, 'guard: the pre-fix read must match nothing')
  assert.deepEqual(selectNewestWechat(snapshots), { id: 'wechat-new', createdAt: 3_000 })
})

test('ignores non-wechat sessions and empty or malformed entries', () => {
  assert.equal(selectNewestWechat([]), undefined)
  assert.equal(selectNewestWechat([{ header: { id: 'web-x', createdAt: 1 } }]), undefined)
  assert.equal(selectNewestWechat([{ header: {} }, { id: '' }, {}]), undefined)
})

test('missing createdAt sorts last rather than throwing', () => {
  const picked = selectNewestWechat([
    { header: { id: 'wechat-no-time' } },
    { header: { id: 'wechat-timed', createdAt: 5 } },
  ])
  assert.equal(picked?.id, 'wechat-timed')
})
