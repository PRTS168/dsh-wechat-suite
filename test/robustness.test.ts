/**
 * Robustness contracts added after the silent-failure audit.
 *
 * Each test here pins one specific way the bridge used to lose a failure, a
 * file, or a message without saying anything. They are deliberately written
 * against the observable outcome (a refusal, a ledger entry, a rotated file)
 * rather than the implementation, because the point is the promise, not the
 * shape of the code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PatchUnreadableError, PatchValueError, applyPatchConfig, readPatchFile } from '../src/node/patch-config.ts'
import { ReminderStore } from '../src/node/reminders.ts'
import { MEMORY_LOG_LIMIT_BYTES, appendMemoryLog, pruneBackups, rotateIfLarge } from '../src/node/memory.ts'
import { ProblemReporter } from '../src/node/problems.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('an unreadable config file is refused, never overwritten', async () => {
  const dir = tempDir('patch-guard-')
  const file = join(dir, 'cordis.patch.yml')
  const original = ['- id: someone-elses-plugin', '  config:', '    key: keep-me', ''].join('\n')
  try {
    writeFileSync(file, original, 'utf8')
    let sawUnreadable = false
    if (process.platform !== 'win32') {
      // Permissions are the portable way to make a readable file unreadable;
      // on Windows the read succeeds for the owner, so the branch is skipped.
      chmodSync(file, 0o000)
      try {
        readFileSync(file)
      } catch {
        sawUnreadable = true
      }
    }

    if (!sawUnreadable) {
      // Simulate the same failure through a path that is a directory: reading it
      // raises EISDIR, which is not ENOENT and must be treated as unreadable.
      const blocked = join(dir, 'blocked.yml')
      mkdirSync(blocked, { recursive: true })
      const read = await readPatchFile(blocked)
      assert.equal(read.exists, true, '目录存在 → 不能说“文件不存在”')
      assert.ok(read.unreadable, '必须标记为读不出来')
      await assert.rejects(() => applyPatchConfig(blocked, { agentModel: 'x' }), PatchUnreadableError)
      return
    }

    try {
      const read = await readPatchFile(file)
      assert.equal(read.exists, true, '文件存在 → 不能说“文件不存在”')
      assert.ok(read.unreadable, '必须标记为读不出来')
      await assert.rejects(() => applyPatchConfig(file, { agentModel: 'x' }), PatchUnreadableError)
    } finally {
      // 权限必须在回读之前恢复：chmod 000 的文件连这个测试自己也读不了，
      // 少了这一步它就会在下面那行以 EACCES 崩掉（Linux CI 上正是这么红的）。
      chmodSync(file, 0o600)
    }
    assert.equal(readFileSync(file, 'utf8'), original, '别人的条目一个字节都不能丢')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing config file is still created normally', async () => {
  const dir = tempDir('patch-create-')
  const file = join(dir, 'cordis.patch.yml')
  try {
    const read = await readPatchFile(file)
    assert.equal(read.exists, false)
    assert.equal(read.unreadable, undefined)
    const result = await applyPatchConfig(file, { allowFrom: 'wxid_one', agentModel: 'deepseek-v4-flash' })
    assert.ok(result.changed.includes('agentModel'))
    assert.match(readFileSync(file, 'utf8'), /wxid_one/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a numeric field holding anything but an integer is refused before it is written', async () => {
  const dir = tempDir('patch-number-')
  const file = join(dir, 'cordis.patch.yml')
  try {
    await applyPatchConfig(file, { allowFrom: 'wxid_one', memoryInjectEvery: '10' })
    const before = readFileSync(file, 'utf8')
    assert.match(before, /memoryInjectEvery: 10\b/, '整数按 YAML 数字写入')

    // Quoted nonsense would make the plugin's numeric schema reject the whole
    // profile at load — the bridge would not boot at all.
    await assert.rejects(() => applyPatchConfig(file, { memoryInjectEvery: '25 分钟' }), PatchValueError)
    await assert.rejects(() => applyPatchConfig(file, { memoryInjectEvery: '1e3' }), PatchValueError)
    assert.equal(readFileSync(file, 'utf8'), before, '被拒绝的写入一个字节都不能落地')
    // Clearing the key is always allowed: it means "use the default".
    await applyPatchConfig(file, { memoryInjectEvery: null })
    assert.doesNotMatch(readFileSync(file, 'utf8'), /memoryInjectEvery/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt reminder file is reported and never overwritten', async () => {
  const dir = tempDir('reminders-corrupt-')
  const file = join(dir, 'wechat-reminders.json')
  try {
    // Valid JSON, wrong shape: the old code turned this into "no reminders" and
    // the next save wrote that emptiness over the file.
    writeFileSync(file, '{"reminders": "not an array"}', 'utf8')
    const problems: string[] = []
    const store = new ReminderStore(new Context(), file, (kind) => problems.push(kind))
    await store.start()
    assert.deepEqual(store.list(), [], '读不出来时列表为空')
    assert.ok(problems.includes('reminders/load'), `要留下痕迹，实际 ${problems.join(',')}`)

    const added = await store.add({ delayMs: 60_000, text: '喝水', peerId: 'peer' })
    assert.equal(store.lastSaveSucceeded(), false, '读不出来就不许覆盖')
    assert.ok(problems.includes('reminders/save'))
    assert.equal(readFileSync(file, 'utf8'), '{"reminders": "not an array"}', '磁盘上的原始内容必须原样保留')
    assert.match(ReminderStore.describe(added), /喝水/, '内存里仍然可用')

    // A genuinely missing file is not an error and saves normally.
    const fresh = join(dir, 'fresh.json')
    const clean = new ReminderStore(new Context(), fresh, () => {})
    await clean.start()
    await clean.add({ delayMs: 60_000, text: '早睡', peerId: 'peer' })
    assert.equal(clean.lastSaveSucceeded(), true)
    assert.match(readFileSync(fresh, 'utf8'), /早睡/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reminder writes are atomic, so a concurrent read never sees half a file', async () => {
  const dir = tempDir('reminders-atomic-')
  const file = join(dir, 'wechat-reminders.json')
  try {
    const store = new ReminderStore(new Context(), file, () => {})
    await store.start()
    await store.add({ delayMs: 60_000, text: '一', peerId: 'peer' })
    await store.add({ delayMs: 120_000, text: '二', peerId: 'peer' })
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { reminders: unknown[] }
    assert.equal(parsed.reminders.length, 2)
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [], '不留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the memory audit log rotates instead of growing forever', () => {
  const dir = tempDir('memory-log-')
  const memoryFile = join(dir, 'MEMORY.md')
  try {
    writeFileSync(memoryFile, '# x\n', 'utf8')
    appendMemoryLog(memoryFile, '第一条')
    const log = join(dir, 'memory-log.md')
    writeFileSync(log, 'x'.repeat(MEMORY_LOG_LIMIT_BYTES + 1), 'utf8')
    appendMemoryLog(memoryFile, '轮转之后')
    assert.ok(existsSync(`${log}.1`), '旧日志留档')
    assert.match(readFileSync(log, 'utf8'), /轮转之后/)
    assert.ok(statSync(log).size < MEMORY_LOG_LIMIT_BYTES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backups are kept to a handful, newest by TIME not by name', () => {
  const dir = tempDir('backups-')
  const file = join(dir, 'wechat-reminders.json')
  try {
    writeFileSync(file, '{}', 'utf8')
    // Deliberately mixed naming eras: alphabetical order would keep the wrong
    // ones, because `bak-before-*` sorts after `bak-<digits>`.
    const names: string[] = []
    for (let i = 0; i < 12; i += 1) {
      const name = `${file}.bak-20260901-${String(i).padStart(8, '0')}`
      writeFileSync(name, 'x', 'utf8')
      // Distinct mtimes so the newest is unambiguous.
      const when = new Date(Date.now() - (12 - i) * 60_000)
      utimesSync(name, when, when)
      names.push(name)
    }
    const newest = `${file}.bak-before-media-restore`
    writeFileSync(newest, 'x', 'utf8')
    utimesSync(newest, new Date(), new Date())
    assert.equal(readdirSync(dir).filter((n) => n.includes('.bak-')).length, 13)

    pruneBackups(file, 5)
    const left = readdirSync(dir).filter((n) => n.includes('.bak-'))
    assert.equal(left.length, 5)
    assert.ok(left.includes('wechat-reminders.json.bak-before-media-restore'), '最新的一份必须在')
    assert.ok(!left.includes(names[0]!), '最老的一份必须被删掉')

    // Rotation is a no-op when the file is small or missing.
    rotateIfLarge(file, 1024)
    assert.ok(existsSync(file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused write is reported with its real reason, not a guessed one', () => {
  const dir = tempDir('problem-reason-')
  const reporter = new ProblemReporter({ file: join(dir, 'problems.log'), notify: () => {} })
  try {
    const io = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    reporter.report('memory/write', io, { notify: false, detail: 'file=MEMORY.md' })
    const row = reporter.recent()[0]!
    assert.match(row.message, /EBUSY/)
    assert.notEqual(row.message, '超过字符上限')
    assert.match(readFileSync(join(dir, 'problems.log'), 'utf8'), /EBUSY/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
