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
import type { Context } from '@deepseek-ai/cordis';
/** Persisted morning-push configuration. */
export interface MorningConfig {
    enabled: boolean;
    /** Wall-clock "HH:MM" (24h) at which the greeting is pushed. */
    time: string;
    /** Latitude of the forecast location. */
    lat: number;
    /** Longitude of the forecast location. */
    lon: number;
    /** Display name of the forecast location (fill in your own city). */
    place: string;
}
/** One parsed daily forecast snapshot. */
export interface DailyForecast {
    label: string;
    tempNow: number;
    tempMax: number;
    tempMin: number;
    windKmh: number;
}
/** Fetch today's forecast for the configured location via Open-Meteo. */
export declare function fetchForecast(cfg: Pick<MorningConfig, 'lat' | 'lon'>, fetchImpl?: typeof fetch): Promise<DailyForecast>;
/** Compose the greeting message text (no LLM). */
export declare function composeGreeting(cfg: Pick<MorningConfig, 'place'>, forecast: DailyForecast): string;
/** Validate a wall-clock time string "HH:MM". */
export declare function isValidTime(value: string): boolean;
/**
 * Morning scheduler bound to a cordis context. Pushes through the gateway's
 * `sendText` to every peer returned by `targets()` (the bridge's allowlist).
 */
export declare class MorningService {
    private readonly ctx;
    private readonly file;
    private readonly targets;
    private config;
    private timer;
    private loaded;
    constructor(ctx: Context, opts: {
        file?: string;
        targets: () => string[];
    });
    /** Load persisted config and arm the scheduler. */
    start(): Promise<void>;
    /** Stop the scheduler (plugin dispose). */
    stop(): void;
    /** Current config (clone). */
    getConfig(): MorningConfig;
    /** Update config fields and persist. */
    update(patch: Partial<MorningConfig>): Promise<MorningConfig>;
    /** Run one greeting push immediately (used for `/早安 test`). */
    pushNow(): Promise<string>;
    private load;
    private save;
    /** (Re)arm the daily timer for the configured time. */
    private arm;
    /** Deliver today's greeting to every target peer (best-effort). */
    private fire;
}
//# sourceMappingURL=morning.d.ts.map