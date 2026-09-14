/**
 * Patch admin/server.ts for multi-platform console — line-sequence matcher.
 * Reads as UTF-8, matches exact full lines (CRLF-safe), writes back CRLF.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = (process.argv[2] ?? process.cwd()) + '/admin/server.ts'
const src = readFileSync(FILE, 'utf8')
// 保持每行原始文本（去掉行尾符）
let lines = src.split(/\r?\n/)
if (lines[lines.length - 1] === '') lines = lines.slice(0, -1) // 去掉尾部空串（文件以换行结尾）

const applied = []
const missed = []

function indexOfSeq(hay, needle) {
  if (needle.length === 0) return -1
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** 替换一个行序列（须唯一）。oldLines/newLines 为字符串数组。 */
function rep(oldLines, newLines, { replaceAll = false } = {}) {
  if (typeof oldLines === 'string') oldLines = oldLines.split('\n')
  if (typeof newLines === 'string') newLines = newLines.split('\n')
  let idx = indexOfSeq(lines, oldLines)
  if (idx < 0) { missed.push(oldLines[0]?.slice(0, 100) ?? '(empty)'); return }
  if (!replaceAll) {
    const second = indexOfSeq(lines.slice(idx + 1), oldLines)
    if (second >= 0) { missed.push('NON-UNIQUE: ' + oldLines[0]?.slice(0, 100)); return }
  }
  if (replaceAll) {
    const out = []
    let i = 0
    while (i < lines.length) {
      const at = indexOfSeq(lines.slice(i), oldLines)
      if (at < 0) { out.push(...lines.slice(i)); break }
      out.push(...lines.slice(i, i + at), ...newLines)
      i += at + oldLines.length
    }
    lines = out
  } else {
    lines = [...lines.slice(0, idx), ...newLines, ...lines.slice(idx + oldLines.length)]
  }
  applied.push(oldLines[0]?.slice(0, 60))
}

// ── 1. 参数区 ──────────────────────────────────────────────────────
rep(
`const PORT = Number(argValue('--port') ?? process.env.WECHAT_ADMIN_PORT ?? 8790)
const PROFILE = argValue('--profile') ?? process.env.WECHAT_ADMIN_PROFILE ?? 'web'
const PATCH = argValue('--patch') ?? join(dshHome(), 'profiles', PROFILE, 'cordis.patch.yml')`,
`const PORT = Number(argValue('--port') ?? process.env.WECHAT_ADMIN_PORT ?? 8790)

/**
 * Platforms this console serves. Multi-platform mode (\`--profiles wechat,qq\`)
 * hosts both bridges under ONE url; the legacy single-platform mode
 * (\`--profile <p>\`) and the historical default (\`web\`) keep working unchanged.
 */
function parseProfiles(): string[] {
  const multi = argValue('--profiles')
  if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean)
  const single = argValue('--profile') ?? process.env.WECHAT_ADMIN_PROFILE ?? 'web'
  return [single]
}

const PROFILES = parseProfiles()
const MAIN_PROFILE = PROFILES[0] ?? 'web'
const PATCH = argValue('--patch') ?? patchFor(MAIN_PROFILE)

function patchFor(p: string): string {
  return join(dshHome(), 'profiles', p, 'cordis.patch.yml')
}

function platformLabel(p: string): string {
  if (p === 'wechat') return '微信'
  if (p === 'qq') return 'QQ'
  return p
}

/** The platform an API call targets: query, then body, then the main profile. */
function platformFrom(url: URL, body?: { platform?: string } | Record<string, unknown>): string {
  const b = body as { platform?: string } | undefined
  return url.searchParams.get('platform') ?? b?.platform ?? MAIN_PROFILE
}
function validPlatform(p: string): boolean {
  return PROFILES.includes(p)
}
function prefixFor(p: string): string {
  return \`\${p}-\`
}`)

// ── 2. currentScheme ────────────────────────────────────────────────
rep('async function currentScheme(): Promise<string> {', 'async function currentScheme(p: string): Promise<string> {')
rep('  const { patch } = await readPatchFile(PATCH)', '  const { patch } = await readPatchFile(patchFor(p))')

// ── 3. listConversations ────────────────────────────────────────────
rep('function listConversations(): Conversation[] {', 'function listConversations(prefix: string): Conversation[] {')
rep("      if (!id.startsWith('wechat-')) continue", '      if (!id.startsWith(prefix)) continue')

// ── 4. transcript ───────────────────────────────────────────────────
rep('function transcript(id: string, limit: number): { role: string; text: string }[] {',
    'function transcript(id: string, limit: number, prefix: string): { role: string; text: string }[] {')
rep('  const found = listConversations().find((c) => c.id === id)',
    '  const found = listConversations(prefix).find((c) => c.id === id)')

// ── 5. environment ──────────────────────────────────────────────────
rep('async function environment(): Promise<Record<string, unknown>> {',
    'async function environment(p: string): Promise<Record<string, unknown>> {')
rep('  const { exists, patch } = await readPatchFile(PATCH)',
    '  const { exists, patch } = await readPatchFile(patchFor(p))')
rep("  const presetDir = join(dshHome(), '.agent-presets', patch.values.agentPreset || 'wechat')",
    "  const presetDir = join(dshHome(), '.agent-presets', patch.values.agentPreset || p)")
rep('    profile: PROFILE,', '    profile: p,')
rep('    patchFile: PATCH,', '    patchFile: patchFor(p),')
rep("    preset: patch.values.agentPreset || 'wechat',", '    preset: patch.values.agentPreset || p,')

// ── 6. queueDir / doneDir ───────────────────────────────────────────
rep('function queueDir(): string {', 'function queueDir(p: string): string {')
rep("  return join(dshHome(), 'wechat-admin', 'queue')", "  return join(dshHome(), \`\${p}-admin\`, 'queue')")
rep('function doneDir(): string {', 'function doneDir(p: string): string {')
rep("  return join(dshHome(), 'wechat-admin', 'done')", "  return join(dshHome(), \`\${p}-admin\`, 'done')")

// ── 7. enqueue ─────────────────────────────────────────────────────
rep('function enqueue(command: Record<string, unknown>): string {',
    'function enqueue(command: Record<string, unknown>, p: string): string {')
rep('  mkdirSync(queueDir(), { recursive: true })', '  mkdirSync(queueDir(p), { recursive: true })')
rep("  writeFileSync(join(queueDir(), name), JSON.stringify(command, null, 2))",
    "  writeFileSync(join(queueDir(p), name), JSON.stringify(command, null, 2))")

// ── 8. recentReports ───────────────────────────────────────────────
rep('function recentReports(limit = 10): unknown[] {', 'function recentReports(p: string, limit = 10): unknown[] {')
rep('    return readdirSync(doneDir())', '    return readdirSync(doneDir(p))')
rep("          return JSON.parse(readFileSync(join(doneDir(), name), 'utf8')) as unknown",
    "          return JSON.parse(readFileSync(join(doneDir(p), name), 'utf8')) as unknown")

// ── 9. trashSession ────────────────────────────────────────────────
rep("  if (!sessionId.startsWith('wechat-')) return { ok: false, detail: '只允许操作微信会话（wechat- 前缀）' }",
    "  if (!PROFILES.some((pp) => sessionId.startsWith(\`\${pp}-\`))) return { ok: false, detail: '只允许操作本管理台托管的会话（' + PROFILES.map(prefixFor).join('、') + ' 前缀）' }")

// ── 10. problemLogFile / memoryFile / configuredPath ───────────────
rep('function problemLogFile(): string {', 'function problemLogFile(p: string): string {')
rep("  return configuredPath('problemFile', join(dshHome(), 'wechat-problems.log'))",
    "  return configuredPath('problemFile', join(dshHome(), \`\${p}-problems.log\`), p)")
rep('function memoryFile(): string {', 'function memoryFile(p: string): string {')
rep("  return configuredPath('memoryFile', join(dshHome(), 'wechat-memory', 'MEMORY.md'))",
    "  return configuredPath('memoryFile', join(dshHome(), \`\${p}-memory\`, 'MEMORY.md'), p)")
rep('function configuredPath(key: string, fallback: string): string {',
    'function configuredPath(key: string, fallback: string, p: string): string {')
rep("    const parsed = parsePatch(readFileSync(PATCH, 'utf8'))",
    "    const parsed = parsePatch(readFileSync(patchFor(p), 'utf8'))")

// ── 11. health ─────────────────────────────────────────────────────
rep('async function health(): Promise<{ ok: boolean; summary: string; checks: HealthCheck[] }> {',
    'async function health(p: string): Promise<{ ok: boolean; summary: string; checks: HealthCheck[] }> {')
rep('  const { exists, patch, unreadable } = await readPatchFile(PATCH)',
    '  const { exists, patch, unreadable } = await readPatchFile(patchFor(p))')
rep("  const preset = patch.values.agentPreset || 'wechat'", '  const preset = patch.values.agentPreset || p')
rep('    detail: unreadable ? `读不出来：${unreadable}` : exists ? PATCH : \'还没有这个文件（第一次保存时会创建）\',',
    '    detail: unreadable ? `读不出来：${unreadable}` : exists ? patchFor(p) : \'还没有这个文件（第一次保存时会创建）\',')
rep('  const problems = tailLines(problemLogFile(), 400)', '  const problems = tailLines(problemLogFile(p), 400)')
rep('  const memory = readMemoryText()', '  const memory = readMemoryText(p)')

// ── 12. readMemoryText ─────────────────────────────────────────────
rep('function readMemoryText(): { exists: boolean; text: string; facts: number; file: string } {',
    'function readMemoryText(p: string): { exists: boolean; text: string; facts: number; file: string } {')
rep('  const file = memoryFile()', '  const file = memoryFile(p)')

// ── 13. listBackups ────────────────────────────────────────────────
rep('function listBackups(): Array<{ name: string; path: string; at: string; bytes: number }> {',
    'function listBackups(patchPath: string): Array<{ name: string; path: string; at: string; bytes: number }> {')
rep('  const dir = dirname(PATCH)', '  const dir = dirname(patchPath)')
rep('  const prefix = `${basename(PATCH)}.bak-`', '  const prefix = `${basename(patchPath)}.bak-`')

// ── 14. /api/platforms ─────────────────────────────────────────────
rep(`      if (url.pathname === '/api/health' && !mutating) {`,
`      if (url.pathname === '/api/platforms' && !mutating) {
        const platforms = await Promise.all(PROFILES.map(async (p) => {
          const { exists } = await readPatchFile(patchFor(p))
          return { id: p, label: platformLabel(p), patchExists: exists }
        }))
        json(res, 200, { ok: true, platforms, active: MAIN_PROFILE })
        return
      }

      if (url.pathname === '/api/health' && !mutating) {`)

// ── 15. health handler ─────────────────────────────────────────────
rep('        json(res, 200, { ok: true, ...(await health()) })',
    '        const p = platformFrom(url)\n        json(res, 200, { ok: true, ...(await health(p)) })')

// ── 16. problems handler ───────────────────────────────────────────
rep(`        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)`,
    `        const p = platformFrom(url)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)`)
rep('        const lines = tailLines(problemLogFile(), limit)', '        const lines = tailLines(problemLogFile(p), limit)')
rep('          file: problemLogFile(),', '          file: problemLogFile(p),')
rep('          exists: lines.length > 0 || existsSync(problemLogFile()),',
    '          exists: lines.length > 0 || existsSync(problemLogFile(p)),')
rep('          rotated: existsSync(`${problemLogFile()}.1`),', '          rotated: existsSync(`${problemLogFile(p)}.1`),')

// ── 17. memory handler ─────────────────────────────────────────────
rep(`        const memory = readMemoryText()
        json(res, 200, { ok: true, ...memory })`,
    `        const p = platformFrom(url)
        const memory = readMemoryText(p)
        json(res, 200, { ok: true, ...memory })`)

// ── 18. models handler ─────────────────────────────────────────────
rep(`        const catalog = readModelCatalog()
        const { patch } = await readPatchFile(PATCH)`,
    `        const p = platformFrom(url)
        const catalog = readModelCatalog()
        const { patch } = await readPatchFile(patchFor(p))`)

// ── 19. backups handler ────────────────────────────────────────────
rep('        json(res, 200, { ok: true, file: PATCH, backups: listBackups().slice(0, 20) })',
    '        const p = platformFrom(url)\n        json(res, 200, { ok: true, file: patchFor(p), backups: listBackups(patchFor(p)).slice(0, 20) })')

// ── 20. rollback handler ───────────────────────────────────────────
rep(`        const body = (await readBody(req)) as { name?: string }`,
    `        const body = (await readBody(req)) as { name?: string }
        const p = platformFrom(url, body)`)
rep('        const target = listBackups().find((entry) => entry.name === name)',
    '        const target = listBackups(patchFor(p)).find((entry) => entry.name === name)')
rep('        const safety = `${PATCH}.bak-${Date.now()}`', '        const safety = `${patchFor(p)}.bak-${Date.now()}`')
rep('          copyFileSync(PATCH, safety)', '          copyFileSync(patchFor(p), safety)')
rep("        writeFileSync(PATCH, content, 'utf8')", "        writeFileSync(patchFor(p), content, 'utf8')")
rep('        pruneBackups(PATCH, 5)', '        pruneBackups(patchFor(p), 5)')

// ── 21. state handler ──────────────────────────────────────────────
rep('        const { patch, unreadable } = await readPatchFile(PATCH)',
    '        const p = platformFrom(url)\n        const { patch, unreadable } = await readPatchFile(patchFor(p))')
rep('          environment: await environment(),', '          environment: await environment(p),')
rep('          activeScheme: await currentScheme(),', '          activeScheme: await currentScheme(p),')
rep('          conversations: listConversations().slice(0, 50),',
    '          conversations: listConversations(prefixFor(p)).slice(0, 50),')

// ── 22. config handler ─────────────────────────────────────────────
rep(`        const body = (await readBody(req)) as { updates?: Record<string, string | null> }`,
    `        const body = (await readBody(req)) as { updates?: Record<string, string | null> }
        const p = platformFrom(url, body)`)
rep('        const before = await readPatchFile(PATCH)', '        const before = await readPatchFile(patchFor(p))')
rep('          result = await applyPatchConfig(PATCH, updates)', '          result = await applyPatchConfig(patchFor(p), updates)')
rep('        const after = await readPatchFile(PATCH)', '        const after = await readPatchFile(patchFor(p))')
rep("          if (result.backup) writeFileSync(PATCH, readFileSync(result.backup, 'utf8'))",
    "          if (result.backup) writeFileSync(patchFor(p), readFileSync(result.backup, 'utf8'))")
rep('          else if (!before.exists) rmSync(PATCH, { force: true })',
    '          else if (!before.exists) rmSync(patchFor(p), { force: true })')

// ── 23. reveal handler ─────────────────────────────────────────────
rep(`        const key = url.searchParams.get('key') ?? ''`,
    `        const p = platformFrom(url)
        const key = url.searchParams.get('key') ?? ''`)
rep('        const { patch } = await readPatchFile(PATCH)',
    '        const { patch } = await readPatchFile(patchFor(p))', { replaceAll: true })

// ── 24. scheme handler ─────────────────────────────────────────────
rep(`        const body = (await readBody(req)) as { scheme?: string; overrides?: SchemeKnobs }`,
    `        const body = (await readBody(req)) as { scheme?: string; overrides?: SchemeKnobs }
        const p = platformFrom(url, body)`)
rep('        const result = await applyPatchConfig(PATCH, { contextPolicy: JSON.stringify(policy) })',
    '        const result = await applyPatchConfig(patchFor(p), { contextPolicy: JSON.stringify(policy) })')

// ── 25. conversations / transcript handlers ────────────────────────
rep('        json(res, 200, { ok: true, conversations: listConversations() })',
    '        const p = platformFrom(url)\n        json(res, 200, { ok: true, conversations: listConversations(prefixFor(p)) })')
rep(`        const id = url.searchParams.get('id') ?? ''`,
    `        const p = platformFrom(url)
        const id = url.searchParams.get('id') ?? ''`)
rep('        json(res, 200, { ok: true, id, messages: transcript(id, limit) })',
    '        json(res, 200, { ok: true, id, messages: transcript(id, limit, prefixFor(p)) })')

// ── 26. session handlers ───────────────────────────────────────────
rep(`        const body = (await readBody(req)) as { prompt?: string; announce?: boolean }`,
    `        const body = (await readBody(req)) as { prompt?: string; announce?: boolean }
        const p = platformFrom(url, body)`)
rep(`          announce: body.announce !== false,
        })`,
    `          announce: body.announce !== false,
        }, p)`)
rep(`        const body = (await readBody(req)) as { sessionId?: string }`,
    `        const body = (await readBody(req)) as { sessionId?: string }
        const p = platformFrom(url, body)`)
rep("        const name = enqueue({ op: 'forget-session', sessionId })",
    "        const name = enqueue({ op: 'forget-session', sessionId }, p)")
rep('        json(res, 200, { ok: true, reports: recentReports(10) })',
    '        const p = platformFrom(url)\n        json(res, 200, { ok: true, reports: recentReports(p, 10) })')

// ── 27. listen ─────────────────────────────────────────────────────
rep(`server.listen(PORT, '127.0.0.1', () => {
  const fingerprint = createHash('sha256').update(PATCH).digest('hex').slice(0, 8)
  console.log(\`wechat-admin  http://127.0.0.1:\${PORT}/\`)
  console.log(\`  token url http://127.0.0.1:\${PORT}/?token=\${TOKEN}\`)
  console.log(\`  profile   \${PROFILE}   (patch \${fingerprint})\`)
  console.log(\`  patch     \${PATCH}\`)
  console.log(\`  dsh home  \${dshHome()}\`)
})`,
`server.listen(PORT, '127.0.0.1', () => {
  const fingerprint = createHash('sha256').update(PATCH).digest('hex').slice(0, 8)
  console.log(\`bridge-admin  http://127.0.0.1:\${PORT}/\`)
  console.log(\`  token url http://127.0.0.1:\${PORT}/?token=\${TOKEN}\`)
  console.log(\`  profiles   \${PROFILES.join(', ')}\`)
  console.log(\`  dsh home  \${dshHome()}\`)
})`)

// ── 写回（CRLF，UTF-8 无 BOM）───────────────────────────────────────
writeFileSync(FILE, lines.join('\r\n') + '\r\n', 'utf8')
console.log('applied:', applied.length, '| missed:', missed.length)
if (missed.length) { console.log('MISSED:'); missed.forEach((m) => console.log('  -', m)) }
