/**
 * The config surface must not have holes.
 *
 * The host validates the profile patch against the BUNDLE's schema
 * (`src/index.ts`), then `apply()` forwards fields to the conversation node
 * (`src/node/index.ts`). A key the node reads but the bundle does not declare is
 * silently stripped before `apply()` runs, and the feature dies quietly:
 *
 *   send_email reported "SMTP 没配" on a profile whose patch had a complete,
 *   *working* SMTP block, because smtpHost/Port/Username/Password/FromName
 *   existed on the node and nowhere else. imageInput/imageInputModel were
 *   stripped the same way.
 *
 * This test walks the real source files, so adding a new feature key to the node
 * without surfacing it in the bundle fails here instead of in the owner's chat.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const bundle = readFileSync(join(root, 'src/index.ts'), 'utf8')
const node = readFileSync(join(root, 'src/node/index.ts'), 'utf8')
const patchConfig = readFileSync(join(root, 'src/node/patch-config.ts'), 'utf8')

/** Keys declared in a schemastery object literal (`  key: z.…`). */
function schemaKeys(text: string): Set<string> {
  const start = text.indexOf('export const Config = z.object({')
  assert.ok(start > 0, 'Config schema not found')
  // The object literal ends at the first `})` on its own line.
  const end = text.indexOf('\n})', start)
  const body = text.slice(start, end)
  return new Set([...body.matchAll(/^\s{2}([a-zA-Z][\w]*):\s*z\./gm)].map((m) => m[1]!))
}

/** Keys `apply()` hands to the conversation node (`    key: config.key,`). */
function forwardedKeys(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s{4}([a-zA-Z][\w]*):\s*config\.\1[,)]/gm)].map((m) => m[1]!))
}

/** Keys the gateway receives through its own extraction helper. */
function gatewayKeys(text: string): Set<string> {
  const start = text.indexOf('function extractGatewayConfig')
  const body = text.slice(start, text.indexOf('\n}', start))
  return new Set([...body.matchAll(/config\.([a-zA-Z][\w]*)/g)].map((m) => m[1]!))
}

/** Keys the admin console can edit. */
function consoleKeys(text: string): Set<string> {
  return new Set([...text.matchAll(/key: '([a-zA-Z][\w]*)'/g)].map((m) => m[1]!))
}

const bundleSchema = schemaKeys(bundle)
const nodeSchema = schemaKeys(node)
const forwarded = forwardedKeys(bundle)
const gateway = gatewayKeys(bundle)
const consoleFields = consoleKeys(patchConfig)

test('every node config key is declared in the bundle schema', () => {
  const missing = [...nodeSchema].filter((key) => !bundleSchema.has(key))
  assert.deepEqual(
    missing,
    [],
    `这些键节点会读、但 bundle 没声明，会被宿主丢掉（功能静默失效）：${missing.join(', ')}`,
  )
})

test('every node config key reaches the node', () => {
  const missing = [...nodeSchema].filter((key) => !forwarded.has(key) && key !== 'allowFrom')
  assert.deepEqual(
    missing,
    [],
    `这些键声明了却没转发给节点：${missing.join(', ')}`,
  )
  // allowFrom is forwarded with a `?? []` default, so the generic pattern misses it.
  assert.match(bundle, /allowFrom: config\.allowFrom \?\? \[\]/)
})

test('the gateway keys are wired by their own path', () => {
  // Every key the GATEWAY_KEYS list forwards must be declared in the bundle
  // schema (else the host strips it before apply()) AND must be a key the
  // gateway actually accepts.
  const listStart = bundle.indexOf('const GATEWAY_KEYS = [')
  const listEnd = bundle.indexOf('] as const', listStart)
  const declared = new Set(
    [...bundle.slice(listStart, listEnd).matchAll(/'([a-zA-Z][\w]*)'/g)].map((m) => m[1]!),
  )
  const missing = [...declared].filter((key) => !bundleSchema.has(key))
  assert.deepEqual(missing, [], `GATEWAY_KEYS 里的这些键没在 bundle schema 里声明，会被丢掉：${missing.join(', ')}`)

  const gatewaySchema = schemaKeys(
    readFileSync(join(root, 'src/gateway/index.ts'), 'utf8'),
  )
  const unknown = [...declared].filter((key) => !gatewaySchema.has(key))
  assert.deepEqual(unknown, [], `GATEWAY_KEYS 里的这些键网关并不认识：${unknown.join(', ')}`)
  assert.ok(declared.size >= 18, `转发的网关键太少了（${declared.size}），是不是又只传了 4 个`)
})

test('the features the owner can use are editable in the console', () => {
  // A feature nobody can configure from the console is a feature that stays
  // broken: the SMTP block was hand-edit-only until this test existed.
  const mustBeEditable = [
    'allowFrom', 'agentPreset', 'agentProvider', 'agentModel',
    'ocrApiKey', 'ocrModel', 'ocrBaseUrl', 'imageInput', 'imageInputModel',
    'imageGenApiKey', 'imageGenModel', 'imageGenDir',
    'sttApiKey', 'sttModel', 'ttsApiKey', 'ttsModel', 'ttsVoice',
    'smtpHost', 'smtpPort', 'smtpUsername', 'smtpPassword', 'smtpFromName',
    'esp32BaseUrl', 'contextPolicy', 'memoryFile', 'memoryInjectEvery',
    'memoryConsolidateTime', 'problemFile',
  ]
  const missing = mustBeEditable.filter((key) => !consoleFields.has(key))
  assert.deepEqual(missing, [], `这些功能键在管理台里没有对应字段：${missing.join(', ')}`)
})

test('the SMTP block is a single source of truth on both sides', () => {
  const smtp = ['smtpHost', 'smtpPort', 'smtpUsername', 'smtpPassword', 'smtpFromName']
  for (const key of smtp) {
    assert.ok(nodeSchema.has(key), `${key} 节点 schema 缺失`)
    assert.ok(bundleSchema.has(key), `${key} bundle schema 缺失——宿主会把它丢掉`)
    assert.ok(forwarded.has(key), `${key} 没有转发给节点`)
  }
})
