/**
 * Morning greeting + daily weather push (`/早安`).
 *
 * A small daily scheduler that fetches the forecast for the configured city
 * (free Open-Meteo API, no key) and pushes a greeting line to the WeChat peer
 * every day at the configured time. Enabled/disabled and the push time are
 * persisted to a JSON file so they survive a DSH restart; the scheduler
 * re-arms after every change and on boot.
 *
 * The weather text is composed locally (no LLM round-trip): the bridge keeps
 * the daily push cheap and predictable.
 *
 * @module @dsh-cowork/chatnode-wechat/node/morning
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

/** Persisted morning-push configuration. */
export interface MorningConfig {
  enabled: boolean
  /** Wall-clock "HH:MM" (24h) at which the greeting is pushed. */
  time: string
  /** Latitude of the forecast location. */
  lat: number
  /** Longitude of the forecast location. */
  lon: number
  /** Display name of the forecast location (fill in your own city). */
  place: string
}

const DEFAULT_CONFIG: MorningConfig = {
  enabled: false,
  time: '08:00',
  lat: 0,
  lon: 0,
  place: '本地',
}

/** Open-Meteo API base. */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'
/** WMO weather codes → short Chinese labels (subset covering common codes). */
const WMO_LABEL: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
}

function wmoLabel(code: number): string {
  return WMO_LABEL[code] ?? `天气码${code}`
}

/** One parsed daily forecast snapshot. */
export interface DailyForecast {
  label: string
  tempNow: number
  tempMax: number
  tempMin: number
  windKmh: number
}

/** Fetch today's forecast for the configured location via Open-Meteo. */
export async function fetchForecast(
  cfg: Pick<MorningConfig, 'lat' | 'lon'>,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyForecast> {
  const url = `${OPEN_METEO_URL}?latitude=${cfg.lat}&longitude=${cfg.lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
    '&timezone=Asia%2FShanghai&forecast_days=1'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`)
    const data = await response.json() as {
      current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number }
      daily?: {
        temperature_2m_max?: number[]
        temperature_2m_min?: number[]
        weather_code?: number[]
      }
    }
    const code = data.current?.weather_code ?? data.daily?.weather_code?.[0] ?? 0
    return {
      label: wmoLabel(code),
      tempNow: data.current?.temperature_2m ?? NaN,
      tempMax: data.daily?.temperature_2m_max?.[0] ?? NaN,
      tempMin: data.daily?.temperature_2m_min?.[0] ?? NaN,
      windKmh: data.current?.wind_speed_10m ?? NaN,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Compose the greeting message text (no LLM). */
export function composeGreeting(cfg: Pick<MorningConfig, 'place'>, forecast: DailyForecast): string {
  const round = (n: number, suffix = ''): string => (Number.isFinite(n) ? `${Math.round(n)}${suffix}` : '?')
  const wind = Number.isFinite(forecast.windKmh) && forecast.windKmh >= 0 ? `，风 ${Math.round(forecast.windKmh)} km/h` : ''
  return [
    `☀️ 早安`,
    `${cfg.place}：${forecast.label} ${round(forecast.tempNow, '°C')}`,
    `最高 ${round(forecast.tempMax, '°C')} / 最低 ${round(forecast.tempMin, '°C')}${wind}`,
  ].join('\n')
}

/** Validate a wall-clock time string "HH:MM". */
export function isValidTime(value: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return false
  const h = Number(m[1]); const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

/**
 * Morning scheduler bound to a cordis context. Pushes through the gateway's
 * `sendText` to every peer returned by `targets()` (the bridge's allowlist).
 */
export class MorningService {
  private readonly ctx: Context
  private readonly file: string
  private readonly targets: () => string[]
  private config: MorningConfig = { ...DEFAULT_CONFIG }
  private timer: ReturnType<typeof setTimeout> | undefined
  private loaded = false

  constructor(ctx: Context, opts: { file?: string; targets: () => string[] }) {
    this.ctx = ctx
    this.file = opts.file ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wechat-morning.json')
    this.targets = opts.targets
  }

  /** Load persisted config and arm the scheduler. */
  async start(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.load()
    this.arm()
  }

  /** Stop the scheduler (plugin dispose). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Current config (clone). */
  getConfig(): MorningConfig {
    return { ...this.config }
  }

  /** Update config fields and persist. */
  async update(patch: Partial<MorningConfig>): Promise<MorningConfig> {
    this.config = { ...this.config, ...patch }
    await this.save()
    this.arm()
    return this.getConfig()
  }

  /** Run one greeting push immediately (used for `/早安 test`). */
  async pushNow(): Promise<string> {
    try {
      const forecast = await fetchForecast(this.config)
      return composeGreeting(this.config, forecast)
    } catch (error) {
      return `❌ 获取天气失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  // -------------------------------------------------------------------------
  // Persistence + scheduling
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<MorningConfig>
      this.config = {
        ...DEFAULT_CONFIG,
        ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
        ...(typeof parsed.time === 'string' && isValidTime(parsed.time) ? { time: parsed.time } : {}),
        ...(typeof parsed.lat === 'number' ? { lat: parsed.lat } : {}),
        ...(typeof parsed.lon === 'number' ? { lon: parsed.lon } : {}),
        ...(typeof parsed.place === 'string' ? { place: parsed.place } : {}),
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(join(this.file, '..'), { recursive: true })
    } catch {
      // directory may already exist
    }
    try {
      await writeFile(this.file, JSON.stringify(this.config, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.('[dsh-chatnode-wechat] morning config persist failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /** (Re)arm the daily timer for the configured time. */
  private arm(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.config.enabled) return
    const [h, m] = this.config.time.split(':').map(Number)
    const now = new Date()
    const next = new Date(now)
    next.setHours(h!, m!, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    const delay = next.getTime() - now.getTime()
    // setTimeout caps ~24.8 days; re-arm on a daily boundary instead.
    const MAX_TIMEOUT = 2_147_000_000
    const armDelay = Math.min(delay, MAX_TIMEOUT)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.config.enabled) {
        void this.fire()
      }
      this.arm()
    }, armDelay)
  }

  /** Deliver today's greeting to every target peer (best-effort). */
  private async fire(): Promise<void> {
    const wechat = this.ctx.get('wechat') as { sendText(to: string, text: string): Promise<{ success: boolean }> } | undefined
    if (!wechat?.sendText) return
    const text = await this.pushNow()
    for (const to of this.targets()) {
      try {
        await wechat.sendText(to, text)
      } catch (error) {
        this.ctx.logger?.warn?.('[dsh-chatnode-wechat] morning push failed to %s: %s', to, error instanceof Error ? error.message : String(error))
      }
    }
  }
}
