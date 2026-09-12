/**
 * ESP32 light control — the shared implementation behind the `/开灯` chat
 * commands and the `control_esp32_light` agent tool.
 *
 * Why these tests exist: the tool disappeared when the `dsh-wechat-tools` plugin
 * was archived, and nothing failed loudly — the model only reported "找不到
 * control_esp32_light 这个工具". These pin the tool's mode vocabulary and the
 * one-line results both surfaces hand back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LIGHT_BASE_URL,
  LIGHT_LABELS,
  LIGHT_MODES,
  LIGHT_ROUTES,
  controlLight,
  isLightMode,
  lightBaseUrl,
  lightToolDefinition,
} from '../src/node/light.ts'

/** A fetch stub answering with one body/status. */
const answering = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch

test('every mode has a route and the routes are device paths', () => {
  assert.deepEqual(Object.keys(LIGHT_ROUTES).sort(), [...LIGHT_MODES].sort())
  for (const route of Object.values(LIGHT_ROUTES)) assert.match(route, /^\/[a-z]+$/)
})

test('isLightMode accepts exactly the five modes', () => {
  for (const mode of LIGHT_MODES) assert.equal(isLightMode(mode), true)
  for (const bad of ['on', 'ON', '', ' low', 'query ', 1, undefined, null, {}]) assert.equal(isLightMode(bad), false)
})

test('lightBaseUrl falls back to the default and strips trailing slashes', () => {
  assert.equal(lightBaseUrl(undefined), DEFAULT_LIGHT_BASE_URL)
  assert.equal(lightBaseUrl(null), DEFAULT_LIGHT_BASE_URL)
  assert.equal(lightBaseUrl('   '), DEFAULT_LIGHT_BASE_URL)
  assert.equal(lightBaseUrl('http://192.168.1.50:80/'), 'http://192.168.1.50:80')
  assert.equal(lightBaseUrl('http://192.168.1.50:80///'), 'http://192.168.1.50:80')
})

test('a switch mode reports the label together with the device body', async () => {
  assert.equal(await controlLight('http://192.168.1.11', 'high', { fetchImpl: answering('3') }), `✅ ${LIGHT_LABELS.high}：3`)
  assert.equal(await controlLight(undefined, 'low', { fetchImpl: answering('1') }), `✅ ${LIGHT_LABELS.low}：1`)
})

test('a switch mode with an empty body still reports success', async () => {
  assert.equal(await controlLight(undefined, 'off', { fetchImpl: answering('') }), `✅ ${LIGHT_LABELS.off}`)
})

test('query reports the current gear, and empty means no answer', async () => {
  assert.equal(await controlLight(undefined, 'query', { fetchImpl: answering('2') }), '当前灯光档位：2（0=关闭，1=低，2=中，3=高）')
  assert.equal(await controlLight(undefined, 'query', { fetchImpl: answering('') }), 'ESP32 无响应')
})

test('an HTTP error is reported as text, never thrown', async () => {
  assert.equal(await controlLight(undefined, 'low', { fetchImpl: answering('nope', 500) }), '❌ ESP32 响应异常（HTTP 500）')
})

test('an unreachable device is reported as text, never thrown', async () => {
  const failing = (async () => {
    throw new Error('connect ECONNREFUSED 192.168.1.11:80')
  }) as unknown as typeof fetch
  const line = await controlLight(undefined, 'mid', { fetchImpl: failing })
  assert.match(line, /^❌ 无法连接 ESP32 灯光设备（/)
  assert.match(line, /ECONNREFUSED/)
})

test('the request hits the configured device path', async () => {
  const seen: string[] = []
  const spy = (async (url: string | URL) => {
    seen.push(String(url))
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  await controlLight('http://10.0.0.9:8080', 'off', { fetchImpl: spy })
  await controlLight('http://10.0.0.9:8080', 'query', { fetchImpl: spy })
  assert.deepEqual(seen, ['http://10.0.0.9:8080/off', 'http://10.0.0.9:8080/gear'])
})

// ── the agent tool itself ───────────────────────────────────────────────────
// This is the part that silently vanished with `dsh-wechat-tools`: the model
// asked for `control_esp32_light` and nothing was registered under that name.

test('the tool keeps the name the model already knows', () => {
  const tool = lightToolDefinition(undefined)
  assert.equal(tool.name, 'control_esp32_light')
  assert.match(tool.description, /ESP32/)
})

test('the tool advertises the five modes as an enum, with mode required', () => {
  const tool = lightToolDefinition(undefined)
  const mode = (tool.parameters as { properties: Record<string, { type: string; enum?: string[] }> }).properties.mode
  assert.equal(mode.type, 'string')
  assert.deepEqual([...(mode.enum ?? [])].sort(), [...LIGHT_MODES].sort())
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ['mode'])
})

test('calling the tool drives the device and returns one line', async () => {
  const tool = lightToolDefinition('http://192.168.1.11', { fetchImpl: answering('3') })
  assert.equal(await tool.execute({ mode: 'high' }, {} as never), `✅ ${LIGHT_LABELS.high}：3`)
})

test('the tool refuses a mode outside the enum', async () => {
  const tool = lightToolDefinition(undefined, { fetchImpl: answering('0') })
  await assert.rejects(() => tool.execute({ mode: 'on' }, {} as never))
  await assert.rejects(() => tool.execute({}, {} as never))
})
