/**
 * Host-side HTTP API behind the WeChat bridge's Web management page.
 *
 * Registered as a second plugin of the bundle (`dsh-chatnode-wechat/config-api`)
 * so profiles without a web server (headless) simply never load it.
 *
 * Routes (all under `/dsh-chatnode-wechat/api`, loopback-only, guarded by a
 * custom header so cross-site requests cannot reach them):
 *   GET  /schema  → editable placeholder metadata
 *   GET  /config  → current values (secrets masked) + environment status
 *   POST /save    → { updates: { key: value | null } } → patch, backup, reload
 *
 * @module @dsh-cowork/chatnode-wechat/node/config-api
 */
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_FIELDS, KNOWN_KEYS, maskSecret, readPatchFile, applyPatchConfig, } from "./patch-config.js";
export const inject = ['webServer'];
const API = '/dsh-chatnode-wechat/api';
const GUARD_HEADER = 'x-dsh-chatnode-wechat';
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
/** Find the profile whose package.json depends on this bundle. */
async function locatePatch() {
    const override = process.env.DSH_WECHAT_PATCH;
    if (override)
        return { profile: process.env.DSH_WECHAT_PROFILE || 'web', file: override };
    const profilesDir = join(dshHome(), 'profiles');
    let names = [];
    try {
        const { readdir } = await import('node:fs/promises');
        names = await readdir(profilesDir);
    }
    catch {
        names = [];
    }
    for (const name of names.sort()) {
        const pkg = join(profilesDir, name, 'package.json');
        try {
            const text = await readFile(pkg, 'utf8');
            if (text.includes('@dsh-cowork/chatnode-wechat'))
                return { profile: name, file: join(profilesDir, name, 'cordis.patch.yml') };
        }
        catch {
            // no profile manifest here
        }
    }
    return { profile: 'web', file: join(profilesDir, 'web', 'cordis.patch.yml') };
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function status() {
    const loc = await locatePatch();
    const { exists: patchExists, patch } = await readPatchFile(loc.file);
    const preset = patch.values.agentPreset || 'wechat';
    const presetDir = join(dshHome(), '.agent-presets', preset);
    let weixinCredentials = false;
    try {
        const creds = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
        weixinCredentials = /WEIXIN_BOT_TOKEN\s*:/.test(creds);
    }
    catch {
        weixinCredentials = false;
    }
    return {
        profile: loc.profile,
        patchFile: loc.file,
        patchExists,
        preset,
        presetDir,
        presetExists: await exists(presetDir),
        weixinCredentials,
        siliconflowKey: Boolean(patch.values.ocrApiKey),
        allowFrom: patch.allowFrom,
    };
}
function maskValues(values) {
    const out = {};
    for (const field of CONFIG_FIELDS) {
        const raw = values[field.key];
        if (raw === undefined)
            continue;
        out[field.key] = field.secret ? maskSecret(raw) : raw;
    }
    return out;
}
function sendJson(res, code, payload) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
}
async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
        body += Buffer.from(chunk).toString('utf8');
        if (body.length > 1_000_000)
            throw new Error('body too large');
    }
    return body;
}
export function apply(ctx) {
    const disposer = ctx.webServer.register({
        kind: 'prefix',
        path: API,
        handler: async (req, res) => {
            if (req.headers?.[GUARD_HEADER] !== '1')
                return sendJson(res, 403, { ok: false, error: 'forbidden' });
            let url;
            try {
                url = new URL(req.url, 'http://127.0.0.1');
            }
            catch {
                return sendJson(res, 400, { ok: false, error: 'bad url' });
            }
            const path = url.pathname;
            try {
                if (path === `${API}/schema` && req.method === 'GET') {
                    return sendJson(res, 200, { ok: true, fields: CONFIG_FIELDS });
                }
                if (path === `${API}/status` && req.method === 'GET') {
                    return sendJson(res, 200, { ok: true, status: await status() });
                }
                if (path === `${API}/config` && req.method === 'GET') {
                    const loc = await locatePatch();
                    const { exists: patchExists, patch } = await readPatchFile(loc.file);
                    return sendJson(res, 200, {
                        ok: true,
                        file: loc.file,
                        profile: loc.profile,
                        patchExists,
                        fields: CONFIG_FIELDS,
                        values: maskValues(patch.values),
                        has: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, Boolean(patch.values[f.key])])),
                        allowFrom: patch.allowFrom,
                        status: await status(),
                    });
                }
                if (path === `${API}/save` && req.method === 'POST') {
                    let payload;
                    try {
                        payload = JSON.parse(await readBody(req));
                    }
                    catch {
                        return sendJson(res, 400, { ok: false, error: 'invalid json' });
                    }
                    const raw = payload?.updates;
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                        return sendJson(res, 400, { ok: false, error: 'updates object required' });
                    const updates = {};
                    for (const [key, value] of Object.entries(raw)) {
                        if (!KNOWN_KEYS.has(key))
                            return sendJson(res, 400, { ok: false, error: `unknown key: ${key}` });
                        if (value === null || value === undefined) {
                            updates[key] = null;
                            continue;
                        }
                        if (typeof value !== 'string')
                            return sendJson(res, 400, { ok: false, error: `value for ${key} must be a string or null` });
                        updates[key] = value.trim();
                    }
                    if (Object.keys(updates).length === 0)
                        return sendJson(res, 400, { ok: false, error: 'no updates' });
                    const loc = await locatePatch();
                    const result = await applyPatchConfig(loc.file, updates);
                    const after = await readPatchFile(loc.file);
                    ctx.logger?.info?.('[dsh-chatnode-wechat] config updated via web: %s', result.changed.join(', '));
                    return sendJson(res, 200, {
                        ok: true,
                        changed: result.changed,
                        backup: result.backup,
                        file: result.file,
                        values: maskValues(after.patch.values),
                        has: Object.fromEntries(CONFIG_FIELDS.filter((f) => f.secret).map((f) => [f.key, Boolean(after.patch.values[f.key])])),
                        allowFrom: after.patch.allowFrom,
                        status: await status(),
                    });
                }
                return sendJson(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
            }
            catch (error) {
                return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    });
    ctx.effect?.(() => () => disposer());
}
//# sourceMappingURL=config-api.js.map