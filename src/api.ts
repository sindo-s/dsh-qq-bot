/**
 * QQ 开放平台 Bot REST API 客户端。
 * 仅依赖 Node.js >= 22 内置 fetch，无第三方框架。
 */

export interface QQApiOptions {
  appId: string
  clientSecret: string
  /** 沙箱环境（开发期未上线时使用）。 */
  sandbox?: boolean
  /** 单次 HTTP 请求超时，默认 10 秒。 */
  requestTimeoutMs?: number
  /** 测试或宿主注入的 fetch 实现。 */
  fetch?: typeof fetch
}

const PROD_API = 'https://api.sgroup.qq.com'
const SANDBOX_API = 'https://sandbox.api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

interface QQTokenResponse {
  access_token?: unknown
  expires_in?: unknown
}

interface PassiveReply {
  msgId: string
  msgSeq: number
}

export class QQApi {
  private readonly options: QQApiOptions
  private readonly fetchImpl: typeof fetch
  private accessToken = ''
  private tokenExpiresAt = 0
  private tokenRefresh: Promise<string> | null = null

  constructor(options: QQApiOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private get baseUrl() {
    return this.options.sandbox ? SANDBOX_API : PROD_API
  }

  private get requestTimeoutMs() {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** 让下一次请求重新获取 AppAccessToken。 */
  invalidateAccessToken() {
    this.accessToken = ''
    this.tokenExpiresAt = 0
  }

  /** 获取（必要时刷新）AppAccessToken；并发刷新只发起一个请求。 */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.accessToken
    }
    if (this.tokenRefresh) return this.tokenRefresh

    const refresh = this.fetchAccessToken()
    this.tokenRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.tokenRefresh === refresh) this.tokenRefresh = null
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.options.appId,
        clientSecret: this.options.clientSecret,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!res.ok) {
      throw new Error(`[dsh-qq-bot] getAppAccessToken failed: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as QQTokenResponse
    const token = typeof data.access_token === 'string' ? data.access_token : ''
    const expiresIn = Number(data.expires_in)
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('[dsh-qq-bot] getAppAccessToken returned an invalid response')
    }

    this.accessToken = token
    this.tokenExpiresAt = Date.now() + expiresIn * 1000
    return token
  }

  private async request<T>(method: string, path: string, body?: unknown, retryAuth = true): Promise<T> {
    const token = await this.getAccessToken()
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': this.options.appId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })

    if (res.status === 401 && retryAuth) {
      this.invalidateAccessToken()
      return this.request(method, path, body, false)
    }
    if (!res.ok) {
      throw new Error(`[dsh-qq-bot] ${method} ${path} failed: ${res.status} ${await res.text()}`)
    }

    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  /** 获取 WebSocket 网关地址。 */
  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url?: unknown }>('GET', '/gateway')
    if (typeof data?.url !== 'string' || !data.url) {
      throw new Error('[dsh-qq-bot] gateway response did not contain a URL')
    }
    return data.url
  }

  private sendMessage(path: string, content: string, reply?: PassiveReply) {
    return this.request('POST', path, {
      content,
      msg_type: 0,
      ...(reply ? { msg_id: reply.msgId, msg_seq: reply.msgSeq } : {}),
    })
  }

  /** 被动回复群聊消息，msgSeq 必须在同一 msgId 下递增。 */
  replyGroupMessage(groupOpenid: string, content: string, msgId: string, msgSeq: number) {
    return this.sendMessage(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, content, { msgId, msgSeq })
  }

  /** 主动发送群聊消息；请求体不携带 msg_id/msg_seq。 */
  sendGroupMessage(groupOpenid: string, content: string) {
    return this.sendMessage(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, content)
  }

  /** 被动回复单聊（C2C）消息。 */
  replyC2CMessage(openid: string, content: string, msgId: string, msgSeq: number) {
    return this.sendMessage(`/v2/users/${encodeURIComponent(openid)}/messages`, content, { msgId, msgSeq })
  }

  /** 主动发送单聊（C2C）消息；请求体不携带 msg_id/msg_seq。 */
  sendC2CMessage(openid: string, content: string) {
    return this.sendMessage(`/v2/users/${encodeURIComponent(openid)}/messages`, content)
  }
}
