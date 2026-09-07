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
import type { Context } from '@deepseek-ai/cordis';
/** One persisted reminder. */
export interface Reminder {
    id: string;
    /** Epoch ms when the reminder fires. */
    at: number;
    /** Message text to deliver. */
    text: string;
    /** WeChat peer (sender id) the reminder belongs to. */
    peerId: string;
    createdAt: number;
}
/** Reminder store + scheduler bound to a cordis context. */
export declare class ReminderStore {
    private readonly ctx;
    private readonly file;
    private reminders;
    private timer;
    private loaded;
    constructor(ctx: Context, file?: string);
    /** Load persisted reminders and arm the scheduler. */
    start(): Promise<void>;
    /** Stop the scheduler (called on plugin dispose). */
    stop(): void;
    /** List reminders, soonest first. */
    list(): Reminder[];
    /**
     * Create a reminder that fires after `delayMs` (or at absolute `at`).
     * Persists immediately; a crashed/down process delivers it on next boot.
     */
    add(input: {
        delayMs?: number;
        at?: number;
        text: string;
        peerId: string;
    }): Promise<Reminder>;
    /** Remove a reminder by id. Returns true when it existed. */
    remove(id: string): Promise<boolean>;
    /** Format one reminder for display. */
    static describe(reminder: Reminder): string;
    private load;
    private save;
    /** (Re)arm a timer for the nearest future reminder; deliver anything due. */
    private arm;
    /** Push a reminder to its peer through the gateway (best-effort). */
    private deliver;
}
//# sourceMappingURL=reminders.d.ts.map