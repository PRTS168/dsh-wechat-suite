/**
 * Text-to-image generation via SiliconFlow (OpenAI-compatible `/images`).
 *
 * Generates an image from a natural-language prompt, downloads the returned
 * temporary URL, and hands back a local file path the bridge can send to
 * WeChat (`wechat.sendImage`). Zero extra deps; the API key rides the bridge
 * config (`imageGenApiKey`), reusing the same SiliconFlow key as OCR when it
 * is not set explicitly.
 *
 * @module @dsh-cowork/chatnode-wechat/node/image-gen
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const DEFAULT_MODEL = 'Kwai-Kolors/Kolors';
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_SIZE = '1024x1024';
const MAX_BYTES = 20_000_000;
/** Generate one image and return the local path of the downloaded file. */
export async function generateImage(cfg, prompt) {
    if (!cfg.apiKey)
        throw new Error('generateImage: no apiKey configured');
    if (!prompt.trim())
        throw new Error('generateImage: prompt is required');
    const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = cfg.model ?? DEFAULT_MODEL;
    const imageSize = cfg.imageSize ?? DEFAULT_SIZE;
    // 1) Request generation.
    const genController = new AbortController();
    const genTimer = setTimeout(() => genController.abort(), 120_000);
    let data;
    try {
        const response = await fetch(`${baseUrl}/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ model, prompt: prompt.trim(), image_size: imageSize }),
            signal: genController.signal,
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`SiliconFlow image API HTTP ${response.status}: ${detail}`);
        }
        data = await response.json();
    }
    finally {
        clearTimeout(genTimer);
    }
    const url = data.images?.[0]?.url;
    if (!url)
        throw new Error('SiliconFlow returned no image url');
    // 2) Download the temporary file.
    const dlController = new AbortController();
    const dlTimer = setTimeout(() => dlController.abort(), 60_000);
    let bytes;
    try {
        const dl = await fetch(url, { signal: dlController.signal });
        if (!dl.ok)
            throw new Error(`image download HTTP ${dl.status}`);
        const raw = new Uint8Array(await dl.arrayBuffer());
        if (raw.length === 0 || raw.length > MAX_BYTES)
            throw new Error(`image download size ${raw.length}`);
        bytes = raw;
    }
    finally {
        clearTimeout(dlTimer);
    }
    // 3) Persist as .png (Kolors/… return PNG).
    const dir = cfg.outDir ?? join(process.cwd(), 'media', 'generated');
    await mkdir(dir, { recursive: true }).catch(() => { });
    const name = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const absPath = join(dir, name);
    await writeFile(absPath, bytes);
    return { path: absPath, bytes: bytes.length };
}
//# sourceMappingURL=image-gen.js.map