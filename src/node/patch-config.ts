/**
 * Profile patch (`cordis.patch.yml`) reader/writer for the dsh-chatnode-wechat
 * bundle's configurable placeholders.
 *
 * Shared by two surfaces so behaviour cannot drift:
 *   - the CLI wizard `scripts/setup.mjs` (built to `lib/node/patch-config.js`)
 *   - the Web management page's host API (`src/node/config-api.ts`)
 *
 * Only the `- id: dsh-chatnode-wechat` entry's `config:` subtree is touched;
 * comments, unknown keys and other entries are preserved verbatim. A backup is
 * written next to the file before every modification.
 *
 * @module @dsh-cowork/chatnode-wechat/node/patch-config
 */

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const ENTRY_ID = 'dsh-chatnode-wechat'

/** One editable placeholder. */
export interface ConfigField {
  key: string
  label: string
  group: string
  /** Secrets are masked in every API/CLI response. */
  secret?: boolean
  /** 'list' = a YAML sequence (allowFrom); 'number' = numeric scalar. */
  kind?: 'string' | 'number' | 'list'
  default?: string
  placeholder?: string
  hint?: string
}

/** All placeholders the bridge accepts, in write order. */
export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'allowFrom', label: '微信白名单 ID', group: '必填', kind: 'list', placeholder: 'xxxxx@im.wechat', hint: '硬白名单；只允许这个微信 ID 与 AI 对话，缺失时桥不会把任何消息交给模型。' },
  { key: 'agentPreset', label: '人设 preset 名', group: '必填', default: 'wechat', hint: '须存在于 $DSH_HOME/.agent-presets/<名>；仓库内不含任何具体人设内容。' },
  { key: 'agentProvider', label: '聊天模型 provider', group: '必填', default: 'deepseek-official' },
  { key: 'agentModel', label: '聊天模型', group: '必填', default: 'deepseek-v4-flash' },
  { key: 'cwd', label: '/new 工作目录', group: '可选', placeholder: 'D:\\your\\workspace' },
  { key: 'mediaDir', label: '媒体落盘目录', group: '可选', placeholder: '$DSH_HOME/attachments/wechat', hint: '入站图片/文件/视频与生成媒体的保存位置。' },
  { key: 'reminderFile', label: '提醒持久化文件', group: '可选', placeholder: '$DSH_HOME/wechat-reminders.json' },
  { key: 'morningFile', label: '早安配置持久化文件', group: '可选', placeholder: '$DSH_HOME/wechat-morning.json' },
  { key: 'esp32BaseUrl', label: 'ESP32 灯控地址', group: '可选', placeholder: 'http://192.168.1.10:80' },
  { key: 'digestIntervalSec', label: '心跳间隔（秒）', group: '可选', kind: 'number', placeholder: '300', hint: '0 = 关闭回合中心跳。' },
  { key: 'approvalTimeoutSec', label: '审批超时（秒）', group: '可选', kind: 'number', placeholder: '600' },
  { key: 'maxMessageChars', label: '单条气泡上限', group: '可选', kind: 'number', placeholder: '2000' },
  { key: 'sendChunkDelayMs', label: '分块发送间隔（毫秒）', group: '可选', kind: 'number', placeholder: '1500' },
  { key: 'ocrApiKey', label: 'SiliconFlow API Key', group: '媒体模型', secret: true, placeholder: 'sk-...', hint: 'OCR/生图/STT/TTS 共用；仅本地保存。' },
  { key: 'ocrModel', label: 'OCR 模型', group: '媒体模型', default: 'deepseek-ai/DeepSeek-OCR' },
  { key: 'ocrBaseUrl', label: 'OCR 端点', group: '媒体模型', default: 'https://api.siliconflow.cn/v1' },
  { key: 'imageGenApiKey', label: '生图 API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
  { key: 'imageGenModel', label: '生图模型', group: '媒体模型', default: 'Kwai-Kolors/Kolors' },
  { key: 'imageGenDir', label: '生图/语音输出目录', group: '媒体模型', placeholder: '默认 mediaDir/generated' },
  { key: 'sttApiKey', label: 'STT API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
  { key: 'sttModel', label: '语音转写模型', group: '媒体模型', default: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
  { key: 'ttsApiKey', label: 'TTS API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
  { key: 'ttsModel', label: '语音合成模型', group: '媒体模型', default: 'FunAudioLLM/CosyVoice2-0.5B' },
  { key: 'ttsVoice', label: '克隆音色 uri', group: '媒体模型', placeholder: 'speech:<name>:...' },
]

export const KNOWN_KEYS: ReadonlySet<string> = new Set(CONFIG_FIELDS.map((f) => f.key))

export function maskSecret(value: string): string {
  if (!value) return ''
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}****(+${value.length - 10})`
}

/** Default patch path for a profile (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). */
export function defaultPatchPath(profile = 'web'): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

function leading(line: string): number {
  const m = /^(\s*)/.exec(line)
  return m ? m[1]!.length : 0
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try { return JSON.parse(t) as string } catch { return t.slice(1, -1) }
  }
  return t
}

export function yamlStr(value: string): string {
  return JSON.stringify(String(value))
}

interface ParsedPatch {
  lines: string[]
  found: boolean
  entryStart: number
  entryEnd: number
  configIndent: number
  current: Record<string, { indent: number; value?: string; list?: string[] }>
}

/** Locate the managed entry and read its current config values. */
export function parsePatch(text: string): ParsedPatch {
  const lines = text.split(/\r?\n/)
  let entryStart = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i]!)
    if (m && m[1] === ENTRY_ID) { entryStart = i; break }
  }
  if (entryStart < 0) {
    return { lines, found: false, entryStart: -1, entryEnd: lines.length, configIndent: 2, current: {} }
  }
  let entryEnd = lines.length
  for (let i = entryStart + 1; i < lines.length; i++) {
    if (lines[i]!.trimStart().startsWith('-') && leading(lines[i]!) === 0) { entryEnd = i; break }
  }
  let configIndent = 2
  const current: ParsedPatch['current'] = {}
  let cfgIdx = -1
  for (let i = entryStart + 1; i < entryEnd; i++) {
    if (/^\s*config:\s*$/.test(lines[i]!)) { cfgIdx = i; configIndent = leading(lines[i]!); break }
  }
  if (cfgIdx >= 0) {
    for (let i = cfgIdx + 1; i < entryEnd; i++) {
      const line = lines[i]!
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const indent = leading(line)
      if (indent <= configIndent) break
      const m = /^([\w-]+):\s*(.*)$/.exec(trimmed)
      if (!m) continue
      const key = m[1]!
      const inline = m[2]!.trim()
      if (key === 'allowFrom') {
        const items: string[] = []
        let j = i + 1
        while (j < entryEnd && leading(lines[j]!) > indent) {
          const li = lines[j]!.trim()
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
  return { lines, found: true, entryStart, entryEnd, configIndent, current }
}

export interface PatchValues {
  /** Scalar values by key (raw, secrets included — mask before display). */
  values: Record<string, string>
  /** allowFrom entries. */
  allowFrom: string[]
}

export function extractValues(parsed: ParsedPatch): PatchValues {
  const values: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed.current)) {
    // Unknown keys are preserved verbatim by the writer but are not editable
    // through the wizard / web page, so they never enter the value set.
    if (key === 'allowFrom' || !KNOWN_KEYS.has(key)) continue
    if (entry.value !== undefined) values[key] = entry.value
  }
  return { values, allowFrom: parsed.current.allowFrom?.list ?? [] }
}

/** Read the patch file; missing file is not an error. */
export async function readPatchFile(file: string): Promise<{ exists: boolean; parsed: ParsedPatch; patch: PatchValues }> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = parsePatch(text)
    return { exists: true, parsed, patch: extractValues(parsed) }
  } catch {
    const parsed = parsePatch('')
    return { exists: false, parsed, patch: { values: {}, allowFrom: [] } }
  }
}

export interface ApplyResult {
  changed: string[]
  backup?: string
  file: string
}

/**
 * Apply updates to the managed entry. `null` clears an optional key (or the
 * allowlist entry); `undefined`/absent leaves it untouched.
 */
export async function applyPatchConfig(file: string, updates: Record<string, string | null | undefined>): Promise<ApplyResult> {
  let text = ''
  let exists = true
  try { text = await readFile(file, 'utf8') } catch { exists = false; text = '' }
  const parsed = parsePatch(text)
  const before = extractValues(parsed)
  const configIndent = parsed.found ? parsed.configIndent : 2
  const ind = ' '.repeat(configIndent + 2)
  const itemInd = ' '.repeat(configIndent + 4)

  /** Effective new value for a key: explicit update, else current. */
  function valueFor(key: string): string | null {
    if (key in updates) {
      const v = updates[key]
      return v === undefined || v === null || v === '' ? null : String(v)
    }
    if (key === 'allowFrom') return before.allowFrom[0] ?? null
    const cur = before.values[key]
    return cur === undefined ? null : cur
  }

  const scalarLine = (key: string, v: string): string => `${ind}${key}: ${/^-?\d+$/.test(v) ? v : yamlStr(v)}`
  const outBlock: string[] = []

  if (parsed.found) {
    const childLines = parsed.lines.slice(parsed.entryStart + 1, parsed.entryEnd)
    let cfgIdx = -1
    for (let i = 0; i < childLines.length; i++) {
      if (/^\s*config:\s*$/.test(childLines[i]!)) { cfgIdx = i; break }
    }
    const emitted = new Set<string>()
    if (cfgIdx >= 0) {
      let i = cfgIdx + 1
      while (i < childLines.length) {
        const line = childLines[i]!
        const trimmed = line.trim()
        const indent = leading(line)
        if (indent <= configIndent) break
        if (!trimmed || trimmed.startsWith('#')) { outBlock.push(line); i++; continue }
        const m = /^([\w-]+):\s*(.*)$/.exec(trimmed)
        if (!m) { outBlock.push(line); i++; continue }
        const key = m[1]!
        if (key === 'allowFrom') {
          let end = i + 1
          while (end < childLines.length && leading(childLines[end]!) > indent) end++
          if (!emitted.has('allowFrom')) {
            emitted.add('allowFrom')
            const v = valueFor('allowFrom')
            if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
            else outBlock.push(`${ind}allowFrom: []`)
          }
          i = end
          continue
        }
        if (KNOWN_KEYS.has(key)) {
          if (!emitted.has(key)) {
            emitted.add(key)
            const v = valueFor(key)
            if (v !== null) outBlock.push(scalarLine(key, v))
          }
          i++
          continue
        }
        outBlock.push(line)
        i++
      }
    }
    for (const field of CONFIG_FIELDS) {
      if (emitted.has(field.key)) continue
      if (field.key === 'allowFrom') {
        const v = valueFor('allowFrom')
        if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
        else outBlock.push(`${ind}allowFrom: []`)
        continue
      }
      const v = valueFor(field.key)
      if (v !== null) outBlock.push(scalarLine(field.key, v))
    }
  } else {
    const v = valueFor('allowFrom')
    if (v) outBlock.push(`${ind}allowFrom:`, `${itemInd}- ${yamlStr(v)}`)
    else outBlock.push(`${ind}allowFrom: []`)
    for (const field of CONFIG_FIELDS) {
      if (field.key === 'allowFrom') continue
      const fv = valueFor(field.key)
      if (fv !== null) outBlock.push(scalarLine(field.key, fv))
    }
  }

  const finalLines: string[] = []
  if (parsed.found) {
    finalLines.push(...parsed.lines.slice(0, parsed.entryStart))
    finalLines.push(`- id: ${ENTRY_ID}`)
    finalLines.push(`${' '.repeat(configIndent)}config:`)
    finalLines.push(...outBlock)
    finalLines.push(...parsed.lines.slice(parsed.entryEnd))
  } else {
    if (exists && text.length) finalLines.push(...parsed.lines, '')
    finalLines.push(`- id: ${ENTRY_ID}`, '  config:')
    finalLines.push(...outBlock)
  }

  // Diff summary
  const changed: string[] = []
  for (const field of CONFIG_FIELDS) {
    const oldV = field.key === 'allowFrom' ? (before.allowFrom[0] ?? '') : (before.values[field.key] ?? '')
    const newV = valueFor(field.key) ?? ''
    if (oldV !== newV) changed.push(field.key)
  }

  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  let backup: string | undefined
  if (exists) {
    backup = `${file}.bak-${Date.now()}`
    await copyFile(file, backup)
  }
  await writeFile(file, finalLines.join('\n') + '\n', 'utf8')
  return { changed, backup, file }
}
