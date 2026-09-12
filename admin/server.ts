/**
 * wechat-admin — a STANDALONE management page for the WeChat bridge.
 *
 * Deliberately NOT a DSH plugin row. The previous in-plugin config API had to be
 * declared inside the profile's plugin tree, and when its optional `webServer`
 * dependency never appeared the loader failed the WHOLE profile
 * ("plugin tree failed to load: 1 entry did not activate"). This service runs as
 * its own process on its own port: it cannot affect profile boot, and stopping
 * it cannot affect the bridge.
 *
 * Responsibilities
 *   1. configuration — every key the bridge accepts, read/written through the
 *      bridge's OWN patch helpers (`src/node/patch-config.ts`), so the schema,
 *      the backup behaviour and the YAML rewriting rules cannot drift apart.
 *   2. conversations — the `wechat-*` sessions in this harness home, with
 *      title/turns/tokens from the projection cache and a transcript viewer.
 *   3. context schemes — named policies for how a WeChat conversation is
 *      rotated/handed over, switchable with one click (the bridge reads
 *      `contextPolicy` from its config).
 *
 * Safety
 *   - loopback bind only;
 *   - a token minted on first start (admin/.admin-token), required on every API
 *     call; mutations additionally require the guard header;
 *   - every write is backed up, then re-read and validated; a write that would
 *     leave the patch unparseable, or empty out `allowFrom`, is refused.
 *
 * Run:  node admin/server.ts [--port 8790]      (see admin/start-admin.bat)
 *
 * @module dsh-chatnode-wechat/admin
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_FIELDS,
  KNOWN_KEYS,
  maskSecret,
  readPatchFile,
  applyPatchConfig,
} from '../src/node/patch-config.ts'

// ---------------------------------------------------------------------------
// Paths and token
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN_FILE = join(HERE, '.admin-token')

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const PORT = Number(argValue('--port') ?? process.env.WECHAT_ADMIN_PORT ?? 8790)
const PROFILE = argValue('--profile') ?? process.env.WECHAT_ADMIN_PROFILE ?? 'web'
const PATCH = argValue('--patch') ?? join(dshHome(), 'profiles', PROFILE, 'cordis.patch.yml')

function token(): string {
  if (process.env.WECHAT_ADMIN_TOKEN) return process.env.WECHAT_ADMIN_TOKEN
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch { /* first run */ }
  const minted = randomBytes(24).toString('base64url')
  try {
    writeFileSync(TOKEN_FILE, minted, { mode: 0o600 })
  } catch { /* read-only dir: fall back to an ephemeral token */ }
  return minted
}

const TOKEN = token()
const GUARD = 'x-wechat-admin'

// ---------------------------------------------------------------------------
// Context schemes (the bridge reads `contextPolicy` from its own config)
// ---------------------------------------------------------------------------

interface SchemeKnobs {
  turns?: number
  pressureRatio?: number
  tokenBudget?: number
  idleHours?: number
  handoff?: boolean
  announce?: boolean
  idleOnly?: boolean
}

interface Scheme {
  id: string
  label: string
  summary: string
  knobs: SchemeKnobs
}

const SCHEMES: Scheme[] = [
  {
    id: 'manual',
    label: '手动（现状）',
    summary: '不自动轮换，完全靠 /new 与你自己的判断。会话会一直长下去——9-6 那个 60 轮的会话就是这么来的。',
    knobs: { idleOnly: true, announce: false },
  },
  {
    id: 'rotate-turns',
    label: '轮次轮换（建议）',
    summary: '每 N 轮结束、且没有进行中的任务时自动开新会话并播报。默认 20 轮。',
    knobs: { turns: 20, idleOnly: true, announce: true, handoff: false },
  },
  {
    id: 'rotate-turns+handoff',
    label: '轮次轮换 + 摘要接力',
    summary: '同上，但换会话前让旧会话产出一段要点交接，注入新会话，避免断片。多一次模型调用。',
    knobs: { turns: 20, idleOnly: true, announce: true, handoff: true },
  },
  {
    id: 'rotate-pressure',
    label: '上下文压力轮换',
    summary: '按 DSH 投影的上下文占用（默认 60% 窗口）触发轮换，比轮次更贴近真实风险。',
    knobs: { pressureRatio: 0.6, idleOnly: true, announce: true, handoff: true },
  },
  {
    id: 'rotate-tokens',
    label: '按 token 预算轮换（自由设置）',
    summary:
      '上下文达到你设定的 token 预算就换会话。优先读 DSH 会话投影里的**真实 token 数**' +
      '（contextPressure.surfaceTokens，回退到 contextBreakdown 求和）；读不到时按 2 字符/token 估算，' +
      '并在播报里注明是估算值。默认预算 120000，可随意改成你要的数。',
    knobs: { tokenBudget: 120_000, idleOnly: true, announce: true, handoff: true },
  },
  {
    id: 'daily',
    label: '按自然日分桶',
    summary: '每天第一条消息自动开新会话，天然分隔上下文；跨天记忆靠交接摘要。',
    knobs: { idleHours: 8, idleOnly: true, announce: true, handoff: true },
  },
]

async function currentScheme(): Promise<string> {
  const { patch } = await readPatchFile(PATCH)
  const raw = patch.values.contextPolicy
  if (!raw) return 'manual'
  try {
    const parsed = JSON.parse(raw) as { scheme?: string }
    return typeof parsed.scheme === 'string' && SCHEMES.some((s) => s.id === parsed.scheme) ? parsed.scheme : 'manual'
  } catch {
    return 'manual'
  }
}

// ---------------------------------------------------------------------------
// Conversations: wechat-* sessions in this harness home
// ---------------------------------------------------------------------------

/** zstd frames are appended per flush, so one file holds many frames. */
function readZstdFrames(path: string): string {
  const buf = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(magic, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  if (offsets.length === 0) {
    try { return zstdDecompressSync(buf).toString('utf8') } catch { return '' }
  }
  const parts: Buffer[] = []
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1]! : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k]!, end))) } catch { /* skip a torn frame */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

function projectionFor(sessionId: string): Record<string, unknown> | undefined {
  const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { record?: { rows?: Record<string, { val?: unknown }> } }
    return doc.record?.rows as Record<string, unknown> | undefined
  } catch {
    return undefined
  }
}

interface Conversation {
  id: string
  cwd: string
  title: string | null
  turns: number
  outputTokens: number
  bytes: number
  lastActivity: string
  transcriptPath: string
}

function listConversations(): Conversation[] {
  const root = join(dshHome(), 'sessions')
  const out: Conversation[] = []
  let dirs: string[] = []
  try { dirs = readdirSync(root) } catch { return out }
  for (const cwdDir of dirs) {
    const cwdPath = join(root, cwdDir)
    let sessions: string[] = []
    try { sessions = readdirSync(cwdPath) } catch { continue }
    for (const id of sessions) {
      if (!id.startsWith('wechat-')) continue
      const dir = join(cwdPath, id)
      const candidates = ['session.jsonl.zstd', 'session.v3.jsonl.zstd']
      const file = candidates.map((n) => join(dir, n)).find((p) => existsSync(p))
      if (!file) continue
      const rows = projectionFor(id)
      const stats = (rows?.sessionStats as { val?: { turns?: number } } | undefined)?.val
      const tokens = (rows?.tokenUsage as { val?: { totals?: { outputTokens?: number } } } | undefined)?.val
      const title = (rows?.title as { val?: unknown } | undefined)?.val
      let cwd = ''
      try {
        const first = readZstdFrames(file).split('\n')[0]
        cwd = String((JSON.parse(first!) as { cwd?: string }).cwd ?? '')
      } catch { /* header unreadable */ }
      out.push({
        id,
        cwd,
        title: typeof title === 'string' ? title : null,
        turns: Number(stats?.turns ?? 0),
        outputTokens: Number(tokens?.totals?.outputTokens ?? 0),
        bytes: statSync(file).size,
        lastActivity: statSync(file).mtime.toISOString(),
        transcriptPath: file,
      })
    }
  }
  return out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
}

function transcript(id: string, limit: number): { role: string; text: string }[] {
  const found = listConversations().find((c) => c.id === id)
  if (!found) return []
  const lines = readZstdFrames(found.transcriptPath).split('\n').filter(Boolean)
  const messages: { role: string; text: string }[] = []
  for (const line of lines) {
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    const kind = String(event.type ?? '')
    if (kind !== 'user/message' && kind !== 'assistant/message') continue
    const content = event.data?.message?.content ?? event.data?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : block?.type === 'reasoning' ? '' : ''))
        .filter(Boolean)
        .join('\n')
    }
    if (!text.trim()) continue
    messages.push({ role: kind === 'user/message' ? 'user' : 'assistant', text })
  }
  return messages.slice(-limit)
}

// ---------------------------------------------------------------------------
// Environment self-check (what the bridge will see at its next start)
// ---------------------------------------------------------------------------

async function environment(): Promise<Record<string, unknown>> {
  const { exists, patch } = await readPatchFile(PATCH)
  const presetDir = join(dshHome(), '.agent-presets', patch.values.agentPreset || 'wechat')
  let credentials = ''
  try { credentials = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8') } catch { /* none */ }
  return {
    dshHome: dshHome(),
    profile: PROFILE,
    patchFile: PATCH,
    patchExists: exists,
    preset: patch.values.agentPreset || 'wechat',
    presetExists: existsSync(join(presetDir, 'agent.cordis.yml')),
    weixinCredentials: /WEIXIN_BOT_TOKEN/.test(credentials),
    siliconflowCredential: /GJLD_API_KEY/.test(credentials),
    allowFrom: patch.allowFrom,
  }
}

// ---------------------------------------------------------------------------
// Control queue (the executing half lives in src/node/admin-control.ts)
// ---------------------------------------------------------------------------

function queueDir(): string {
  return join(dshHome(), 'wechat-admin', 'queue')
}

function doneDir(): string {
  return join(dshHome(), 'wechat-admin', 'done')
}

function trashDir(): string {
  return join(dshHome(), 'sessions-trash')
}

/** Drop one command for the bridge to execute on its next poll (≤2s). */
function enqueue(command: Record<string, unknown>): string {
  mkdirSync(queueDir(), { recursive: true })
  const name = `${Date.now()}-${randomBytes(3).toString('hex')}.json`
  writeFileSync(join(queueDir(), name), JSON.stringify(command, null, 2))
  return name
}

/** Recent command outcomes, newest first. */
function recentReports(limit = 10): unknown[] {
  try {
    return readdirSync(doneDir())
      .filter((name) => name.endsWith('.result.json'))
      .sort()
      .slice(-limit)
      .reverse()
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(doneDir(), name), 'utf8')) as unknown
        } catch {
          return { file: name, unparsable: true }
        }
      })
  } catch {
    return []
  }
}

/**
 * Move one WeChat session ASIDE rather than deleting it.
 *
 * The session directory keeps the only copy of that conversation, so this is a
 * reversible `renameSync` into `$DSH_HOME/sessions-trash/<stamp>-<id>/` (the
 * projection cache goes with it, otherwise the GUI list would re-materialize the
 * session). The caller also queues `forget-session` so the host stops pointing
 * at it — otherwise the next inbound message would route into a session whose
 * log no longer exists.
 */
function trashSession(sessionId: string): { ok: boolean; detail: string; trash?: string; alreadyGone?: boolean } {
  if (!sessionId.startsWith('wechat-')) return { ok: false, detail: '只允许操作微信会话（wechat- 前缀）' }
  const sessionsRoot = join(dshHome(), 'sessions')
  let found: string | undefined
  try {
    for (const cwdDir of readdirSync(sessionsRoot)) {
      const candidate = join(sessionsRoot, cwdDir, sessionId)
      if (existsSync(candidate)) {
        found = candidate
        break
      }
    }
  } catch {
    // no sessions directory at all
  }
  const projection = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (!found) {
    if (existsSync(projection)) {
      // Nothing on disk but a stale projection: clean that up too.
      try {
        rmSync(projection, { force: true })
        return { ok: true, detail: '会话文件已不存在，已清理残留投影', alreadyGone: true }
      } catch (error) {
        return { ok: false, detail: `清理投影失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    return { ok: false, detail: `找不到会话：${sessionId}` }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(trashDir(), `${stamp}-${sessionId}`)
  try {
    mkdirSync(trashDir(), { recursive: true })
    renameSync(found, target)
  } catch (error) {
    return { ok: false, detail: `移动失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    if (existsSync(projection)) renameSync(projection, join(target, 'projection.json'))
  } catch {
    // best effort: a leftover projection only affects the GUI's session list
  }
  return { ok: true, detail: '已移入回收站（可手动恢复）', trash: target }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 256 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function authorized(req: IncomingMessage, url: URL, mutating: boolean): boolean {
  if (url.searchParams.get('token') === TOKEN) return true
  if (req.headers['x-admin-token'] === TOKEN) return true
  if (mutating && req.headers[GUARD] !== '1') return false
  return false
}

const PAGE = readFileSync(join(HERE, 'index.html'), 'utf8')

/**
 * The page with this run's token already embedded.
 *
 * Convenience: `http://127.0.0.1:8790/` alone opens the console. The bind is
 * loopback-only AND the Host header must be a loopback authority, so a
 * DNS-rebinding page (an attacker domain resolving to 127.0.0.1) is refused —
 * and every `/api/*` route still demands the token, which a cross-origin page
 * cannot read anyway. Anyone who could abuse this can already read the files.
 */
function pageWithToken(): string {
  return PAGE.replace('__ADMIN_TOKEN__', TOKEN)
}

/** Whether the request addressed a loopback authority (rebinding fence). */
function loopbackHost(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const mutating = req.method === 'POST'

    if (url.pathname === '/' && !mutating) {
      const viaToken = url.searchParams.get('token') === TOKEN
      if (!viaToken && !loopbackHost(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('unauthorized: open http://127.0.0.1:<port>/ on this machine')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pageWithToken())
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` })
      return
    }
    if (!authorized(req, url, mutating)) {
      json(res, 403, { ok: false, error: 'forbidden' })
      return
    }

    try {
      if (url.pathname === '/api/state' && !mutating) {
        const { patch } = await readPatchFile(PATCH)
        json(res, 200, {
          ok: true,
          environment: await environment(),
          fields: CONFIG_FIELDS,
          values: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, maskSecret(patch.values[f.key] ?? '')])),
          plainValues: Object.fromEntries(CONFIG_FIELDS.filter((f) => !f.secret).map((f) => [f.key, patch.values[f.key] ?? ''])),
          schemes: SCHEMES,
          activeScheme: await currentScheme(),
          conversations: listConversations().slice(0, 50),
        })
        return
      }

      if (url.pathname === '/api/config' && mutating) {
        const body = (await readBody(req)) as { updates?: Record<string, string | null> }
        const updates = body.updates ?? {}
        // A no-op save must not rewrite the patch: this profile runs with
        // `patchReload: live`, so every rewrite is a live plugin reload, and the
        // 2026-09-12 crash was triggered by exactly that (three quick saves).
        if (Object.keys(updates).length === 0) {
          json(res, 200, { ok: true, changed: [], backup: null, note: 'no updates: patch left untouched' })
          return
        }
        for (const key of Object.keys(updates)) {
          if (!KNOWN_KEYS.has(key)) {
            json(res, 400, { ok: false, error: `unknown key: ${key}` })
            return
          }
        }
        const before = await readPatchFile(PATCH)
        const result = await applyPatchConfig(PATCH, updates)
        const after = await readPatchFile(PATCH)
        // Refuse a state the bridge cannot boot from: the node throws on an
        // empty allowlist, and the profile then fails to load entirely.
        if (after.patch.allowFrom.length === 0) {
          writeFileSync(PATCH, readFileSync(result.backup, 'utf8'))
          json(res, 400, { ok: false, error: 'refused: allowFrom would end up empty (the bridge would not mount); rolled back' })
          return
        }
        json(res, 200, { ok: true, changed: result.changed, backup: result.backup, allowFrom: after.patch.allowFrom, before: before.patch.values })
        return
      }

      if (url.pathname === '/api/reveal' && !mutating) {
        const key = url.searchParams.get('key') ?? ''
        if (!KNOWN_KEYS.has(key) || !CONFIG_FIELDS.find((f) => f.key === key)?.secret) {
          json(res, 400, { ok: false, error: 'not a secret field' })
          return
        }
        const { patch } = await readPatchFile(PATCH)
        json(res, 200, { ok: true, key, value: patch.values[key] ?? '' })
        return
      }

      if (url.pathname === '/api/scheme' && mutating) {
        const body = (await readBody(req)) as { scheme?: string; overrides?: SchemeKnobs }
        const scheme = SCHEMES.find((s) => s.id === body.scheme)
        if (!scheme) {
          json(res, 400, { ok: false, error: `unknown scheme: ${String(body.scheme)}` })
          return
        }
        const policy = { scheme: scheme.id, ...scheme.knobs, ...(body.overrides ?? {}) }
        const result = await applyPatchConfig(PATCH, { contextPolicy: JSON.stringify(policy) })
        json(res, 200, { ok: true, policy, backup: result.backup })
        return
      }

      if (url.pathname === '/api/conversations' && !mutating) {
        json(res, 200, { ok: true, conversations: listConversations() })
        return      }

      if (url.pathname === '/api/transcript' && !mutating) {
        const id = url.searchParams.get('id') ?? ''
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, 400)
        json(res, 200, { ok: true, id, messages: transcript(id, limit) })
        return
      }

      // ── session control: the host executes, this process only queues ───────
      if (url.pathname === '/api/session/new' && mutating) {
        const body = (await readBody(req)) as { prompt?: string; announce?: boolean }
        const name = enqueue({
          op: 'new-session',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          announce: body.announce !== false,
        })
        json(res, 202, { ok: true, queued: name, note: '桥会在下一次轮询（≤2 秒）执行，稍后刷新会话列表' })
        return
      }

      if (url.pathname === '/api/session/forget' && mutating) {
        const body = (await readBody(req)) as { sessionId?: string }
        const sessionId = String(body.sessionId ?? '')
        const moved = trashSession(sessionId)
        if (!moved.ok) {
          json(res, 400, { ok: false, error: moved.detail })
          return
        }
        const name = enqueue({ op: 'forget-session', sessionId })
        json(res, 200, { ok: true, queued: name, trash: moved.trash, detail: moved.detail })
        return
      }

      if (url.pathname === '/api/session/box' && !mutating) {
        json(res, 200, { ok: true, reports: recentReports(10) })
        return
      }

      json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` })
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  const fingerprint = createHash('sha256').update(PATCH).digest('hex').slice(0, 8)
  console.log(`wechat-admin  http://127.0.0.1:${PORT}/`)
  console.log(`  token url http://127.0.0.1:${PORT}/?token=${TOKEN}`)
  console.log(`  profile   ${PROFILE}   (patch ${fingerprint})`)
  console.log(`  patch     ${PATCH}`)
  console.log(`  dsh home  ${dshHome()}`)
})
