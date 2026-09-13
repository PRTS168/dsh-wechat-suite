/**
 * Transport resilience.
 *
 * The failure this file guards against, observed on 2026-09-13: the bridge spent
 * 18 minutes failing *every* request with
 * `fetch failed / invalid content-length header / UND_ERR_INVALID_ARG`, ~96
 * retries inside that process failed identically, and restarting the process
 * fixed it instantly. Every request through the pooled connection was broken;
 * a fresh connection was not. So: after a transport failure, the next request
 * takes a brand-new connection instead of the pool.
 *
 * These tests run against a local HTTP server — no iLink, no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  getUpdates,
  postJson,
  resetTransportPreference,
  transportUsesDirectConnection,
} from '../src/gateway/ilink-client.ts'
import { capLongPollWindow } from '../src/gateway/index.ts'

interface Recorded {
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function startLocalServer(): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, echo: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A fetch that reproduces the incident's failure mode. */
const brokenFetch = (() => {
  throw new TypeError('fetch failed')
}) as unknown as typeof fetch

test('a transport failure moves the next request onto a fresh connection', async (t) => {
  resetTransportPreference()
  const server = await startLocalServer()
  t.after(async () => {
    await server.close()
    resetTransportPreference()
  })

  await assert.rejects(
    () => postJson({
      baseUrl: server.url,
      endpoint: 'probe',
      payload: { text: '把灯开开吧' },
      token: 'test-token',
      fetchImpl: brokenFetch,
    }),
    /fetch failed/,
  )
  assert.equal(transportUsesDirectConnection(), true, '传输失败之后，下一次请求应改走新建连接')

  // Second call: the pooled path is still broken, the fresh connection is not.
  const out = await postJson<{ ret: number; echo: { text: string } }>({
    baseUrl: server.url,
    endpoint: 'probe',
    payload: { text: '把灯开开吧' },
    token: 'test-token',
    fetchImpl: brokenFetch,
  })
  assert.equal(out.ret, 0, '第二次请求必须走新建连接并成功')
  assert.equal(out.echo.text, '把灯开开吧', '重放的报文必须一字不差')
  assert.equal(transportUsesDirectConnection(), false, '成功之后应回到常规路径')

  const last = server.requests.at(-1)!
  assert.equal(
    last.headers['content-length'],
    String(Buffer.byteLength(last.body)),
    'Content-Length 必须等于实际字节数（中文按 UTF-8 计）',
  )
  assert.equal(last.headers.authorization, 'Bearer test-token', '鉴权头必须照带')
})

test('a healthy pooled request clears the preference', async (t) => {
  resetTransportPreference()
  const server = await startLocalServer()
  t.after(async () => {
    await server.close()
    resetTransportPreference()
  })

  await assert.rejects(
    () => postJson({ baseUrl: server.url, endpoint: 'probe', payload: {}, token: 't', fetchImpl: brokenFetch }),
    /fetch failed/,
  )
  assert.equal(transportUsesDirectConnection(), true)

  // Real fetch succeeds → the pool is healthy again, no need for fresh sockets.
  const out = await postJson<{ ret: number }>({ baseUrl: server.url, endpoint: 'probe', payload: {}, token: 't' })
  assert.equal(out.ret, 0)
  assert.equal(transportUsesDirectConnection(), false)
})

test('an HTTP error answer is not a transport failure', async (t) => {
  resetTransportPreference()
  const server = await startLocalServer()
  t.after(async () => {
    await server.close()
    resetTransportPreference()
  })

  // A server that answers but with an error must not flip the transport.
  await assert.rejects(
    () => postJson({
      baseUrl: server.url,
      endpoint: 'missing',
      payload: {},
      token: 't',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    }),
    /HTTP 500/,
  )
  assert.equal(transportUsesDirectConnection(), false, '服务端答复了，就说明连接是好的')
})

test('the server long-poll suggestion is capped by the configured window', () => {
  // The incident-shaped case: iLink asks for a minute, the operator set 35s.
  assert.equal(capLongPollWindow(60_000, 35_000), 35_000, '服务端建议不能超过配置值')
  // A shorter suggestion is still honored — no reason to poll harder than asked.
  assert.equal(capLongPollWindow(100, 35_000), 100)
  // 0 / negative means "no suggestion": keep the configured window.
  assert.equal(capLongPollWindow(0, 35_000), 35_000)
  assert.equal(capLongPollWindow(-1, 35_000), 35_000)
  // An operator who wants snappier pickup can lower it and it takes effect.
  assert.equal(capLongPollWindow(60_000, 10_000), 10_000)
})

test('requests carry no hand-made Content-Length', async () => {
  // The header we used to send was the only one that could disagree with the
  // transport's own computation for a replayed or aborted copy of the request;
  // `invalid content-length header / UND_ERR_INVALID_ARG` is exactly that
  // disagreement, and it took the long poll down once per window (2026-09-13).
  resetTransportPreference()
  let sent: Record<string, string> | undefined
  const capture = (async (_url: string, init: RequestInit) => {
    sent = init.headers as Record<string, string>
    return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  await postJson({
    baseUrl: 'http://127.0.0.1:1',
    endpoint: 'probe',
    payload: { text: '把灯开开吧' },
    token: 't',
    fetchImpl: capture,
  })
  assert.equal(sent?.['Content-Length'], undefined, 'undici 会按实际字节数设置，不需要我们自己算')
  assert.equal(sent?.['Content-Type'], 'application/json')
  assert.equal(sent?.Authorization, 'Bearer t')
})

test('a long poll that reaches its own window is an empty round, not a failure', async () => {
  // Reproduces the real race: the window elapses and the peer closes the
  // connection at the same moment, so undici reports `fetch failed` instead of
  // an abort. That used to be logged as a transport failure (and announced to
  // the owner) once per window.
  resetTransportPreference()
  let sawAbort = false
  const racyFetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      sawAbort = true
      reject(new TypeError('fetch failed'))
    })
  })) as unknown as typeof fetch

  const out = await getUpdates({
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    syncBuf: 'cursor',
    timeoutMs: 60,
    fetchImpl: racyFetch,
  })
  assert.equal(sawAbort, true, '这次中止确实发生了')
  assert.deepEqual(out.messages, [], '窗口到期应视为空轮询')
  assert.equal(out.cancelled, undefined, '这不是 dispose 中止，不能标成 cancelled')
  assert.equal(out.syncBuf, 'cursor', '游标必须保持原值，否则会重放消息')
})

test('a genuine transport failure still surfaces', async () => {
  // The normalisation above must not swallow real failures.
  resetTransportPreference()
  const failing = (() => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await assert.rejects(
    () => getUpdates({ baseUrl: 'http://127.0.0.1:1', token: 't', syncBuf: '', timeoutMs: 5_000, fetchImpl: failing }),
    /fetch failed/,
  )
})
