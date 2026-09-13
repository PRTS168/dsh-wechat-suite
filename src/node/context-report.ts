/**
 * Context usage, read from the host's own projection cache and rendered as one
 * plain-language report for the owner.
 *
 * Why this exists: the owner's complaint was that switching a "context scheme"
 * felt like losing the conversation, and nothing in the chat ever said how full
 * the context was or what would happen when it filled up. Every number here is
 * the host's own measurement (`$DSH_HOME/storages/session_projcache/…`), never a
 * guess, so `/context` can be trusted the way `/status` is.
 *
 * The reader is deliberately dependency-free and best-effort: this runs from a
 * WeChat command, and a missing or half-written projection file must degrade to
 * "no data yet", never to an exception.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the host measured for one session. All fields optional on purpose. */
export interface ContextUsage {
  /** The model's context window in tokens. */
  contextWindow?: number
  /** Everything the next request will carry (system + tools + messages). */
  pressureTokens?: number
  /** The live message surface only. */
  surfaceTokens?: number
  /** System prompt tokens, when the host breaks the total down. */
  systemTokens?: number
  /** Tool catalog tokens. */
  toolsTokens?: number
  /** Message tokens (same measure as {@link surfaceTokens}). */
  messageTokens?: number
}

/** Compaction settings, as far as the preset states them. */
export interface CompactionPolicy {
  thresholdRatio: number
  retainRatio: number
  /** `preset` = read from the preset file, `default` = the plugin's own default. */
  source: 'preset' | 'default'
}

/**
 * The compaction defaults of `@deepseek-ai/dsh-compaction-basic`. Used when a
 * preset mounts the row without a `config:` block (which is what the plugin
 * itself would do), so the report can still state a real trigger point instead
 * of hand-waving — and labels it as a default so it never claims precision the
 * preset does not have.
 */
export const DEFAULT_COMPACTION: Omit<CompactionPolicy, 'source'> = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
}

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Raw projection rows for one session, or undefined when unavailable. */
export function readContextUsage(sessionId: string): ContextUsage | undefined {
  try {
    const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      record?: { rows?: Record<string, { val?: unknown }> }
    }
    const rows = doc.record?.rows
    if (!rows) return undefined
    const pressure = rows.contextPressure?.val as ContextUsage | undefined
    const breakdown = rows.contextBreakdown?.val as ContextUsage | undefined
    const usage: ContextUsage = {
      ...(typeof pressure?.contextWindow === 'number' ? { contextWindow: pressure.contextWindow } : {}),
      ...(typeof pressure?.pressureTokens === 'number' ? { pressureTokens: pressure.pressureTokens } : {}),
      ...(typeof pressure?.surfaceTokens === 'number' ? { surfaceTokens: pressure.surfaceTokens } : {}),
      ...(typeof breakdown?.systemTokens === 'number' ? { systemTokens: breakdown.systemTokens } : {}),
      ...(typeof breakdown?.toolsTokens === 'number' ? { toolsTokens: breakdown.toolsTokens } : {}),
      ...(typeof breakdown?.messageTokens === 'number' ? { messageTokens: breakdown.messageTokens } : {}),
    }
    return Object.keys(usage).length > 0 ? usage : undefined
  } catch {
    return undefined
  }
}

/** How many turns the session has recorded, when the projection says. */
export function readTurnCount(sessionId: string): number | undefined {
  try {
    const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      record?: { rows?: Record<string, { val?: unknown }> }
    }
    const stats = doc.record?.rows?.sessionStats?.val as { turns?: unknown } | undefined
    return typeof stats?.turns === 'number' ? stats.turns : undefined
  } catch {
    return undefined
  }
}

/**
 * The compaction ratios in force, read from the agent preset the bridge runs.
 *
 * A preset that mounts `compaction-basic` without a `config:` block is running
 * the plugin defaults, which is the normal case here — hence the `source` field
 * so the report can say which of the two it is instead of implying precision it
 * does not have.
 */
export function readCompactionPolicy(presetId: string): CompactionPolicy | undefined {
  try {
    const file = join(dshHome(), '.agent-presets', presetId, 'agent.cordis.yml')
    const text = readFileSync(file, 'utf8')
    const threshold = /thresholdRatio:\s*([\d.]+)/.exec(text)
    const retain = /retainRatio:\s*([\d.]+)/.exec(text)
    if (!threshold && !retain) return { ...DEFAULT_COMPACTION, source: 'default' }
    const parsed = {
      thresholdRatio: threshold ? Number(threshold[1]) : DEFAULT_COMPACTION.thresholdRatio,
      retainRatio: retain ? Number(retain[1]) : DEFAULT_COMPACTION.retainRatio,
    }
    const sane = Number.isFinite(parsed.thresholdRatio) && Number.isFinite(parsed.retainRatio)
    return sane ? { ...parsed, source: 'preset' } : { ...DEFAULT_COMPACTION, source: 'default' }
  } catch {
    return undefined
  }
}

/** `1_000_000` → `100 万`, `15947` → `1.6 万`, `800_000` → `80 万`, `3547` → `3547`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 10_000) return String(Math.round(value))
  const wan = value / 10_000
  return `${wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '')} 万`
}

function percent(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '?'
  const pct = (used / total) * 100
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

export interface ContextReportInput {
  sessionId: string
  turns?: number
  usage?: ContextUsage
  /** Facts currently in long-term memory. */
  memoryFacts: number
  compaction?: CompactionPolicy
}

/**
 * The report the owner sees for `/context`.
 *
 * Kept in one place, and pure, so the wording (and the arithmetic behind it) can
 * be tested without a host, a session, or a projection file.
 */
export function formatContextReport(input: ContextReportInput): string {
  const lines: string[] = [`📊 上下文 · 会话 ${input.sessionId}${input.turns === undefined ? '' : ` · ${input.turns} 轮`}`]
  const usage = input.usage
  if (!usage || (usage.pressureTokens === undefined && usage.surfaceTokens === undefined)) {
    lines.push('宿主还没记录这个会话的用量（聊过一轮之后再看）。')
    lines.push(`长期记忆：${input.memoryFacts} 条`)
    return lines.join('\n')
  }

  const used = usage.pressureTokens ?? ((usage.systemTokens ?? 0) + (usage.toolsTokens ?? 0) + (usage.messageTokens ?? 0))
  lines.push(
    usage.contextWindow === undefined
      ? `已用约 ${formatTokens(used)} token`
      : `已用 ${formatTokens(used)} / ${formatTokens(usage.contextWindow)}（${percent(used, usage.contextWindow)}）`,
  )

  const parts: string[] = []
  if (usage.messageTokens !== undefined) parts.push(`对话 ${formatTokens(usage.messageTokens)}`)
  if (usage.toolsTokens !== undefined) parts.push(`工具 ${formatTokens(usage.toolsTokens)}`)
  if (usage.systemTokens !== undefined) parts.push(`系统 ${formatTokens(usage.systemTokens)}`)
  // These two always agree; say so once rather than printing a mystery gap.
  if (parts.length > 0) lines.push(`　${parts.join(' · ')}`)

  const policy = input.compaction
  if (policy && usage.contextWindow !== undefined) {
    const trigger = Math.round(usage.contextWindow * policy.thresholdRatio)
    const keep = Math.round(usage.contextWindow * policy.retainRatio)
    lines.push(
      `压缩：到 ${formatTokens(trigger)} 才自动触发（${Math.round(policy.thresholdRatio * 100)}%），最近约 ${formatTokens(keep)} token 的对话原样保留`,
    )
    if (policy.source === 'default') lines.push('　（这是宿主默认值，preset 里没写死）')
  }
  lines.push(`长期记忆：${input.memoryFacts} 条（换会话也带着）`)
  return lines.join('\n')
}
