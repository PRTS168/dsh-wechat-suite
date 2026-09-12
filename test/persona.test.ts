/**
 * Persona-keyed preset editing tests.
 *
 * DSH 0.1.5 renamed the persona scalar: `dsh-persona`'s schema is
 * `{ prefix: required, suffix, complete, includeRuntimeContext }` and knows no
 * `text` key, so a preset still keyed `text:` fails to mount the preset with
 * "$.prefix missing required value". These tests pin the compatibility rule:
 * read both spellings, write the 0.1.5 one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPersonaText, replacePersonaText } from '../src/node/config-api.ts'

/** A minimal preset in the legacy (`text:`) shape. */
const LEGACY = [
  '# preset header',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: |-',
  '      你是旧人设。',
  '      第二行。',
  '- id: agent-instructions',
  '  config:',
  '    maxBytes: 65536',
  '',
].join('\n')

/** The same preset in the 0.1.5 (`prefix:`) shape, plus a suffix sibling key. */
const MODERN = [
  '# preset header',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: cwd is {{cwd}}.',
  '    prefix: >-',
  '      你是测试助手。',
  '      用中文回答。',
  '- id: agent-instructions',
  '  config:',
  '    maxBytes: 65536',
  '',
].join('\n')

test('readPersonaText reads the legacy text: key', () => {
  assert.equal(readPersonaText(LEGACY), '你是旧人设。\n第二行。')
})

test('readPersonaText reads the 0.1.5 prefix: key', () => {
  assert.equal(readPersonaText(MODERN), '你是测试助手。\n用中文回答。')
})

test('readPersonaText returns null when the row has no scalar', () => {
  const noScalar = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    suffix: x', ''].join('\n')
  assert.equal(readPersonaText(noScalar), null)
  assert.equal(readPersonaText('- id: other\n  config:\n'), null)
})

test('replacePersonaText keeps the modern prefix: key and preserves siblings', () => {
  const out = replacePersonaText(MODERN, '新人设。\n第二行。')
  // The suffix sibling key must survive untouched.
  assert.match(out, /suffix: cwd is \{\{cwd\}\}\./)
  assert.match(out, /prefix: >-/)
  assert.equal(out.includes('text:'), false)
  assert.equal(readPersonaText(out), '新人设。\n第二行。')
})

test('replacePersonaText migrates a legacy text: row to prefix:', () => {
  const out = replacePersonaText(LEGACY, '修好的人设。')
  assert.match(out, /prefix: \|-/)
  assert.equal(out.includes('text:'), false)
  assert.equal(readPersonaText(out), '修好的人设。')
  // Rows after the persona row must be intact.
  assert.match(out, /- id: agent-instructions/)
  assert.match(out, /maxBytes: 65536/)
})

test('replacePersonaText keeps the file line ending', () => {
  const crlf = MODERN.replace(/\n/g, '\r\n')
  const out = replacePersonaText(crlf, '换了。')
  assert.ok(out.includes('\r\n'), 'CRLF input must produce CRLF output')
  assert.equal(out.includes('\n\n'), false, 'no LF-only line may appear')
})

test('replacePersonaText throws when the preset has no persona row', () => {
  assert.throws(() => replacePersonaText('- id: other\n  config:\n    x: 1\n', 'x'), /找不到 persona 行/)
})
