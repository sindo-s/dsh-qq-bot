/**
 * QQ 开放平台 WebSocket 网关客户端。
 * 负责鉴权（Identify）、心跳、断线重连与会话恢复（Resume）。
 * 使用 Node.js >= 22 内置 WebSocket，无第三方依赖。
 */

import type { QQApi } from './api.ts'

/** 群聊 @ 机器人 + 单聊消息事件 intent。 */
const INTENTS_GROUP_AND_C2C = 1 << 25

export interface QQMessageEvent {
  /** 事件类型：GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE */
  type: string
  /** 消息纯文本内容（群聊中会包含 @机器人 前缀，需调用方自行清理） */
  content: string
  /** 被动回复凭证 */
  msgId: string
  /** 群聊事件的 group_openid 或单聊事件的 author openid */
  chatId: string
  /** 是否群聊 */
  isGroup: boolean
}

interface GatewayPayload {
  op: number
  d?: any
  s?: number
  t?: string
}

export interface QQGatewayOptions {
  onMessage: (event: QQMessageEvent) => void
  onLog?: (line: string) => void
}

export class QQGateway {
  private api: QQApi
  private options: QQGatewayOptions
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastSeq: number | null = null
  private sessionId = ''
  private stopped = false

  constructor(api: QQApi, options: QQGatewayOptions) {
    this.api = api
    this.options = options
  }

  private log(line: string) {
    this.options.onLog?.(line)
  }

  async start() {
    this.stopped = false
    await this.connect()
  }

  stop() {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
  }

  private async connect() {
    const url = await this.api.getGatewayUrl()
    const token = await this.api.getAccessToken()
    const authToken = `QQBot ${token}`
    this.log(`[dsh-qq-bot] connecting gateway ${url}`)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onmessage = (ev) => {
      const payload = JSON.parse(String(ev.data)) as GatewayPayload
      if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s

      switch (payload.op) {
        case 10: {
          // Hello：启动心跳并鉴权/恢复
          const interval = payload.d.heartbeat_interval as number
          this.startHeartbeat(ws, interval)
          if (this.sessionId) {
            this.send(ws, { op: 6, d: { token: authToken, session_id: this.sessionId, seq: this.lastSeq } })
          } else {
            this.send(ws, {
              op: 2,
              d: {
                token: authToken,
                intents: INTENTS_GROUP_AND_C2C,
                shard: [0, 1],
                properties: {},
              },
            })
          }
          break
        }
        case 0:
          this.handleDispatch(payload)
          break
        case 7:
        case 9:
          // 服务端要求重连 / 会话失效
          if (payload.op === 9) this.sessionId = ''
          this.reconnect()
          break
      }
    }

    ws.onclose = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      if (!this.stopped) this.reconnect()
    }

    ws.onerror = () => {
      this.log('[dsh-qq-bot] gateway error')
    }
  }

  private reconnect() {
    if (this.stopped) return
    this.log('[dsh-qq-bot] reconnecting in 5s...')
    setTimeout(() => {
      if (!this.stopped) void this.connect().catch((err) => {
        this.log(`[dsh-qq-bot] reconnect failed: ${err}`)
        this.reconnect()
      })
    }, 5000)
  }

  private startHeartbeat(ws: WebSocket, interval: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this.send(ws, { op: 1, d: this.lastSeq })
    }, interval)
  }

  private send(ws: WebSocket, payload: GatewayPayload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  private handleDispatch(payload: GatewayPayload) {
    switch (payload.t) {
      case 'READY':
        this.sessionId = payload.d.session_id
        this.log(`[dsh-qq-bot] READY, user=${payload.d.user?.username}`)
        break
      case 'RESUMED':
        this.log('[dsh-qq-bot] session resumed')
        break
      case 'GROUP_AT_MESSAGE_CREATE':
        this.options.onMessage({
          type: payload.t!,
          content: String(payload.d.content ?? ''),
          msgId: payload.d.id,
          chatId: payload.d.group_openid,
          isGroup: true,
        })
        break
      case 'C2C_MESSAGE_CREATE':
        this.options.onMessage({
          type: payload.t!,
          content: String(payload.d.content ?? ''),
          msgId: payload.d.id,
          chatId: payload.d.author?.user_openid,
          isGroup: false,
        })
        break
    }
  }
}
