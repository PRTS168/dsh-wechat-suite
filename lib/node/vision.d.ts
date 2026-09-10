/**
 * Native image input: capability resolution and image-block construction.
 *
 * An inbound WeChat image can reach the model two ways:
 *
 * - **native** — a real `image` content block, so a multimodal model sees the
 *   pixels itself (best for photos, layouts, anything OCR garbles);
 * - **OCR** — text extracted by a cheap OCR model and handed over as text
 *   (cheaper for documents/screenshots, and the only option for text-only
 *   models).
 *
 * Which one applies is resolved from the *routed model's own declaration*:
 * `llm.listModels()` reports `inputModalities`, and `dsh-llm-deepseek` refuses
 * an image block outright when the model does not declare `image`
 * ("DeepSeek model … does not support image input"). Declaring is not proving,
 * though — the harness documents that a model claiming images its endpoint
 * refuses is refused mid-turn — so a refusal observed once is cached and later
 * pictures go straight to OCR instead of burning a turn each time.
 *
 * @module @dsh-cowork/chatnode-wechat/node/vision
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** Mode selection for how an inbound image reaches the model. */
export type ImageInputMode = 'auto' | 'native' | 'ocr';
/**
 * Media types the harness attachment store accepts for a native image block.
 * Declared locally because `@deepseek-ai/dsh-attachment` is a host service
 * this bundle consumes through `ctx.attachments`, not a declared dependency.
 */
export type NativeImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/**
 * Durable reference returned by `attachments.saveImage`. Only the identity is
 * needed here; the block carries the reference and the harness resolves it.
 */
export interface SavedImageRef {
    attachmentId: unknown;
    mediaType: NativeImageMediaType;
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
/** Minimal shape of the `llm` service this module needs. */
export interface LlmModelCatalog {
    listProviders(): Array<{
        id: string;
        name?: string;
    }>;
    listModels(provider: string): Promise<Array<{
        id: string;
        name?: string;
        inputModalities?: readonly string[];
    }>>;
}
/** Minimal shape of the `attachments` service this module needs. */
export interface ImageAttachmentSaver {
    saveImage(input: {
        data: Uint8Array;
        mediaType: NativeImageMediaType;
        name?: string;
    }): Promise<SavedImageRef>;
}
/** What the resolver decided for one inbound image. */
export interface ImageDeliveryDecision {
    mode: ImageInputMode;
    /** Route the native block would go to, when one was found. */
    route?: {
        provider: string;
        model: string;
    };
    /** Why the resolver settled on `mode` (logged, never sent to the user). */
    reason: string;
}
/** `provider/model` key used for the refusal cache and log lines. */
export declare function routeKey(provider: string, model: string): string;
/** Record that a route refused an image, suppressing native retries for a while. */
export declare function noteImageRefusal(provider: string, model: string): void;
/** Cleared by tests; production never needs it. */
export declare function clearImageRefusals(): void;
/** Whether a route is currently suppressed by an observed provider refusal. */
export declare function isImageRefused(provider: string, model: string): boolean;
/** Split a `provider/model` string (model ids may contain `/`, provider may not). */
export declare function parseRoute(value: string | undefined): {
    provider: string;
    model: string;
} | undefined;
/** Whether a model's declared modalities include image input. */
export declare function declaresImageInput(llm: LlmModelCatalog | undefined, provider: string, model: string): Promise<boolean>;
/** First model on any route that declares image input (for `auto`). */
export declare function findImageCapableRoute(llm: LlmModelCatalog | undefined): Promise<{
    provider: string;
    model: string;
} | undefined>;
/**
 * Decide how one inbound image should reach the model.
 *
 * `chatRoute` is the route the active agent actually chats on; `configured`
 * (`imageInputModel`) overrides it for pictures only.
 */
export declare function resolveImageDelivery(options: {
    mode: ImageInputMode;
    llm?: LlmModelCatalog;
    chatRoute?: {
        provider: string;
        model: string;
    };
    configuredRoute?: {
        provider: string;
        model: string;
    };
}): Promise<ImageDeliveryDecision>;
/** Build the durable image content block for a native delivery. */
export declare function buildImageBlock(attachments: ImageAttachmentSaver | undefined, image: {
    data: Uint8Array;
    mediaType: NativeImageMediaType;
    name?: string;
}): Promise<ContentBlock>;
//# sourceMappingURL=vision.d.ts.map