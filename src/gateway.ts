/**
 * QQ 开放平台 WebSocket 网关客户端。
 * 负责鉴权（Identify）、心跳、断线重连与会话恢复（Resume）。
 * 使用 Node.js >= 22 内置 WebSocket，无第三方依赖。
 */

import type { QQApi } from './api.ts'

/** 群聊 @ 机器人 + 单聊消息事件 intent。 */
const INTENTS_GROUP_AND_C2C = 1 << 25

/** 重连间隔（毫秒）。 */
const RECONNECT_DELAY = 5000

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastSeq: number | null = null
  private sessionId = ''
  private stopped = false
  /** 上次心跳后是否收到过 ACK（op 11），用于心跳丢失告警 */
  private heartbeatAcked = true

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
    this.clearTimers()
    this.ws?.close()
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = null
    this.reconnectTimer = null
  }

  private async connect() {
    // 建立新连接前，确保旧连接已关闭，避免同一 token 双连接互踢
    const old = this.ws
    this.ws = null
    if (old && old.readyState !== WebSocket.CLOSED && old.readyState !== WebSocket.CLOSING) {
      old.onclose = null
      old.close()
    }

    const url = await this.api.getGatewayUrl()
    const token = await this.api.getAccessToken()
    const authToken = `QQBot ${token}`
    this.log(`[dsh-qq-bot] connecting gateway ${url}`)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onmessage = (ev) => {
      let payload: GatewayPayload
      try {
        payload = JSON.parse(String(ev.data)) as GatewayPayload
      } catch {
        this.log('[dsh-qq-bot] ignoring unparseable gateway frame')
        return
      }
      if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s

      try {
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
          case 1:
            // 服务端主动请求心跳，立即回应
            this.send(ws, { op: 1, d: this.lastSeq })
            break
          case 11:
            this.heartbeatAcked = true
            break
          case 7:
            // 服务端要求重连（可恢复会话）
            this.log('[dsh-qq-bot] server requested reconnect')
            this.scheduleReconnect(ws)
            break
          case 9:
            // 会话失效；d=false 表示不可恢复，需重新 Identify
            if (payload.d === false) this.sessionId = ''
            this.log(`[dsh-qq-bot] invalid session (resumable=${payload.d !== false})`)
            this.scheduleReconnect(ws)
            break
        }
      } catch (err) {
        this.log(`[dsh-qq-bot] frame handling error: ${err}`)
      }
    }

    ws.onclose = (ev) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      // 关闭码是掉线原因的关键线索（4009 会话超时 / 4014 intents 未开通 等）
      this.log(`[dsh-qq-bot] gateway closed: code=${ev.code} reason=${ev.reason || '(none)'}`)
      if (!this.stopped) this.scheduleReconnect(ws)
    }

    ws.onerror = () => {
      this.log('[dsh-qq-bot] gateway error')
    }
  }

  /** 单flight 重连：同一时间只允许一个重连定时器。 */
  private scheduleReconnect(fromWs?: WebSocket) {
    if (this.stopped || this.reconnectTimer) return
    if (fromWs && fromWs.readyState !== WebSocket.CLOSED && fromWs.readyState !== WebSocket.CLOSING) {
      fromWs.onclose = null
      fromWs.close()
    }
    this.log(`[dsh-qq-bot] reconnecting in ${RECONNECT_DELAY / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect().catch((err) => {
        this.log(`[dsh-qq-bot] reconnect failed: ${err}`)
        this.scheduleReconnect()
      })
    }, RECONNECT_DELAY)
  }

  private startHeartbeat(ws: WebSocket, interval: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatAcked = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.log('[dsh-qq-bot] heartbeat ack missed, connection may be dead')
      }
      this.heartbeatAcked = false
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
