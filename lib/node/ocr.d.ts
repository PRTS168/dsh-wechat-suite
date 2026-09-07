/**
 * DeepSeek-OCR integration for inbound WeChat images.
 *
 * When an `ocrApiKey` is configured (SiliconFlow), inbound images are sent to
 * `deepseek-ai/DeepSeek-OCR` (OpenAI-compatible chat completions) right after
 * they are saved, and the recognized text is included in the message handed to
 * the agent — so the default text-only model can answer "what's in this image"
 * without needing a vision model or a read_image tool.
 *
 * No key → OCR is skipped entirely (image is only saved + path forwarded).
 *
 * @module @dsh-cowork/chatnode-wechat/node/ocr
 */
/** Defaults for the SiliconFlow-hosted DeepSeek-OCR endpoint. */
export interface OcrConfig {
    /** SiliconFlow API key (sk-…). Empty/undefined disables OCR. */
    apiKey?: string;
    /** Model id on the OpenAI-compatible endpoint. */
    model?: string;
    /** Base URL of the OpenAI-compatible API (no trailing slash). */
    baseUrl?: string;
    /** Per-request timeout. */
    timeoutMs?: number;
}
/**
 * Recognize text in an image via DeepSeek-OCR (SiliconFlow).
 * @returns the recognized text.
 * @throws on network/API failures so callers can decide how to degrade.
 */
export declare function ocrImage(config: OcrConfig, bytes: Uint8Array): Promise<string>;
//# sourceMappingURL=ocr.d.ts.map