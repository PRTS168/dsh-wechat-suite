/**
 * WeChat command vocabulary: /sessions /use /new /stop /status /yes /no /help.
 *
 * Session targeting follows the spec: `/sessions` lists numbered sessions
 * (most recent first), `/use N` switches, `/new <prompt>` creates a fresh
 * agent+session, `/stop` cancels the active turn, `/status` reports the
 * active session. `/yes`/`/no` and bare `1`/`2` resolve pending approvals
 * (see `approvals.ts`).
 *
 * @module @dsh-cowork/chatnode-wechat/node/commands
 */

import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { WechatConversationNode } from './core.ts'
import { sendTextToPeer } from './outbound.ts'
import { sessionBadge, sessionName } from './labels.ts'

/**
 * Sessions ordered most-recent-first. Only `wechat-` prefixed sessions
 * qualify: this bundle bridges WeChat, and the hosting process may also run
 * the Web GUI against the SAME SessionStore — listing every session would let
 * `/sessions`, `/use`, and default targeting reach (or leak into) a web
 * session that no WeChat message should ever touch.
 */
export function listSessions(node: WechatConversationNode): Session[] {
  return [...node.ctx.sessions.list()]
    .filter((s) => String(s.id).startsWith('wechat-'))
    .sort((a, b) => {
      const diff = b.header.createdAt - a.header.createdAt
      if (diff !== 0) return diff
      return b.seq - a.seq
    })
}

/** Try to route one command. Returns true when the text was a command. */
export async function routeCommand(node: WechatConversationNode, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false

  // Approval replies are handled by the bridge even when no agent is active.
  if (trimmed === '/yes' || trimmed === '/no' || /^[12]$/.test(trimmed)) {
    if (node.resolveApproval(trimmed)) return true
  }

  const [command, ...rest] = trimmed.slice(1).split(/\s+/)
  switch (command) {
    case 'help':
      await sendTextToPeer(node, helpText())
      return true

    case 'sessions':
      await sendTextToPeer(node, renderSessions(node))
      return true

    case 'use': {
      const index = Number(rest[0])
      const sessions = listSessions(node)
      if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
        await sendTextToPeer(node, `❌ 无效编号。可用: 1–${sessions.length}（/sessions 查看列表）`)
        return true
      }
      const session = sessions[index - 1]!
      node.setActiveSession(session)
      await sendTextToPeer(node, `✅ 已切换到会话 #${index} ${sessionBadge(node, session)}`)
      return true
    }

    case 'new': {
      const prompt = rest.join(' ').trim()
      await node.createSession(prompt)
      return true
    }

    case 'stop': {
      const agent = node.activeAgent()
      if (!agent) {
        await sendTextToPeer(node, '❌ 没有活动的 agent')
      } else {
        agent.cancel({ kind: 'user' })
        await sendTextToPeer(node, '⏹ 已请求停止')
      }
      return true
    }

    // Picture delivery policy: a real image block for a multimodal route, or
    // OCR text for a text-only one. `auto` decides per routed model; the other
    // two override it until the bridge restarts.
    case '识图':
    case 'image': {
      const wanted = rest[0]?.toLowerCase()
      const current = node.imageInputMode()
      if (!wanted) {
        const route = node.currentModelRoute()
        const where = route ? `${route.provider}/${route.model}` : '（未知）'
        await sendTextToPeer(
          node,
          `🖼 图片识别模式：${current}\n` +
            `当前模型：${where}\n` +
            'auto — 能原生识图就原生，否则用 OCR（默认）\n' +
            'native — 强制原生图片输入（多模态模型）\n' +
            'ocr — 强制 OCR 文字识别（省 token，文档/截图更稳）\n' +
            `切换：/识图 auto | native | ocr`,
        )
        return true
      }
      if (wanted !== 'auto' && wanted !== 'native' && wanted !== 'ocr') {
        await sendTextToPeer(node, `❌ 未知模式 "${wanted}"。可用：auto / native / ocr`)
        return true
      }
      node.runtimeImageInput = wanted
      const note = '（本次运行生效；重启后回到配置值）'
      await sendTextToPeer(node, `✅ 图片识别模式已切换：${wanted} ${note}`)
      return true
    }

    case 'status': {      const agent = node.activeAgent()
      const session = node.activeSession()
      if (!session) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始，或 /sessions 查看已有会话。')
        return true
      }
      const status = agent?.status ?? 'idle'
      const lastTurn = [...session.events].reverse().find((e) => e.type === 'turn/end')
      const reason = lastTurn ? describeTurnEnd(lastTurn.data.reason) : '尚未运行'
      await sendTextToPeer(node, `📊 状态\n会话: ${sessionBadge(node, session)}\nagent: ${status}\n事件: ${session.seq} 条\n最近: ${reason}`)
      return true
    }

    case 'send': {
      const target = rest.join(' ').trim()
      if (!target) {
        await sendTextToPeer(node, '❌ 用法: /send <图片文件路径>')
        return true
      }
      const peer = node.peerId
      if (!peer) {
        await sendTextToPeer(node, '❌ 没有可回复的联系人')
        return true
      }
      await sendTextToPeer(node, '🖼 正在发送图片…')
      const result = await node.ctx.wechat.sendImage(peer, target)
      await sendTextToPeer(node, result.success ? '✅ 图片已发送' : `❌ 发送失败: ${result.error}`)
      return true
    }

    case 'model': {
      const options = await node.modelPickerOptions()
      if (options.length === 0) {
        await sendTextToPeer(node, '❌ 无法枚举模型（llm 服务不可用）。')
        return true
      }
      node.beginPicker('model', options)
      const menu = ['🧠 模型列表（回复数字切换）', ...options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n')
      await sendTextToPeer(node, menu)
      return true
    }

    case 'perm': {
      const options = node.permissionPickerOptions()
      if (options.length === 0) {
        await sendTextToPeer(node, '❌ 没有可用的权限预设（permission presets 未配置）。')
        return true
      }
      node.beginPicker('perm', options)
      const menu = ['🔐 权限预设列表（回复数字切换）', ...options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n')
      await sendTextToPeer(node, menu)
      return true
    }

    case '早安':
    case 'morning': {
      const svc = node.morningService
      if (!svc) {
        await sendTextToPeer(node, '❌ 早安推送服务不可用。')
        return true
      }
      const arg = rest.join(' ').trim()
      const cfg = svc.getConfig()
      if (arg === '' || arg === 'status') {
        const state = cfg.enabled ? '🟢 开启' : '⚪ 关闭'
        await sendTextToPeer(node,
          `🌤 早安推送\n状态: ${state}\n时间: 每天 ${cfg.time}\n地点: ${cfg.place}（${cfg.lat}, ${cfg.lon}）\n\n用法:\n/早安 on — 开启\n/早安 off — 关闭\n/早安 HH:MM — 改时间\n/早安 test — 立即试推一次`)
        return true
      }
      if (arg === 'on' || arg === 'off') {
        await svc.update({ enabled: arg === 'on' })
        await sendTextToPeer(node, arg === 'on' ? `✅ 早安推送已开启（每天 ${cfg.time}）` : '✅ 早安推送已关闭')
        return true
      }
      if (arg === 'test') {
        await sendTextToPeer(node, '📡 正在获取天气…')
        const text = await svc.pushNow()
        await sendTextToPeer(node, text)
        return true
      }
      if (/^\d{1,2}:\d{2}$/.test(arg)) {
        const [h, m] = arg.split(':').map(Number)
        if (h === undefined || m === undefined || h < 0 || h > 23 || m < 0 || m > 59) {
          await sendTextToPeer(node, `❌ 无效时间 ${arg}，用 HH:MM（24 小时制）。`)
          return true
        }
        const pad = (n: number) => String(n).padStart(2, '0')
        const time = `${pad(h)}:${pad(m)}`
        await svc.update({ time })
        await sendTextToPeer(node, `✅ 推送时间已改为每天 ${time}${cfg.enabled ? '' : '（当前未开启，/早安 on 开启）'}`)
        return true
      }
      await sendTextToPeer(node, `❌ 无法识别的参数 "${arg}"。\n用法: /早安 on|off|status|test|HH:MM`)
      return true
    }

    case '开灯':
    case '开灯1':
    case '开灯2':
    case '开灯3':
    case '关灯': {
      const result = await controlEsp32Light(node, command)
      await sendTextToPeer(node, result)
      return true
    }

    default:
      await sendTextToPeer(node, `❓ 未知命令 /${command}\n${helpText()}`)
      return true
  }
}

/** ESP32 gear label for each command. */
const ESP32_ROUTE: Record<string, string> = {
  '关灯': '/off',
  '开灯': '/high',   // plain /开灯 → gear 3 per user preference
  '开灯1': '/low',
  '开灯2': '/mid',
  '开灯3': '/high',
}

/** Fire one ESP32 light request (GET) and return a human result line. */
async function controlEsp32Light(node: WechatConversationNode, command: string): Promise<string> {
  const route = ESP32_ROUTE[command]
  const base = (node.config.esp32BaseUrl ?? 'http://192.168.1.11:80').replace(/\/+$/, '')
  if (!route) return `❌ 未知灯光命令 /${command}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(base + route, { signal: controller.signal })
    const text = (await res.text()).trim()
    if (!res.ok) return `❌ ESP32 响应异常（HTTP ${res.status}）`
    const label: Record<string, string> = { '/off': '关灯', '/low': '开灯（1 档·低）', '/mid': '开灯（2 档·中）', '/high': '开灯（3 档·高）' }
    const desc = label[route] ?? route
    return text ? `✅ ${desc}：${text}` : `✅ ${desc}`
  } catch (error) {
    return `❌ 无法连接 ESP32 灯光设备（${error instanceof Error ? error.message : String(error)}）`
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Handle a bare numbered reply against an active two-step picker (`/model`,
 * `/perm`) BEFORE it is routed to the model as ordinary text. Returns true
 * when the message was consumed by a picker.
 */
export async function routePickerReply(node: WechatConversationNode, text: string): Promise<boolean> {
  if (!node.hasActivePicker()) return false
  if (!/^\d+$/.test(text.trim())) return false
  const outcome = await node.resolvePicker(text.trim())
  return outcome === 'consumed'
}

function describeTurnEnd(reason: { kind: string }): string {
  switch (reason.kind) {
    case 'completed': return '✅ 完成'
    case 'error': return '❌ 出错'
    case 'aborted': return '⏹ 已停止'
    case 'blocked': return '⏸ 已阻塞'
    case 'max-tokens': return '⚠️ 输出截断'
    case 'interrupted': return '⚠️ 中断'
    default: return reason.kind
  }
}

function renderSessions(node: WechatConversationNode): string {
  const sessions = listSessions(node)
  if (sessions.length === 0) return '📋 没有会话。发送 /new <prompt> 开始。'
  const lines = sessions.map((session, i) => {
    const marker = session.id === node.activeSessionId ? ' ▶' : ''
    return `${i + 1}. ${sessionName(node, session)} — ${session.id}${marker}`
  })
  return `📋 会话列表（/use N 切换）\n${lines.join('\n')}`
}

function helpText(): string {
  return [
    '🤖 dsh-chatnode-wechat 命令',
    '/sessions — 列出会话',
    '/use N — 切换到会话 N',
    '/new <prompt> — 新建会话并开始',
    '/stop — 停止当前任务',
    '/status — 查看状态',
    '/send <路径> — 发送一张图片',
    '/model — 切换模型（两步菜单）',
    '/perm — 切换权限预设（两步菜单）',
    '/识图 — 图片识别模式（auto/native/ocr）',
    '/早安 — 每日天气推送开关（on/off/时间/test）',
    '/开灯 /关灯 /开灯1~3 — 控制灯光',
    '/yes /no 或 1/2 — 回应权限请求',
    '/help — 本帮助',
  ].join('\n')
}

/** Default session id prefix for /new-created sessions. */
export function newSessionId(node: WechatConversationNode): SessionId {
  return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
}
