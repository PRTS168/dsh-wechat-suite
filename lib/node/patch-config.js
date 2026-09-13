/**
 * Profile patch (`cordis.patch.yml`) reader/writer for the dsh-chatnode-wechat
 * bundle's configurable placeholders.
 *
 * Shared by two surfaces so behaviour cannot drift:
 *   - the CLI wizard `scripts/setup.mjs` (built to `lib/node/patch-config.js`)
 *   - the standalone admin console (`admin/server.ts`)
 *
 * Only the `- id: dsh-chatnode-wechat` entry's `config:` subtree is touched;
 * comments, unknown keys and other entries are preserved verbatim. A backup is
 * written next to the file before every modification.
 *
 * @module @dsh-cowork/chatnode-wechat/node/patch-config
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pruneBackups } from "./memory.js";
export const ENTRY_ID = 'dsh-chatnode-wechat';
/** All placeholders the bridge accepts, in write order. */
export const CONFIG_FIELDS = [
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
    { key: 'imageInput', label: '图片输入模式', group: '媒体模型', placeholder: 'auto', hint: 'auto=按模型声明的模态自动选；native=强制原生图片；ocr=只走文字识别。' },
    { key: 'imageInputModel', label: '图片专用模型', group: '媒体模型', placeholder: 'provider/model', hint: '留空 = 跟随聊天模型。' },
    { key: 'ocrBaseUrl', label: 'OCR 端点', group: '媒体模型', default: 'https://api.siliconflow.cn/v1' },
    { key: 'imageGenApiKey', label: '生图 API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
    { key: 'imageGenModel', label: '生图模型', group: '媒体模型', default: 'Kwai-Kolors/Kolors' },
    { key: 'imageGenDir', label: '生图/语音输出目录', group: '媒体模型', placeholder: '默认 mediaDir/generated' },
    { key: 'sttApiKey', label: 'STT API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
    { key: 'sttModel', label: '语音转写模型', group: '媒体模型', default: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
    { key: 'ttsApiKey', label: 'TTS API Key', group: '媒体模型', secret: true, placeholder: '留空则用 OCR Key' },
    { key: 'ttsModel', label: '语音合成模型', group: '媒体模型', default: 'FunAudioLLM/CosyVoice2-0.5B' },
    { key: 'ttsVoice', label: '克隆音色 uri', group: '媒体模型', placeholder: 'speech:<name>:...' },
    // Email. Missing from this list is why the SMTP block could only be edited by
    // hand: the tool existed, the config existed, and the console had no field.
    {
        key: 'smtpHost',
        label: 'SMTP 服务器',
        group: '邮件',
        placeholder: 'smtp.qq.com',
        hint: 'send_email 工具需要 host + 用户名 + 密码三项齐全；用隐式 TLS（465）。',
    },
    { key: 'smtpPort', label: 'SMTP 端口', group: '邮件', kind: 'number', placeholder: '465' },
    { key: 'smtpUsername', label: 'SMTP 用户名', group: '邮件', placeholder: 'you@qq.com', hint: '同时作为发件人地址。' },
    { key: 'smtpPassword', label: 'SMTP 密码/授权码', group: '邮件', secret: true, placeholder: '邮箱授权码' },
    { key: 'smtpFromName', label: '发件人显示名', group: '邮件', placeholder: '留空则用用户名' },
    // Context-management scheme, owned by the standalone admin page
    // (admin/server.ts) and consumed by the conversation node. JSON so a scheme
    // can carry its own knobs without a schema change per knob:
    //   {"scheme":"rotate-turns","turns":20,"idleOnly":true,"announce":true,"handoff":false}
    // Schemes: manual | rotate-turns | rotate-turns+handoff | rotate-pressure | daily
    { key: 'contextPolicy', label: '上下文管理方案（JSON）', group: '可选', placeholder: '{"scheme":"manual"}', hint: '由管理台一键切换；桥按此决定何时轮换/交接会话。' },
    {
        key: 'memoryFile',
        label: '长期记忆文件',
        group: '可选',
        placeholder: '$DSH_HOME/wechat-memory/MEMORY.md',
        hint: '跨会话的长期事实（关于主人）；每天自动整理一次，可用 /memory 查看。',
    },
    {
        key: 'problemFile',
        label: '问题日志文件',
        group: '可选',
        placeholder: '$DSH_HOME/wechat-problems.log',
        hint: '被吞掉的失败都会写一行到这里；/problems 可查看。',
    }, {
        key: 'memoryInjectEvery',
        label: '记忆注入间隔（条）',
        group: '可选',
        kind: 'number',
        placeholder: '10',
        hint: '每 N 条消息把长期记忆作为背景注入一次；会话首条与记忆变化时必定注入。',
    },
    {
        key: 'memoryConsolidateTime',
        label: '记忆整理时间',
        group: '可选',
        placeholder: '04:30',
        hint: '每天这个时间整理长期记忆（需距最后一条消息 2 小时以上）；留空关闭。',
    },
];
export const KNOWN_KEYS = new Set(CONFIG_FIELDS.map((f) => f.key));
export function maskSecret(value) {
    if (!value)
        return '';
    return value.length <= 8 ? '****' : `${value.slice(0, 6)}****(+${value.length - 10})`;
}
/** Default patch path for a profile (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). */
export function defaultPatchPath(profile = 'web') {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'profiles', profile, 'cordis.patch.yml');
}
function leading(line) {
    const m = /^(\s*)/.exec(line);
    return m ? m[1].length : 0;
}
function unquote(s) {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        try {
            return JSON.parse(t);
        }
        catch {
            return t.slice(1, -1);
        }
    }
    return t;
}
export function yamlStr(value) {
    return JSON.stringify(String(value));
}
/** Locate the managed entry and read its current config values. */
export function parsePatch(text) {
    const lines = text.split(/\r?\n/);
    let entryStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i]);
        if (m && m[1] === ENTRY_ID) {
            entryStart = i;
            break;
        }
    }
    if (entryStart < 0) {
        return { lines, found: false, entryStart: -1, entryEnd: lines.length, configIndent: 2, current: {} };
    }
    let entryEnd = lines.length;
    for (let i = entryStart + 1; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith('-') && leading(lines[i]) === 0) {
            entryEnd = i;
            break;
        }
    }
    let configIndent = 2;
    const current = {};
    let cfgIdx = -1;
    for (let i = entryStart + 1; i < entryEnd; i++) {
        if (/^\s*config:\s*$/.test(lines[i])) {
            cfgIdx = i;
            configIndent = leading(lines[i]);
            break;
        }
    }
    if (cfgIdx >= 0) {
        for (let i = cfgIdx + 1; i < entryEnd; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const indent = leading(line);
            if (indent <= configIndent)
                break;
            const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
            if (!m)
                continue;
            const key = m[1];
            const inline = m[2].trim();
            if (key === 'allowFrom') {
                const items = [];
                let j = i + 1;
                while (j < entryEnd && leading(lines[j]) > indent) {
                    const li = lines[j].trim();
                    if (li.startsWith('-'))
                        items.push(unquote(li.slice(1).trim()));
                    j++;
                }
                current[key] = { indent, list: items };
                i = j - 1;
            }
            else if (inline) {
                current[key] = { indent, value: unquote(inline) };
            }
        }
    }
    return { lines, found: true, entryStart, entryEnd, configIndent, current };
}
export function extractValues(parsed) {
    const values = {};
    for (const [key, entry] of Object.entries(parsed.current)) {
        // Unknown keys are preserved verbatim by the writer but are not editable
        // through the wizard / web page, so they never enter the value set.
        if (key === 'allowFrom' || !KNOWN_KEYS.has(key))
            continue;
        if (entry.value !== undefined)
            values[key] = entry.value;
    }
    return { values, allowFrom: parsed.current.allowFrom?.list ?? [] };
}
/** Read the patch file; missing file is not an error. */
export async function readPatchFile(file) {
    try {
        const text = await readFile(file, 'utf8');
        const parsed = parsePatch(text);
        return { exists: true, parsed, patch: extractValues(parsed) };
    }
    catch (error) {
        const parsed = parsePatch('');
        // "There is no patch file" and "there is one and I could not read it" look
        // identical to a caller that only gets `exists: false`, and the difference
        // matters enormously: saving on top of the second case rewrites the profile
        // from scratch and takes every other plugin's entry with it.
        const code = error.code;
        if (code === 'ENOENT')
            return { exists: false, parsed, patch: { values: {}, allowFrom: [] } };
        return {
            exists: true,
            parsed,
            patch: { values: {}, allowFrom: [] },
            unreadable: error instanceof Error ? error.message : String(error),
        };
    }
}
/** Raised instead of writing when the target exists but cannot be read. */
export class PatchUnreadableError extends Error {
    file;
    reason;
    constructor(file, reason) {
        super(`配置文件存在但读不出来，已放弃写入以免覆盖：${file}（${reason}）`);
        this.name = 'PatchUnreadableError';
        this.file = file;
        this.reason = reason;
    }
}
/** Raised instead of writing when a value cannot be stored as its field's type. */
export class PatchValueError extends Error {
    key;
    value;
    constructor(key, value, expected) {
        super(`${key} 需要${expected}，收到「${value}」`);
        this.name = 'PatchValueError';
        this.key = key;
        this.value = value;
    }
}
/**
 * Validate one incoming value against its field's declared kind.
 *
 * The admin page checks this too, but the page is not the only caller: a hand
 * written request, a future UI bug, or `curl` would otherwise write
 * `memoryInjectEvery: "25 分钟"`, which the plugin's numeric schema rejects at
 * load — taking the whole profile down with it.
 */
export function validateUpdate(key, value) {
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    if (!field || field.kind !== 'number')
        return;
    if (/^-?\d+$/.test(value))
        return;
    throw new PatchValueError(key, value, '整数');
}
/**
 * Apply updates to the managed entry. `null` clears an optional key (or the
 * allowlist entry); `undefined`/absent leaves it untouched.
 */
export async function applyPatchConfig(file, updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (typeof value === 'string' && value !== '')
            validateUpdate(key, value);
    }
    let text = '';
    let exists = true;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT') {
            // Writing here would replace a file we could not read — losing every other
            // entry in the profile patch. Refuse loudly instead.
            throw new PatchUnreadableError(file, error instanceof Error ? error.message : String(error));
        }
        exists = false;
        text = '';
    }
    const parsed = parsePatch(text);
    const before = extractValues(parsed);
    const configIndent = parsed.found ? parsed.configIndent : 2;
    const ind = ' '.repeat(configIndent + 2);
    const itemInd = ' '.repeat(configIndent + 4);
    /** Effective new value for a key: explicit update, else current. */
    function valueFor(key) {
        if (key in updates) {
            const v = updates[key];
            return v === undefined || v === null || v === '' ? null : String(v);
        }
        if (key === 'allowFrom')
            return before.allowFrom[0] ?? null;
        const cur = before.values[key];
        return cur === undefined ? null : cur;
    }
    /**
     * The allowlist as a LIST, which is the shape the schema and the page both
     * use. The scalar path kept only `allowFrom[0]`, so a second WeChat id typed
     * into the console was silently dropped on save.
     */
    function allowList() {
        if ('allowFrom' in updates) {
            const raw = updates.allowFrom;
            if (raw === undefined || raw === null || raw === '')
                return null;
            return String(raw)
                .split(/[\n,]/)
                .map((entry) => entry.trim().replace(/^-\s*/, ''))
                .filter(Boolean);
        }
        return before.allowFrom.length > 0 ? [...before.allowFrom] : null;
    }
    /** One `allowFrom:` block (or `[]` when it ends up empty). */
    function pushAllowFrom(target) {
        const list = allowList();
        if (list && list.length > 0) {
            target.push(`${ind}allowFrom:`, ...list.map((entry) => `${itemInd}- ${yamlStr(entry)}`));
        }
        else {
            target.push(`${ind}allowFrom: []`);
        }
    }
    const scalarLine = (key, v) => `${ind}${key}: ${/^-?\d+$/.test(v) ? v : yamlStr(v)}`;
    const outBlock = [];
    if (parsed.found) {
        const childLines = parsed.lines.slice(parsed.entryStart + 1, parsed.entryEnd);
        let cfgIdx = -1;
        for (let i = 0; i < childLines.length; i++) {
            if (/^\s*config:\s*$/.test(childLines[i])) {
                cfgIdx = i;
                break;
            }
        }
        const emitted = new Set();
        if (cfgIdx >= 0) {
            let i = cfgIdx + 1;
            while (i < childLines.length) {
                const line = childLines[i];
                const trimmed = line.trim();
                const indent = leading(line);
                if (indent <= configIndent)
                    break;
                if (!trimmed || trimmed.startsWith('#')) {
                    outBlock.push(line);
                    i++;
                    continue;
                }
                const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
                if (!m) {
                    outBlock.push(line);
                    i++;
                    continue;
                }
                const key = m[1];
                if (key === 'allowFrom') {
                    let end = i + 1;
                    while (end < childLines.length && leading(childLines[end]) > indent)
                        end++;
                    if (!emitted.has('allowFrom')) {
                        emitted.add('allowFrom');
                        pushAllowFrom(outBlock);
                    }
                    i = end;
                    continue;
                }
                if (KNOWN_KEYS.has(key)) {
                    if (!emitted.has(key)) {
                        emitted.add(key);
                        const v = valueFor(key);
                        if (v !== null)
                            outBlock.push(scalarLine(key, v));
                    }
                    i++;
                    continue;
                }
                outBlock.push(line);
                i++;
            }
        }
        for (const field of CONFIG_FIELDS) {
            if (emitted.has(field.key))
                continue;
            if (field.key === 'allowFrom') {
                pushAllowFrom(outBlock);
                continue;
            }
            const v = valueFor(field.key);
            if (v !== null)
                outBlock.push(scalarLine(field.key, v));
        }
    }
    else {
        pushAllowFrom(outBlock);
        for (const field of CONFIG_FIELDS) {
            if (field.key === 'allowFrom')
                continue;
            const fv = valueFor(field.key);
            if (fv !== null)
                outBlock.push(scalarLine(field.key, fv));
        }
    }
    const finalLines = [];
    if (parsed.found) {
        finalLines.push(...parsed.lines.slice(0, parsed.entryStart));
        finalLines.push(`- id: ${ENTRY_ID}`);
        finalLines.push(`${' '.repeat(configIndent)}config:`);
        finalLines.push(...outBlock);
        finalLines.push(...parsed.lines.slice(parsed.entryEnd));
    }
    else {
        if (exists && text.length)
            finalLines.push(...parsed.lines, '');
        finalLines.push(`- id: ${ENTRY_ID}`, '  config:');
        finalLines.push(...outBlock);
    }
    // Diff summary
    const changed = [];
    for (const field of CONFIG_FIELDS) {
        const oldV = field.key === 'allowFrom' ? before.allowFrom.join('\n') : (before.values[field.key] ?? '');
        const newV = field.key === 'allowFrom' ? (allowList() ?? []).join('\n') : (valueFor(field.key) ?? '');
        if (oldV !== newV)
            changed.push(field.key);
    }
    await mkdir(dirname(file), { recursive: true }).catch(() => { });
    let backup;
    if (exists) {
        backup = `${file}.bak-${Date.now()}`;
        await copyFile(file, backup);
        // Saving repeatedly from the admin page used to leave one backup per save.
        pruneBackups(file, 5);
    }
    await writeFile(file, finalLines.join('\n') + '\n', 'utf8');
    return { changed, backup, file };
}
//# sourceMappingURL=patch-config.js.map