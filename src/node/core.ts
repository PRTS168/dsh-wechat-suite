/**
 * WechatConversationNode — the orchestration state behind the
 * `wechat-conversation-node` plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 *
 * @module @dsh-cowork/chatnode-wechat/node/core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  chatService,
  platformEvents,
  platformLabel,
  platformNamespace,
  resolvePlatformPlan,
  type ChatPlatform,
  type PlatformCapabilities,
  type PlatformEvents,
  type PlatformId,
} from '../platform/index.ts'
import type { PendingApproval } from './approvals.ts'
import { attachApprovalBridge } from './approvals.ts'
import { attachSessionOutbound, sendTextToPeer } from './outbound.ts'
import { handleInbound } from './inbound.ts'
import { attachAdminControl } from './admin-control.ts'
import { describeError } from './net.ts'
import {
  buildHandoff,
  parseContextPolicy,
  rotationReason,
  signalsFromEvents,
  transcriptFromEvents,
  type ContextPolicy,
} from './context-policy.ts'
import { listSessions, newSessionId } from './commands.ts'
import { sessionBadge } from './labels.ts'
import type { MorningService } from './morning.ts'
import { ProblemReporter, defaultProblemFile } from './problems.ts'
import { readContextUsage } from './context-report.ts'
import type { MemoryService } from './memory.ts'
import type { InboundMessage } from '../gateway/types.ts'

/**
 * One entry from `sessionPersistence.list()`.
 *
 * DSH 0.1.5 returns `SessionPersistenceSnapshot`, which carries the identity
 * under `.header`; older versions exposed `id`/`createdAt` at the top level.
 * Both are accepted so the bridge runs on either.
 */
export interface PersistenceEntry {
  id?: string
  createdAt?: number
  header?: { id?: string; createdAt?: number }
}

/**
 * The host permission-preset service, as actually shaped by the host.
 *
 * It is **session-scoped**: `current(session)` and `set(session, name)` take a
 * session, and menu labels come from `optionOf()`. Getting this wrong is
 * invisible — the throw escapes `routeCommand`, the inbound handler swallows it
 * and the user simply gets no answer at all. That is exactly what `/perm` did
 * while this code passed an event array to `current()`.
 */
export interface HostPermissionPresets {
  names?: readonly string[]
  current(session: unknown): string
  resolve(name: string): { name?: string; description?: string }
  optionOf?(name: string): { name?: string; description?: string }
  set?(session: unknown, name: string): void
}

/**
 * Pick the newest persisted session **of this platform**, or undefined if none.
 *
 * The prefix is a parameter, not a constant: the session store is shared with
 * the Web GUI *and* with the other platform's profile, so "newest session on
 * disk" is meaningless without saying whose.
 */
export function selectNewestSession(
  entries: readonly PersistenceEntry[],
  prefix: string,
): { id: string; createdAt: number } | undefined {
  const mine = entries
    .map((entry) => ({ id: entry.header?.id ?? entry.id, createdAt: entry.header?.createdAt ?? entry.createdAt ?? 0 }))
    .filter((entry): entry is { id: string; createdAt: number } => typeof entry.id === 'string' && entry.id.length > 0)
    .filter((entry) => entry.id.startsWith(prefix))
    .sort((a, b) => b.createdAt - a.createdAt)
  return mine[0]
}

/** Kept for callers written before the platform seam; means "newest WeChat one". */
export function selectNewestWechat(entries: readonly PersistenceEntry[]): { id: string; createdAt: number } | undefined {
  return selectNewestSession(entries, 'wechat-')
}

/** The runtime `SessionId` is a branded string; the brand is erased at runtime. */
function asSessionId(id: string): SessionId {
  return id as unknown as SessionId
}

/**
 * Where one outbound message goes: which platform, which peer, and the gateway
 * service that can actually send it.
 *
 * The three travel together on purpose. In a merged profile `peerId` alone is
 * ambiguous — a WeChat `wxid_…` and a QQ `user_openid` are both just strings —
 * and sending a QQ peer's answer through the WeChat gateway (or the reverse) is
 * exactly the failure this type exists to make impossible.
 */
export interface OutboundTarget {
  /** The platform the message belongs to. */
  platform: PlatformId
  /** The peer on that platform. */
  peerId: string
  /**
   * That platform's gateway, or undefined when its service is not mounted.
   *
   * Undefined means "cannot send", never "send on the other platform": a reply
   * that arrives on the wrong side is worse than a reply that did not arrive,
   * because the owner cannot even tell it happened.
   */
  chat?: ChatPlatform
}

/** The `{platform, peerId}` pair the turn-target FIFO and the last-used fallback hold. */
interface TargetKey {
  platform: PlatformId
  peerId: string
}

/** Runtime shape of the node plugin's config (defaults applied). */
export interface NodeConfig {
  /** Hard allowlist of WeChat sender ids allowed to drive the agent. REQUIRED. */
  allowFrom: string[]
  /** Chat platform this node serves; see platform/index.ts. */
  platform?: PlatformId
  /**
   * The platform this node serves, as a list. Only ever one entry; unwritten
   * means "just `platform`" — the behaviour every profile written before this key
   * had.
   */
  platforms?: PlatformId[]
  /**
   * Per-platform allowlists, e.g. `{ qq: ['<user_openid>'] }`.
   *
   * Lookup rule: a platform with its own entry uses it, every other platform
   * uses `allowFrom`. An entry that is an **empty list** means "this platform
   * accepts nobody" — the strict reading, because the alternative is falling
   * back to a WeChat id list and letting a QQ stranger through.
   */
  allowFromByPlatform?: Record<string, string[]>
  /** Heartbeat interval for progress digests (seconds; 0 disables). */
  digestIntervalSec: number
  /** Approval prompt timeout before default-deny (seconds). */
  approvalTimeoutSec: number
  /** Max chars per WeChat bubble. */
  maxMessageChars: number
  /** Throttle between outbound bubbles (ms). */
  sendChunkDelayMs: number
  /** Working directory for `/new` sessions. */
  cwd?: string
  /** Directory inbound images are saved to (defaults under $DSH_HOME). */
  mediaDir?: string
  /**
   * How an inbound image reaches the model:
   * - `auto` (default) — send a real image block when the routed model declares
   *   `image` input, otherwise fall back to the OCR text path;
   * - `native` — force the image block; fall back to OCR only after the
   *   provider itself refuses one;
   * - `ocr` — always use the OCR text path (cheaper for documents/screenshots).
   */
  imageInput?: 'auto' | 'native' | 'ocr'
  /**
   * Explicit `provider/model` used for native image input. When set, this route
   * is probed for image support instead of the chat route — useful when the
   * chat model is text-only but a vision route is available for pictures.
   */
  imageInputModel?: string
  /** SiliconFlow API key for DeepSeek-OCR (sk-…). Empty/absent disables OCR. */
  ocrApiKey?: string
  /** DeepSeek-OCR model id (defaults to deepseek-ai/DeepSeek-OCR). */
  ocrModel?: string
  /** OpenAI-compatible base URL for OCR (defaults to SiliconFlow). */
  ocrBaseUrl?: string
  /** JSON file reminders persist to (defaults to $DSH_HOME/wechat-reminders.json). */
  reminderFile?: string
  /** JSON file the morning-greeting config persists to (defaults under $DSH_HOME). */
  morningFile?: string
  /** Markdown file holding long-term facts about the owner (defaults under $DSH_HOME). */
  memoryFile?: string
  /** Append-only problem log (defaults under $DSH_HOME). */
  problemFile?: string
  /** Inject the memory briefing on the first message and every N messages. */
  memoryInjectEvery?: number
  /** Wall-clock "HH:MM" for the daily memory consolidation (empty disables). */
  memoryConsolidateTime?: string
  /** ESP32 PWM light base url (defaults to http://<esp32-ip>:80). */
  esp32BaseUrl?: string
  /** SiliconFlow API key for image generation (defaults to ocrApiKey when absent). */
  imageGenApiKey?: string
  /** Image generation model id (defaults to Kwai-Kolors/Kolors). */
  imageGenModel?: string
  /** Where generated images are saved (defaults to <mediaDir>/generated). */
  imageGenDir?: string
  /** SiliconFlow API key for speech-to-text (defaults to ocrApiKey when absent). */
  sttApiKey?: string
  /** ASR model id (defaults to XingChenAGI/XingChenASR-V3.2-Ultra). */
  sttModel?: string
  /** SiliconFlow API key for TTS (defaults to ocrApiKey when absent). */
  ttsApiKey?: string
  /** TTS model id (defaults to FunAudioLLM/CosyVoice2-0.5B). */
  ttsModel?: string
  /** Cloned voice uri used for speech replies (e.g. speech:my-clone:…). */
  ttsVoice?: string
  /** Agent preset name for `/new` sessions. */
  agentPreset?: string
  /** Provider route for `/new` agents. */
  agentProvider?: string
  /** Model id for `/new` agents. */
  agentModel?: string
  /**
   * Context-management scheme (JSON). Parsed by `context-policy.ts`; `manual`
   * or absent keeps the legacy behaviour (rotate only when a human types /new).
   */
  contextPolicy?: string
}

export class WechatConversationNode {
  /** The active session the WeChat user drives. */
  activeSessionId: SessionId | null = null

  /**
   * The allowlisted peer outbound currently goes to — the target of the turn in
   * flight, or the last peer that spoke (see {@link currentTarget}).
   *
   * Kept as a property because it predates the platform seam and a dozen call
   * sites read it; assigning to it is the "one known peer" shortcut and means
   * "on the primary platform". The real routing state is the target FIFO below.
   */
  get peerId(): string | null {
    return this.lastTarget?.peerId ?? null
  }

  set peerId(value: string | null) {
    this.lastTarget = value ? { platform: this.platform, peerId: value } : undefined
  }

  /**
   * Runtime override for {@link NodeConfig.imageInput}, set by the `/识图`
   * command. Survives until the bridge process restarts; config remains the
   * source of truth for the next boot.
   */
  runtimeImageInput: 'auto' | 'native' | 'ocr' | null = null

  /**
   * The long-term memory briefing for one inbound message, or '' when this
   * message should not carry one. Injection cadence lives in the service.
   */
  memoryPreamble(): string {
    try {
      const sessionId = this.activeSessionId === null ? '(none)' : String(this.activeSessionId)
      return this.memoryService?.briefing(sessionId) ?? ''
    } catch (error) {
      // A memory failure must never block a message from being handled — but it
      // must not vanish either: a silent '' means the owner's identity facts are
      // simply absent from that message with nothing to explain it.
      this.problems.report('memory/briefing', error, { notify: false })
      return ''
    }
  }

  /** Effective image-delivery policy (runtime override, else config). */
  imageInputMode(): 'auto' | 'native' | 'ocr' {
    return this.runtimeImageInput ?? this.config.imageInput ?? 'auto'
  }

  private readonly pending = new Map<number, PendingApproval>()
  private approvalCounter = 0
  private disposers: Array<() => void> = []

  /** Two-step picker state (`/model`, `/perm`): waiting for a numbered reply. */
  private picker: { kind: 'model' | 'perm'; options: Array<{ label: string; value: string }>; timer: ReturnType<typeof setTimeout> } | null = null

  /** Per-agent mutable model selection (lazily installed, mirroring the host). */
  private readonly agentSelections = new WeakMap<Agent, ModelSelectionRef>()

  /** Morning-greeting scheduler, when the plugin mounted one. */
  morningService?: MorningService

  /** Long-term memory (facts about the owner), when the plugin mounted one. */
  memoryService?: MemoryService

  /**
   * The problem ledger. Always present — a swallowed failure must have somewhere
   * to go even before any service is wired, and `/problems` reads it.
   */
  readonly problems: ProblemReporter

  /**
   * Last gateway status seen (`wechat/status`), and when. `/status` reports it:
   * a bridge whose poller died otherwise looks identical to a quiet day.
   *
   * These two mirror the **primary** platform so every existing caller (and
   * `tests`) keeps working; {@link gatewayStatusFor} reads any platform.
   */
  gatewayStatus = 'unknown'
  gatewayStatusAt = ''

  /** Per-platform mirror of the two fields above (each platform reports its own). */
  private readonly platformStatuses = new Map<PlatformId, { status: string; at: string }>()

  readonly ctx: Context
  readonly config: NodeConfig

  /**
   * The chat platform this node serves, resolved once from config.
   *
   * Everything platform-specific goes through {@link chat}: the gateway is
   * mounted under this id and emits `<platform>/…` events, so the node never
   * names a platform itself. Defaults to WeChat, which is what every existing
   * profile configured by saying nothing.
   *
   * In merge mode this is the **primary** platform: it names the session
   * namespace, the default on-disk locations and the outbound fallback. The
   * other mounted platform(s) live in {@link platforms}.
   */
  readonly platform: PlatformId

  /**
   * Every platform this node is subscribed to, primary first — one element
   * unless the profile asked for merge mode.
   *
   * The node subscribes to each of them (message/status/error/fatal) and each
   * inbound message carries its own platform into the turn target, so one brain
   * answers whichever channel the owner used, on that channel only.
   */
  readonly platforms: readonly PlatformId[]

  /**
   * Outbound targets of the turns in flight, oldest first.
   *
   * A turn's replies are asynchronous — heartbeats, tool calls, the final
   * answer — while the owner can start another turn from the other platform
   * meanwhile. Binding the target at inbound time and releasing it at `turn/end`
   * is what keeps "QQ said something while WeChat's turn was running" from
   * delivering the WeChat answer to QQ. Entries are pushed only when a message
   * really becomes a turn: a command or a menu reply produces no `turn/end`, so
   * a queued target would never drain and would misroute the next real answer.
   */
  private readonly turnTargets: TargetKey[] = []

  /** The last peer that spoke (any platform); the fallback when no turn is open. */
  private lastTarget: TargetKey | undefined

  /**
   * The gateway of one platform, or undefined while it is not mounted.
   *
   * Two of these are live at once in merge mode, and every outbound path has to
   * go through the *target's* one — see {@link currentTarget}.
   */
  chatFor(platform: PlatformId): ChatPlatform | undefined {
    return chatService(this.ctx, platform)
  }

  /**
   * What one platform can actually do (images, files, voice, reply budget), as
   * declared by its own gateway — not by the primary's.
   *
   * A merged profile can hold a WeChat gateway that sends images and a QQ
   * gateway that cannot; asking the primary would promise the QQ user a picture
   * that the QQ API will refuse after the image was generated and paid for.
   */
  capabilitiesFor(platform: PlatformId): PlatformCapabilities | undefined {
    return this.chatFor(platform)?.capabilities
  }

  /** The active platform's service, or undefined while its gateway is unmounted. */
  get chat(): ChatPlatform | undefined {
    return chatService(this.ctx, this.platform)
  }

  /**
   * Where this turn's outbound messages go: queue head → last peer that spoke →
   * the primary platform's first allowlisted id.
   *
   * The last step is what lets a proactive push (a reminder, an admin
   * announcement, a rotation notice) leave the bridge at all when nothing has
   * been said yet — the owner's own allowlisted id is the only defensible
   * recipient. Returns undefined only when there is nobody to address.
   */
  currentTarget(): OutboundTarget | undefined {
    const chosen = this.turnTargets[0] ?? this.lastTarget ?? this.fallbackTarget()
    if (!chosen) return undefined
    const chat = this.chatFor(chosen.platform)
    return chat ? { ...chosen, chat } : { ...chosen }
  }

  /** Queue depth of the turn targets (diagnostics and tests). */
  pendingTurnTargets(): number {
    return this.turnTargets.length
  }

  /**
   * Record where a message came from: it becomes "the peer that spoke last".
   *
   * Called only for messages that passed the allowlist — a stranger's message
   * must not be able to steer where the bridge answers.
   */
  noteInboundTarget(platform: PlatformId, peerId: string): void {
    this.lastTarget = { platform, peerId }
  }

  /** Bind the outbound target of a turn that is about to start (FIFO tail). */
  beginTurnTarget(platform: PlatformId, peerId: string): void {
    this.turnTargets.push({ platform, peerId })
  }

  /** The turn ended: its target leaves the queue (`turn/end`). */
  endTurnTarget(): void {
    this.turnTargets.shift()
  }

  /**
   * The turn never started (submitting it threw), so take back the target that
   * was just bound. Leaving it queued would misroute the next answer, because
   * nothing will ever dequeue it.
   */
  dropTurnTarget(): void {
    this.turnTargets.pop()
  }

  /**
   * Submit a turn for the peer that spoke last, binding it as this turn's
   * outbound target.
   *
   * `/new <prompt>` is the one place a chat message starts a turn from inside the
   * node instead of from `inbound.ts`, so it has to bind the target the same way
   * — otherwise the answer to "QQ 用户开了个新会话" would go to WeChat.
   */
  submitForLastTarget(submit: () => void): void {
    const target = this.lastTarget
    if (target) this.beginTurnTarget(target.platform, target.peerId)
    try {
      submit()
    } catch (error) {
      if (target) this.dropTurnTarget()
      throw error
    }
  }

  /**
   * Which platform a bare peer id belongs to — for the pushes that carry only a
   * peer (a persisted reminder), never a platform.
   *
   * Explicit per-platform allowlists are the honest source: put each platform's
   * ids in `allowFromByPlatform` and every reminder finds its way back to the
   * channel it was asked for. Anything unrecognised falls to the primary
   * platform, which is exactly what a single-platform profile always did.
   */
  platformForPeer(peerId: string): PlatformId {
    for (const platform of this.platforms) {
      if ((this.config.allowFromByPlatform?.[platform] ?? []).includes(peerId)) return platform
    }
    return this.platform
  }

  /** Nobody has spoken yet: address the primary platform's first allowlisted id. */
  private fallbackTarget(): TargetKey | undefined {
    const peerId = (this.config.allowFrom ?? [])[0]
    return peerId ? { platform: this.platform, peerId } : undefined
  }

  /** Events of the active platform (`<platform>/message`, `…/error`, …). */
  get events(): PlatformEvents {
    return platformEvents(this.platform)
  }

  /**
   * Context-management policy for this conversation (see context-policy.ts).
   * `manual` reproduces the legacy behaviour: the session grows until a human
   * types `/new`.
   */
  readonly contextPolicy: ContextPolicy

  /** Re-entrancy guard: one rotation at a time. */
  private rotating = false

  /**
   * A rotation's handoff note, waiting for the owner's next message.
   *
   * Deliberately NOT submitted as a turn of its own: doing that produced an extra
   * unsolicited reply on every rotation (a fresh-session greeting), because a user
   * message — fenced or not — starts a turn. The note rides along with the next
   * real inbound message instead, so a rotation costs zero extra replies.
   */
  private pendingHandoff: string | null = null

  /**
   * 交接摘要"真的被一条消息带走"之后要做的事（合并模式用它删掉磁盘上的
   * `pending/<platform>.md`）。
   *
   * 删除**推迟到这一步**是有意的：摘要文件是那段历史的唯一副本，排进队列就删，
   * 进程在两条消息之间退出就等于把它丢了。宁可下次启动再排一次。
   */
  private onHandoffTaken: (() => void) | undefined

  constructor(ctx: Context, config: NodeConfig) {
    this.ctx = ctx
    this.config = config
    // Merge mode lives entirely in this resolution: write two platforms and both
    // gateways feed one node; write none and `platform` decides, exactly as
    // before. `platform` stays the primary either way (namespace, default paths).
    const plan = resolvePlatformPlan(config.platforms, config.platform)
    this.platform = plan.primary
    this.platforms = plan.platforms
    if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
      const idKind = this.platform === 'qq' ? 'QQ user_openid' : 'WeChat sender id'
      throw new Error(
        `dsh-chatnode-wechat: allowFrom is REQUIRED and must list at least one ${idKind}. ` +
        'An agent that accepts instructions from any contact is a prompt-injection front door.',
      )
    }
    // 台账按平台分开：两个 profile 共用一个 $DSH_HOME，一份 wechat-problems.log
    // 会让 QQ 的失败在 /problems 里看起来像微信的。（合并模式下**本来**就是同一个
    // 桥、同一段会话，所以共用主平台那一份是对的。）
    this.problems = new ProblemReporter({ file: config.problemFile ?? defaultProblemFile(this.platform) })
    this.contextPolicy = parseContextPolicy(config.contextPolicy, (kind, error, detail) => {
      this.problems.report(kind, error, detail === undefined ? { notify: false } : { notify: false, detail })
    })
    this.disposers.push(attachSessionOutbound(this))
    this.disposers.push(attachApprovalBridge(this))
    this.disposers.push(attachContextRotation(this))
    this.disposers.push(attachGatewayObservability(this))
    this.disposers.push(attachAdminControl(this))
    for (const platform of this.platforms) {
      const events = platformEvents(platform)
      const disposer = this.ctx.on(events.message, (message: InboundMessage) => {
        // Same fatal-rejection rule as the credentials boot in src/index.ts: a
        // throw escaping an event handler becomes an unhandled rejection, and the
        // host treats that as a fatal load failure. Handling one chat message must
        // never be able to take the whole harness down — record it and stay alive.
        //
        // The platform travels with the message: it decides the user fence, the
        // media directory, the reply's gateway and the allowlist to check.
        handleInbound(this, message, platform).catch((error) => {
          this.problems.report('inbound', error, {
            detail: `platform=${platform} message=${message.message_id ?? '?'}`,
          })
        })
      })
      // Keep the disposer: relying on the fiber alone means the listener survives
      // an explicit dispose() and keeps handling messages for a torn-down node.
      this.disposers.push(disposer)
    }
    this.pickDefaultSession()
  }

  /** Whether a rotation is currently in flight (used by tests and the guard). */
  isRotating(): boolean {
    return this.rotating
  }

  /** Claim the rotation slot; returns false when one is already running. */
  beginRotation(): boolean {
    if (this.rotating) return false
    this.rotating = true
    return true
  }

  /** Release the rotation slot. */
  endRotation(): void {
    this.rotating = false
  }

  /** Take the queued rotation note for the next inbound message (once). */
  consumeHandoff(): string {
    const note = this.pendingHandoff
    this.pendingHandoff = null
    const taken = this.onHandoffTaken
    this.onHandoffTaken = undefined
    if (note) {
      // 「带走」= 这条摘要已经进了那条即将提交给模型的消息。此时删掉磁盘上的
      // 交接文件是安全的：它要送的那段历史已经在这条消息里。
      try {
        taken?.()
      } catch (error) {
        this.problems.report('merge/handoff', error, { notify: false })
      }
    }
    return note ?? ''
  }

  /**
   * Queue a rotation note for the next inbound message.
   *
   * `onTaken` 是可选的一次性回调（合并模式用它删除已消费的交接文件）；不给它
   * 就等价于从前那版——轮换交接没有任何副作用。
   */
  setPendingHandoff(note: string | null, onTaken?: () => void): void {
    this.pendingHandoff = note && note.trim() ? note : null
    this.onHandoffTaken = this.pendingHandoff ? onTaken : undefined
  }

  /** Whether a rotation note is waiting (tests and diagnostics). */
  hasPendingHandoff(): boolean {
    return this.pendingHandoff !== null
  }

  /** The active WeChat session, if any. Never a non-`wechat-` session: this
   *  process shares its SessionStore with the Web GUI, and an inbound WeChat
   *  message must never be routed into a web conversation. */
  activeSession(): Session | undefined {
    if (!this.activeSessionId) return undefined
    if (!this.isOwnSessionId(this.activeSessionId)) return undefined
    return this.ctx.sessions.get(this.activeSessionId)
  }

  /** The agent driving the active WeChat session, if any. */
  activeAgent(): Agent | undefined {
    const session = this.activeSession()
    if (!session) return undefined
    return this.ctx.agents.get(session.id)
  }

  /**
   * Whether the bridge drives the given agent.
   *
   * Compared as **strings**: a session id may be a branded `SessionId` object on
   * some hosts (the package exports both an identity function and a constructor),
   * and `===` against a plain string then answers "not ours" for the bridge's own
   * agent — which is how a permission request once ended up delegated and
   * invisible. A null active id means "any `wechat-` session", i.e. the bridge's
   * own namespace.
   */
  ownsAgent(agent: Agent): boolean {
    const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
    if (!this.isWechatSessionId(id)) return false
    return this.activeSessionId === null || String(this.activeSessionId) === String(id)
  }

  /**
   * The prefix every session of this bridge carries.
   *
   * Answers `wechat-` / `qq-` — the on-disk contract those profiles already
   * have, and the namespace their sessions live in.
   *
   * Single source of truth: seven places ask "is this session mine?", and each of
   * them used to hardcode `'wechat-'`. Fixing one and missing the others would
   * take the bridge down silently — empty `/sessions`, `/use` doing nothing,
   * outbound refusing to send, approvals all delegated, admin page blank.
   */
  sessionPrefix(): string {
    return platformNamespace(this.platform)
  }

  /** Whether a session id belongs to this bridge (i.e. to this platform). */
  isOwnSessionId(id: unknown): boolean {
    return id !== null && id !== undefined && String(id).startsWith(this.sessionPrefix())
  }

  /** Kept for call sites written before the platform seam; platform-correct now. */
  isWechatSessionId(id: unknown): boolean {
    return this.isOwnSessionId(id)
  }

  /** Whether a sender is allowlisted on this node's own (primary) platform. */
  isAllowed(senderId: string): boolean {
    return this.isAllowedFor(this.platform, senderId)
  }

  /**
   * Whether a sender may drive the agent **on one platform**.
   *
   * A platform with its own `allowFromByPlatform` entry answers from it; every
   * other platform falls back to `allowFrom`. An entry that exists but is empty
   * allows nobody: falling back to the WeChat id list instead would mean a QQ
   * stranger passes a gate the owner never opened for that channel.
   */
  isAllowedFor(platform: PlatformId, senderId: string): boolean {
    const list = this.config.allowFromByPlatform?.[platform] ?? this.config.allowFrom
    return Array.isArray(list) && list.includes(senderId)
  }

  /** The (primary) gateway's own account id (used for group detection). */
  get gatewayAccountId(): string {
    return this.gatewayAccountIdFor(this.platform)
  }

  /**
   * One platform's own account id, or '' when its gateway does not publish one.
   *
   * Group detection compares the message's `to_user_id` against the account that
   * received it, so it has to be the **source** platform's id: in a merged
   * profile the QQ message carries the QQ AppID as `to_user_id`, and comparing
   * that against WeChat's account id classifies every QQ单聊 message as a group
   * message — which is dropped in silence. A platform without an account id
   * answers '', which is the "cannot tell → not a group" default the QQ gateway
   * already relied on.
   */
  gatewayAccountIdFor(platform: PlatformId): string {
    return this.chatFor(platform)?.accountId ?? ''
  }

  /**
   * Last status seen for one platform, and when ('' when none was ever seen).
   *
   * The primary platform also reads the two legacy fields when no status event
   * has been recorded for it: those fields are still written from outside (a
   * dozen callers and tests set them directly), and `/status` reading a stale
   * internal map instead of them would silently report "unknown" forever.
   */
  gatewayStatusFor(platform: PlatformId): { status: string; at: string } {
    const seen = this.platformStatuses.get(platform)
    if (seen) return seen
    if (platform === this.platform && (this.gatewayStatus !== 'unknown' || this.gatewayStatusAt)) {
      return { status: this.gatewayStatus, at: this.gatewayStatusAt }
    }
    return { status: 'unknown', at: '' }
  }

  /**
   * Record one platform's gateway status.
   *
   * Both platforms report into the same node now, so the value cannot be a single
   * field: "QQ never came up" would be invisible behind WeChat's cheerful
   * `connected`. The primary's status is mirrored onto {@link gatewayStatus} /
   * {@link gatewayStatusAt} for every caller written before merge mode.
   */
  noteGatewayStatus(platform: PlatformId, status: string): void {
    const at = new Date().toISOString()
    this.platformStatuses.set(platform, { status, at })
    if (platform === this.platform) {
      this.gatewayStatus = status
      this.gatewayStatusAt = at
    }
  }

  /** Switch the active session and reply confirmation to the peer. */
  setActiveSession(session: Session): void {
    this.activeSessionId = session.id
  }

  /** Pick the most recent WeChat session as the default (zero-config targeting).
   *  Only `wechat-` prefixed sessions qualify: this process hosts the Web GUI
   *  too, whose sessions share the same SessionStore — routing an inbound
   *  WeChat message to a web session would leak it into the wrong conversation.
   */
  pickDefaultSession(): void {
    const sessions = listSessions(this).filter((s) => this.isOwnSessionId(s.id))
    if (sessions.length > 0) this.activeSessionId = sessions[0]!.id
  }

  // -------------------------------------------------------------------------
  // Two-step pickers (/model, /perm) and runtime model/permission switching
  // -------------------------------------------------------------------------

  /** Whether a plain (non-command) message is consumed by an active picker. */
  hasActivePicker(): boolean {
    return this.picker !== null
  }

  /** Start a numbered-menu picker; callers send the menu text themselves. */
  beginPicker(kind: 'model' | 'perm', options: Array<{ label: string; value: string }>, timeoutSec = 120): void {
    if (this.picker) clearTimeout(this.picker.timer)
    const timer = setTimeout(() => {
      this.picker = null
    }, timeoutSec * 1000)
    timer.unref?.()
    this.picker = { kind, options, timer }
  }

  /** Resolve a numbered reply against the active picker. */
  async resolvePicker(reply: string): Promise<'consumed' | 'ignored'> {
    const picker = this.picker
    if (!picker) return 'ignored'
    const index = Number(reply.trim())
    if (!Number.isInteger(index) || index < 1 || index > picker.options.length) {
      await sendTextToPeer(this, `❌ 无效编号，请输入 1–${picker.options.length}。`)
      return 'consumed'
    }
    clearTimeout(picker.timer)
    this.picker = null
    const option = picker.options[index - 1]!
    if (picker.kind === 'model') {
      await this.applyModelSelection(option.value)
    } else {
      await this.applyPermissionPreset(option.value)
    }
    return 'consumed'
  }

  /** Available model options as picker entries (provider + model). */
  async modelPickerOptions(): Promise<Array<{ label: string; value: string }>> {
    const options: Array<{ label: string; value: string }> = []
    const llm = this.ctx.get('llm') as
      | { listProviders(): Array<{ id: string; name?: string }>; listModels(provider: string): Promise<Array<{ id: string; name?: string }>> }
      | undefined
    if (!llm) return options
    for (const provider of llm.listProviders()) {
      let models: Array<{ id: string; name?: string }> = []
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        // A provider whose listing fails just disappears from the picker, which
        // looks exactly like "that vendor has no models".
        this.problems.report('model/list', error, { notify: false, detail: `provider=${provider.id}` })
        continue
      }
      for (const model of models) {
        const label = `${provider.name ?? provider.id} · ${model.name ?? model.id} (${provider.id}/${model.id})`
        options.push({ label, value: `${provider.id}/${model.id}` })
      }
    }
    return options
  }

  /** The host permission-preset service, when the profile mounted one. */
  private permissionPresets(): HostPermissionPresets | undefined {
    return this.ctx.get('permissionPresets') as HostPermissionPresets | undefined
  }

  /** The preset effective for a session, or undefined when the host cannot say. */
  private activePreset(presets: HostPermissionPresets, session: Session | undefined): string | undefined {
    if (!session) return undefined
    try {
      return presets.current(session)
    } catch (error) {
      this.ctx.logger?.warn?.(
        '[dsh-chatnode-wechat] permission preset state unavailable: %s',
        describeError(error),
      )
      return undefined
    }
  }

  /** Available permission presets as picker entries. Never throws. */
  permissionPickerOptions(): Array<{ label: string; value: string }> {
    const presets = this.permissionPresets()
    if (!presets?.names) return []
    const active = this.activePreset(presets, this.activeSession())
    try {
      return presets.names.map((name) => {
        const option = presets.optionOf?.(name) ?? presets.resolve(name)
        const label = `${option?.name ?? name}${name === active ? ' ✓' : ''}${option?.description ? ` — ${option.description}` : ''}`
        return { label, value: name }
      })
    } catch (error) {
      this.ctx.logger?.warn?.(
        '[dsh-chatnode-wechat] permission presets unavailable: %s',
        describeError(error),
      )
      return []
    }
  }

  /** Switch the live agent's model to `provider/model` (applies next message). */
  async applyModelSelection(value: string): Promise<void> {
    const [provider, model] = value.split('/')
    const llm = this.ctx.get('llm') as
      | { resolveCallConfig(config: { provider?: string; model?: string }, signal?: AbortSignal): Promise<{ provider: string; model: string }> }
      | undefined
    if (!provider || !model) {
      await sendTextToPeer(this, '❌ 模型格式错误。')
      return
    }
    // Make sure the switch lands on a live WeChat agent (a restart or the
    // web-GUI-shared store can leave the bridge without an active target).
    await this.ensureWechatTarget()
    const agent = this.activeAgent()
    try {
      const resolved = llm
        ? await llm.resolveCallConfig({ provider, model })
        : { provider, model }
      const selection: ModelSelection = { provider: resolved.provider, model: resolved.model }
      if (agent) {
        this.selectionFor(agent).current = selection
      }
      // Persist as the default so future /new sessions and resumes use it.
      const defaults = this.ctx.get('agentDefaultModel') as { saveSelection?(next: ModelSelection): Promise<void> } | undefined
      try {
        await defaults?.saveSelection?.(selection)
      } catch (error) {
        this.ctx.logger?.warn?.('[dsh-chatnode-wechat] model default not persisted: %s', error instanceof Error ? error.message : String(error))
      }
      const name = resolved.model === model ? model : `${model} (${resolved.model})`
      await sendTextToPeer(this, `✅ 模型已切换：${name}${agent ? '' : '（当前无活动 agent，已存为默认）'}`)
    } catch (error) {
      await sendTextToPeer(this, `❌ 模型不可用: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Switch the session's permission preset. Never throws. */
  async applyPermissionPreset(name: string): Promise<void> {
    try {
      await this.ensureWechatTarget()
      const session = this.activeSession()
      const presets = this.permissionPresets()
      if (!presets) {
        await sendTextToPeer(this, '❌ 权限预设服务不可用。')
        return
      }
      presets.resolve(name) // throws on unknown names
      if (!session) {
        await sendTextToPeer(this, '❌ 没有活动会话，无法切换权限预设。发送 /new <prompt> 开始一个会话。')
        return
      }
      presets.set?.(session, name)
      const current = this.activePreset(presets, session)
      await sendTextToPeer(this, `✅ 权限预设已切换：${name}${current && current !== name ? `（当前生效: ${current}）` : ''}`)
    } catch (error) {
      await sendTextToPeer(this, `❌ 权限预设无效: ${describeError(error)}`)
    }
  }

  /**
   * Return (installing on first use) the mutable model selection for an agent,
   * mirroring the host api-proxy `selectionFor`. The bridge's own agents are
   * created with a fixed AgentOptions route, so the first call here installs
   * the selection hook and later `.current` writes take effect on the next
   * prompt assembly.
   */
  selectionFor(agent: Agent): ModelSelectionRef {
    const installed = this.agentSelections.get(agent)
    if (installed !== undefined) return installed
    let picked: ModelSelection | undefined
    const ref: ModelSelectionRef = {
      get current() {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader?.()?.config
        if (logged === undefined) return undefined
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: ModelSelection | undefined) {
        picked = next
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, ref)
    this.agentSelections.set(agent, ref)
    return ref
  }

  /**
   * The `provider/model` route the active agent currently chats on, resolved
   * from (in order) an explicit `/model` pick, the session's own request
   * header, then the configured default. Used by the native-image path to ask
   * the routed model whether it accepts images.
   */
  currentModelRoute(): { provider: string; model: string } | undefined {
    const agent = this.activeAgent()
    if (agent) {
      const picked = this.selectionFor(agent).current
      if (picked) return { provider: picked.provider, model: picked.model }
    }
    if (this.config.agentProvider && this.config.agentModel) {
      return { provider: this.config.agentProvider, model: this.config.agentModel }
    }
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection?(): { provider: string; model: string } | undefined }
      | undefined
    const fallback = defaults?.currentSelection?.()
    return fallback ? { provider: fallback.provider, model: fallback.model } : undefined
  }

  /**
   * Create a fresh agent+session via the agent factory and make it active.
   *
   * `notice` controls the chat line: `''` (default) uses the built-in
   * "已创建新会话" text, `null` stays silent, and any other string is sent
   * verbatim — automatic rotation passes its own reason there, and honours the
   * policy's `announce: false` by passing `null`.
   */
  async createSession(prompt: string, notice: string | null = ''): Promise<{ ok: boolean; detail: string }> {
    const sessionId = newSessionId(this)
    try {
      const meta: Record<string, string> = {}
      if (this.config.cwd) meta.cwd = this.config.cwd

      const presets = this.ctx.get('agentPresets') as AgentPresets | undefined
      let setup: ((agentCtx: Context) => Promise<void>) | undefined
      if (presets) {
        const wanted = this.config.agentPreset ?? presets.defaultId
        if (wanted) {
          const mountId = (await presets.resolve(wanted)).id
          meta.agentPreset = mountId
          setup = async (agentCtx: Context) => {
            await presets.mount(agentCtx, mountId)
          }
        }
      } else if (this.config.agentPreset) {
        meta.agentPreset = this.config.agentPreset
      }

      const handle = await this.ctx.agents.create({
        sessionId,
        meta,
        agentOptions: {
          ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
          ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
        },
        ...(setup === void 0 ? {} : { setup }),
      })
      this.activeSessionId = handle.agent.session.id
      if (prompt) {
        // A `/new <prompt>` from the chat starts a turn with this very message,
        // so it binds the outbound target exactly like an inbound message does.
        // Rotation and the admin console create sessions with an empty prompt
        // and start no turn, which is why this is conditional.
        this.submitForLastTarget(() => {
          handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          }))
        })
      }
      if (notice !== null) {
        await sendTextToPeer(
          this,
          notice || `✅ 已创建新会话 ${sessionBadge(this, handle.agent.session)}${prompt ? '，开始处理…' : '（无初始提示词）'}`,
        )
      }
      return { ok: true, detail: `已创建会话 ${String(handle.agent.session.id)}` }
    } catch (error) {
      await sendTextToPeer(this, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`)
      // The failure is reported as a value too: callers that are not the chat
      // (the admin console, the rotation path) must not record a success.
      this.problems.report('session/create', error)
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Ensure the bridge targets a live WeChat agent before routing inbound
   * traffic. Correction order:
   *   1. current active id is a live WeChat agent → keep;
   *   2. any live WeChat session in the store → adopt the most recent;
   *   3. else resume the most recent persisted WeChat session (restart case);
   *   4. else nothing (caller asks the user for /new).
   * Never adopts a non-`wechat-` session (the Web GUI shares this store).
   */
  async ensureWechatTarget(): Promise<boolean> {
    if (this.activeAgent()) return true
    // Step 2: an existing live WeChat session (created this boot, or another
    // entry resumed it) beats re-resuming from disk.
    const live = listSessions(this).find((s) => this.ctx.agents.get(s.id) !== undefined)
    if (live) {
      this.activeSessionId = live.id
      return true
    }
    // Step 3: resume the newest persisted WeChat session (restart recovery).
    return this.resumeLatestWechatSession()
  }

  /**
   * Resume the most recent persisted WeChat session (id prefixed `wechat-`)
   * so a DSH restart does not strand the conversation: the session data
   * survives on disk, only the live agent instance was lost. Mirrors the Web
   * host's `ensureSession` resume path (persistence list → inspect → resume
   * with the stored preset). Returns true when a session was resumed.
   */
  async resumeLatestWechatSession(): Promise<boolean> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(signal?: AbortSignal): Promise<readonly PersistenceEntry[]> }
      | undefined
    if (!persistence) return false
    try {
      const entries = await persistence.list()
      const mine = selectNewestSession(entries, this.sessionPrefix())
      const target = mine ? { id: asSessionId(mine.id) } : undefined
      if (!target) return false
      const live = this.ctx.agents.get(target.id)
      if (live) {
        this.activeSessionId = live.session.id
        return true
      }
      const presets = this.ctx.get('agentPresets') as AgentPresets | undefined
      let setup: ((agentCtx: Context) => Promise<void>) | undefined
      if (presets) {
        const wanted = this.config.agentPreset ?? presets.defaultId
        if (wanted) {
          const mountId = (await presets.resolve(wanted)).id
          setup = async (agentCtx: Context) => {
            await presets.mount(agentCtx, mountId)
          }
        }
      }
      const handle = await this.ctx.agents.resume({
        resumeSessionId: target.id,
        agentOptions: {
          ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
          ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
        },
        ...(setup === void 0 ? {} : { setup }),
      })
      this.activeSessionId = handle.agent.session.id
      this.ctx.logger?.info?.(
        '[dsh-chatnode-wechat] resumed persisted WeChat session %s after restart',
        target.id,
      )
      return true
    } catch (error) {
      this.ctx.logger?.warn?.(
        '[dsh-chatnode-wechat] auto-resume of WeChat session failed: %s',
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Pending approvals
  // -------------------------------------------------------------------------

  nextApprovalNumber(): number {
    this.approvalCounter += 1
    return this.approvalCounter
  }

  registerApproval(number: number, approval: PendingApproval): void {
    this.pending.set(number, approval)
  }

  clearApproval(number: number): void {
    const entry = this.pending.get(number)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(number)
    }
  }

  /**
   * Resolve a pending approval from a WeChat reply. `/yes` and `/no` answer
   * the most recent pending request; bare `1`/`2` only while exactly one is
   * pending (1 = allow, 2 = reject). Returns false when the text is not an
   * approval reply.
   */
  resolveApproval(text: string): boolean {
    const entries = [...this.pending.entries()]
    if (entries.length === 0) return false
    const outcome: ApprovalOutcome | undefined =
      text === '/yes' ? 'allowed-once'
        : text === '/no' ? 'rejected'
          : undefined
    if (outcome) {
      const [number, entry] = entries[entries.length - 1]!
      this.clearApproval(number)
      entry.resolve(outcome)
      return true
    }
    if ((text === '1' || text === '2') && entries.length === 1) {
      const [number, entry] = entries[0]!
      this.clearApproval(number)
      entry.resolve(text === '1' ? 'allowed-once' : 'rejected')
      return true
    }
    return false
  }

  /** Tear down all registered listeners (called on plugin dispose). */
  dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers = []
    // A queued turn target belongs to a listener that no longer exists.
    this.turnTargets.length = 0
    if (this.picker) clearTimeout(this.picker.timer)
    this.picker = null
    // Clear AND settle: a pending approval whose promise is never resolved
    // leaves the host's approval waterfall hanging forever on a request that
    // can no longer be answered by anyone. Denying is the safe default.
    const abandoned = [...this.pending.entries()]
    for (const number of [...this.pending.keys()]) this.clearApproval(number)
    for (const [number, entry] of abandoned) {
      try {
        entry.resolve('rejected')
      } catch (error) {
        this.problems.report('approvals/dispose', error, { notify: false, detail: `#${number}` })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Context rotation (see context-policy.ts for the decision half)
// ---------------------------------------------------------------------------

/**
 * Rotate the WeChat conversation when the configured policy says so.
 *
 * Registered on `session/event` and evaluated only on `turn/end` — the one
 * moment the bridge knows the agent finished a turn. Idleness is re-checked
 * immediately before acting, because a queued WeChat message can start the next
 * turn while this one is being evaluated: rotating then would cut a live turn in
 * half and strand the agent with the old session's context.
 *
 * Rotation goes through the SAME `createSession()` as `/new`, so there is exactly
 * one code path that creates WeChat sessions, and a rotation can never leave two
 * agents pointed at the same chat. The handoff note (when enabled) is fenced with
 * its own markers and labelled as background, never as an instruction: a rotation
 * must not look like the owner asking for something.
 */
/**
 * Real context size of a session, read from the host's projection cache.
 *
 * The token scheme wants a token budget, and the honest source is what the host
 * already measured. `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 * carries it: `contextPressure.pressureTokens` (everything the next request
 * sends), with the `contextBreakdown` parts and the live message surface as
 * fallbacks. Returns undefined when nothing usable is there — the policy module
 * then falls back to its character proxy and says so in the rotation reason.
 *
 * Read-only, best effort, and it must never throw: this runs on the turn/end path.
 */
export function readContextTokens(sessionId: string): number | undefined {
  const usage = readContextUsage(sessionId)
  if (!usage) return undefined
  if (typeof usage.pressureTokens === 'number' && usage.pressureTokens > 0) return usage.pressureTokens
  const sum = (usage.systemTokens ?? 0) + (usage.toolsTokens ?? 0) + (usage.messageTokens ?? 0)
  if (sum > 0) return sum
  if (typeof usage.surfaceTokens === 'number' && usage.surfaceTokens > 0) return usage.surfaceTokens
  return undefined
}

export function attachContextRotation(node: WechatConversationNode): () => void {
  const evaluate = (session: Session): void => {
    if (node.contextPolicy.scheme === 'manual') return
    const events = session.snapshotEvents()
    const contextTokens = readContextTokens(String(session.id))
    const reason = rotationReason(node.contextPolicy, { ...signalsFromEvents(events, new Date()), contextTokens })
    if (!reason) return
    if (!node.beginRotation()) return

    void (async () => {
      try {
        // Re-check against the CURRENT session state: an inbound message may have
        // started the next turn between the event and this continuation.
        const current = node.activeSession()
        if (!current || String(current.id) !== String(session.id)) return
        const fresh = signalsFromEvents(current.snapshotEvents(), new Date())
        if (node.contextPolicy.idleOnly !== false && fresh.turnOpen) return

        const notice = node.contextPolicy.announce === false ? null : `🔄 已自动开启新会话（${reason}）`
        // The handoff is queued, NOT submitted: passing it as the new session's
        // prompt made every rotation answer itself, which is exactly the extra
        // extra "fresh session" greeting bubble the owner saw on 2026-09-12 15:32.
        node.setPendingHandoff(node.contextPolicy.handoff ? buildHandoff(transcriptFromEvents(events), reason) : null)
        try {
          node.ctx.get('logger')?.info?.('[dsh-chatnode-wechat] rotating conversation: %s', reason)
        } catch { /* context gone; the rotation below is still worth attempting */ }
        await node.createSession('', notice)
      } catch (error) {
        try {
          node.ctx.get('logger')?.warn?.(
            '[dsh-chatnode-wechat] context rotation failed: %s',
            error instanceof Error ? error.message : String(error),
          )
        } catch { /* nothing to log to */ }
      } finally {
        node.endRotation()
      }
    })()
  }

  const listener = (session: Session, event: { type?: string }): void => {
    if (String(session.id) !== String(node.activeSessionId ?? '')) return
    if (event?.type !== 'turn/end') return
    evaluate(session)
  }
  const disposer = node.ctx.on('session/event', listener as never)
  return () => disposer()
}

/**
 * Watch the gateways' own health events.
 *
 * Each gateway emits `<platform>/status`, `<platform>/error` and
 * `<platform>/fatal`, and nothing in the bridge used to subscribe: a revoked
 * credential, a 403 from a competing poller, a DNS outage or a paused session
 * all ended up in the host log at best, while from the owner's side the bridge
 * simply stopped answering. From here each of them lands in the problem ledger
 * (so `/problems` can show it), a fatal one is announced once, and the last
 * known status is kept per platform for `/status` so a silent dead gateway is
 * visible on demand.
 *
 * Every mounted platform is watched, not just the primary: in merge mode a QQ
 * long-poll that died would otherwise be indistinguishable from the owner not
 * using QQ today.
 */
export function attachGatewayObservability(node: WechatConversationNode): () => void {
  const disposers: Array<() => void> = []

  for (const platform of node.platforms) {
    const events = platformEvents(platform)
    const where = platformLabel(platform)

    disposers.push(
      node.ctx.on(events.status as never, ((status: string) => {
        const previous = node.gatewayStatusFor(platform).status
        node.noteGatewayStatus(platform, status)
        // `idle` matters as much as `error`: "凭据没配 / 从未启动" is the most likely
        // total outage, and it used to leave no trace anywhere — the gateways'
        // own `setStatus('idle')` frequently emits nothing at all (the initial
        // status value is already `idle`). A quiet day and a dead bridge must not
        // look the same on the ledger.
        if (status === 'idle' || status === 'reconnecting' || status === 'error' || status === 'paused') {
          node.problems.report('gateway/status', new Error(`${where}网关状态变为 ${status}（之前 ${previous}）`), {
            notify: status === 'error',
            ...(status === 'idle' ? { detail: `platform=${platform}：网关未在运行，检查凭据与 platforms/platform 配置` } : {}),
          })
        }
      }) as never),
    )

    disposers.push(
      node.ctx.on(events.error as never, ((error: unknown) => {
        // Poll failures repeat every few seconds while the network is down; the
        // ledger collapses them by signature and the notifier rate limits.
        node.problems.report('gateway', error, { detail: `platform=${platform}` })
      }) as never),
    )

    disposers.push(
      node.ctx.on(events.fatal as never, ((error: unknown) => {
        node.noteGatewayStatus(platform, 'error')
        node.problems.report('gateway/fatal', error, { detail: `${where}网关已停止轮询，需要人工处理` })
      }) as never),
    )
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A disposer that fails must not stop the others.
      }
    }
  }
}

/**
 * Re-anchor long-term memory after the host compacts a session.
 *
 * Compaction swaps older messages for a summary, and it runs before a step —
 * mid-turn, not between messages — so a session can lose its history while the
 * agent keeps working. Marking the session here makes the owner's next message
 * carry the full memory briefing again instead of waiting out the usual cadence.
 *
 * Observing events is the only route: the preset mounts compaction inside its
 * own realm, so this (host-plane) bridge cannot resolve `ctx.compaction`.
 */
export function attachMemoryCompactionWatch(node: WechatConversationNode): () => void {
  const listener = (session: Session, event: { type?: string }): void => {
    if (event?.type !== 'compaction/summary' && event?.type !== 'compaction/prune') return
    if (String(session.id) !== String(node.activeSessionId ?? '')) return
    try {
      node.memoryService?.noteCompaction(String(session.id))
    } catch (error) {
      // A memory bookkeeping failure must never disturb the session itself, but
      // it does mean the post-compaction re-anchor will not happen.
      node.problems.report('memory/compaction', error, { notify: false })
    }
  }
  const disposer = node.ctx.on('session/event', listener as never)
  return () => disposer()
}
