/**
 * Morning-greeting tests: forecast fetch (stubbed HTTP), greeting text,
 * time validation, and the config persistence/arm cycle — no WeChat account.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { fetchForecast, composeGreeting, isValidTime, MorningService } from '../src/node/morning.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('isValidTime accepts HH:MM and rejects garbage', () => {
  assert.equal(isValidTime('08:00'), true)
  assert.equal(isValidTime('23:59'), true)
  assert.equal(isValidTime('8:5'), false)
  assert.equal(isValidTime('24:00'), false)
  assert.equal(isValidTime('12:60'), false)
  assert.equal(isValidTime('noon'), false)
})

test('fetchForecast parses open-meteo shape', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    current: { temperature_2m: 20.6, weather_code: 3, wind_speed_10m: 7.4 },
    daily: { temperature_2m_max: [25.9], temperature_2m_min: [15.9] },
  }), { status: 200 }) as unknown as Response
  const f = await fetchForecast({ lat: 46.63, lon: 126.98 }, fetchImpl as typeof fetch)
  assert.equal(f.label, '阴')
  assert.equal(f.tempNow, 20.6)
  assert.equal(f.tempMax, 25.9)
  assert.equal(f.tempMin, 15.9)
})

test('fetchForecast throws on HTTP error', async () => {
  const fetchImpl = async () => new Response('nope', { status: 500 }) as unknown as Response
  await assert.rejects(() => fetchForecast({ lat: 0, lon: 0 }, fetchImpl as typeof fetch))
})

test('composeGreeting produces a readable line with the place', () => {
  const text = composeGreeting({ place: '绥化' }, { label: '晴', tempNow: 25, tempMax: 30, tempMin: 18, windKmh: 9 })
  assert.ok(text.includes('绥化'))
  assert.ok(text.includes('晴'))
  assert.ok(text.includes('25°C'))
  assert.ok(text.includes('30°C'))
  assert.ok(text.includes('18°C'))
})

test('MorningService persists config and toggles enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-morning-'))
  const file = join(dir, 'morning.json')
  const ctx = new Context()
  const targets = () => ['wxid_allow1']
  try {
    const svc = new MorningService(ctx, { file, targets })
    await svc.start()
    assert.equal(svc.getConfig().enabled, false) // default off
    await svc.update({ enabled: true, time: '07:45' })
    assert.equal(svc.getConfig().enabled, true)
    assert.equal(svc.getConfig().time, '07:45')
    svc.stop()

    // Recreate from disk: state must survive.
    const svc2 = new MorningService(ctx, { file, targets })
    await svc2.start()
    const loaded = svc2.getConfig()
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.time, '07:45')
    svc2.stop()
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.time, '07:45')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MorningService pushNow composes from stubbed forecast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-morning-'))
  const file = join(dir, 'morning.json')
  const ctx = new Context()
  const targets = () => ['wxid_allow1']
  try {
    const svc = new MorningService(ctx, { file, targets })
    await svc.start()
    // Stub global fetch for the single call inside pushNow.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      current: { temperature_2m: 18.2, weather_code: 61, wind_speed_10m: 12 },
      daily: { temperature_2m_max: [21], temperature_2m_min: [14] },
    }), { status: 200 }) as unknown as Response) as typeof fetch
    try {
      const text = await svc.pushNow()
      assert.ok(text.includes('小雨'))
      assert.ok(text.includes('绥化'))
    } finally {
      globalThis.fetch = realFetch
    }
    svc.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
