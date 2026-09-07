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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
/** Reminder store + scheduler bound to a cordis context. */
export class ReminderStore {
    ctx;
    file;
    reminders = [];
    timer;
    loaded = false;
    constructor(ctx, file) {
        this.ctx = ctx;
        this.file = file ?? defaultReminderFile();
    }
    /** Load persisted reminders and arm the scheduler. */
    async start() {
        if (this.loaded)
            return;
        this.loaded = true;
        await this.load();
        this.arm();
    }
    /** Stop the scheduler (called on plugin dispose). */
    stop() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** List reminders, soonest first. */
    list() {
        return [...this.reminders].sort((a, b) => a.at - b.at);
    }
    /**
     * Create a reminder that fires after `delayMs` (or at absolute `at`).
     * Persists immediately; a crashed/down process delivers it on next boot.
     */
    async add(input) {
        const at = input.at ?? Date.now() + (input.delayMs ?? 0);
        if (!Number.isFinite(at) || at <= Date.now()) {
            throw new Error('reminder time must be in the future');
        }
        const reminder = {
            id: `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            at,
            text: input.text.trim().slice(0, 500),
            peerId: input.peerId,
            createdAt: Date.now(),
        };
        if (!reminder.text)
            throw new Error('reminder text is required');
        this.reminders.push(reminder);
        await this.save();
        this.arm();
        return reminder;
    }
    /** Remove a reminder by id. Returns true when it existed. */
    async remove(id) {
        const before = this.reminders.length;
        this.reminders = this.reminders.filter((r) => r.id !== id);
        if (this.reminders.length === before)
            return false;
        await this.save();
        this.arm();
        return true;
    }
    /** Format one reminder for display. */
    static describe(reminder) {
        const d = new Date(reminder.at);
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return `#${reminder.id} ${stamp} ${reminder.text}`;
    }
    // -------------------------------------------------------------------------
    // Persistence + scheduling
    // -------------------------------------------------------------------------
    async load() {
        try {
            const raw = await readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            this.reminders = Array.isArray(parsed.reminders) ? parsed.reminders : [];
        }
        catch {
            this.reminders = [];
        }
    }
    async save() {
        try {
            await mkdir(join(this.file, '..'), { recursive: true });
        }
        catch {
            // directory may already exist
        }
        const payload = JSON.stringify({ reminders: this.reminders }, null, 2);
        try {
            await writeFile(this.file, payload, 'utf8');
        }
        catch (error) {
            this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder persist failed: %s', error instanceof Error ? error.message : String(error));
        }
    }
    /** (Re)arm a timer for the nearest future reminder; deliver anything due. */
    arm() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const now = Date.now();
        // Deliver anything due (including reminders that fired while we were down).
        const due = this.reminders.filter((r) => r.at <= now);
        if (due.length > 0) {
            this.reminders = this.reminders.filter((r) => r.at > now);
            for (const reminder of due) {
                void this.deliver(reminder);
            }
            void this.save();
        }
        const next = this.reminders.reduce((best, r) => (best === undefined || r.at < best.at ? r : best), undefined);
        if (!next)
            return;
        const delay = Math.max(0, next.at - Date.now());
        // setTimeout caps around 2^31-1 ms (~24.8 days); beyond that, re-arm on a
        // daily boundary instead of overflowing.
        const MAX_TIMEOUT = 2_147_000_000;
        const armDelay = Math.min(delay, MAX_TIMEOUT);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.arm();
        }, armDelay);
    }
    /** Push a reminder to its peer through the gateway (best-effort). */
    async deliver(reminder) {
        const wechat = this.ctx.wechat;
        try {
            const result = await wechat.sendText(reminder.peerId, `⏰ 提醒：${reminder.text}`);
            if (!result.success) {
                this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder delivery failed for %s: %s', reminder.peerId, result.error);
            }
        }
        catch (error) {
            this.ctx.logger?.warn?.('[dsh-chatnode-wechat] reminder delivery error: %s', error instanceof Error ? error.message : String(error));
        }
    }
}
/** Default reminder file under $DSH_HOME (mirrors the media-dir default). */
function defaultReminderFile() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wechat-reminders.json');
}
//# sourceMappingURL=reminders.js.map