/**
 * Tests for the shared profile-patch reader/writer behind the setup wizard and
 * the Web management page — no browser and no DSH host required.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatch, extractValues, applyPatchConfig, readPatchFile, maskSecret, CONFIG_FIELDS } from '../src/node/patch-config.ts'

const SAMPLE = [
  '# header comment',
  '- id: dsh-chatnode-wechat',
  '  config:',
  '    # inline note',
  '    allowFrom:',
  '      - old-wxid@im.wechat',
  '    cwd: C:\\old\\dir',
  '    ocrApiKey: sk-old-key-12345',
  '    keepMe: "自定义键应保留"',
  '- id: some-other-plugin',
  '  config:',
  '    x: 1',
  '',
].join('\n')

function withTempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  if (content !== undefined) writeFileSync(file, content, 'utf8')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parsePatch reads managed values and ignores other entries', () => {
  const parsed = parsePatch(SAMPLE)
  const values = extractValues(parsed)
  assert.equal(parsed.found, true)
  assert.deepEqual(values.allowFrom, ['old-wxid@im.wechat'])
  assert.equal(values.values.cwd, 'C:\\old\\dir')
  assert.equal(values.values.ocrApiKey, 'sk-old-key-12345')
  assert.equal(values.values.keepMe, undefined)
})

test('applyPatchConfig updates values and preserves comments, unknown keys and other entries', async () => {
  const t = withTempFile(SAMPLE)
  try {
    const result = await applyPatchConfig(t.file, { allowFrom: 'new@im.wechat', cwd: 'D:\\workspace', ocrApiKey: 'sk-new' })
    const text = readFileSync(t.file, 'utf8')
    assert.ok(result.changed.includes('allowFrom'))
    assert.ok(result.changed.includes('cwd'))
    assert.ok(text.includes('"new@im.wechat"'))
    assert.ok(text.includes('"sk-new"'))
    assert.ok(!text.includes('sk-old-key-12345'))
    assert.ok(text.includes('# header comment'))
    assert.ok(text.includes('# inline note'))
    assert.ok(text.includes('keepMe: "自定义键应保留"'))
    assert.ok(text.includes('- id: some-other-plugin'))
    assert.ok(existsSync(result.backup))
    assert.ok(readdirSync(t.dir).some((f) => f.startsWith('cordis.patch.yml.bak-')))
  } finally { t.cleanup() }
})

test('applyPatchConfig clears optional keys with null and rewrites the allowlist', async () => {
  const t = withTempFile(SAMPLE)
  try {
    await applyPatchConfig(t.file, { cwd: null, allowFrom: 'another@im.wechat' })
    const text = readFileSync(t.file, 'utf8')
    assert.ok(!text.includes('cwd:'))
    assert.ok(text.includes('"another@im.wechat"'))
    assert.ok(!text.includes('old-wxid@im.wechat'))
  } finally { t.cleanup() }
})

test('applyPatchConfig creates the entry when the file has none', async () => {
  const t = withTempFile('# only comments\n')
  try {
    await applyPatchConfig(t.file, { allowFrom: 'fresh@im.wechat', agentPreset: 'wechat' })
    const text = readFileSync(t.file, 'utf8')
    assert.ok(text.includes('- id: dsh-chatnode-wechat'))
    assert.ok(text.includes('"fresh@im.wechat"'))
    assert.ok(text.includes('agentPreset: "wechat"'))
    assert.ok(text.startsWith('# only comments'))
  } finally { t.cleanup() }
})

test('readPatchFile reports a missing file without throwing', async () => {
  const t = withTempFile(undefined)
  try {
    const res = await readPatchFile(join(t.dir, 'nope.yml'))
    assert.equal(res.exists, false)
    assert.deepEqual(res.patch.allowFrom, [])
  } finally { t.cleanup() }
})

test('maskSecret hides all but a short prefix', () => {
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret('short'), '****')
  assert.match(maskSecret('sk-abcdef1234567890'), /^sk-abc\*\*\*\*/)
})

test('field metadata covers every key applyPatchConfig can write', () => {
  const keys = CONFIG_FIELDS.map((f) => f.key)
  assert.ok(keys.includes('allowFrom'))
  assert.ok(keys.includes('ttsVoice'))
  assert.equal(new Set(keys).size, keys.length)
})
