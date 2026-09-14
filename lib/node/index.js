/**
 * wechat-conversation-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * Consumes the `wechat` gateway service, the `sessions` store, the `agents`
 * registry, the `approval` seam, and the `sessionTitle` service (status
 * messages carry the real session title with a first-prompt fallback).
 * Inbound WeChat text becomes a user message on the active session; session
 * events become digest-style WeChat messages (task started, heartbeat,
 * assistant text chunked, finished/error). Commands
 * (`/sessions /use /new /stop /status /yes /no`) are handled locally. The
 * allowlist gate lives here — non-allowlisted senders are never fed to the
 * model.
 *
 * @module @dsh-cowork/chatnode-wechat/node
 */
import { normalizeAllowFromByPlatform, platformLabel, resolvePlatformPlan } from "../platform/index.js";
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MAX_MESSAGE_CHARS } from "../gateway/types.js";
import { WechatConversationNode, attachMemoryCompactionWatch } from "./core.js";
import { resolveOutboundTarget, sendTextToPeer } from "./outbound.js";
import { ReminderStore } from "./reminders.js";
import { MorningService } from "./morning.js";
import { MEMORY_SECTIONS, MemoryService, applyPatch, defaultMemoryFile, factCount } from "./memory.js";
import { generateImage } from "./image-gen.js";
import { synthesizeSpeech } from "./tts.js";
import { sendEmail } from "./email.js";
import { lightToolDefinition } from "./light.js";
/**
 * The active platform's service, or a thrown tool error.
 *
 * Tool handlers used to reach `ctx.wechat` directly: that property access throws
 * "cannot get required service … in inactive context" once the scope is torn
 * down, and on 2026-09-12 an escaped version of exactly that killed the host.
 * Going through the resolved service keeps the failure inside the tool call.
 *
 * A tool call belongs to the platform of the **turn** that asked for it, so its
 * result must go back there — a QQ user's picture sent through the WeChat gateway
 * would reach a stranger or nobody. A profile serves one platform, but the target
 * is still resolved per turn because a session can be handed over between them.
 */
function targetOrThrow(node) {
    const target = resolveOutboundTarget(node);
    if (!target?.chat) {
        throw new Error(target
            ? `${platformLabel(target.platform)}网关服务不可用：目标平台没有挂载网关`
            : '网关服务不可用：当前平台没有挂载网关');
    }
    return target;
}
/**
 * A target that can also *deliver media*, or a thrown error.
 *
 * The capability is read from the **target platform's own gateway**: WeChat
 * declares images/voice, QQ's official API declares neither until its three-step
 * upload exists. Without this the answer to a QQ user's "画张图" was generated
 * (and paid for) and only then discovered to be undeliverable.
 */
function mediaTargetOrThrow(node, kind) {
    const target = targetOrThrow(node);
    // Read from the node (not from the primary platform, and not assumed).
    const capabilities = node.capabilitiesFor(target.platform);
    const supported = kind === 'voice' ? (capabilities?.voice ?? true) : (capabilities?.media ?? true);
    if (!supported) {
        const what = kind === 'voice' ? '语音' : '图片与文件';
        throw new Error(`${platformLabel(target.platform)}网关声明自己不能发送${what}，已在生成/发送之前拒绝（没有产生费用）`);
    }
    return target;
}
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    platform: z.union([z.const('wechat'), z.const('qq')]).default('wechat'),
    // 单平台列表。故意不给默认值：写没写要能区分开，解析规则在 resolvePlatformPlan()。
    platforms: z.array(z.union([z.const('wechat'), z.const('qq')])),
    // `z.transform`, not `z.dict`, on purpose — see normalizeAllowFromByPlatform.
    allowFromByPlatform: z.transform(z.any(), normalizeAllowFromByPlatform),
    digestIntervalSec: z.number().default(300),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(MAX_MESSAGE_CHARS),
    sendChunkDelayMs: z.number().default(1_500),
    cwd: z.string(),
    mediaDir: z.string(),
    // How an inbound image reaches the model: `auto` sends a real image block
    // when the routed model declares image input and falls back to OCR when it
    // does not; `native` forces the image block (falling back to OCR only after
    // the provider actually refuses one); `ocr` keeps the text-only path.
    imageInput: z.union([z.const('auto'), z.const('native'), z.const('ocr')]).default('auto'),
    // Optional explicit `provider/model` for native image input, when the
    // chat route itself cannot accept images (e.g. a text-only chat model plus
    // a vision route used only for pictures).
    imageInputModel: z.string(),
    ocrApiKey: z.string(),
    ocrModel: z.string(),
    ocrBaseUrl: z.string(),
    reminderFile: z.string(),
    morningFile: z.string(),
    memoryFile: z.string(),
    problemFile: z.string(),
    memoryInjectEvery: z.number(),
    memoryConsolidateTime: z.string(),
    esp32BaseUrl: z.string(),
    smtpHost: z.string(),
    smtpPort: z.number(),
    smtpUsername: z.string(),
    smtpPassword: z.string(),
    smtpFromName: z.string(),
    imageGenApiKey: z.string(),
    imageGenModel: z.string(),
    imageGenDir: z.string(),
    sttApiKey: z.string(),
    sttModel: z.string(),
    ttsApiKey: z.string(),
    ttsModel: z.string(),
    ttsVoice: z.string(),
    agentPreset: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
    contextPolicy: z.string(),
});
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-chatnode-wechat';
/**
 * Services required by the conversation node.
 *
 * `llm` and `attachments` are deliberately NOT listed: cordis treats `inject`
 * as a wait gate (a missing entry leaves the plugin inactive with no error),
 * and both are optional here — the node reads them through `ctx.get()` and the
 * native-image path degrades to OCR when either is absent.
 *
 * `sessionTitle` was removed from this list for the same reason after the DSH
 * 0.1.5 upgrade: the title service now depends on `sessionProjections`, so a
 * host that does not mount `dsh-session-projection` silently withholds it —
 * and listing it here would take the whole bridge down with it. Labels already
 * fall back to the first user message (see `labels.ts`), so the title is a
 * decoration, never a loading prerequisite.
 */
export const inject = ['sessions', 'agents', 'approval', 'tools'];
/**
 * Mount the conversation node once **every platform it serves** has a gateway.
 *
 * The platforms cannot appear in the static `inject` list above: they are only
 * known from the config, at apply time. Listing `wechat` there instead meant a QQ
 * profile mounted `ctx.qq`, `ctx.wechat` never appeared, and cordis — which
 * treats `inject` as a wait gate — left this entire plugin inactive. The gateway
 * still connected, so from the outside everything looked healthy while every
 * frame it emitted (`qq/message`, `qq/error`) went nowhere: no reply, no ledger
 * line, no reminder fired. Waiting on the resolved platform keeps WeChat's
 * behaviour identical (it waits for `ctx.wechat`, exactly as before) and lets a
 * QQ profile mount.
 *
 * The node waits for the platform it serves rather than mounting once per
 * platform: one node owns one conversation, so it must exist exactly once — and
 * it must not start before the gateway it subscribes to is there, or this
 * channel's messages would have no listener at all.
 */
export function apply(ctx, config) {
    // The allowlist is the security boundary, and this check has to happen HERE,
    // synchronously: a failed mount must reject `ctx.plugin(...)` so the operator
    // sees it. Left to the node's constructor it would throw inside the deferred
    // `ctx.inject` callback below, where cordis swallows it — the plugin would
    // simply not mount, and a missing allowlist would look exactly like a quiet
    // profile. (The constructor still re-checks; this is the mount-time gate.)
    if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
        throw new Error('dsh-chatnode-wechat: allowFrom is REQUIRED and must list at least one sender id ' +
            '(WeChat sender id, or the QQ user_openid). An agent that accepts instructions from ' +
            'any contact is a prompt-injection front door.');
    }
    const plan = resolvePlatformPlan(config.platforms, config.platform);
    ctx.inject(plan.platforms, (nodeCtx) => {
        mountConversationNode(nodeCtx, config);
    });
}
/**
 * The node itself, mounted on a context where every platform's gateway is present.
 *
 * The config is handed over as written — `platform` and `platforms` included —
 * so the node resolves the very same plan this apply resolved (see
 * `resolvePlatformPlan`, which is deterministic), and there is exactly one place
 * that decides what the primary platform is.
 */
function mountConversationNode(ctx, config) {
    const node = new WechatConversationNode(ctx, { ...config });
    const platform = node.platform;
    /** One call shape for every swallowed failure in the bridge. */
    const report = (kind, error, detail) => {
        node.problems.report(kind, error, detail === undefined ? {} : { detail });
    };
    // Every swallowed failure goes to the ledger: the host log, the problem file,
    // and — rate limited — the owner's WeChat. A silent failure is a bug in a
    // bridge whose whole job is to answer.
    node.problems.setLogger((level, text) => {
        try {
            ctx.get('logger')?.[level]?.(text);
        }
        catch {
            // The context is gone (live patch reload); the file sink still works.
        }
    });
    node.problems.setNotifier((text) => {
        void sendTextToPeer(node, text).catch(() => {
            // No peer to tell yet (nothing inbound since boot). The log already has it.
        });
    });
    ctx.effect(() => {
        return () => node.dispose();
    });
    // ---- reminders: durable scheduled alerts --------------------------------
    // Registered as tools so the agent can answer natural-language requests
    // ("30 分钟后提醒我喝水") with real tool calls. Persisted to a JSON file so
    // reminders survive restarts; the store pushes due alerts to their peer.
    // The store's own file stays the primary platform's (its format and default
    // path are an existing on-disk contract), but delivery follows the peer: a
    // reminder set from QQ is pushed back through the QQ gateway, not WeChat's.
    const reminderStore = new ReminderStore(ctx, config.reminderFile, report, platform, (peerId) => node.platformForPeer(peerId));
    void reminderStore.start().catch((error) => report('reminders/start', error));
    ctx.effect(() => {
        return () => reminderStore.stop();
    });
    // ---- morning greeting: daily weather push, toggled via /早安 ------------
    // A proactive push has no turn to read a target from, so it stays on the
    // profile's own platform (its file, its gateway, its subset of the allowlist) —
    // the behaviour single-platform profiles always had. The per-platform filter is
    // what keeps a QQ openid from being pushed at the WeChat API.
    const morningService = new MorningService(ctx, {
        onProblem: (kind, error) => report(kind, error),
        file: config.morningFile,
        targets: () => (config.allowFrom ?? []).filter((peer) => node.platformForPeer(peer) === platform),
        platform,
    });
    node.morningService = morningService;
    void morningService.start().catch((error) => report('morning/start', error));
    ctx.effect(() => {
        return () => morningService.stop();
    });
    // ---- long-term memory: facts about the owner, injected as background -----
    // The briefing rides OUTSIDE the user fence (see inbound.ts), and the daily
    // consolidation asks for the reasoning the bridge already knows how to do:
    // active session + its routed model.
    const memoryService = new MemoryService(ctx, {
        // 记忆按平台分开：默认路径带平台前缀，否则两个 profile 会互相把对方的事实
        // 注入到自己的对话里。
        file: config.memoryFile ?? defaultMemoryFile(platform),
        onProblem: report,
        injectEvery: config.memoryInjectEvery,
        consolidateAt: config.memoryConsolidateTime,
    });
    node.memoryService = memoryService;
    memoryService.sessionProvider = () => node.activeSession();
    memoryService.routeProvider = () => node.currentModelRoute();
    void memoryService.start();
    ctx.effect(() => {
        return () => memoryService.stop();
    });
    // A compaction folds the history away mid-turn; the owner's next message then
    // carries the memory again (see attachMemoryCompactionWatch).
    const detachCompactionWatch = attachMemoryCompactionWatch(node);
    ctx.effect(() => {
        return () => detachCompactionWatch();
    });
    // remember_fact — the owner says "记一下", and it is really written down.
    //
    // Without this the only path into MEMORY.md was the nightly consolidation, so
    // "你先记一下我的邮箱" produced a cheerful "记下了" from the model and an empty
    // file on disk. The tool writes through the same applyPatch() path as the
    // consolidator: backup, 4000-character cap, audit line in memory-log.md.
    const unregisterRemember = ctx.tools.register(defineTool({
        name: 'remember_fact',
        description: 'Write one long-lived fact about the owner into the cross-session memory file. ' +
            'Use it when the owner says 记一下 / 记住 / 别忘了, or states something durable about himself ' +
            '(name, city, schedule, habits, devices, promises, decisions). ' +
            'Only say 记下了 to the owner AFTER this tool returns success — saying it without calling this ' +
            'tool is a promise the bridge cannot keep. ' +
            `Pick section from exactly: ${MEMORY_SECTIONS.join(' / ')} (use 关于主人 when unsure). ` +
            'Never record passwords, tokens, API keys, one-off arrangements or small talk. ' +
            'One fact per call; write it as a plain third-person statement about the owner.',
        parameters: {
            text: {
                type: 'string',
                required: true,
                description: 'The fact itself, third person, at most 300 characters, e.g. "主人喜欢在早上喝咖啡"',
            },
            section: {
                type: 'string',
                description: `Optional. One of: ${MEMORY_SECTIONS.join(' / ')}. Defaults to 关于主人.`,
            },
            replaces: {
                type: 'string',
                description: 'Optional. Exact text of an older fact this one supersedes ("我搬到 B 市了" replacing "主人在 A 市"). ' +
                    'The old entry is retired, so the two never sit in the file contradicting each other.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const raw = typeof args.text === 'string' ? args.text.trim() : '';
            if (!raw)
                return '❌ 没给要记的内容（text 必填）。';
            // Every fence the bridge itself uses is off limits. A fact carrying one
            // is injected into every future turn, gets the model's own replies cut
            // by the outbound guard, and would close the briefing's fence early so
            // the rest stops being marked as background.
            if (raw.includes('<<<')) {
                return '❌ 这条里含桥用的围栏标记（<<<），不能写进记忆。去掉标记再记一次。';
            }
            const LIMIT = 300;
            const stored = raw.slice(0, LIMIT);
            const truncated = stored !== raw;
            const known = MEMORY_SECTIONS.includes(args.section);
            const section = known ? String(args.section) : MEMORY_SECTIONS[0];
            // Say it in the receipt: the model repeats this to the owner, so an
            // unmentioned fallback becomes a fact filed in the wrong drawer.
            const sectionNote = known ? '' : `（section「${String(args.section ?? '')}」不认识，已放进「${section}」）`;
            const cutNote = truncated ? `（超过 ${LIMIT} 字，只记了前半段）` : '';
            const file = memoryService.filePath;
            const replaces = typeof args.replaces === 'string' ? args.replaces.trim() : '';
            if (replaces) {
                const updated = applyPatch(file, { update: [{ from: replaces, to: stored }] }, 'tool:remember_fact');
                if (updated.updated > 0)
                    return `✅ 已更新长期记忆：把「${replaces}」换成「${stored}」${cutNote}`;
                // The old entry was not found verbatim: still record the new fact, but
                // say so rather than reporting a replacement that did not happen.
                const added = applyPatch(file, { add: [{ section, text: stored }] }, 'tool:remember_fact');
                if (added.added > 0) {
                    return `✅ 已记下「${stored}」${cutNote}；但没找到要替换的旧那条「${replaces}」，它仍在文件里，每天整理时会再收拢。`;
                }
                const why = added.skipped.join('；');
                return why ? `❌ 没能记下来：${why}` : `ℹ️ 这条已经记过了（共 ${factCount(file)} 条）`;
            }
            const before = factCount(file);
            const result = applyPatch(file, { add: [{ section, text: stored }] }, 'tool:remember_fact');
            if (result.added > 0) {
                const facts = factCount(file);
                return `✅ 已写进长期记忆（${section}）：${stored}${cutNote}${sectionNote}（现在共 ${facts} 条，换会话也带着）`;
            }
            // Every refusal has to reach the model as a refusal: the one thing this
            // tool exists for is not to let "记下了" be said about nothing.
            const skipped = result.skipped.join('；');
            if (skipped)
                return `❌ 没能记下来：${skipped}`;
            // added=0 with nothing skipped can also mean the text normalizes to
            // nothing ("-", "*", a bare date): check before claiming a duplicate.
            if (!stored.replace(/[\s\-*（()）\d年月日\-/.、:：]/g, '')) {
                return '❌ 没能记下来：这条里没有可记录的文字。';
            }
            return `ℹ️ 这条已经记过了，没有重复添加（共 ${before} 条）`;
        },
        timeoutMs: 15_000,
    }));
    ctx.effect(() => {
        return () => unregisterRemember();
    });
    const nowStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    /** Resolve a reminder target to epoch ms from inMinutes / atTime. */
    function resolveTarget(args) {
        const now = new Date();
        if (typeof args.inMinutes === 'number' && Number.isFinite(args.inMinutes)) {
            return now.getTime() + args.inMinutes * 60_000;
        }
        if (typeof args.atTime === 'string' && /^\d{1,2}:\d{2}$/.test(args.atTime.trim())) {
            const [h, m] = args.atTime.trim().split(':').map(Number);
            if (h === undefined || m === undefined || h < 0 || h > 23 || m < 0 || m > 59) {
                throw new Error(`set_reminder: invalid atTime "${args.atTime}" (use HH:MM)`);
            }
            const target = new Date(now);
            target.setHours(h, m, 0, 0);
            // A time earlier today means tomorrow (the natural reading of "明天9点"
            // vs an already-passed "今天9点").
            if (target.getTime() <= now.getTime())
                target.setDate(target.getDate() + 1);
            return target.getTime();
        }
        throw new Error('set_reminder: provide inMinutes (relative) or atTime ("HH:MM", today/tomorrow)');
    }
    /**
     * 媒体工具的名字。
     *
     * 用户的要求是"**微信侧不变，QQ 去微信化**"：跑单平台微信的 profile 必须与今天
     * 逐字一致（人设、习惯、历史里都写着 `wechat_send_*`），而 QQ 单平台与合并模式
     * 下模型不该看到"发给微信 peer"这种与当前渠道不符的名字。合并模式下一套工具要
     * 同时服务两条渠道，所以取中性名。
     */
    const neutralToolNames = !(platform === 'wechat' && !(Array.isArray(config.platforms) && config.platforms.length > 1));
    const mediaToolName = (base) => neutralToolNames ? base : `wechat_${base}`;
    const imageTool = mediaToolName('send_image');
    const fileTool = mediaToolName('send_file');
    const videoTool = mediaToolName('send_video');
    const unregisterSendImage = ctx.tools.register(defineTool({
        name: imageTool,
        description: 'Send a local image file to the current chat peer through this bridge (the peer is whoever ' +
            'messaged the bot most recently, so at least one inbound message must have arrived since the ' +
            'profile started). Pass the absolute path of the image file.',
        parameters: {
            path: { type: 'string', required: true, description: 'Absolute path to the image file (jpg/png/webp/gif).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path)
                throw new Error(`${imageTool}: path is required`);
            const target = mediaTargetOrThrow(node, 'media');
            const result = await target.chat.sendImage(target.peerId, path);
            if (!result.success)
                throw new Error(`${imageTool}: ${result.error}`);
            return `✅ 图片已发送到${platformLabel(target.platform)}: ${path}`;
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterSendImage();
    });
    // wechat_send_file — send any local file (documents, archives, …) to the peer.
    // 文件工具（名字随平台：见上面的 neutralToolNames）
    const unregisterSendFile = ctx.tools.register(defineTool({
        name: fileTool,
        description: 'Send a local file (document, archive, pdf, mp3, …) to the current chat peer through this ' +
            'bridge (the peer is whoever messaged the bot most recently, so at least one inbound message ' +
            'must have arrived since the profile started). Pass the absolute path of the file.',
        parameters: {
            path: { type: 'string', required: true, description: 'Absolute path of the file to send.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path)
                throw new Error(`${fileTool}: path is required`);
            const target = mediaTargetOrThrow(node, 'media');
            const result = await target.chat.sendFile(target.peerId, path);
            if (!result.success)
                throw new Error(`${fileTool}: ${result.error}`);
            return `✅ 文件已发送到${platformLabel(target.platform)}: ${path}`;
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterSendFile();
    });
    // wechat_send_video — send a local video clip (mp4/mov/…) to the peer. The
    // iLink gateway has no reliable native video bubble, so like voice replies
    // the clip is delivered as a playable file attachment (mp4 opens and plays
    // directly in WeChat).
    // 视频工具：iLink 没有原生视频气泡，所以按可播放的附件发（QQ 侧同理，见能力门禁）。
    const unregisterSendVideo = ctx.tools.register(defineTool({
        name: videoTool,
        description: 'Send a local video file (mp4/mov/webm/…) to the current chat peer through this bridge (the ' +
            'peer is whoever messaged the bot most recently, so at least one inbound message must have ' +
            'arrived since the profile started). Pass the absolute path of the video file. Note: this ' +
            'bridge has no native video bubble, so the clip arrives as a playable file attachment.',
        parameters: {
            path: { type: 'string', required: true, description: 'Absolute path of the video file (mp4/mov/webm/…).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path)
                throw new Error(`${videoTool}: path is required`);
            const target = mediaTargetOrThrow(node, 'media');
            const result = await target.chat.sendFile(target.peerId, path);
            if (!result.success)
                throw new Error(`${videoTool}: ${result.error}`);
            return `✅ 视频已发送到${platformLabel(target.platform)}: ${path}`;
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterSendVideo();
    });
    // generate_image — text-to-image via SiliconFlow, then send to the peer.
    const unregisterGenerateImage = ctx.tools.register(defineTool({
        name: 'generate_image',
        description: 'Generate an image from a text prompt (SiliconFlow text-to-image) and send it to the current chat peer. ' +
            'Use when the user asks to 画/生成/绘一张图, an illustration, a picture of something. ' +
            'Describe the subject, style, and composition in the prompt. The image is sent automatically; returns confirmation.',
        parameters: {
            prompt: { type: 'string', required: true, description: 'Image description, e.g. "a cat girl in JK uniform, anime style, soft colors"' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
            if (!prompt)
                throw new Error('generate_image: prompt is required');
            const target = mediaTargetOrThrow(node, 'media');
            const apiKey = config.imageGenApiKey ?? config.ocrApiKey ?? '';
            if (!apiKey)
                throw new Error('generate_image: no SiliconFlow key configured (set imageGenApiKey or ocrApiKey)');
            await target.chat.sendTyping(target.peerId, 1).catch(() => { });
            await target.chat.sendText(target.peerId, `🎨 正在画图：${prompt.slice(0, 120)}`).catch(() => { });
            const outDir = config.imageGenDir ?? (config.mediaDir ? `${config.mediaDir}/generated` : undefined);
            const result = await generateImage({ apiKey, model: config.imageGenModel, outDir, baseUrl: config.ocrBaseUrl }, prompt);
            const sendResult = await target.chat.sendImage(target.peerId, result.path);
            if (!sendResult.success)
                throw new Error(`图片生成成功但发送失败: ${sendResult.error}`);
            return `✅ 图已生成并发送`;
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterGenerateImage();
    });
    // speak — synthesize speech with the cloned voice and send a voice note.
    // Pipeline: SiliconFlow TTS (mp3) → silk (ffmpeg + pilk) → gateway sendVoice.
    const unregisterSpeak = ctx.tools.register(defineTool({
        name: 'speak',
        description: 'Speak the given text to the user: it is converted to speech with the configured cloned voice ' +
            'and sent to WeChat as an mp3 FILE attachment (native voice bubbles are unreliable on the iLink ' +
            'gateway, so the audio arrives as a file the user taps to play). ' +
            'Use when the user asks 语音说/用语音回复/说给我听. Returns confirmation.',
        parameters: {
            text: { type: 'string', required: true, description: 'The exact text to speak aloud (short, natural)' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (!text)
                throw new Error('speak: text is required');
            const target = mediaTargetOrThrow(node, 'voice');
            const apiKey = config.ttsApiKey ?? config.ocrApiKey ?? '';
            const voice = config.ttsVoice ?? '';
            if (!apiKey || !voice)
                throw new Error('speak: TTS not configured (set ttsApiKey and ttsVoice)');
            await target.chat.sendTyping(target.peerId, 1).catch(() => { });
            await target.chat.sendText(target.peerId, '🎙 正在说话…').catch(() => { });
            // 1) mp3 via SiliconFlow TTS.
            const mp3 = await synthesizeSpeech({ apiKey, model: config.ttsModel, voice, baseUrl: config.ocrBaseUrl }, text);
            // 2) persist mp3 and send as a file attachment (plays on tap).
            const dir = config.imageGenDir ?? (config.mediaDir ? `${config.mediaDir}/generated` : undefined);
            const { writeFile, mkdir } = await import('node:fs/promises');
            const { join } = await import('node:path');
            if (dir)
                await mkdir(dir, { recursive: true }).catch(() => { });
            const name = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
            const absPath = join(dir ?? process.cwd(), name);
            await writeFile(absPath, Buffer.from(mp3));
            const result = await target.chat.sendFile(target.peerId, absPath, name);
            if (!result.success)
                throw new Error(`语音文件发送失败: ${result.error}`);
            return '✅ 语音文件已发送';
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterSpeak();
    });
    // set_reminder — create a reminder. The agent translates the user's natural
    // language into inMinutes or atTime. The tool resolves wall-clock against
    // the REAL current time, so it never depends on the model knowing the clock.
    const unregisterSetReminder = ctx.tools.register(defineTool({
        name: 'set_reminder',
        description: 'Create a WeChat reminder that will be pushed to the user at the scheduled time. ' +
            `Current server time: ${nowStamp()}. Provide EITHER inMinutes (relative from now, e.g. 30 for "30 分钟后") ` +
            'OR atTime (wall clock "HH:MM", 24h; if that time already passed today it means tomorrow, e.g. atTime "09:00" for "明早 9 点"). ' +
            'Return the created reminder id and scheduled time to the user in a friendly way.',
        parameters: {
            text: { type: 'string', required: true, description: 'The reminder content, e.g. "喝水" / "给老板发周报"' },
            inMinutes: { type: 'number', description: 'Minutes from now. Use for "X 分钟后/小时后" requests.' },
            atTime: { type: 'string', description: 'Wall-clock "HH:MM" (24h). Use for "X 点/明早 X 点" requests.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (!text)
                throw new Error('set_reminder: text is required');
            // The peer is the one whose turn this is: a reminder set from QQ must
            // wake its owner on QQ, and the store remembers only the id it is given.
            const target = resolveOutboundTarget(node);
            if (!target)
                throw new Error('set_reminder: no peer yet — the user must message the bot first');
            const at = resolveTarget(args);
            const reminder = await reminderStore.add({ at, text, peerId: target.peerId });
            // A reminder that only lives in memory fires fine today and is gone
            // after a restart; a plain "✅ 已设置" would promise more than the
            // bridge can keep.
            return reminderStore.lastSaveSucceeded()
                ? `✅ 提醒已设置：${ReminderStore.describe(reminder)}`
                : `⚠️ 提醒已设置，但没能写进磁盘（重启后会丢）：${ReminderStore.describe(reminder)}`;
        },
        timeoutMs: 10_000,
    }));
    ctx.effect(() => {
        return () => unregisterSetReminder();
    });
    // list_reminders — show all pending reminders for this peer.
    const unregisterListReminders = ctx.tools.register(defineTool({
        name: 'list_reminders',
        description: 'List all pending WeChat reminders for the current user, soonest first. ' +
            'Use when the user asks "有什么提醒" / "我的闹钟" / "提醒我什么了". Returns ids usable with cancel_reminder.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
            const peer = resolveOutboundTarget(node)?.peerId;
            if (!peer)
                return '（还没有收到过你的消息，无法确认会话）';
            const mine = reminderStore.list().filter((r) => r.peerId === peer);
            if (mine.length === 0)
                return '📭 当前没有待触发的提醒。';
            return mine.map((r) => `• ${ReminderStore.describe(r)}`).join('\n');
        },
        timeoutMs: 10_000,
    }));
    ctx.effect(() => {
        return () => unregisterListReminders();
    });
    // cancel_reminder — remove a reminder by id.
    const unregisterCancelReminder = ctx.tools.register(defineTool({
        name: 'cancel_reminder',
        description: 'Cancel a pending WeChat reminder by its id (see list_reminders). ' +
            'Use when the user says "取消提醒" / "删掉闹钟". Only reminders owned by the current user can be cancelled.',
        parameters: {
            id: { type: 'string', required: true, description: 'The reminder id returned by set_reminder or shown by list_reminders.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const id = typeof args.id === 'string' ? args.id.trim() : '';
            if (!id)
                throw new Error('cancel_reminder: id is required');
            const peer = resolveOutboundTarget(node)?.peerId;
            const mine = reminderStore.list().find((r) => r.id === id && r.peerId === peer);
            if (!mine)
                return `❌ 未找到提醒 ${id}（只能取消你自己的提醒）。可用 list_reminders 查看。`;
            await reminderStore.remove(id);
            return `🗑 已取消提醒 ${id}：${mine.text}`;
        },
        timeoutMs: 10_000,
    }));
    ctx.effect(() => {
        return () => unregisterCancelReminder();
    });
    // send_email — plain-text mail through the configured SMTP account. Ported
    // from the retired `dsh-wechat-tools` plugin, which held the only
    // implementation; keeping it here lets that plugin be uninstalled.
    const unregisterSendEmail = ctx.tools.register(defineTool({
        name: 'send_email',
        description: 'Send a plain-text email through the SMTP account configured for this bridge. ' +
            'Use when the user asks to send an email to someone. Returns confirmation or the error.',
        parameters: {
            to: { type: 'string', required: true, description: 'Recipient email address, e.g. someone@example.com' },
            subject: { type: 'string', required: true, description: 'Email subject line' },
            body: { type: 'string', required: true, description: 'Email body (plain text)' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            return await sendEmail({
                host: config.smtpHost ?? '',
                port: config.smtpPort,
                username: config.smtpUsername ?? '',
                password: config.smtpPassword ?? '',
                fromName: config.smtpFromName,
                fromEmail: config.smtpUsername,
            }, {
                to: typeof args.to === 'string' ? args.to.trim() : '',
                subject: typeof args.subject === 'string' ? args.subject.trim() : '',
                body: typeof args.body === 'string' ? args.body : '',
            });
        },
        timeoutMs: 40_000,
    }));
    ctx.effect(() => {
        return () => unregisterSendEmail();
    });
    // control_esp32_light — the ESP32 PWM light as an AGENT tool. The chat commands
    // (/开灯, /关灯, /开灯1~3) predate it and stay; this restores the tool the
    // retired `dsh-wechat-tools` plugin provided, so the model can act on
    // "把灯打开" / "调暗一点" without the user typing a command. Both surfaces run
    // the same code path in light.ts, and the definition lives there so tests can
    // pin the tool's name, enum and behaviour.
    const unregisterLight = ctx.tools.register(lightToolDefinition(config.esp32BaseUrl));
    ctx.effect(() => {
        return () => unregisterLight();
    });
}
/** The conversation-node plugin object (mountable via `ctx.plugin`). */
export const wechatConversationNode = { name, inject, Config, apply };
export { WechatConversationNode } from "./core.js";
export { ReminderStore } from "./reminders.js";
export { splitForWechat, digestLine, textOfAssistantMessage, markdownToWechat } from "./outbound.js";
export { extractText, isGroupMessage } from "./inbound.js";
export { listSessions } from "./commands.js";
//# sourceMappingURL=index.js.map