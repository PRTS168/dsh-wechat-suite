#!/usr/bin/env node
/**
 * One-shot setup wizard for dsh-chatnode-wechat.
 *
 * Fills every placeholder the bridge needs into the DSH profile's
 * cordis.patch.yml (the `dsh-chatnode-wechat` entry), so you don't have to
 * hand-edit YAML:
 *
 *   node scripts/setup.mjs                    # interactive wizard
 *   node scripts/setup.mjs --dry-run          # preview only, touch nothing
 *   node scripts/setup.mjs --yes --set allowFrom=abc123@im.wechat \
 *       --set siliconflowKey=sk-...           # non-interactive
 *
 * Options:
 *   --file <path>    Target cordis.patch.yml (default: $DSH_HOME/profiles/<profile>/cordis.patch.yml)
 *   --profile <name> Profile directory name (default: web)
 *   --set k=v        Set one value (repeatable). `siliconflowKey` fans out to
 *                    ocr/imageGen/stt/tts ApiKey at once.
 *   --clear k        Clear one optional value (repeatable).
 *   --yes            Non-interactive: unset values keep the current value,
 *                    else fall back to defaults; never prompts.
 *   --dry-run        Print what would change without writing.
 *   --help           This help.
 *
 * Only the `- id: dsh-chatnode-wechat` entry's `config:` subtree is touched,
 * key by key: comments, unknown keys and any other entries are preserved.
 *
 * After writing: restart dsh web so the bridge reloads lib/ and the new
 * config; if WEIXIN_* credentials are missing, run `pnpm login`.
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import readline from 'node:readline/promises'
import process from 'node:process'

const ENTRY_ID = 'dsh-chatnode-wechat'

/** Known config keys, in the order they are written when appended. */
const KEYS = [
  'allowFrom',
  'cwd',
  'agentPreset',
  'agentProvider',
  'agentModel',
  'mediaDir',
  'reminderFile',
  'morningFile',
  'esp32BaseUrl',
  'digestIntervalSec',
  'approvalTimeoutSec',
  'maxMessageChars',
  'sendChunkDelayMs',
  'ocrApiKey', 'ocrModel', 'ocrBaseUrl',
  'imageGenApiKey', 'imageGenModel', 'imageGenDir',
  'sttApiKey', 'sttModel',
  'ttsApiKey', 'ttsModel', 'ttsVoice',
]
const KNOWN = new Set(KEYS)
const SECRET_KEYS = new Set(['ocrApiKey', 'imageGenApiKey', 'sttApiKey', 'ttsApiKey'])

const DEFAULTS = {
  agentPreset: 'wechat',
  agentProvider: 'deepseek-official',
  agentModel: 'deepseek-v4-flash',
  ocrModel: 'deepseek-ai/DeepSeek-OCR',
  ocrBaseUrl: 'https://api.siliconflow.cn/v1',
  imageGenModel: 'Kwai-Kolors/Kolors',
  sttModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
  ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
}

const DESCRIPTIONS = {
  allowFrom: '你的微信 ID（形如 xxx@im.wechat）——硬白名单，必填',
  cwd: '/new 会话的工作目录（可选）',
  agentPreset: '人设/工具 preset 名（须存在于 $DSH_HOME/.agent-presets/<名>）',
  agentProvider: '聊天模型 provider',
  agentModel: '聊天模型（与媒体模型无关）',
  mediaDir: '入站媒体落盘目录（默认 $DSH_HOME/attachments/wechat）',
  reminderFile: '提醒持久化文件路径（默认 $DSH_HOME/wechat-reminders.json）',
  morningFile: '早安配置持久化路径（默认 $DSH_HOME/wechat-morning.json）',
  esp32BaseUrl: 'ESP32 灯控地址，如 http://192.168.1.10:80（可选）',
  digestIntervalSec: '回合中心跳秒数，0=关（默认 300）',
  approvalTimeoutSec: '审批超时秒数（默认 600）',
  maxMessageChars: '微信单条气泡上限（默认 2000）',
  sendChunkDelayMs: '出站分块间隔毫秒（默认 1500）',
  ocrModel: 'OCR 模型',
  ocrBaseUrl: 'SiliconFlow 兼容端点',
  imageGenModel: '生图模型',
  imageGenDir: '生图/语音输出目录（默认 mediaDir/generated）',
  sttModel: '语音转写模型',
  ttsModel: '语音合成模型',
  ttsVoice: '克隆音色 uri（speech:<name>:...，speak 用）',
}

function yamlStr(s) {
  return JSON.stringify(String(s))
}

function mask(s) {
  if (!s) return ''
  const t = String(s)
  return t.length <= 8 ? '****' : `${t.slice(0, 6)}****(+${t.length - 10})`
}

function leading(line) {
  const m = /^(\s*)/.exec(line)
  return m[1].length
}

function unquote(s) {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try { return JSON.parse(t) } catch { return t.slice(1, -1) }
  }
  return t
}

function parseArgs(argv) {
  const out = { file: undefined, profile: 'web', yes: false, dryRun: false, help: false, set: {}, clear: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a === '--file') out.file = val()
    else if (a === '--profile') out.profile = val()
    else if (a === '--yes') out.yes = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--set') {
      const kv = val()
      const eq = kv.indexOf('=')
      if (eq < 0) { console.error(`--set expects key=value, got: ${kv}`); out.help = true; continue }
      out.set[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (a === '--clear') out.clear.add(val())
    else { console.error(`unknown option: ${a}`); out.help = true }
  }
  return out
}

async function defaultFile(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * Locate the managed entry and read current values from its `config:` block.
 * Returns { found, entryStart, entryEnd, configIndent, current }.
 * `current[key]` = { indent, value } for scalars or { indent, list } for
 * allowFrom; unknown/comment lines are left for the writer to walk through.
 */
function parseEntry(lines) {
  let entryStart = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i])
    if (m && m[1] === ENTRY_ID) { entryStart = i; break }
  }
  if (entryStart < 0) return { found: false }

  // End of this entry = next top-level array item (`- ` at column 0).
  let entryEnd = lines.length
  for (let i = entryStart + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('-') && leading(lines[i]) === 0) { entryEnd = i; break }
  }

  let configIndent = 2
  const current = {}
  let cfgIdx = -1
  for (let i = entryStart + 1; i < entryEnd; i++) {
    if (/^\s*config:\s*$/.test(lines[i])) { cfgIdx = i; configIndent = leading(lines[i]); break }
  }
  if (cfgIdx >= 0) {
    for (let i = cfgIdx + 1; i < entryEnd; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const indent = leading(line)
      if (indent <= configIndent) break
      const m = /^([\w-]+):\s*(.*)$/.exec(trimmed)
      if (!m) continue
      const key = m[1]
      const inline = m[2].trim()
      if (key === 'allowFrom') {
        const items = []
        let j = i + 1
        while (j < entryEnd && leading(lines[j]) > indent) {
          const li = lines[j].trim()
          if (li.startsWith('-')) items.push(unquote(li.slice(1).trim()))
          j++
        }
        current[key] = { indent, list: items }
        i = j - 1
      } else if (inline) {
        current[key] = { indent, value: unquote(inline) }
      }
    }
  }
  return { found: true, entryStart, entryEnd, configIndent, current }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/setup.mjs [--file <path>] [--profile <name>] [--yes] [--dry-run] [--set k=v]... [--clear k]... [--help]')
    process.exit(0)
  }
  const target = args.file || await defaultFile(args.profile)
  let lines = []
  let existed = true
  try { lines = (await readFile(target, 'utf8')).split(/\r?\n/) } catch { existed = false; lines = [] }

  const parsed = parseEntry(lines)
  const current = parsed.found ? parsed.current : {}
  const configIndent = parsed.found ? parsed.configIndent : 2
  const ind = ' '.repeat(configIndent + 2) // child key indent (e.g. 4)
  const itemInd = ' '.repeat(configIndent + 4) // allowFrom list item indent (e.g. 6)

  // Decide values: explicit set > clear > (interactive answer) > keep current > default.
  const wants = {}
  const rl = args.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout })

  const askValue = async (key, secret) => {
    const label = DESCRIPTIONS[key] ?? key
    const cur = key === 'allowFrom' ? (current.allowFrom?.list?.[0]) : (current[key]?.value)
    const def = cur !== undefined ? cur : DEFAULTS[key]
    const shown = def === undefined || def === null || def === ''
      ? '（空）'
      : secret ? mask(def) : String(def)
    const answer = await rl.question(`\n${label}\n[key ${key}] 当前: ${shown}\n输入新值 / 回车保留 / 输入 - 清空: `)
    const t = answer.trim()
    if (t === '') return undefined      // keep
    if (t === '-') return null          // clear
    return t
  }

  if ('allowFrom' in args.set) wants.allowFrom = args.set.allowFrom
  else if (args.clear.has('allowFrom')) wants.allowFrom = null
  else if (rl) wants.allowFrom = await askValue('allowFrom', false)
  // else --yes: leave unset (keeps current / requires current)

  for (const key of KEYS) {
    if (key === 'allowFrom') continue
    if (key in args.set) { wants[key] = args.set[key]; continue }
    if (args.clear.has(key)) { wants[key] = null; continue }
    if (rl) {
      const ans = await askValue(key, SECRET_KEYS.has(key))
      if (ans !== undefined) wants[key] = ans
    }
  }
  if (rl) rl.close()

  const shared = args.set.siliconflowKey
  if (shared) for (const k of ['ocrApiKey', 'imageGenApiKey', 'sttApiKey', 'ttsApiKey']) wants[k] = shared

  /** Final value for a key: explicit decision, else current, else default. */
  function valueFor(key) {
    if (key in wants) return wants[key] // may be null (cleared)
    if (key === 'allowFrom') return current.allowFrom?.list?.[0]
    const c = current[key]?.value
    if (c !== undefined) return c
    return DEFAULTS[key] ?? undefined
  }

  const scalarLine = (key, v) => `${ind}${key}: ${/^-?\d+$/.test(String(v)) ? v : yamlStr(v)}`

  // ---- Rebuild the config subtree in place -------------------------------
  const outBlock = []
  if (parsed.found) {
    const childLines = lines.slice(parsed.entryStart + 1, parsed.entryEnd)
    // find the `config:` line inside the entry, then walk its children
    let cfgIdx = -1
    for (let i = 0; i < childLines.length; i++) {
      if (/^\s*config:\s*$/.test(childLines[i])) { cfgIdx = i; break }
    }
    const emitted = new Set()
    if (cfgIdx >= 0) {
      let i = cfgIdx + 1
      while (i < childLines.length) {
        const line = childLines[i]
        const trimmed = line.trim()
        const indent = leading(line)
        if (indent <= configIndent) break
        if (!trimmed || trimmed.startsWith('#')) { outBlock.push(line); i++; continue }
        const m = /^([\w-]+):\s*(.*)$/.exec(trimmed)
        if (!m) { outBlock.push(line); i++; continue }
        const key = m[1]
        const keyIndent = indent
        if (key === 'allowFrom') {
          let end = i + 1
          while (end < childLines.length && leading(childLines[end]) > keyIndent) end++
          if (!emitted.has('allowFrom')) {
            emitted.add('allowFrom')
            const v = valueFor('allowFrom')
            if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
            else outBlock.push(`${ind}allowFrom: []`)
          }
          i = end
          continue
        }
        if (KNOWN.has(key)) {
          if (!emitted.has(key)) {
            emitted.add(key)
            const v = valueFor(key)
            if (v !== undefined && v !== null && v !== '') outBlock.push(scalarLine(key, v))
          }
          i++
          continue
        }
        // unknown key: keep verbatim (its nested lines walk through below)
        outBlock.push(line)
        i++
        continue
      }
    }
    // keys not present in the original file: append them in canonical order
    for (const key of KEYS) {
      if (emitted.has(key)) continue
      if (key === 'allowFrom') {
        const v = valueFor('allowFrom')
        if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
        else outBlock.push(`${ind}allowFrom: []`)
        continue
      }
      const v = valueFor(key)
      if (v !== undefined && v !== null && v !== '') outBlock.push(scalarLine(key, v))
    }
  } else {
    // No existing entry: create the whole entry (header comments in the file
    // are preserved by keeping all original lines above).
    const v = valueFor('allowFrom')
    if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
    else outBlock.push(`${ind}allowFrom: []`)
    for (const key of KEYS) {
      if (key === 'allowFrom') continue
      const v2 = valueFor(key)
      if (v2 !== undefined && v2 !== null && v2 !== '') outBlock.push(scalarLine(key, v2))
    }
  }

  // ---- Diff summary -------------------------------------------------------
  const summary = []
  for (const key of KEYS) {
    const oldV = key === 'allowFrom' ? (current.allowFrom?.list?.[0] ?? '') : (current[key]?.value ?? '')
    const newV = valueFor(key)
    const shown = (x) => (x === undefined || x === null || x === '' ? '(空)' : SECRET_KEYS.has(key) ? mask(String(x)) : String(x))
    if (String(oldV) !== String(newV ?? '')) summary.push(`  ${key}: ${shown(oldV)} -> ${shown(newV)}`)
  }
  if (!parsed.found) summary.unshift(`  (未找到 ${ENTRY_ID} 条目，将新建)`)
  if (summary.length === 0) console.log('ℹ 没有配置变化。')
  else { console.log('将写入：\n' + summary.join('\n')) }

  // ---- Assemble final file ------------------------------------------------
  const finalLines = []
  if (parsed.found) {
    finalLines.push(...lines.slice(0, parsed.entryStart))
    finalLines.push(`- id: ${ENTRY_ID}`)
    finalLines.push(`${' '.repeat(configIndent)}config:`)
    for (const l of outBlock) finalLines.push(l)
    finalLines.push(...lines.slice(parsed.entryEnd))
  } else {
    if (existed && lines.length) finalLines.push(...lines, '')
    finalLines.push(`- id: ${ENTRY_ID}`, `  config:`)
    for (const l of outBlock) finalLines.push(l)
  }

  if (args.dryRun) {
    console.log('\n(--dry-run) 不写入。目标: ' + target)
    return
  }
  if (!existed) await mkdir(dirname(target), { recursive: true }).catch(() => {})
  else {
    const bak = `${target}.bak-${Date.now()}`
    await copyFile(target, bak)
    console.log(`备份已保存: ${bak}`)
  }
  await writeFile(target, finalLines.join('\n') + '\n', 'utf8')
  console.log(`✅ 已写入 ${target}`)
  if (!valueFor('allowFrom')) {
    console.warn('⚠ allowFrom 为空：请务必填写你的微信 ID，否则桥不会把任何消息交给模型。')
  }
  console.log('下一步：重启 dsh web；若 WEIXIN_* 凭据未配置请运行 `pnpm login`。')
}

main().catch((e) => { console.error('setup failed:', e); process.exit(1) })
