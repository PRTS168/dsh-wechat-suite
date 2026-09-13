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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { describeError, directRequest } from "./net.js";
/** The five modes both surfaces can ask for. */
export const LIGHT_MODES = ['query', 'off', 'low', 'mid', 'high'];
/** Device route per mode. Mirrors the retired plugin's table. */
export const LIGHT_ROUTES = {
    query: '/gear',
    off: '/off',
    low: '/low',
    mid: '/mid',
    high: '/high',
};
/** Chinese label per switching mode, matching the command replies. */
export const LIGHT_LABELS = {
    off: '关灯',
    low: '开灯（1 档·低）',
    mid: '开灯（2 档·中）',
    high: '开灯（3 档·高）',
};
/**
 * Fallback device address — deliberately EMPTY.
 *
 * There used to be a hard-coded `http://192.168.1.x:80` here, which shipped one
 * operator's real device address to everyone and silently pointed the tool at a
 * stranger's LAN. With no configured address the tool now says so instead of
 * guessing.
 */
export const DEFAULT_LIGHT_BASE_URL = '';
/** Narrow an untrusted value (tool argument) to a known mode. */
export function isLightMode(value) {
    return typeof value === 'string' && LIGHT_MODES.includes(value);
}
/**
 * Normalize the configured device address: trimmed, non-empty, no trailing
 * slash (the routes start with one).
 */
export function lightBaseUrl(configured) {
    const trimmed = (configured ?? '').trim();
    return (trimmed || DEFAULT_LIGHT_BASE_URL).replace(/\/+$/, '');
}
/**
 * Fire one device request and describe the outcome in a single human line.
 * Deliberately never throws — see the module comment.
 */
export async function controlLight(baseUrl, mode, options = {}) {
    const base = lightBaseUrl(baseUrl);
    if (!base) {
        return '❌ 灯控还没配置：在 profile 的 `esp32BaseUrl`（或管理台 → 高级模式 → 可选）填上设备的地址，例如 http://<esp32-ip>:80';
    }
    const url = base + LIGHT_ROUTES[mode];
    const timeoutMs = options.timeoutMs ?? 5000;
    const doFetch = options.fetchImpl ?? fetch;
    const doDirect = options.directImpl ?? ((target, timeout) => directRequest(target, { timeoutMs: timeout }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const describe = (status, raw) => {
        const text = raw.trim();
        if (mode === 'query') {
            return text ? `当前灯光档位：${text}（0=关闭，1=低，2=中，3=高）` : 'ESP32 无响应';
        }
        if (status < 200 || status >= 300)
            return `❌ ESP32 响应异常（HTTP ${status}）`;
        const label = LIGHT_LABELS[mode];
        return text ? `✅ ${label}：${text}` : `✅ ${label}`;
    };
    try {
        const res = await doFetch(url, { signal: controller.signal });
        return describe(res.status, await res.text());
    }
    catch (error) {
        // The device is on the LAN: never let a host proxy decide whether the light
        // can be reached. Retry once directly and name both reasons when it is
        // really down (a bare "fetch failed" tells the user nothing, see net.ts).
        const first = describeError(error);
        try {
            const res = await doDirect(url, timeoutMs);
            return describe(res.status, res.body);
        }
        catch (directError) {
            return `❌ 无法连接 ESP32 灯光设备（${first}；直连重试失败：${describeError(directError)}）`;
        }
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * The `control_esp32_light` agent tool.
 *
 * Kept in this module (rather than inline in the node plugin) so tests can pin
 * the tool's name, its mode enum and its behaviour: the failure mode that
 * motivated it — a model reporting "找不到 control_esp32_light" — is invisible
 * unless the definition itself is asserted somewhere.
 */
export function lightToolDefinition(baseUrl, options = {}) {
    return defineTool({
        name: 'control_esp32_light',
        description: 'Control the ESP32 PWM light on the LAN: query its current gear, or switch it off / to low / mid / high. ' +
            'Use when the user asks to turn the light on or off, change its brightness, or asks which gear it is in. ' +
            'Returns one human-readable line describing the outcome.',
        parameters: {
            mode: {
                type: 'string',
                required: true,
                enum: [...LIGHT_MODES],
                description: 'query=查询当前档位, off=关灯, low=低档, mid=中档, high=高档（等同 /开灯）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const mode = args.mode;
            // The parameter schema already restricts this to the five modes; the guard
            // keeps a caller that bypasses validation (a test, a future refactor) honest.
            if (!isLightMode(mode)) {
                throw new Error(`unknown light mode ${JSON.stringify(mode)}; expected one of ${LIGHT_MODES.join(', ')}`);
            }
            return await controlLight(baseUrl, mode, options);
        },
        timeoutMs: 10_000,
    });
}
//# sourceMappingURL=light.js.map