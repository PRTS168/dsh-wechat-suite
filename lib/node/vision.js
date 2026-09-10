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
/** How long a provider refusal suppresses native attempts for the same route. */
const REFUSAL_TTL_MS = 3 * 60 * 60 * 1000;
/** Route → epoch ms until which native image input is considered refused. */
const refusals = new Map();
/** `provider/model` key used for the refusal cache and log lines. */
export function routeKey(provider, model) {
    return `${provider}/${model}`;
}
/** Record that a route refused an image, suppressing native retries for a while. */
export function noteImageRefusal(provider, model) {
    refusals.set(routeKey(provider, model), Date.now() + REFUSAL_TTL_MS);
}
/** Cleared by tests; production never needs it. */
export function clearImageRefusals() {
    refusals.clear();
}
/** Whether a route is currently suppressed by an observed provider refusal. */
export function isImageRefused(provider, model) {
    const until = refusals.get(routeKey(provider, model));
    if (until === undefined)
        return false;
    if (until <= Date.now()) {
        refusals.delete(routeKey(provider, model));
        return false;
    }
    return true;
}
/** Split a `provider/model` string (model ids may contain `/`, provider may not). */
export function parseRoute(value) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    const cut = trimmed.indexOf('/');
    if (cut <= 0 || cut === trimmed.length - 1)
        return undefined;
    return { provider: trimmed.slice(0, cut).trim(), model: trimmed.slice(cut + 1).trim() };
}
/** Whether a model's declared modalities include image input. */
export async function declaresImageInput(llm, provider, model) {
    if (!llm)
        return false;
    try {
        const models = await llm.listModels(provider);
        const entry = models.find((m) => m.id === model);
        return entry?.inputModalities?.includes('image') === true;
    }
    catch {
        // An unreachable route cannot accept anything: treat as no image support.
        return false;
    }
}
/** First model on any route that declares image input (for `auto`). */
export async function findImageCapableRoute(llm) {
    if (!llm)
        return undefined;
    let providers = [];
    try {
        providers = llm.listProviders();
    }
    catch {
        return undefined;
    }
    for (const provider of providers) {
        let models = [];
        try {
            models = await llm.listModels(provider.id);
        }
        catch {
            continue;
        }
        for (const model of models) {
            if (model.inputModalities?.includes('image') === true && !isImageRefused(provider.id, model.id)) {
                return { provider: provider.id, model: model.id };
            }
        }
    }
    return undefined;
}
/**
 * Decide how one inbound image should reach the model.
 *
 * `chatRoute` is the route the active agent actually chats on; `configured`
 * (`imageInputModel`) overrides it for pictures only.
 */
export async function resolveImageDelivery(options) {
    const { mode, llm } = options;
    if (mode === 'ocr')
        return { mode: 'ocr', reason: 'imageInput=ocr (forced text path)' };
    const target = options.configuredRoute ?? options.chatRoute;
    const source = options.configuredRoute ? 'imageInputModel' : 'chat route';
    if (target) {
        if (isImageRefused(target.provider, target.model)) {
            return { mode: 'ocr', reason: `${routeKey(target.provider, target.model)} refused an image recently` };
        }
        if (await declaresImageInput(llm, target.provider, target.model)) {
            return { mode: 'native', route: target, reason: `${source} ${routeKey(target.provider, target.model)} declares image input` };
        }
        if (mode === 'native') {
            // Forced native with no such declaration: still try it once. The route may
            // accept images without advertising them, and a refusal degrades later
            // messages instead of failing silently now.
            return { mode: 'native', route: target, reason: `${source} ${routeKey(target.provider, target.model)} does not declare image input (forced native)` };
        }
    }
    if (mode === 'auto') {
        const found = await findImageCapableRoute(llm);
        if (found) {
            return { mode: 'native', route: found, reason: `auto-discovered image-capable route ${routeKey(found.provider, found.model)}` };
        }
    }
    const because = target
        ? `${routeKey(target.provider, target.model)} does not accept images`
        : 'no active model route';
    return { mode: 'ocr', reason: `${because}; using OCR` };
}
/** Build the durable image content block for a native delivery. */
export async function buildImageBlock(attachments, image) {
    if (!attachments)
        throw new Error('image attachment service unavailable');
    const ref = await attachments.saveImage(image);
    return { type: 'image', attachment: ref };
}
//# sourceMappingURL=vision.js.map