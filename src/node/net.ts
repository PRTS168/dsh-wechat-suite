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

import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

/**
 * One-line reason for a failed request, with the cause chain unwrapped.
 *
 * Also handles the `AggregateError` that happy-eyeballs failures arrive in
 * (one error per address family), because that is the shape undici throws when
 * a host resolves to both IPv6 and IPv4 and one of them cannot be reached.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts: string[] = []
  if (error.message) parts.push(error.message)
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    if (cause.message && cause.message !== error.message) parts.push(cause.message)
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code && !parts.join(' ').includes(code)) parts.push(code)
  } else if (cause && typeof cause === 'object' && Array.isArray((cause as { errors?: unknown[] }).errors)) {
    for (const inner of (cause as { errors: unknown[] }).errors) {
      if (inner instanceof Error && inner.message) parts.push(inner.message)
    }
  }
  return parts.join(' / ') || 'unknown error'
}

export interface DirectResponse {
  status: number
  body: string
}

/**
 * One request over `node:http(s)`, bypassing any global fetch dispatcher.
 *
 * `agent: false` gives the request its own agent, so a proxy configured for the
 * process cannot capture it. Rejects on transport failure; a non-2xx status is
 * returned (the caller decides what it means).
 */
export function directRequest(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<DirectResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise<DirectResponse>((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsGet : httpGet
    const request = send(url, { agent: false, headers: { accept: '*/*', ...options.headers } }, (response) => {
      const chunks: Buffer[] = []
      // A body that dies half-way emits 'error' on the RESPONSE, not on the
      // request: without this listener that becomes an uncaught exception, which
      // in this host is fatal (the LAN light and the direct weather retry both
      // come through here).
      response.on('error', reject)
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`direct request timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}
