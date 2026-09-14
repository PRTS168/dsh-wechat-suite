/**
 * 管理台的安全回归测试。
 *
 * 背景（2026-09-15 审查，真实复现过）：管理台加了 `?platform=` 之后，
 * `patchFor()` 会把**请求里传来的名字**直接拼成文件路径，而当时写好的
 * `validPlatform()` 白名单从未被调用。后果：
 *
 *   GET /api/state?platform=DECOY      → 读到不在托管列表里的 profile 配置
 *   GET /api/state?platform=..         → 路径穿越，读 profiles/ 之外的文件
 *   POST /api/config  (platform 在 body 里) → 同一路径可被写入
 *
 * 这个文件把三条路都钉死：未知 platform 必须是 4xx，且**文件内容不得外泄**。
 * 它同时覆盖"合法请求仍然正常"，免得修复把功能一起关掉。
 *
 * 这里走的是**真进程 + 真 HTTP**：函数级单测证明不了"参数在到达路径拼接前就被拦住"，
 * 而那正是这个缺陷的全部内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADMIN = join(HERE, '..', 'admin', 'server.ts')

/** A home with two served profiles plus a decoy the console must not reveal. */
function makeHome(): { home: string; token: string; secret: string } {
  const home = mkdtempSync(join(tmpdir(), 'admin-guard-'))
  for (const p of ['wechat', 'qq', 'DECOY']) {
    mkdirSync(join(home, 'profiles', p), { recursive: true })
  }
  const w = (p: string, yml: string) => writeFileSync(join(home, 'profiles', p, 'cordis.patch.yml'), yml, 'utf8')
  w('wechat', '- id: dsh-chatnode-wechat\n  config:\n    platform: wechat\n    allowFrom:\n      - "SERVED-WECHAT"\n')
  w('qq', '- id: dsh-chatnode-wechat\n  config:\n    platform: qq\n    allowFrom:\n      - "SERVED-QQ"\n')
  // 不在 --profiles 里：任何正确实现都不该把它的内容交出去
  w('DECOY', '- id: dsh-chatnode-wechat\n  config:\n    platform: qq\n    allowFrom:\n      - "DECOY-SECRET"\n')
  // profiles/ 之外，用来测穿越：<home>/outside/cordis.patch.yml
  mkdirSync(join(home, 'outside'), { recursive: true })
  writeFileSync(join(home, 'outside', 'cordis.patch.yml'), '- id: dsh-chatnode-wechat\n  config:\n    allowFrom:\n      - "OUTSIDE-SECRET"\n', 'utf8')
  return { home, token: 't'.repeat(32), secret: 'DECOY-SECRET' }
}

/** Start the console on a free port, wait for it to listen, and hand back a fetcher. */
async function startConsole(home: string, token: string) {
  // `--port 0`: the OS picks a free port. Hardcoding one made this test collide
  // with the console the owner is actually running.
  const child = spawn(process.execPath, [ADMIN, '--profiles', 'wechat,qq', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, WECHAT_ADMIN_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('管理台没在 15 秒内监听：' + out)), 15_000)
    const look = () => {
      const m = /bridge-admin\s+http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    }
    child.stdout.on('data', (chunk) => { out += String(chunk); look() })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`管理台提前退出 (${code})：${out}`)) })
  })
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'x-admin-token': token, 'x-wechat-admin': '1', 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = await res.text()
    return { status: res.status, body }
  }
  return { call, stop: () => { child.kill('SIGKILL') } }
}

test('未知 platform 一律 4xx，且不泄露其它 profile 的内容', async () => {
  const { home, token, secret } = makeHome()
  const console_ = await startConsole(home, token)
  try {
    for (const asked of ['DECOY', '..', '../..', '..\\..', '../../wechat', '....//wechat', '%2e%2e%2f%2e%2e']) {
      const res = await console_.call(`/api/state?platform=${asked}&token=${token}`)
      assert.ok(res.status >= 400 && res.status < 500, `platform=${asked} 应当是 4xx，实际 ${res.status}`)
      assert.ok(!res.body.includes(secret), `platform=${asked} 泄漏了 DECOY 的内容`)
      assert.ok(!res.body.includes('OUTSIDE-SECRET'), `platform=${asked} 穿越读取了 profiles/ 之外的文件`)
    }
  } finally {
    console_.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('合法 platform 仍然正常：默认 profile 与被服务的 profile 都读得到', async () => {
  const { home, token } = makeHome()
  const console_ = await startConsole(home, token)
  try {
    const fallback = await console_.call(`/api/state?token=${token}`)
    assert.equal(fallback.status, 200, '不带 platform 时应当回落到主 profile')
    assert.ok(fallback.body.includes('SERVED-WECHAT'))

    const qq = await console_.call(`/api/state?platform=qq&token=${token}`)
    assert.equal(qq.status, 200)
    assert.ok(qq.body.includes('SERVED-QQ'))

    const list = await console_.call(`/api/platforms?token=${token}`)
    assert.equal(list.status, 200)
    const parsed = JSON.parse(list.body)
    assert.deepEqual(parsed.platforms.map((p: { id: string }) => p.id), ['wechat', 'qq'])
  } finally {
    console_.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('写接口同样拦：带穿越 platform 的保存不得改动任何文件', async () => {
  const { home, token } = makeHome()
  const console_ = await startConsole(home, token)
  const outside = join(home, 'outside', 'cordis.patch.yml')
  const before = readFileSync(outside, 'utf8')
  try {
    const res = await console_.call(`/api/config?platform=${encodeURIComponent('../outside')}&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ updates: { agentModel: 'PWNED' } }),
    })
    assert.ok(res.status >= 400 && res.status < 500, `写入穿越应当 4xx，实际 ${res.status}`)
    assert.equal(readFileSync(outside, 'utf8'), before, 'profiles/ 之外的文件被改动了')
  } finally {
    console_.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('启动参数里的非法 profile 名直接拒绝启动', async () => {
  const home = mkdtempSync(join(tmpdir(), 'admin-guard-bad-'))
  const child = spawn(process.execPath, [ADMIN, '--profiles', '../evil', '--port', '8899'], {
    env: { ...process.env, DSH_HOME: home, WECHAT_ADMIN_TOKEN: 't'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { out += String(c) })
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
  rmSync(home, { recursive: true, force: true })
  assert.equal(code, 2, `非法 profile 名应当以退出码 2 拒绝，实际 ${code}；输出：${out}`)
})
