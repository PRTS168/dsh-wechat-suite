/**
 * WeChat reminders: durable, natural-language-friendly scheduled alerts.
 *
 * The model-facing tools (`set_reminder` / `list_reminders` /
 * `cancel_reminder`, registered in `node/index.ts`) let the agent turn a
 * request like "30 分钟后提醒我喝水" into a persisted reminder. A scheduler
 * here fires due reminders by pushing a text message to the peer that created
 * them, through the `wechat` gateway service.
 *
 * Persistence: a JSON file (configurable via `reminderFile`, default under
 * `$DSH_HOME`) so reminders survive a DSH restart; on boot, due-while-down
 * reminders are still delivered once the plugin loads.
 *
 * @module @dsh-cowork/chatnode-wechat/node/reminders
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

/** One persisted reminder. */
export interface Reminder {
  id: string
  /** Epoch ms when the reminder fires. */
  at: number
  /** Message text to deliver. */
  text: string
  /** WeChat peer (sender id) the reminder belongs to. */
  peerId: string
  createdAt: number
}

/** Reminder store + scheduler bound to a cordis context. */
export class ReminderStore {
  private readonly ctx: Context
  private readonly file: string
  private reminders: Reminder[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private loaded = false
  private stopped = false
  /**
   * True when the file exists but could not be read. Saving in that state would
   * write the in-memory (empty) list over reminders that are still on disk.
   */
  private unreadable = false
  /** Whether the last persist reached the disk. */
  private lastSaveOk = true

  constructor(ctx: Context, file?: string, onProblem?: (kind: string, error: unknown, detail?: string) => void) {
    this.ctx = ctx
    this.file = file ?? defaultReminderFile()
    this.onProblem = onProblem
  }

  /** Where a swallowed failure goes; optional so the store works standalone. */
  private readonly onProblem?: (kind: string, error: unknown, detail?: string) => void

  /** Load persisted reminders and arm the scheduler. */
  async start(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.stopped = false
    await this.load()
    // The plugin can be torn down while the file read is still in flight; arming
    // afterwards would leave a live timer on a disposed context.
    if (this.stopped) return
    this.arm()
  }

  /** Stop the scheduler (called on plugin dispose). */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** List reminders, soonest first. */
  list(): Reminder[] {
    return [...this.reminders].sort((a, b) => a.at - b.at)
  }

  /**
   * Create a reminder that fires after `delayMs` (or at absolute `at`).
   * Persists immediately; a crashed/down process delivers it on next boot.
   */
  async add(input: { delayMs?: number; at?: number; text: string; peerId: string }): Promise<Reminder> {
    const at = input.at ?? Date.now() + (input.delayMs ?? 0)
    if (!Number.isFinite(at) || at <= Date.now()) {
      throw new Error('reminder time must be in the future')
    }
    const reminder: Reminder = {
      id: `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at,
      text: input.text.trim().slice(0, 500),
      peerId: input.peerId,
      createdAt: Date.now(),
    }
    if (!reminder.text) throw new Error('reminder text is required')
    this.reminders.push(reminder)
    this.lastSaveOk = await this.save()
    this.arm()
    return reminder
  }

  /** Remove a reminder by id. Returns true when it existed. */
  async remove(id: string): Promise<boolean> {
    const before = this.reminders.length
    this.reminders = this.reminders.filter((r) => r.id !== id)
    if (this.reminders.length === before) return false
    this.lastSaveOk = await this.save()
    this.arm()
    return true
  }

  /**
   * Whether the most recent persist actually reached the disk.
   *
   * A reminder that only exists in memory still fires while the process runs and
   * is gone after a restart, so `/提醒` reporting a plain "✅ 已设置" would be
   * promising more than the bridge can keep.
   */
  lastSaveSucceeded(): boolean {
    return this.lastSaveOk
  }

  /** Format one reminder for display. */
  static describe(reminder: Reminder): string {
    const d = new Date(reminder.at)
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    return `#${reminder.id} ${stamp} ${reminder.text}`
  }

  // -------------------------------------------------------------------------
  // Persistence + scheduling
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { reminders?: unknown }
      if (!Array.isArray(parsed.reminders)) {
        // Valid JSON with the wrong shape is still unreadable data: treating it
        // as "no reminders" and then saving would erase whatever is really in
        // there, exactly like a broken file.
        throw new Error('提醒文件的结构不对（reminders 不是数组）')
      }
      this.reminders = parsed.reminders as Reminder[]
      this.unreadable = false
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') {
        // No file yet: an empty store is the truth.
        this.reminders = []
        this.unreadable = false
        return
      }
      // A corrupt or unreadable file used to become `[]` silently: every
      // reminder vanished from view, and the next save wrote that emptiness
      // over the file for good.
      this.reminders = []
      this.unreadable = true
      this.ctx.logger?.warn?.(
        '[dsh-chatnode-wechat] reminder file unreadable (%s): %s',
        this.file,
        error instanceof Error ? error.message : String(error),
      )
      this.onProblem?.('reminders/load', error, `file=${this.file}`)
    }
  }

  /** Persist the list. Returns false (and says why) when it could not be saved. */
  private async save(): Promise<boolean> {
    if (this.unreadable) {
      const error = new Error(`提醒文件存在但读不出来，拒绝覆盖：${this.file}`)
      this.ctx.logger?.warn?.('[dsh-chatnode-wechat] %s', error.message)
      this.onProblem?.('reminders/save', error, `file=${this.file}`)
      return false
    }
    try {
      await mkdir(join(this.file, '..'), { recursive: true })
    } catch {
      // directory may already exist
    }
    const payload = JSON.stringify({ reminders: this.reminders }, null, 2)
    // temp + rename: a timer callback and a command can save at the same time,
    // and a half-written JSON file loses every reminder at once.
    const temp = `${this.file}.tmp-${process.pid}`
    try {
      await writeFile(temp, payload, 'utf8')
      await rename(temp, this.file)
      return true
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        // Nothing to clean up.
      }
      this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder persist failed: %s', error instanceof Error ? error.message : String(error))
      this.onProblem?.('reminders/save', error, `file=${this.file}`)
      return false
    }
  }

  /** (Re)arm a timer for the nearest future reminder; deliver anything due. */
  private arm(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const now = Date.now()
    // Deliver anything due (including reminders that fired while we were down).
    const due = this.reminders.filter((r) => r.at <= now)
    if (due.length > 0) {
      this.reminders = this.reminders.filter((r) => r.at > now)
      for (const reminder of due) {
        void this.deliver(reminder).catch((error) => {
          this.onProblem?.('reminders/deliver', error, `reminder=#${reminder.id}`)
        })
      }
      void this.save()
    }
    const next = this.reminders.reduce<Reminder | undefined>((best, r) => (best === undefined || r.at < best.at ? r : best), undefined)
    if (!next) return
    const delay = Math.max(0, next.at - Date.now())
    // setTimeout caps around 2^31-1 ms (~24.8 days); beyond that, re-arm on a
    // daily boundary instead of overflowing.
    const MAX_TIMEOUT = 2_147_000_000
    const armDelay = Math.min(delay, MAX_TIMEOUT)
    if (!Number.isFinite(armDelay) || armDelay < 0) {
      // Same guard as the morning scheduler: a NaN delay fires immediately and
      // the callback re-arms, which is a busy loop with no error anywhere.
      this.onProblem?.('reminders/clock', new Error(`无法计算下一次提醒时间（delay=${String(armDelay)}）`))
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.arm()
    }, armDelay)
    // A pending reminder must not keep the host process alive.
    this.timer.unref?.()
  }

  /** Push a reminder to its peer through the gateway (best-effort). */
  private async deliver(reminder: Reminder): Promise<void> {
    const wechat = this.ctx.wechat
    try {
      const result = await wechat.sendText(reminder.peerId, `⏰ 提醒：${reminder.text}`)
      if (!result.success) {
        // The owner is waiting for exactly this bubble; a log line he never
        // reads is not enough of a trace.
        this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder delivery failed for %s: %s', reminder.peerId, result.error)
        this.onProblem?.('reminders/deliver', new Error(result.error ?? 'sendText returned success=false'), `reminder=#${reminder.id}`)
      }
    } catch (error) {
      this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder delivery error: %s', error instanceof Error ? error.message : String(error))
      this.onProblem?.('reminders/deliver', error, `reminder=#${reminder.id}`)
    }
  }
}

/** Default reminder file under $DSH_HOME (mirrors the media-dir default). */
function defaultReminderFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wechat-reminders.json')
}
