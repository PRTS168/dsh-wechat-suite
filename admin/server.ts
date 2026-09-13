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
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_FIELDS,
  KNOWN_KEYS,
  maskSecret,
  parsePatch,
  readPatchFile,
  applyPatchConfig,
} from '../src/node/patch-config.ts'
import { pruneBackups } from '../src/node/memory.ts'

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
      // The bridge rotates and deletes sessions while this runs: a file that
      // vanished between the exists check and statSync used to throw out of
      // `/api/state` entirely, leaving a blank first screen.
      let bytes = 0
      let lastActivity = new Date().toISOString()
      try {
        const stat = statSync(file)
        bytes = stat.size
        lastActivity = stat.mtime.toISOString()
      } catch {
        continue
      }
      out.push({
        id,
        cwd,
        title: typeof title === 'string' ? title : null,
        turns: Number(stats?.turns ?? 0),
        outputTokens: Number(tokens?.totals?.outputTokens ?? 0),
        bytes,
        lastActivity,
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
    // Name-agnostic on purpose: the credential file belongs to the operator and
    // its key names differ per setup. A SiliconFlow key is recognised by either a
    // siliconflow-ish name or the `sk-` value shape, so the console tells the
    // truth without hard-coding one operator's alias into a public package.
    siliconflowCredential: /siliconflow/i.test(credentials) || /\bsk-[A-Za-z0-9_-]{16,}/.test(credentials),
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
  const tokenOk = url.searchParams.get('token') === TOKEN || req.headers['x-admin-token'] === TOKEN
  if (!tokenOk) return false
  // Every mutation additionally carries this header. It used to be unreachable
  // (both token branches returned first), so the second factor the page relies
  // on — a header a cross-origin form cannot set without a CORS preflight —
  // was decorative.
  if (mutating && req.headers[GUARD] !== '1') return false
  return true
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

// ---------------------------------------------------------------------------
// Diagnostics: what the bridge recorded, shown where a human can see it
// ---------------------------------------------------------------------------

/** `$DSH_HOME/wechat-problems.log` — every failure the bridge swallowed. */
function problemLogFile(): string {
  // The bridge reads problemFile from config, so a configured path must win over
  // the default here too: otherwise the console reports an empty log forever.
  return configuredPath('problemFile', join(dshHome(), 'wechat-problems.log'))
}

/** `$DSH_HOME/wechat-memory/MEMORY.md` — the long-term facts file. */
function memoryFile(): string {
  return configuredPath('memoryFile', join(dshHome(), 'wechat-memory', 'MEMORY.md'))
}

/**
 * One configured path, falling back to the bridge's default.
 *
 * `memoryFile` and `problemFile` are ordinary editable keys, and the bridge
 * reads them from config. Hard-coding the defaults here meant that the moment
 * an operator set either one, the console pointed at an empty file and
 * cheerfully reported "no problems" / "no memories yet".
 */
function configuredPath(key: string, fallback: string): string {
  try {
    const parsed = parsePatch(readFileSync(PATCH, 'utf8'))
    const value = parsed.current[key]?.value
    if (typeof value !== 'string' || !value.trim()) return fallback
    // `$DSH_HOME/...` is the documented placeholder form; expand it.
    return value.trim().replace(/^\$DSH_HOME[\\/]/, `${dshHome()}/`).replace(/\\/g, '/')
  } catch {
    return fallback
  }
}

/** Last `limit` non-empty lines of a text file (best effort, never throws). */
function tailLines(file: string, limit: number): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).slice(-limit)
  } catch {
    return []
  }
}

/** How many facts a MEMORY.md holds (headings and comments do not count). */
function memoryFactCount(text: string): number {
  let count = 0
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
      continue
    }
    if (section && section !== '已过期' && /^[-*]\s+\S/.test(line)) count += 1
  }
  return count
}

/**
 * Models the host actually offers, read from `$DSH_HOME/settings.yaml`.
 *
 * Declaring `models` in that file REPLACES the adapter's built-in catalog, so
 * this list is the complete set of routes on the native DeepSeek provider — the
 * one the bridge is configured against by default. Third-party relay providers
 * are exported too, but only as names: their route ids are the adapter's
 * business, and offering a guessed id would let a beginner save a route that
 * cannot resolve.
 */
function readModelCatalog(): { provider: string; models: string[]; relays: string[]; note: string } {
  let text = ''
  try {
    text = readFileSync(join(dshHome(), 'settings.yaml'), 'utf8')
  } catch {
    // No settings file: an empty catalog is the truth.
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const indentOf = (line: string): number => (/^(\s*)/.exec(line)?.[1] ?? '').length

  /** Index of the first line matching `re`, or -1. */
  const findLine = (re: RegExp, from = 0): number => {
    for (let i = from; i < lines.length; i += 1) if (re.test(lines[i]!)) return i
    return -1
  }

  /**
   * The `models:` list inside one top-level block, at exact nesting depth.
   *
   * A naive "collect every `- id:` after a `models:` line" run mixes the
   * relay providers' catalogs into the native route, and picking one of those
   * from the dropdown would save a route that cannot resolve.
   */
  const modelsIn = (blockName: string): string[] => {
    const start = findLine(new RegExp(`^${blockName}:\\s*$`))
    if (start < 0) return []
    const blockIndent = indentOf(lines[start]!)
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '') continue
      if (indentOf(lines[i]!) <= blockIndent) { end = i; break }
    }
    const modelsAt = findLine(/^\s+models:\s*$/, start)
    if (modelsAt < 0 || modelsAt >= end) return []
    const listIndent = indentOf(lines[modelsAt]!)
    const found: string[] = []
    for (let i = modelsAt + 1; i < end; i += 1) {
      const line = lines[i]!
      if (line.trim() === '') continue
      if (indentOf(line) <= listIndent) break
      const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
      if (m?.[1]) found.push(m[1])
    }
    return found
  }

  const models = modelsIn('llm-deepseek')

  // Relay names are informational: their route ids are the adapter's business.
  const relays: string[] = []
  const relaysAt = findLine(/^llm-pi-ai:\s*$/)
  if (relaysAt >= 0) {
    const providersAt = findLine(/^\s+providers:\s*$/, relaysAt)
    if (providersAt >= 0) {
      const pIndent = indentOf(lines[providersAt]!)
      // Only the provider KEYS themselves: each relay repeats a nested
      // `models:` key, and a looser match collects those as provider names.
      let keyIndent = -1
      for (let i = providersAt + 1; i < lines.length; i += 1) {
        const line = lines[i]!
        if (line.trim() === '') continue
        const indent = indentOf(line)
        if (indent <= pIndent) break
        const m = /^\s*([A-Za-z0-9_.-]+):\s*$/.exec(line)
        if (!m?.[1]) continue
        if (keyIndent < 0) keyIndent = indent
        if (indent !== keyIndent) continue
        if (m[1] === 'models') continue
        relays.push(m[1])
      }
    }
  }

  return {
    provider: 'deepseek-official',
    models,
    relays,
    note: models.length > 0 ? '来自 settings.yaml 的 llm-deepseek.models（它替换内置目录，所以这就是全部可用路由）' : '',
  }
}

function readCorpusSafe(ids: readonly string[]): { found: string[]; text: string } {
  let text = ''
  try {
    text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  } catch {
    // No credential file: nothing found is the truth.
    return { found: [], text: '' }
  }
  return { found: ids.filter((id) => text.includes(id)), text }
}

interface HealthCheck {
  id: string
  label: string
  state: 'ok' | 'warn' | 'bad'
  detail: string
  fix?: string
}

/**
 * A one-glance answer to "is this thing actually working?".
 *
 * The checks are ordered by what stops the bridge from working at all, and each
 * failure carries the plain-language fix, because knowing that `allowFrom` is
 * empty is useless without knowing where to type the WeChat id.
 */
async function health(): Promise<{ ok: boolean; summary: string; checks: HealthCheck[] }> {
  const { exists, patch, unreadable } = await readPatchFile(PATCH)
  const allowFrom = patch.allowFrom
  const preset = patch.values.agentPreset || 'wechat'
  const presetFile = join(dshHome(), '.agent-presets', preset, 'agent.cordis.yml')
  const credentials = readCorpusSafe(['WEIXIN_BOT_TOKEN', 'WEIXIN_BOT_ID', 'WEIXIN_ACCOUNT_ID'])
  const problems = tailLines(problemLogFile(), 400)
  // The ledger writes a second line when it told the owner about a problem
  // ("已告知主人：…"). Counting those doubles every number and can surface a
  // notice as if it were the failure itself.
  const failures = problems.filter((line) => !line.includes('已告知主人'))
  const recent = failures.filter((line) => {
    const at = Date.parse(line.slice(0, 24))
    return Number.isFinite(at) && Date.now() - at < 24 * 60 * 60 * 1000
  })
  const memory = readMemoryText()

  const checks: HealthCheck[] = []
  checks.push({
    id: 'patch',
    label: '配置文件',
    state: unreadable ? 'bad' : exists ? 'ok' : 'warn',
    detail: unreadable ? `读不出来：${unreadable}` : exists ? PATCH : '还没有这个文件（第一次保存时会创建）',
    ...(unreadable ? { fix: '检查文件权限；读不出来时保存会被拒绝，以免覆盖其它配置' } : {}),
  })
  checks.push({
    id: 'allowFrom',
    label: '谁能让它说话',
    state: allowFrom.length > 0 ? 'ok' : 'bad',
    detail: allowFrom.length > 0 ? allowFrom.join('、') : '白名单是空的',
    ...(allowFrom.length > 0 ? {} : { fix: '填上你自己的微信 ID（在下面的“谁能让它说话”里）' }),
  })
  checks.push({
    id: 'preset',
    label: '它的人设',
    state: existsSync(presetFile) ? 'ok' : 'bad',
    detail: existsSync(presetFile) ? `${preset} · 已就位` : `${preset} · 找不到这个 preset`,
    ...(existsSync(presetFile) ? {} : { fix: `确认 $DSH_HOME/.agent-presets/${preset}/agent.cordis.yml 存在` }),
  })
  checks.push({
    id: 'weixin',
    label: '微信登录凭据',
    state: credentials.found.includes('WEIXIN_BOT_TOKEN') ? 'ok' : 'warn',
    detail: credentials.found.length > 0 ? `找到了 ${credentials.found.join('、')}` : '凭据库里没找到 WEIXIN_*',
    ...(credentials.found.includes('WEIXIN_BOT_TOKEN') ? {} : { fix: '桥首次登录后会把 token 写进 .credentials.yaml；没有它桥不会开始收消息' }),
  })
  const hasMediaKey = /siliconflow/i.test(credentials.text) || /\bsk-[A-Za-z0-9_-]{16,}/.test(credentials.text)
  checks.push({
    id: 'siliconflow',
    label: '图片/语音的模型 Key',
    state: hasMediaKey ? 'ok' : 'warn',
    // One boolean drives both the state and the sentence: computing them from
    // different tests produced a green check whose text said "not configured".
    detail: hasMediaKey ? '已找到可用的媒体模型 Key' : '没配——只发文字聊天可以不管',
    ...(hasMediaKey ? {} : { fix: '要它看图/听语音/画图，就在下面的「媒体模型」里填一个 Key' }),
  })
  checks.push({
    id: 'memory',
    label: '长期记忆',
    state: memory.exists ? 'ok' : 'warn',
    detail: memory.exists ? `已记录 ${memory.facts} 条事实` : '还没有记忆文件（聊几天就有了）',
  })
  checks.push({
    id: 'problems',
    label: '最近 24 小时的问题',
    state: recent.length === 0 ? 'ok' : 'warn',
    detail: recent.length === 0
      ? (problems.length === 0 ? '没有问题日志，也没有记录到问题' : '日志里没有最近 24 小时的条目')
      : `${recent.length} 条，最新一条：${recent[recent.length - 1]!.slice(11, 60)}`,
    ...(recent.length > 0 ? { fix: '在“诊断”页看完整日志' } : {}),
  })
  // A model that cannot resolve is the one failure the owner experiences as
  // "it stopped answering", and nothing above would have caught it.
  const model = patch.values.agentModel ?? ''
  const catalog = readModelCatalog()
  const modelKnown = !model || catalog.models.length === 0 || catalog.models.includes(model)
  checks.push({
    id: 'model',
    label: '聊天模型',
    state: modelKnown ? 'ok' : 'bad',
    detail: model
      ? `${model}${modelKnown ? '' : ' · settings.yaml 的模型列表里没有它'}`
      : '没有配置模型（会用 DSH 的默认路由）',
    ...(modelKnown ? {} : { fix: `改成列表里的一个：${catalog.models.join('、')}` }),
  })

  const bad = checks.filter((c) => c.state === 'bad')
  const summary = bad.length === 0 ? '一切就绪' : `还有 ${bad.length} 项必须先处理：${bad.map((c) => c.label).join('、')}`
  return { ok: bad.length === 0, summary, checks }
}

function readMemoryText(): { exists: boolean; text: string; facts: number; file: string } {
  const file = memoryFile()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { exists: false, text: '', facts: 0, file }
  }
  return { exists: true, text, facts: memoryFactCount(text), file }
}

/** Patch backups, newest first (the admin page keeps only the last few). */
function listBackups(): Array<{ name: string; path: string; at: string; bytes: number }> {
  const dir = dirname(PATCH)
  const prefix = `${basename(PATCH)}.bak-`
  try {
    const rows: Array<{ name: string; path: string; at: string; bytes: number }> = []
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue
      try {
        const path = join(dir, name)
        const stat = statSync(path)
        if (!stat.isFile()) continue
        rows.push({ name, path, at: stat.mtime.toISOString(), bytes: stat.size })
      } catch {
        // One unreadable entry must not hide every other backup.
      }
    }
    // Newest first by TIME: backup names mix several schemes (epoch, date,
    // "before-*"), so name order is not time order.
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  } catch {
    return []
  }
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
      if (url.pathname === '/api/health' && !mutating) {
        json(res, 200, { ok: true, ...(await health()) })
        return
      }

      if (url.pathname === '/api/problems' && !mutating) {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
        const lines = tailLines(problemLogFile(), limit)
        json(res, 200, {
          ok: true,
          file: problemLogFile(),
          exists: lines.length > 0 || existsSync(problemLogFile()),
          lines,
          rotated: existsSync(`${problemLogFile()}.1`),
        })
        return
      }

      if (url.pathname === '/api/memory' && !mutating) {
        const memory = readMemoryText()
        json(res, 200, { ok: true, ...memory })
        return
      }

      if (url.pathname === '/api/models' && !mutating) {
        const catalog = readModelCatalog()
        const { patch } = await readPatchFile(PATCH)
        json(res, 200, {
          ok: true,
          ...catalog,
          current: { provider: patch.values.agentProvider || catalog.provider, model: patch.values.agentModel || '' },
        })
        return
      }

      if (url.pathname === '/api/backups' && !mutating) {
        json(res, 200, { ok: true, file: PATCH, backups: listBackups().slice(0, 20) })
        return
      }

      if (url.pathname === '/api/rollback' && mutating) {
        const body = (await readBody(req)) as { name?: string }
        const name = String(body.name ?? '')
        const target = listBackups().find((entry) => entry.name === name)
        if (!target) {
          json(res, 400, { ok: false, error: `找不到这个备份：${name}` })
          return
        }
        const content = readFileSync(target.path, 'utf8')
        const parsedBackup = parsePatch(content)
        if (parsedBackup.found && (parsedBackup.current.allowFrom?.list ?? []).length === 0) {
          // Restoring this would leave a bridge that refuses to mount.
          json(res, 400, { ok: false, error: '拒绝：这个备份里的白名单是空的（恢复后桥起不来）' })
          return
        }        // Keep the current state recoverable before overwriting it.
        const safety = `${PATCH}.bak-${Date.now()}`
        try {
          copyFileSync(PATCH, safety)
        } catch (error) {
          json(res, 500, { ok: false, error: `回滚前没能备份当前配置：${error instanceof Error ? error.message : String(error)}` })
          return
        }
        writeFileSync(PATCH, content, 'utf8')
        pruneBackups(PATCH, 5)
        json(res, 200, { ok: true, restored: name, safety: basename(safety) })
        return
      }

      if (url.pathname === '/api/state' && !mutating) {
        const { patch, unreadable } = await readPatchFile(PATCH)
        json(res, 200, {
          ok: true,
          environment: await environment(),
          fields: CONFIG_FIELDS,
          values: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, maskSecret(patch.values[f.key] ?? '')])),
          plainValues: {
            ...Object.fromEntries(CONFIG_FIELDS.filter((f) => !f.secret).map((f) => [f.key, patch.values[f.key] ?? ''])),
            // allowFrom lives in its own list, not in `values`: without this the
            // console rendered an EMPTY whitelist for a bridge that has one, and
            // reading it as "not configured" is exactly the wrong conclusion.
            allowFrom: patch.allowFrom.join('\n'),
          },
          // Present when the patch exists but could not be read: the page must
          // say so instead of showing an empty config that is not the truth.
          ...(unreadable ? { unreadable } : {}),
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
        let result
        try {
          result = await applyPatchConfig(PATCH, updates)
        } catch (error) {
          // A rejected value is the caller's mistake, not a server fault. This
          // guard exists because a bad number written into the patch makes the
          // plugin's schema reject the whole profile at load.
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        const after = await readPatchFile(PATCH)
        // Refuse a state the bridge cannot boot from: the node throws on an
        // empty allowlist, and the profile then fails to load entirely.
        if (after.patch.allowFrom.length === 0) {
          // If the file did not exist before this call there is no backup to go
          // back to, so undoing means removing what we just created — reading
          // `result.backup` blindly threw a TypeError instead and left the
          // profile sitting at `allowFrom: []`.
          if (result.backup) writeFileSync(PATCH, readFileSync(result.backup, 'utf8'))
          else if (!before.exists) rmSync(PATCH, { force: true })
          json(res, 400, { ok: false, error: '已拒绝：白名单会变空（桥将无法启动），已撤销本次写入' })
          return
        }
        json(res, 200, { ok: true, changed: result.changed, backup: result.backup, allowFrom: after.patch.allowFrom })
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
        // Only the knob keys this scheme actually declares, and only with the
        // right type: overrides arrived straight from the request body, so a
        // hand-made POST could previously write any contextPolicy it liked.
        const overrides: Record<string, number | boolean> = {}
        for (const [key, value] of Object.entries(body.overrides ?? {})) {
          const expected = (scheme.knobs as Record<string, unknown>)[key]
          if (expected === undefined) continue
          if (typeof expected === 'boolean' && typeof value === 'boolean') overrides[key] = value
          else if (typeof expected === 'number' && typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
        }
        const policy = { scheme: scheme.id, ...scheme.knobs, ...overrides }
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
