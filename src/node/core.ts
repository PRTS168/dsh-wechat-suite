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
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PendingApproval } from './approvals.ts'
import { attachApprovalBridge } from './approvals.ts'
import { attachSessionOutbound, sendTextToPeer } from './outbound.ts'
import { handleInbound } from './inbound.ts'
import { listSessions, newSessionId } from './commands.ts'
import { sessionBadge } from './labels.ts'
import type { MorningService } from './morning.ts'
import type { InboundMessage } from '../gateway/types.ts'

/** Runtime shape of the node plugin's config (defaults applied). */
export interface NodeConfig {
  /** Hard allowlist of WeChat sender ids allowed to drive the agent. REQUIRED. */
  allowFrom: string[]
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
  /** ESP32 PWM light base url (defaults to http://192.168.1.11:80). */
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
}

export class WechatConversationNode {
  /** The active session the WeChat user drives. */
  activeSessionId: SessionId | null = null
  /** The allowlisted peer outbound text goes to (last inbound sender). */
  peerId: string | null = null

  /**
   * Runtime override for {@link NodeConfig.imageInput}, set by the `/识图`
   * command. Survives until the bridge process restarts; config remains the
   * source of truth for the next boot.
   */
  runtimeImageInput: 'auto' | 'native' | 'ocr' | null = null

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

  readonly ctx: Context
  readonly config: NodeConfig

  constructor(ctx: Context, config: NodeConfig) {
    this.ctx = ctx
    this.config = config
    if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
      throw new Error(
        'dsh-chatnode-wechat: allowFrom is REQUIRED and must list at least one WeChat sender id. ' +
        'An agent that accepts instructions from any WeChat contact is a prompt-injection front door.',
      )
    }
    this.disposers.push(attachSessionOutbound(this))
    this.disposers.push(attachApprovalBridge(this))
    this.ctx.on('wechat/message', (message: InboundMessage) => {
      void handleInbound(this, message)
    })
    this.pickDefaultSession()
  }

  /** The active WeChat session, if any. Never a non-`wechat-` session: this
   *  process shares its SessionStore with the Web GUI, and an inbound WeChat
   *  message must never be routed into a web conversation. */
  activeSession(): Session | undefined {
    if (!this.activeSessionId) return undefined
    if (!String(this.activeSessionId).startsWith('wechat-')) return undefined
    return this.ctx.sessions.get(this.activeSessionId)
  }

  /** The agent driving the active WeChat session, if any. */
  activeAgent(): Agent | undefined {
    const session = this.activeSession()
    if (!session) return undefined
    return this.ctx.agents.get(session.id)
  }

  /** Whether this node drives the given agent (its session is active). */
  ownsAgent(agent: Agent): boolean {
    return this.activeSessionId !== null
      && agent.session.id === this.activeSessionId
      && this.isWechatSessionId(agent.session.id)
  }

  /** Whether a session id belongs to this bridge's own WeChat sessions. */
  isWechatSessionId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith('wechat-')
  }

  /** Whether a sender is allowlisted. */
  isAllowed(senderId: string): boolean {
    return this.config.allowFrom.includes(senderId)
  }

  /** The gateway's own account id (used for group detection). */
  get gatewayAccountId(): string {
    return this.ctx.wechat.accountId
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
    const sessions = listSessions(this).filter((s) => String(s.id).startsWith('wechat-'))
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
      } catch {
        continue // unreachable route today; skip
      }
      for (const model of models) {
        const label = `${provider.name ?? provider.id} · ${model.name ?? model.id} (${provider.id}/${model.id})`
        options.push({ label, value: `${provider.id}/${model.id}` })
      }
    }
    return options
  }

  /** Available permission presets as picker entries. */
  permissionPickerOptions(): Array<{ label: string; value: string }> {
    const presets = this.ctx.get('permissionPresets') as
      | { names: readonly string[]; current(events: readonly unknown[]): string; resolve(name: string): { label?: string; description?: string } }
      | undefined
    if (!presets) return []
    const active = presets.current([])
    return presets.names.map((name) => {
      const resolved = presets.resolve(name)
      const label = `${name}${name === active ? ' ✓' : ''}${resolved.description ? ` — ${resolved.description}` : ''}`
      return { label, value: name }
    })
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

  /** Switch the session's permission preset. */
  async applyPermissionPreset(name: string): Promise<void> {
    await this.ensureWechatTarget()
    const session = this.activeSession()
    const presets = this.ctx.get('permissionPresets') as
      | { resolve(presetName: string): unknown; current(events: readonly unknown[]): string }
      | undefined
    if (!presets) {
      await sendTextToPeer(this, '❌ 权限预设服务不可用。')
      return
    }
    try {
      presets.resolve(name) // throws on unknown names
      if (session) {
        const svc = this.ctx.get('permissionPresets') as { set(session: Session, preset: string): void }
        svc.set(session, name)
      }
      const current = presets.current([])
      await sendTextToPeer(this, `✅ 权限预设已切换：${name}${session ? '' : '（无活动会话，已记录）'}${current === name ? '' : `（当前生效: ${current}）`}`)
    } catch (error) {
      await sendTextToPeer(this, `❌ 权限预设无效: ${error instanceof Error ? error.message : String(error)}`)
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

  /** Create a fresh agent+session via the agent factory and make it active. */
  async createSession(prompt: string): Promise<void> {    const sessionId = newSessionId(this)
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
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
      }
      await sendTextToPeer(this, `✅ 已创建新会话 ${sessionBadge(this, handle.agent.session)}${prompt ? '，开始处理…' : '（无初始提示词）'}`)
    } catch (error) {
      await sendTextToPeer(this, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`)
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
      | { list(signal?: AbortSignal): Promise<Array<{ id: SessionId; createdAt: number }>> }
      | undefined
    if (!persistence) return false
    try {
      const headers = await persistence.list()
      const wechat = headers
        .filter((h) => String(h.id).startsWith('wechat-'))
        .sort((a, b) => b.createdAt - a.createdAt)
      const target = wechat[0]
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
    if (this.picker) clearTimeout(this.picker.timer)
    this.picker = null
    for (const number of [...this.pending.keys()]) this.clearApproval(number)
  }
}
