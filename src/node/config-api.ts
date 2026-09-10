/**
 * Host-side HTTP API behind the WeChat bridge's Web management page.
 *
 * Registered as a second plugin of the bundle (`dsh-chatnode-wechat/config-api`)
 * so profiles without a web server (headless) simply never load it.
 *
 * Routes (all under `/dsh-chatnode-wechat/api`, loopback-only, guarded by a
 * custom header so cross-site requests cannot reach them):
 *   GET  /schema  → editable placeholder metadata
 *   GET  /config  → current values (secrets masked) + environment status
 *   POST /save    → { updates: { key: value | null } } → patch, backup, reload
 *
 * @module @dsh-cowork/chatnode-wechat/node/config-api
 */

import { readFile, access, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  CONFIG_FIELDS,
  KNOWN_KEYS,
  maskSecret,
  readPatchFile,
  applyPatchConfig,
} from './patch-config.ts'

export const inject = ['webServer']

const API = '/dsh-chatnode-wechat/api'
const GUARD_HEADER = 'x-dsh-chatnode-wechat'

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

interface Location {
  profile: string
  file: string
}

/** Find the profile whose package.json depends on this bundle. */
async function locatePatch(): Promise<Location> {
  const override = process.env.DSH_WECHAT_PATCH
  if (override) return { profile: process.env.DSH_WECHAT_PROFILE || 'web', file: override }
  const profilesDir = join(dshHome(), 'profiles')
  let names: string[] = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = await readdir(profilesDir)
  } catch {
    names = []
  }
  for (const name of names.sort()) {
    const pkg = join(profilesDir, name, 'package.json')
    try {
      const text = await readFile(pkg, 'utf8')
      if (text.includes('@dsh-cowork/chatnode-wechat')) return { profile: name, file: join(profilesDir, name, 'cordis.patch.yml') }
    } catch {
      // no profile manifest here
    }
  }
  return { profile: 'web', file: join(profilesDir, 'web', 'cordis.patch.yml') }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function status(): Promise<Record<string, unknown>> {
  const loc = await locatePatch()
  const { exists: patchExists, patch } = await readPatchFile(loc.file)
  const preset = patch.values.agentPreset || 'wechat'
  const presetDir = join(dshHome(), '.agent-presets', preset)
  let weixinCredentials = false
  try {
    const creds = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8')
    weixinCredentials = /WEIXIN_BOT_TOKEN\s*:/.test(creds)
  } catch {
    weixinCredentials = false
  }
  return {
    profile: loc.profile,
    patchFile: loc.file,
    patchExists,
    preset,
    presetDir,
    presetExists: await exists(presetDir),
    weixinCredentials,
    siliconflowKey: Boolean(patch.values.ocrApiKey),
    allowFrom: patch.allowFrom,
  }
}

function maskValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of CONFIG_FIELDS) {
    const raw = values[field.key]
    if (raw === undefined) continue
    out[field.key] = field.secret ? maskSecret(raw) : raw
  }
  return out
}

function sendJson(res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, code: number, payload: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: AsyncIterable<Uint8Array>): Promise<string> {
  let body = ''
  for await (const chunk of req) {
    body += Buffer.from(chunk).toString('utf8')
    if (body.length > 1_000_000) throw new Error('body too large')
  }
  return body
}

// ---------------------------------------------------------------------------
// Persona presets: $DSH_HOME/.agent-presets/<name>/{preset.yml,agent.cordis.yml}
// The persona text lives in the row whose id/name contains "persona":
//     - id: persona
//       name: '@deepseek-ai/dsh-persona'
//       config:
//         text: |-
//           你是…
// ---------------------------------------------------------------------------

function presetsDir(): string {
  return join(dshHome(), '.agent-presets')
}

interface PersonaBlock { rowStart: number; keyIndent: number; style: string; contentStart: number; contentEnd: number }

/** Locate the persona row and its `config.text` scalar inside a preset file. */
function findPersonaBlock(lines: string[]): PersonaBlock | null {
  let rowStart = -1
  let rowIndent = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(lines[i]!)
    if (m && /persona/i.test(m[2]!)) { rowStart = i; rowIndent = m[1]!.length; break }
  }
  if (rowStart < 0) return null
  for (let i = rowStart + 1; i < lines.length; i++) {
    const line = lines[i]!
    const indent = ((/^(\s*)/.exec(line) ?? ['', ''])[1]!).length
    if (line.trim() && indent <= rowIndent && /^-/.test(line.trimStart())) break
    const m = /^(\s*)text:\s*([|>][-+]?)?\s*(.*)$/.exec(line)
    if (!m) continue
    const keyIndent = m[1]!.length
    const style = m[2] ?? ''
    if (!style) return { rowStart, keyIndent, style: '', contentStart: i, contentEnd: i + 1 }
    let end = i + 1
    while (end < lines.length) {
      const l = lines[end]!
      if (!l.trim()) { end++; continue }
      const ind = ((/^(\s*)/.exec(l) ?? ['', ''])[1]!).length
      if (ind <= keyIndent) break
      end++
    }
    return { rowStart, keyIndent, style, contentStart: i + 1, contentEnd: end }
  }
  return null
}

function readPersonaText(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const block = findPersonaBlock(lines)
  if (!block) return null
  if (!block.style) {
    const m = /^\s*text:\s*(.*)$/.exec(lines[block.contentStart] ?? '')
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const body = lines.slice(block.contentStart, block.contentEnd)
  const indents = body.filter((l) => l.trim()).map((l) => ((/^(\s*)/.exec(l) ?? ['', ''])[1]!).length)
  const strip = indents.length ? Math.min(...indents) : 0
  return body.map((l) => l.slice(strip)).join('\n').replace(/\n+$/, '')
}

async function readPreset(name: string): Promise<{
  dir: string
  agentFile: string
  exists: boolean
  meta: { name?: string; description?: string }
  persona: string | null
}> {
  const dir = join(presetsDir(), name)
  const agentFile = join(dir, 'agent.cordis.yml')
  const meta: { name?: string; description?: string } = {}
  let persona: string | null = null
  try {
    const ptext = await readFile(join(dir, 'preset.yml'), 'utf8')
    const nm = /^name:\s*(.*)$/m.exec(ptext)
    const de = /^description:\s*(.*)$/m.exec(ptext)
    if (nm) meta.name = nm[1]!.trim().replace(/^["']|["']$/g, '')
    if (de) meta.description = de[1]!.trim().replace(/^["']|["']$/g, '')
  } catch { /* preset.yml is optional */ }
  try {
    persona = readPersonaText(await readFile(agentFile, 'utf8'))
  } catch { /* agent.cordis.yml is optional */ }
  return { dir, agentFile, exists: await exists(agentFile), meta, persona }
}

async function listPresets(active: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  let names: string[] = []
  try {
    const { readdir, stat } = await import('node:fs/promises')
    for (const entry of await readdir(presetsDir())) {
      const st = await stat(join(presetsDir(), entry)).catch(() => null)
      if (st?.isDirectory()) names.push(entry)
    }
  } catch { names = [] }
  for (const name of names.sort()) {
    const preset = await readPreset(name)
    out.push({
      name,
      isActive: name === active,
      hasAgentFile: preset.exists,
      title: preset.meta.name ?? '',
      description: preset.meta.description ?? '',
      personaChars: preset.persona ? preset.persona.length : 0,
    })
  }
  return out
}

/** Replace the persona text in a preset, keeping every other row untouched. */
async function writePersona(name: string, persona: string): Promise<{ file: string; backup: string }> {
  if (!/^[\w.@-]+$/.test(name)) throw new Error('非法 preset 名（仅允许字母数字与 . @ - _）')
  const { agentFile } = await readPreset(name)
  let text: string
  try {
    text = await readFile(agentFile, 'utf8')
  } catch {
    throw new Error(`preset 不存在或缺 agent.cordis.yml：${agentFile}（可先用「复制现有 preset」新建）`)
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = findPersonaBlock(lines)
  if (!block) throw new Error('该 preset 的 agent.cordis.yml 中找不到 persona 行（id/name 含 persona）')
  const contentIndent = ' '.repeat(block.keyIndent + 2)
  const newContent = persona.split(/\r?\n/).map((l) => (l.trim() ? contentIndent + l : ''))
  const next = block.style
    ? [...lines.slice(0, block.contentStart), ...newContent, ...lines.slice(block.contentEnd)]
    : [...lines.slice(0, block.contentStart), `${' '.repeat(block.keyIndent)}text: |-`, ...newContent, ...lines.slice(block.contentStart + 1)]
  const backup = `${agentFile}.bak-${Date.now()}`
  await copyFile(agentFile, backup)
  await writeFile(agentFile, next.join(eol), 'utf8')
  return { file: agentFile, backup }
}

/** Copy an existing preset directory (bootstrap for a new persona). */
async function copyPreset(from: string, to: string): Promise<void> {
  if (!/^[\w.@-]+$/.test(to)) throw new Error('非法 preset 名')
  const src = join(presetsDir(), from)
  const dst = join(presetsDir(), to)
  if (!(await exists(src))) throw new Error(`源 preset 不存在：${from}`)
  if (await exists(dst)) throw new Error(`目标 preset 已存在：${to}`)
  const { cp } = await import('node:fs/promises')
  await cp(src, dst, { recursive: true, errorOnExist: false })
}


export function apply(ctx: {
  webServer: { register: (route: { kind: 'prefix'; path: string; handler: (req: any, res: any) => Promise<void> | void }) => () => void }
  logger?: { info?: (...args: any[]) => void }
  effect?: (fn: () => () => void) => void
}): void {
  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req: any, res: any) => {
      if (req.headers?.[GUARD_HEADER] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' })
      let url: URL
      try { url = new URL(req.url, 'http://127.0.0.1') } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }) }
      const path = url.pathname
      try {
        if (path === `${API}/schema` && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, fields: CONFIG_FIELDS })
        }
        if (path === `${API}/status` && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, status: await status() })
        }
        if (path === `${API}/config` && req.method === 'GET') {
          const loc = await locatePatch()
          const { exists: patchExists, patch } = await readPatchFile(loc.file)
          return sendJson(res, 200, {
            ok: true,
            file: loc.file,
            profile: loc.profile,
            patchExists,
            fields: CONFIG_FIELDS,
            values: maskValues(patch.values),
            has: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, Boolean(patch.values[f.key])])),
            allowFrom: patch.allowFrom,
            status: await status(),
          })
        }
        if (path === `${API}/save` && req.method === 'POST') {
          let payload: any
          try { payload = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }) }
          const raw = payload?.updates
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sendJson(res, 400, { ok: false, error: 'updates object required' })
          const updates: Record<string, string | null> = {}
          for (const [key, value] of Object.entries(raw)) {
            if (!KNOWN_KEYS.has(key)) return sendJson(res, 400, { ok: false, error: `unknown key: ${key}` })
            if (value === null || value === undefined) { updates[key] = null; continue }
            if (typeof value !== 'string') return sendJson(res, 400, { ok: false, error: `value for ${key} must be a string or null` })
            updates[key] = value.trim()
          }
          if (Object.keys(updates).length === 0) return sendJson(res, 400, { ok: false, error: 'no updates' })
          const loc = await locatePatch()
          const result = await applyPatchConfig(loc.file, updates)
          const after = await readPatchFile(loc.file)
          ctx.logger?.info?.('[dsh-chatnode-wechat] config updated via web: %s', result.changed.join(', '))
          return sendJson(res, 200, {
            ok: true,
            changed: result.changed,
            backup: result.backup,
            file: result.file,
            values: maskValues(after.patch.values),
            has: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, Boolean(after.patch.values[f.key])])),
            allowFrom: after.patch.allowFrom,
            status: await status(),
          })
        }
        if (path === `${API}/presets` && req.method === 'GET') {
          const loc = await locatePatch()
          const { patch } = await readPatchFile(loc.file)
          const active = patch.values.agentPreset || 'wechat'
          return sendJson(res, 200, { ok: true, active, presets: await listPresets(active), dir: presetsDir() })
        }
        if (path === `${API}/persona` && req.method === 'GET') {
          const name = String(url.searchParams.get('name') || '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: 'name required' })
          const preset = await readPreset(name)
          return sendJson(res, 200, {
            ok: true,
            name,
            file: preset.agentFile,
            exists: preset.exists,
            meta: preset.meta,
            persona: preset.persona ?? '',
          })
        }
        if (path === `${API}/persona` && req.method === 'POST') {
          let payload: any
          try { payload = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }) }
          const name = String(payload?.name || '').trim()
          const persona = payload?.persona
          if (!name) return sendJson(res, 400, { ok: false, error: 'name required' })
          if (typeof persona !== 'string' || !persona.trim()) return sendJson(res, 400, { ok: false, error: 'persona text required' })
          const result = await writePersona(name, persona)
          ctx.logger?.info?.('[dsh-chatnode-wechat] persona updated: %s (%d chars)', name, persona.length)
          return sendJson(res, 200, { ok: true, name, file: result.file, backup: result.backup, personaChars: persona.length })
        }
        if (path === `${API}/preset/copy` && req.method === 'POST') {
          let payload: any
          try { payload = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }) }
          const from = String(payload?.from || '').trim()
          const to = String(payload?.to || '').trim()
          if (!from || !to) return sendJson(res, 400, { ok: false, error: 'from/to required' })
          await copyPreset(from, to)
          return sendJson(res, 200, { ok: true, name: to, dir: join(presetsDir(), to) })
        }
        return sendJson(res, 404, { ok: false, error: `no route ${req.method} ${path}` })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  ctx.effect?.(() => () => disposer())
}
