/**
 * QQ 开放平台 Bot REST API 客户端。
 * 仅依赖 Node.js >= 22 内置 fetch，无第三方框架。
 */

export interface QQApiOptions {
  appId: string
  clientSecret: string
  /** 沙箱环境（开发期未上线时使用） */
  sandbox?: boolean
}

const PROD_API = 'https://api.sgroup.qq.com'
const SANDBOX_API = 'https://sandbox.api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

export class QQApi {
  private options: QQApiOptions
  private accessToken = ''
  private tokenExpiresAt = 0

  constructor(options: QQApiOptions) {
    this.options = options
  }

  private get baseUrl() {
    return this.options.sandbox ? SANDBOX_API : PROD_API
  }

  /** 获取（必要时刷新）AppAccessToken。凭证有效期约 2 小时，提前 5 分钟刷新。 */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.options.appId,
        clientSecret: this.options.clientSecret,
      }),
    })
    if (!res.ok) {
      throw new Error(`[dsh-qq-bot] getAppAccessToken failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { access_token: string; expires_in: string }
    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + Number(data.expires_in) * 1000
    return this.accessToken
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken()
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': this.options.appId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`[dsh-qq-bot] ${method} ${path} failed: ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as T
  }

  /** 获取 WebSocket 网关地址。 */
  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url: string }>('GET', '/gateway')
    return data.url
  }

  /** 回复群聊消息（被动回复必须带 msg_id 与自增 msg_seq）。 */
  async sendGroupMessage(groupOpenid: string, content: string, msgId: string, msgSeq: number) {
    return this.request('POST', `/v2/groups/${groupOpenid}/messages`, {
      content,
      msg_type: 0,
      msg_id: msgId,
      msg_seq: msgSeq,
    })
  }

  /** 回复单聊（C2C）消息。 */
  async sendC2CMessage(openid: string, content: string, msgId: string, msgSeq: number) {
    return this.request('POST', `/v2/users/${openid}/messages`, {
      content,
      msg_type: 0,
      msg_id: msgId,
      msg_seq: msgSeq,
    })
  }
}
