/**
 * Speech-to-text via SiliconFlow (XingChen ASR family).
 *
 * WeChat voice notes that carry a downloadable audio item are transcribed
 * here and handed to the agent as `[语音转写]` text. The API is the
 * OpenAI-compatible `/v1/audio/transcriptions` multipart endpoint; audio is
 * sent as-is (silk/amr/m4a), no local conversion needed.
 *
 * @module @dsh-cowork/chatnode-wechat/node/stt
 */
const DEFAULT_MODEL = 'XingChenAGI/XingChenASR-V3.2-Ultra';
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
/** Safety cap: WeChat voice notes are seconds-long; reject absurd payloads. */
const MAX_AUDIO_BYTES = 30_000_000;
/** Guess a multipart filename extension from audio magic bytes (best-effort). */
export function audioExtension(bytes) {
    // MP4/M4A: ....ftyp
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
        return 'm4a';
    // AMR: "#!AMR"
    if (bytes.length >= 6 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41 && bytes[3] === 0x4d && bytes[4] === 0x52)
        return 'amr';
    // WAV: RIFF....WAVE
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45)
        return 'wav';
    // MP3: ID3 or 0xFF 0xFB
    if (bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)))
        return 'mp3';
    // WeChat voice notes are often Silk v3; SiliconFlow accepts a raw stream.
    return 'audio';
}
/** Transcribe an audio buffer to text. @throws on network/API failures. */
export async function transcribeSpeech(cfg, bytes) {
    if (!cfg.apiKey)
        throw new Error('transcribeSpeech: no apiKey configured');
    if (bytes.length === 0)
        throw new Error('transcribeSpeech: empty audio');
    if (bytes.length > MAX_AUDIO_BYTES)
        throw new Error(`transcribeSpeech: audio too large (${bytes.length} bytes)`);
    const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = cfg.model ?? DEFAULT_MODEL;
    const ext = audioExtension(bytes);
    const mime = ext === 'm4a' ? 'audio/mp4'
        : ext === 'amr' ? 'audio/amr'
            : ext === 'wav' ? 'audio/wav'
                : ext === 'mp3' ? 'audio/mpeg'
                    : 'application/octet-stream';
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([Buffer.from(bytes)], { type: mime }), `voice.${ext}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
        const response = await fetch(`${baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`SiliconFlow ASR HTTP ${response.status}: ${detail}`);
        }
        const data = await response.json();
        const text = data.text?.trim();
        if (!text)
            throw new Error('SiliconFlow ASR returned empty text');
        return text;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=stt.js.map