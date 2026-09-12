/**
 * File-based control channel for the standalone admin page (`admin/server.ts`).
 *
 * The admin page is its own process and cannot reach into the host's session
 * registry, so "new / switch / forget a WeChat session" travels through a small
 * command queue instead of an API: the page drops a JSON file into
 * `$DSH_HOME/wechat-admin/queue/`, this module executes it inside the host (where
 * `sessions`/`agents` actually live) and writes the outcome to `done/`.
 *
 * Why files rather than HTTP:
 *   - the bridge already owns `$DSH_HOME`, and the admin page already reads it;
 *   - no port, no token, no callback surface inside the host process;
 *   - a command written while the bridge is down is simply executed on the next
 *     poll (or stays queued), instead of being lost.
 *
 * Hard rule (learned the expensive way on 2026-09-12): NOTHING here may produce
 * an unhandled rejection — the host treats one as a fatal load failure and takes
 * the whole profile down. Every path is wrapped; every log goes through `ctx.get`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/admin-control
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { WechatConversationNode } from './core.ts'

/** One queued instruction from the admin page. */
export interface ControlCommand {
  /** What to do. */
  op: 'new-session' | 'switch-session' | 'forget-session'
  /** `new-session`: optional first prompt (empty = an empty new session). */
  prompt?: string
  /** `switch-session` / `forget-session`: the target session id. */
  sessionId?: string
  /** `new-session`: suppress the chat announcement (default: announce). */
  announce?: boolean
}

/** Where the queue lives (shared with the admin page). */
export function adminControlDir(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-admin')
}

/** Never-throwing log for a context that may already be torn down. */
function note(node: WechatConversationNode, message: string): void {
  try {
    node.ctx.get('logger')?.info?.('[dsh-chatnode-wechat] admin-control: %s', message)
  } catch {
    // Nothing to log to.
  }
}

/** Execute one command; returns a result the admin page can display. */
async function run(node: WechatConversationNode, command: ControlCommand): Promise<{ ok: boolean; detail: string }> {
  switch (command.op) {
    case 'new-session': {
      const prompt = typeof command.prompt === 'string' ? command.prompt.trim() : ''
      await node.createSession(prompt, command.announce === false ? null : '')
      return { ok: true, detail: `已新建会话${prompt ? '（带初始提示词）' : ''}` }
    }
    case 'switch-session': {
      const id = String(command.sessionId ?? '')
      if (!id.startsWith('wechat-')) return { ok: false, detail: `拒绝：${id} 不是微信会话` }
      const session = node.ctx.sessions.get(id as never)
      if (!session) return { ok: false, detail: `会话不存在：${id}` }
      node.activeSessionId = session.id
      try {
        await node.ensureWechatTarget()
      } catch { /* target correction is best effort */ }
      return { ok: true, detail: `已切换到 ${id}` }
    }
    case 'forget-session': {
      const id = String(command.sessionId ?? '')
      // The admin page already moved the files aside; the host must stop
      // pointing at them, or the next inbound message would route into a session
      // whose log no longer exists.
      const wasActive = String(node.activeSessionId ?? '') === id
      if (wasActive) {
        node.activeSessionId = null
        try {
          await node.ensureWechatTarget()
        } catch { /* adopt whatever is left, or nothing */ }
      }
      return { ok: true, detail: wasActive ? `已删除并已切换走：${id}` : `已删除（非活跃）：${id}` }
    }
    default:
      return { ok: false, detail: `未知指令：${String((command as { op?: string }).op)}` }
  }
}

/**
 * Poll the queue and execute commands. Returns a disposer (clears the timer).
 *
 * `unref()` keeps the timer from holding the process open — the host has its own
 * lifetime, this poller must never be the reason it stays alive.
 */
export function attachAdminControl(node: WechatConversationNode, options: { intervalMs?: number } = {}): () => void {
  const queueDir = join(adminControlDir(), 'queue')
  const doneDir = join(adminControlDir(), 'done')
  let busy = false

  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      try {
        mkdirSync(queueDir, { recursive: true })
        mkdirSync(doneDir, { recursive: true })
      } catch {
        return // unwritable home: nothing to do, and definitely nothing to throw
      }
      let names: string[] = []
      try {
        names = readdirSync(queueDir).filter((name) => name.endsWith('.json')).sort()
      } catch {
        return
      }
      for (const name of names.slice(0, 5)) {
        const file = join(queueDir, name)
        let command: ControlCommand
        try {
          command = JSON.parse(readFileSync(file, 'utf8')) as ControlCommand
        } catch (error) {
          // A malformed file must not block the queue forever.
          try {
            renameSync(file, join(doneDir, `${name}.bad`))
          } catch { /* leave it */ }
          note(node, `丢弃无法解析的指令 ${name}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        let result: { ok: boolean; detail: string }
        try {
          result = await run(node, command)
        } catch (error) {
          result = { ok: false, detail: error instanceof Error ? error.message : String(error) }
        }
        try {
          writeFileSync(
            join(doneDir, `${name}.result.json`),
            JSON.stringify({ at: new Date().toISOString(), command, ...result }, null, 2),
          )
        } catch { /* report is best effort */ }
        try {
          rmSync(file, { force: true })
        } catch { /* the next poll will retry it */ }
        note(node, `${command.op} → ${result.ok ? 'ok' : 'failed'}: ${result.detail}`)
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    // `.catch` even though `tick` swallows its own errors: this is a fire-and-
    // forget call, and one escaping rejection here is fatal to the host.
    tick().catch(() => {})
  }, options.intervalMs ?? 2000)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
