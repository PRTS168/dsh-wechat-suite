/**
 * ESP32 PWM light control — ONE implementation behind both surfaces:
 *
 *  - the WeChat chat commands (`/开灯`, `/关灯`, `/开灯1~3`, see commands.ts), and
 *  - the `control_esp32_light` agent tool registered by the conversation node.
 *
 * The tool lived in the retired `dsh-wechat-tools` plugin and was lost when that
 * plugin was archived; the commands kept working, so the bridge could still be
 * driven by hand but the model could no longer act on "把灯打开" by itself.
 * Both surfaces now share this module, so their wording and failure modes cannot
 * drift apart.
 *
 * Protocol (unchanged from the AstrBot-era plugin): one plain GET per mode —
 * `/gear` returns the current gear, `/off`, `/low`, `/mid`, `/high` switch it —
 * with a 5s timeout. The device sits on the LAN, so failures are returned as
 * text rather than thrown: the model relays the reason instead of the turn
 * failing, which is what the command path has always done.
 *
 * @module @dsh-cowork/chatnode-wechat/node/light
 */
import { type DirectResponse } from './net.ts';
/** The five modes both surfaces can ask for. */
export declare const LIGHT_MODES: readonly ["query", "off", "low", "mid", "high"];
export type LightMode = (typeof LIGHT_MODES)[number];
/** Device route per mode. Mirrors the retired plugin's table. */
export declare const LIGHT_ROUTES: Record<LightMode, string>;
/** Chinese label per switching mode, matching the command replies. */
export declare const LIGHT_LABELS: Record<Exclude<LightMode, 'query'>, string>;
/**
 * Fallback device address — deliberately EMPTY.
 *
 * There used to be a hard-coded `http://192.168.1.x:80` here, which shipped one
 * operator's real device address to everyone and silently pointed the tool at a
 * stranger's LAN. With no configured address the tool now says so instead of
 * guessing.
 */
export declare const DEFAULT_LIGHT_BASE_URL = "";
/** Narrow an untrusted value (tool argument) to a known mode. */
export declare function isLightMode(value: unknown): value is LightMode;
/**
 * Normalize the configured device address: trimmed, non-empty, no trailing
 * slash (the routes start with one).
 */
export declare function lightBaseUrl(configured?: string | null): string;
export interface LightOptions {
    /** Injected fetch (tests); defaults to the global. */
    fetchImpl?: typeof fetch;
    /**
     * Injected direct transport (tests). Defaults to `directRequest()` — one
     * `node:http(s)` request with its own agent, so a system proxy configured for
     * the host process cannot capture a request to a LAN device.
     */
    directImpl?: (url: string, timeoutMs: number) => Promise<DirectResponse>;
    /** Request timeout in ms. Default 5000, same as the command path. */
    timeoutMs?: number;
}
/**
 * Fire one device request and describe the outcome in a single human line.
 * Deliberately never throws — see the module comment.
 */
export declare function controlLight(baseUrl: string | null | undefined, mode: LightMode, options?: LightOptions): Promise<string>;
/**
 * The `control_esp32_light` agent tool.
 *
 * Kept in this module (rather than inline in the node plugin) so tests can pin
 * the tool's name, its mode enum and its behaviour: the failure mode that
 * motivated it — a model reporting "找不到 control_esp32_light" — is invisible
 * unless the definition itself is asserted somewhere.
 */
export declare function lightToolDefinition(baseUrl: string | undefined, options?: LightOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=light.d.ts.map