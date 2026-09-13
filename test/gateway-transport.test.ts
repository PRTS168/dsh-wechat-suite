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
