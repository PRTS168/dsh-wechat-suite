/**
 * Text-to-speech via SiliconFlow (CosyVoice2) with a cloned voice.
 *
 * Generates an mp3 for the given text using a previously cloned reference
 * voice (`voice` uri like `speech:<name>:<id>:<token>`). The mp3 is returned
 * as bytes; the caller converts to WeChat SILK and sends it as a voice note.
 *
 * @module @dsh-cowork/chatnode-wechat/node/tts
 */
/** TTS request options. */
export interface TtsConfig {
    /** SiliconFlow API key (sk-…). Required. */
    apiKey: string;
    /** Model id, defaults to FunAudioLLM/CosyVoice2-0.5B. */
    model?: string;
    /** Cloned voice uri returned by the upload-reference-audio endpoint. */
    voice: string;
    /** OpenAI-compatible base URL (no trailing slash). */
    baseUrl?: string;
}
/** Synthesize speech for `text`; returns the mp3 bytes. @throws on failure. */
export declare function synthesizeSpeech(cfg: TtsConfig, text: string): Promise<Uint8Array>;
//# sourceMappingURL=tts.d.ts.map