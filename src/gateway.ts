/**
 * QQ 开放平台 WebSocket 网关客户端。
 * 负责鉴权、心跳、断线重连与会话恢复。
 */

import type { QQApi } from './api.ts'

/** 群聊 @机器人 + 单聊消息事件 intent。 */
const INTENTS_GROUP_AND_C2C = 1 << 25
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const
const RATE_LIMIT_RECONNECT_DELAY_MS = 60_000
const DEFAULT_HELLO_TIMEOUT_MS = 15_000
const FATAL_CLOSE_CODES = new Set([4010, 4011, 4012, 4013, 4014, 4914, 4915])
const CLEAR_SESSION_CLOSE_CODES = new Set([4006, 4007, 4009])

export interface QQMessageEvent {
  /** 事件类型：GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE。 */
  type: string
  /** 消息纯文本内容；群聊中可能包含 @机器人 前缀。 */
  content: string
  /** 被动回复凭证。 */
  msgId: string
  /** 群事件的 group_openid 或单聊事件的 author user_openid。 */
  chatId: string
  /** 是否群聊。 */
  isGroup: boolean
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
}

export interface GatewayClosePolicy {
  fatal: boolean
  clearToken: boolean
  clearSession: boolean
  minimumDelayMs: number
}

/** 将 QQ 网关关闭码归一成可测试的恢复策略。 */
export function gatewayClosePolicy(code: number): GatewayClosePolicy {
  return {
    fatal: FATAL_CLOSE_CODES.has(code),
    clearToken: code === 4004,
    clearSession: code === 4004 || CLEAR_SESSION_CLOSE_CODES.has(code),
    minimumDelayMs: code === 4008 ? RATE_LIMIT_RECONNECT_DELAY_MS : 0,
  }
}

export interface QQGatewayOptions {
  onMessage: (event: QQMessageEvent) => void
  onLog?: (line: string) => void
  /** 测试或宿主注入的 WebSocket 构造器。 */
  createWebSocket?: (url: string) => WebSocket
  /** 测试或部署覆盖的退避序列。 */
  reconnectDelaysMs?: readonly number[]
  /** 建连后等待 HELLO 的超时。 */
  helloTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class QQGateway {
  private readonly api: QQApi
  private readonly options: QQGatewayOptions
  private readonly createWebSocket: (url: string) => WebSocket
  private readonly reconnectDelaysMs: readonly number[]
  private ws: WebSocket | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastSeq: number | null = null
  private sessionId = ''
  private stopped = true
  private heartbeatAcked = true
  private reconnectAttempt = 0
  private connectionGeneration = 0
  private readonly helloTimeoutMs: number

  constructor(api: QQApi, options: QQGatewayOptions) {
    this.api = api
    this.options = options
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url))
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : DEFAULT_RECONNECT_DELAYS_MS
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  }

  private log(line: string) {
    this.options.onLog?.(line)
  }

  /** 启动网关；初次连接失败也会进入退避重试。 */
  async start() {
    this.stopped = false
    try {
      await this.connect()
    } catch (err) {
      if (this.stopped) return
      this.log(`[dsh-qq-bot] gateway connect failed: ${err}`)
      this.scheduleReconnect()
    }
  }

  stop() {
    this.stopped = true
    this.connectionGeneration++
    this.clearTimers()

    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      if (ws.readyState !== WS_CLOSED && ws.readyState !== WS_CLOSING) ws.close()
    }
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.helloTimer = null
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearHelloTimeout() {
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = null
  }

  private async connect() {
    const generation = ++this.connectionGeneration
    this.clearHeartbeat()
    this.clearHelloTimeout()

    const old = this.ws
    this.ws = null
    if (old && old.readyState !== WS_CLOSED && old.readyState !== WS_CLOSING) {
      old.onclose = null
      old.close()
    }

    const [url, token] = await Promise.all([
      this.api.getGatewayUrl(),
      this.api.getAccessToken(),
    ])
    if (this.stopped || generation !== this.connectionGeneration) return

    const authToken = `QQBot ${token}`
    this.log(`[dsh-qq-bot] connecting gateway ${url}`)
    const ws = this.createWebSocket(url)
    if (this.stopped || generation !== this.connectionGeneration) {
      ws.close()
      return
    }
    this.ws = ws

    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.stopped) return

      let payload: GatewayPayload
      try {
        const parsed = JSON.parse(String(ev.data)) as unknown
        if (!isRecord(parsed) || typeof parsed.op !== 'number') {
          this.log('[dsh-qq-bot] ignoring malformed gateway frame')
          return
        }
        payload = parsed as unknown as GatewayPayload
      } catch {
        this.log('[dsh-qq-bot] ignoring unparseable gateway frame')
        return
      }

      if (typeof payload.s === 'number') this.lastSeq = payload.s

      try {
        switch (payload.op) {
          case 10: {
            this.clearHelloTimeout()
            const data = isRecord(payload.d) ? payload.d : null
            const interval = data?.heartbeat_interval
            if (typeof interval !== 'number' || interval <= 0) {
              this.log('[dsh-qq-bot] gateway HELLO did not contain a heartbeat interval')
              this.scheduleReconnect(ws)
              return
            }

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
            this.send(ws, { op: 1, d: this.lastSeq })
            break
          case 11:
            this.heartbeatAcked = true
            break
          case 7:
            this.log('[dsh-qq-bot] server requested reconnect')
            this.scheduleReconnect(ws)
            break
          case 9:
            if (payload.d === false) this.clearSession()
            this.log(`[dsh-qq-bot] invalid session (resumable=${payload.d !== false})`)
            this.scheduleReconnect(ws)
            break
        }
      } catch (err) {
        this.log(`[dsh-qq-bot] frame handling error: ${err}`)
      }
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearHeartbeat()
      this.clearHelloTimeout()
      this.log(`[dsh-qq-bot] gateway closed: code=${ev.code} reason=${ev.reason || '(none)'}`)
      if (this.stopped) return

      const policy = gatewayClosePolicy(ev.code)
      if (policy.clearToken) this.api.invalidateAccessToken()
      if (policy.clearSession) this.clearSession()
      if (policy.fatal) {
        this.stopped = true
        this.log(`[dsh-qq-bot] gateway close code ${ev.code} is fatal; automatic reconnect stopped`)
        return
      }
      this.scheduleReconnect(undefined, policy.minimumDelayMs)
    }

    ws.onerror = () => {
      if (this.ws === ws) this.log('[dsh-qq-bot] gateway error')
    }

    this.helloTimer = setTimeout(() => {
      if (this.ws !== ws || this.stopped) return
      this.log('[dsh-qq-bot] gateway HELLO timed out; reconnecting')
      this.scheduleReconnect(ws)
    }, this.helloTimeoutMs)
  }

  private clearSession() {
    this.sessionId = ''
    this.lastSeq = null
  }

  /** Single-flight 指数退避重连。 */
  private scheduleReconnect(fromWs?: WebSocket, minimumDelayMs = 0) {
    if (this.stopped || this.reconnectTimer) return
    this.clearHeartbeat()
    this.clearHelloTimeout()

    if (fromWs && fromWs.readyState !== WS_CLOSED && fromWs.readyState !== WS_CLOSING) {
      fromWs.onclose = null
      fromWs.close()
    }
    if (fromWs && this.ws === fromWs) this.ws = null

    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    const delay = Math.max(this.reconnectDelaysMs[index] ?? 60_000, minimumDelayMs)
    this.reconnectAttempt++
    this.log(`[dsh-qq-bot] reconnecting in ${delay / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect().catch((err) => {
        this.log(`[dsh-qq-bot] reconnect failed: ${err}`)
        this.scheduleReconnect()
      })
    }, delay)
  }

  private startHeartbeat(ws: WebSocket, interval: number) {
    this.clearHeartbeat()
    this.heartbeatAcked = true
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || this.stopped) return
      if (!this.heartbeatAcked) {
        this.log('[dsh-qq-bot] heartbeat ack missed; reconnecting')
        this.scheduleReconnect(ws)
        return
      }
      this.heartbeatAcked = false
      this.send(ws, { op: 1, d: this.lastSeq })
    }, interval)
  }

  private send(ws: WebSocket, payload: GatewayPayload) {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(payload))
  }

  private handleDispatch(payload: GatewayPayload) {
    const data = isRecord(payload.d) ? payload.d : null
    if (!data) {
      this.log(`[dsh-qq-bot] ignoring malformed dispatch ${payload.t ?? '(unknown)'}`)
      return
    }

    switch (payload.t) {
      case 'READY': {
        const sessionId = nonEmptyString(data.session_id)
        if (!sessionId) {
          this.log('[dsh-qq-bot] READY event did not contain a session_id')
          return
        }
        this.sessionId = sessionId
        this.reconnectAttempt = 0
        const user = isRecord(data.user) ? data.user : null
        this.log(`[dsh-qq-bot] READY, user=${nonEmptyString(user?.username) ?? '(unknown)'}`)
        break
      }
      case 'RESUMED':
        this.reconnectAttempt = 0
        this.log('[dsh-qq-bot] session resumed')
        break
      case 'GROUP_AT_MESSAGE_CREATE': {
        const msgId = nonEmptyString(data.id)
        const chatId = nonEmptyString(data.group_openid)
        if (!msgId || !chatId) {
          this.log('[dsh-qq-bot] ignoring malformed group message event')
          return
        }
        this.options.onMessage({
          type: payload.t,
          content: typeof data.content === 'string' ? data.content : '',
          msgId,
          chatId,
          isGroup: true,
        })
        break
      }
      case 'C2C_MESSAGE_CREATE': {
        const author = isRecord(data.author) ? data.author : null
        const msgId = nonEmptyString(data.id)
        const chatId = nonEmptyString(author?.user_openid)
        if (!msgId || !chatId) {
          this.log('[dsh-qq-bot] ignoring malformed C2C message event')
          return
        }
        this.options.onMessage({
          type: payload.t,
          content: typeof data.content === 'string' ? data.content : '',
          msgId,
          chatId,
          isGroup: false,
        })
        break
      }
    }
  }
}
