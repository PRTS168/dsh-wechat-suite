/**
 * Text-to-speech via SiliconFlow (CosyVoice2) with a cloned voice.
 *
 * Generates an mp3 for the given text using a previously cloned reference
 * voice (`voice` uri like `speech:<name>:<id>:<token>`). The mp3 is returned
 * as bytes; the caller converts to WeChat SILK and sends it as a voice note.
 *
 * @module @dsh-cowork/chatnode-wechat/node/tts
 */
const DEFAULT_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const MAX_BYTES = 20_000_000;
/** Synthesize speech for `text`; returns the mp3 bytes. @throws on failure. */
export async function synthesizeSpeech(cfg, text) {
    if (!cfg.apiKey)
        throw new Error('synthesizeSpeech: no apiKey configured');
    if (!cfg.voice)
        throw new Error('synthesizeSpeech: no cloned voice uri configured');
    if (!text.trim())
        throw new Error('synthesizeSpeech: text is required');
    const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = cfg.model ?? DEFAULT_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
        const response = await fetch(`${baseUrl}/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
                model,
                input: text.trim().slice(0, 500),
                voice: cfg.voice,
                response_format: 'mp3',
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`SiliconFlow TTS HTTP ${response.status}: ${detail}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_BYTES) {
            throw new Error(`SiliconFlow TTS returned ${bytes.length} bytes`);
        }
        return bytes;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=tts.js.map