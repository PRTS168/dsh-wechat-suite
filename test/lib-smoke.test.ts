/**
 * The built output is what actually runs.
 *
 * Every other test imports `src/`, but the live bridge loads `lib/` — the profile
 * mounts this repo through a junction, and `lib/` is what the package ships. So a
 * stale, unloadable or half-built `lib/` could reach the running bridge with a
 * fully green test suite. This file closes that gap on three levels:
 *
 *   1. the compiled plugin entry loads and exports what the host mounts;
 *   2. the compiled transport still does a real round trip (the fixes that only
 *      exist in the built output would otherwise be untested);
 *   3. no source file is newer than its build, so nobody ships yesterday's code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = join(import.meta.dirname, '..')

test('the compiled plugin entry loads and exposes what the host mounts', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-chatnode-wechat')
  assert.deepEqual(mod.inject, ['sessions', 'agents', 'approval', 'credentials'])
  assert.equal(typeof mod.apply, 'function', 'apply 是宿主挂载插件时调用的入口')
  // schemastery schemas are callable: calling one validates the input and fills
  // defaults — exactly what the host does to a profile patch before mounting.
  assert.equal(typeof mod.Config, 'function', 'Config 必须是 schemastery schema')
  const parsed = mod.Config({ allowFrom: ['someone@im.wechat'] })
  assert.equal(parsed.allowFrom[0], 'someone@im.wechat')
  assert.equal(typeof parsed.digestIntervalSec, 'number', '默认值必须由编译产物填出来')
  // The host may mount either the named export or the default one.
  assert.equal(mod.default?.name, 'dsh-chatnode-wechat')
})

test('the compiled transport still does a real round trip', async (t) => {
  const { postJson } = await import('../lib/gateway/ilink-client.js')
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, echo: JSON.parse(body || '{}') }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo

  const out = await postJson<{ ret: number; echo: { text: string } }>({
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint: 'probe',
    payload: { text: '把灯开开吧' },
    token: 'smoke',
  })
  assert.equal(out.ret, 0)
  assert.equal(out.echo.text, '把灯开开吧', '编译产物必须能原样送出中文')
  const sent = requests.at(-1)!
  assert.equal(sent.headers['content-length'], String(Buffer.byteLength(sent.body)))
  assert.equal(sent.headers['content-length'] !== undefined, true, 'undici 会自己设置它')
})

test('no source file is newer than its build', () => {
  const srcDir = join(root, 'src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  walk(srcDir)
  assert.ok(files.length > 20, `src 下的源文件数量异常：${files.length}`)

  const stale: string[] = []
  const missing: string[] = []
  for (const file of files) {
    const rel = relative(srcDir, file).split(sep).join('/')
    const built = join(root, 'lib', rel.replace(/\.ts$/, '.js'))
    if (!existsSync(built)) {
      missing.push(rel)
      continue
    }
    // 2s tolerance: a checkout or a fast build can land in the same second.
    if (statSync(file).mtimeMs > statSync(built).mtimeMs + 2_000) stale.push(rel)
  }
  assert.deepEqual(missing, [], 'lib/ 里缺少这些源文件的编译产物（live 加载的就是 lib/）')
  assert.deepEqual(stale, [], '这些源文件比编译产物新：先跑 pnpm build 再谈发布')
})

test('the compiled node plane keeps the outbound guard', async () => {
  const { sanitizeAssistantText } = await import('../lib/node/outbound.js')
  const { text, echoed } = sanitizeAssistantText('好\n\nuser<<<微信用户消息>>>\n先放着')
  assert.equal(echoed, true)
  assert.doesNotMatch(text, /先放着/, '编译产物里也必须带着这条护栏')
})
