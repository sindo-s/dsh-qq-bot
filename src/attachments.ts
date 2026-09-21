import type { AttachmentStore, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export interface QQAttachment {
  url: string
  contentType?: string
  filename?: string
  size?: number
}
export class ImageInputError extends Error {}
export interface ImageOptions {
  enableImages?: boolean
  maxImagesPerMessage?: number
  maxImageBytes?: number
  imageDownloadTimeoutMs?: number
}
export function parseQQAttachments(value: unknown): QQAttachment[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const row = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    return {
      url: typeof row.url === 'string' ? row.url : '',
      contentType: typeof row.content_type === 'string' ? row.content_type : undefined,
      filename: typeof row.filename === 'string' ? row.filename : undefined,
      size: typeof row.size === 'number' ? row.size : undefined,
    }
  })
}

/** QQ media URLs may omit the scheme. Only fetch QQ's image CDNs, never arbitrary message URLs. */
export function qqImageUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`) }
  catch { throw new ImageInputError('图片地址无效，请重新发送图片。') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !(host === 'multimedia.nt.qq.com' || host === 'multimedia.nt.qq.com.cn' || host.endsWith('.qpic.cn'))) {
    throw new ImageInputError('图片地址不是受支持的 QQ 图片地址，请通过 QQ 直接发送图片。')
  }
  return url
}
function imageType(data: Uint8Array): ImageMediaType {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new ImageInputError('暂不支持此附件格式，请发送 PNG、JPEG、WebP 或 GIF 图片。')
}
async function downloadImage(attachment: QQAttachment, limit: number, signal: AbortSignal, fetchImpl: typeof fetch): Promise<SaveImageAttachment> {
  if (attachment.contentType && !attachment.contentType.toLowerCase().startsWith('image/')
    && attachment.contentType.toLowerCase() !== 'application/octet-stream') {
    throw new ImageInputError('目前仅支持文字和图片附件，暂不支持语音、视频或其他文件。')
  }
  if (attachment.size !== undefined && attachment.size > limit) throw new ImageInputError('图片太大，请压缩后重发。')
  let url = qqImageUrl(attachment.url)
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const target = response.headers.get('location')
      if (!target || hop === 3) throw new ImageInputError('图片下载跳转失败，请重新发送。')
      url = qqImageUrl(new URL(target, url).href)
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new ImageInputError('图片下载失败，可能已经过期，请重新发送图片。')
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel()
      throw new ImageInputError('图片太大，请压缩后重发。')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const {done, value} = await reader.read()
        signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new ImageInputError('图片太大，请压缩后重发。')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const data = Buffer.concat(chunks, size)
    return { data, mediaType: imageType(data), name: attachment.filename }
  }
  throw new ImageInputError('图片下载失败，请重新发送。')
}

export async function prepareQQContent(
  text: string,
  attachments: readonly QQAttachment[],
  store: Pick<AttachmentStore, 'imageLimits' | 'saveImages'> | undefined,
  options: ImageOptions,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ContentBlock[]> {
  if (!attachments.length) return [{ type: 'text', text }]
  if (options.enableImages === false) throw new ImageInputError('机器人尚未开启图片输入，请联系管理员开启 enableImages。')
  if (!store) throw new ImageInputError('DSH 图片存储服务未加载，请联系管理员检查附件插件。')
  const countLimit = Math.min(options.maxImagesPerMessage ?? 4, store.imageLimits.maxImagesPerMessage)
  if (attachments.length > countLimit) throw new ImageInputError(`一次最多支持 ${countLimit} 张图片，请分开发送。`)
  const perImage = Math.min(options.maxImageBytes ?? 10 * 1024 * 1024, store.imageLimits.maxImageBytes)
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(options.imageDownloadTimeoutMs ?? 15_000)])
  const images: SaveImageAttachment[] = []
  let remaining = store.imageLimits.maxMessageImageBytes
  try {
    for (const attachment of attachments) {
      downloadSignal.throwIfAborted()
      const image = await downloadImage(attachment, Math.min(perImage, remaining), downloadSignal, fetchImpl)
      remaining -= image.data.byteLength
      images.push(image)
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ImageInputError) throw error
    throw new ImageInputError('图片下载失败或超时，请稍后重新发送。')
  }
  signal.throwIfAborted()
  try {
    const refs = await store.saveImages(images)
    signal.throwIfAborted()
    return [
      { type: 'text', text: text || '请查看并分析图片中的内容。' },
      ...refs.map((attachment) => ({ type: 'image' as const, attachment })),
    ]
  } catch {
    signal.throwIfAborted()
    throw new ImageInputError('图片无法解析或超出 DSH 图片限制，请压缩为 PNG/JPEG 后重新发送。')
  }
}
