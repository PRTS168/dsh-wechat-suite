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
/** Device address used when the profile config leaves `esp32BaseUrl` unset. */
export const DEFAULT_LIGHT_BASE_URL = 'http://192.168.1.11:80';
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
    const route = LIGHT_ROUTES[mode];
    const doFetch = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
    try {
        const res = await doFetch(base + route, { signal: controller.signal });
        const text = (await res.text()).trim();
        if (mode === 'query') {
            return text ? `当前灯光档位：${text}（0=关闭，1=低，2=中，3=高）` : 'ESP32 无响应';
        }
        if (!res.ok)
            return `❌ ESP32 响应异常（HTTP ${res.status}）`;
        const label = LIGHT_LABELS[mode];
        return text ? `✅ ${label}：${text}` : `✅ ${label}`;
    }
    catch (error) {
        return `❌ 无法连接 ESP32 灯光设备（${error instanceof Error ? error.message : String(error)}）`;
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