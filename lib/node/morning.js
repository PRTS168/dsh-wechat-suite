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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describeError, directRequest } from "./net.js";
const DEFAULT_CONFIG = {
    enabled: false,
    time: '08:00',
    lat: 0,
    lon: 0,
    place: '本地',
};
/** Open-Meteo API base. */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
/** WMO weather codes → short Chinese labels (subset covering common codes). */
const WMO_LABEL = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '阵雨', 82: '强阵雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};
function wmoLabel(code) {
    return WMO_LABEL[code] ?? `天气码${code}`;
}
/** Map the raw payload onto the values the greeting shows. */
function toForecast(data) {
    const code = data.current?.weather_code ?? data.daily?.weather_code?.[0] ?? 0;
    return {
        label: wmoLabel(code),
        tempNow: data.current?.temperature_2m ?? NaN,
        tempMax: data.daily?.temperature_2m_max?.[0] ?? NaN,
        tempMin: data.daily?.temperature_2m_min?.[0] ?? NaN,
        windKmh: data.current?.wind_speed_10m ?? NaN,
    };
}
export { describeError };
/** Direct JSON read that never consults a global fetch dispatcher. */
export async function directJson(url, timeoutMs = 15_000) {
    const { status, body } = await directRequest(url, { timeoutMs, headers: { accept: 'application/json' } });
    if (status < 200 || status >= 300)
        throw new Error(`Open-Meteo HTTP ${status}`);
    try {
        return JSON.parse(body);
    }
    catch (error) {
        throw new Error(`Open-Meteo returned invalid JSON: ${describeError(error)}`);
    }
}
/**
 * Fetch today's forecast for the configured location via Open-Meteo.
 *
 * Tries the ambient `fetch` first (honouring whatever dispatcher the host
 * installed) and retries **directly** over `node:https` when that fails at the
 * transport level. The retry is what keeps the feature alive behind a local
 * proxy that is up but does not carry `api.open-meteo.com`, which otherwise
 * shows up as `❌ 获取天气失败：fetch failed` with nothing else to go on.
 */
export async function fetchForecast(cfg, fetchImpl = fetch, directImpl = directJson) {
    const url = `${OPEN_METEO_URL}?latitude=${cfg.lat}&longitude=${cfg.lon}` +
        '&current=temperature_2m,weather_code,wind_speed_10m' +
        '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
        '&timezone=Asia%2FShanghai&forecast_days=1';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok)
            throw new Error(`Open-Meteo HTTP ${response.status}`);
        return toForecast(await response.json());
    }
    catch (error) {
        const first = describeError(error);
        // A server-side status is an answer, not a transport problem: do not retry.
        if (/Open-Meteo HTTP \d{3}/.test(first))
            throw new Error(first);
        try {
            return toForecast(await directImpl(url));
        }
        catch (directError) {
            throw new Error(`${first}；直连重试失败：${describeError(directError)}` +
                '（若开启了系统代理，请确认代理放行 api.open-meteo.com，或临时关闭代理）');
        }
    }
    finally {
        clearTimeout(timer);
    }
}
/** Compose the greeting message text (no LLM). */
export function composeGreeting(cfg, forecast) {
    const round = (n, suffix = '') => (Number.isFinite(n) ? `${Math.round(n)}${suffix}` : '?');
    const wind = Number.isFinite(forecast.windKmh) && forecast.windKmh >= 0 ? `，风 ${Math.round(forecast.windKmh)} km/h` : '';
    return [
        `☀️ 早安`,
        `${cfg.place}：${forecast.label} ${round(forecast.tempNow, '°C')}`,
        `最高 ${round(forecast.tempMax, '°C')} / 最低 ${round(forecast.tempMin, '°C')}${wind}`,
    ].join('\n');
}
/** Validate a wall-clock time string "HH:MM". */
export function isValidTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m)
        return false;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}
/**
 * Morning scheduler bound to a cordis context. Pushes through the gateway's
 * `sendText` to every peer returned by `targets()` (the bridge's allowlist).
 */
export class MorningService {
    ctx;
    file;
    targets;
    config = { ...DEFAULT_CONFIG };
    timer;
    loaded = false;
    constructor(ctx, opts) {
        this.ctx = ctx;
        this.file = opts.file ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wechat-morning.json');
        this.targets = opts.targets;
    }
    /** Load persisted config and arm the scheduler. */
    async start() {
        if (this.loaded)
            return;
        this.loaded = true;
        await this.load();
        this.arm();
    }
    /** Stop the scheduler (plugin dispose). */
    stop() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** Current config (clone). */
    getConfig() {
        return { ...this.config };
    }
    /** Update config fields and persist. */
    async update(patch) {
        this.config = { ...this.config, ...patch };
        await this.save();
        this.arm();
        return this.getConfig();
    }
    /** Run one greeting push immediately (used for `/早安 test`). */
    async pushNow() {
        try {
            const forecast = await fetchForecast(this.config);
            return composeGreeting(this.config, forecast);
        }
        catch (error) {
            return `❌ 获取天气失败：${error instanceof Error ? error.message : String(error)}`;
        }
    }
    // -------------------------------------------------------------------------
    // Persistence + scheduling
    // -------------------------------------------------------------------------
    async load() {
        try {
            const raw = await readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            this.config = {
                ...DEFAULT_CONFIG,
                ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
                ...(typeof parsed.time === 'string' && isValidTime(parsed.time) ? { time: parsed.time } : {}),
                ...(typeof parsed.lat === 'number' ? { lat: parsed.lat } : {}),
                ...(typeof parsed.lon === 'number' ? { lon: parsed.lon } : {}),
                ...(typeof parsed.place === 'string' ? { place: parsed.place } : {}),
            };
        }
        catch {
            this.config = { ...DEFAULT_CONFIG };
        }
    }
    async save() {
        try {
            await mkdir(join(this.file, '..'), { recursive: true });
        }
        catch {
            // directory may already exist
        }
        try {
            await writeFile(this.file, JSON.stringify(this.config, null, 2), 'utf8');
        }
        catch (error) {
            this.ctx.logger?.warn?.('[dsh-chatnode-wechat] morning config persist failed: %s', error instanceof Error ? error.message : String(error));
        }
    }
    /** (Re)arm the daily timer for the configured time. */
    arm() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.config.enabled)
            return;
        const [h, m] = this.config.time.split(':').map(Number);
        const now = new Date();
        const next = new Date(now);
        next.setHours(h, m, 0, 0);
        if (next.getTime() <= now.getTime())
            next.setDate(next.getDate() + 1);
        const delay = next.getTime() - now.getTime();
        // setTimeout caps ~24.8 days; re-arm on a daily boundary instead.
        const MAX_TIMEOUT = 2_147_000_000;
        const armDelay = Math.min(delay, MAX_TIMEOUT);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.config.enabled) {
                void this.fire();
            }
            this.arm();
        }, armDelay);
    }
    /** Deliver today's greeting to every target peer (best-effort). */
    async fire() {
        const wechat = this.ctx.get('wechat');
        if (!wechat?.sendText)
            return;
        const text = await this.pushNow();
        for (const to of this.targets()) {
            try {
                await wechat.sendText(to, text);
            }
            catch (error) {
                this.ctx.logger?.warn?.('[dsh-chatnode-wechat] morning push failed to %s: %s', to, error instanceof Error ? error.message : String(error));
            }
        }
    }
}
//# sourceMappingURL=morning.js.map