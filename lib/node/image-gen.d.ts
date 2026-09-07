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
/** Generation request options. */
export interface ImageGenConfig {
    /** SiliconFlow API key (sk-…). Required. */
    apiKey: string;
    /** Model id, defaults to Kwai-Kolors/Kolors. */
    model?: string;
    /** OpenAI-compatible base URL (no trailing slash). */
    baseUrl?: string;
    /** Output size; model-dependent. */
    imageSize?: string;
    /** Where generated files are written (defaults alongside mediaDir). */
    outDir?: string;
}
/** Generate one image and return the local path of the downloaded file. */
export declare function generateImage(cfg: ImageGenConfig, prompt: string): Promise<{
    path: string;
    bytes: number;
}>;
//# sourceMappingURL=image-gen.d.ts.map