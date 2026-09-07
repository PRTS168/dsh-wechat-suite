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
/** STT request options. */
export interface SttConfig {
    /** SiliconFlow API key (sk-…). Required. */
    apiKey: string;
    /** ASR model id, defaults to XingChenAGI/XingChenASR-V3.2-Ultra. */
    model?: string;
    /** OpenAI-compatible base URL (no trailing slash). */
    baseUrl?: string;
}
/** Guess a multipart filename extension from audio magic bytes (best-effort). */
export declare function audioExtension(bytes: Uint8Array): string;
/** Transcribe an audio buffer to text. @throws on network/API failures. */
export declare function transcribeSpeech(cfg: SttConfig, bytes: Uint8Array): Promise<string>;
//# sourceMappingURL=stt.d.ts.map