/**
 * Shared HTTP helpers for the bridge's own outbound requests.
 *
 * Two lessons are baked in here, both learned the hard way:
 *
 * 1. `fetch` (undici) reports **every** transport failure as a bare
 *    `TypeError: fetch failed` and keeps the real reason (ENOTFOUND /
 *    ECONNREFUSED / TLS / timeout) in `error.cause`. Without unwrapping it, a
 *    local proxy that silently drops the request is indistinguishable from a
 *    genuine outage — which is exactly how `/早安 test` ended up answering
 *    "❌ 获取天气失败：fetch failed" with nothing to act on.
 * 2. The ambient `fetch` follows whatever dispatcher the host installed, which
 *    on a desktop host may be a system proxy. Requests to LAN devices (the
 *    ESP32 light) must never be routed through it.
 *
 * `describeError()` unwraps the reason; `directRequest()` performs one request
 * over `node:http(s)` with `agent: false`, which never consults a proxy.
 *
 * @module @dsh-cowork/chatnode-wechat/node/net
 */
/**
 * One-line reason for a failed request, with the cause chain unwrapped.
 *
 * Also handles the `AggregateError` that happy-eyeballs failures arrive in
 * (one error per address family), because that is the shape undici throws when
 * a host resolves to both IPv6 and IPv4 and one of them cannot be reached.
 */
export declare function describeError(error: unknown): string;
export interface DirectResponse {
    status: number;
    body: string;
}
/**
 * One request over `node:http(s)`, bypassing any global fetch dispatcher.
 *
 * `agent: false` gives the request its own agent, so a proxy configured for the
 * process cannot capture it. Rejects on transport failure; a non-2xx status is
 * returned (the caller decides what it means).
 */
export declare function directRequest(url: string, options?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
}): Promise<DirectResponse>;
//# sourceMappingURL=net.d.ts.map