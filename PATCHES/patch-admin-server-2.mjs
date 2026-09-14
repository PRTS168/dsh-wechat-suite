/** Incremental patch: platform-aware credential checks in health()/environment(). */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = (process.argv[2] ?? process.cwd()) + '/admin/server.ts'
const src = readFileSync(FILE, 'utf8')
let lines = src.split(/\r?\n/)
if (lines[lines.length - 1] === '') lines = lines.slice(0, -1)

const applied = []
const missed = []
function indexOfSeq(hay, needle) {
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
function rep(oldLines, newLines, { replaceAll = false } = {}) {
  if (typeof oldLines === 'string') oldLines = oldLines.split('\n')
  if (typeof newLines === 'string') newLines = newLines.split('\n')
  const idx = indexOfSeq(lines, oldLines)
  if (idx < 0) { missed.push(oldLines[0]?.slice(0, 100)); return }
  if (!replaceAll && indexOfSeq(lines.slice(idx + 1), oldLines) >= 0) { missed.push('NON-UNIQUE: ' + oldLines[0]?.slice(0, 100)); return }
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

// ── health(): 加 qq 凭据判断 ────────────────────────────────────────
rep(`  const credentials = readCorpusSafe(['WEIXIN_BOT_TOKEN', 'WEIXIN_BOT_ID', 'WEIXIN_ACCOUNT_ID'])`,
`  const qqCred = p === 'qq' ? Boolean(patch.values.qqAppId && patch.values.qqClientSecret) : false
  const credentials = readCorpusSafe(['WEIXIN_BOT_TOKEN', 'WEIXIN_BOT_ID', 'WEIXIN_ACCOUNT_ID'])`)

// ── health(): 凭据检查按平台分支 ────────────────────────────────────
rep(`  checks.push({
    id: 'weixin',
    label: '微信登录凭据',
    state: credentials.found.includes('WEIXIN_BOT_TOKEN') ? 'ok' : 'warn',
    detail: credentials.found.length > 0 ? \`找到了 \${credentials.found.join('、')}\` : '凭据库里没找到 WEIXIN_*',
    ...(credentials.found.includes('WEIXIN_BOT_TOKEN') ? {} : { fix: '桥首次登录后会把 token 写进 .credentials.yaml；没有它桥不会开始收消息' }),
  })`,
`  checks.push(p === 'qq' ? {
    id: 'platform-cred',
    label: 'QQ 机器人凭据',
    state: qqCred ? 'ok' : 'warn',
    detail: qqCred ? '已配置 AppID 与 ClientSecret' : '没配 qqAppId / qqClientSecret',
    ...(qqCred ? {} : { fix: '在下面的「谁能跟我说话」里填 QQ 机器人的 AppID 与 ClientSecret' }),
  } : {
    id: 'weixin',
    label: '微信登录凭据',
    state: credentials.found.includes('WEIXIN_BOT_TOKEN') ? 'ok' : 'warn',
    detail: credentials.found.length > 0 ? \`找到了 \${credentials.found.join('、')}\` : '凭据库里没找到 WEIXIN_*',
    ...(credentials.found.includes('WEIXIN_BOT_TOKEN') ? {} : { fix: '桥首次登录后会把 token 写进 .credentials.yaml；没有它桥不会开始收消息' }),
  })`)

// ── environment(): 加平台化凭据字段 ─────────────────────────────────
rep(`    weixinCredentials: /WEIXIN_BOT_TOKEN/.test(credentials),`,
`    weixinCredentials: /WEIXIN_BOT_TOKEN/.test(credentials),
    platformCredential: p === 'qq' ? Boolean(patch.values.qqAppId && patch.values.qqClientSecret) : /WEIXIN_BOT_TOKEN/.test(credentials),`)

writeFileSync(FILE, lines.join('\r\n') + '\r\n', 'utf8')
console.log('applied:', applied.length, '| missed:', missed.length)
if (missed.length) { console.log('MISSED:'); missed.forEach((m) => console.log('  -', m)) }
