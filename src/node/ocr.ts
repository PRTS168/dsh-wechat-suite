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
  apiKey?: string
  /** Model id on the OpenAI-compatible endpoint. */
  model?: string
  /** Base URL of the OpenAI-compatible API (no trailing slash). */
  baseUrl?: string
  /** Per-request timeout. */
  timeoutMs?: number
}

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-OCR'
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1'
const DEFAULT_TIMEOUT_MS = 60_000
/** Upper bound on the request body we are willing to build (protects memory). */
const MAX_IMAGE_BYTES = 15_000_000

/** Build the mime type from image bytes for the data URL. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  return 'image/png'
}

/**
 * Recognize text in an image via DeepSeek-OCR (SiliconFlow).
 * @returns the recognized text.
 * @throws on network/API failures so callers can decide how to degrade.
 */
export async function ocrImage(config: OcrConfig, bytes: Uint8Array): Promise<string> {
  if (!config.apiKey) throw new Error('ocrImage: no apiKey configured')
  if (bytes.length === 0) throw new Error('ocrImage: empty image')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`ocrImage: image too large (${bytes.length} bytes)`)

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = config.model ?? DEFAULT_MODEL
  const dataUrl = `data:${sniffMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: '请完整识别这张图片中的所有文字内容；如果是截图、文档、聊天记录或界面，请按阅读顺序逐条输出。不要编造图片里没有的内容。' },
            ],
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new Error(`DeepSeek-OCR HTTP ${response.status}: ${detail}`)
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('DeepSeek-OCR returned empty content')
    return content
  } finally {
    clearTimeout(timer)
  }
}
