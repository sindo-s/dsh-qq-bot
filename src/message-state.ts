/** QQ 消息长度、去重与被动回复序号状态。 */

export const MAX_CONTENT_LENGTH = 1800
export const DEFAULT_MESSAGE_STATE_TTL_MS = 10 * 60 * 1000
export const DEFAULT_MESSAGE_STATE_MAX_ENTRIES = 10_000

/** 按 Unicode code point 切分，避免截断代理对或丢失超长回复。 */
export function splitQQContent(text: string, maxLength = MAX_CONTENT_LENGTH): string[] {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new RangeError('maxLength must be a positive integer')
  }
  const characters = Array.from(text)
  if (characters.length === 0) return []

  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += maxLength) {
    chunks.push(characters.slice(offset, offset + maxLength).join(''))
  }
  return chunks
}

interface TimedSequence {
  sequence: number
  touchedAt: number
}

/** 有界、带 TTL 的 QQ 消息去重器。accept=false 表示重复。 */
export class MessageDeduplicator {
  private readonly entries = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    ttlMs = DEFAULT_MESSAGE_STATE_TTL_MS,
    maxEntries = DEFAULT_MESSAGE_STATE_MAX_ENTRIES,
    now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
  }

  accept(key: string): boolean {
    const now = this.now()
    this.prune(now)
    const seenAt = this.entries.get(key)
    if (seenAt !== undefined && now - seenAt < this.ttlMs) return false

    this.entries.delete(key)
    this.entries.set(key, now)
    this.trim()
    return true
  }

  private prune(now: number) {
    for (const [key, seenAt] of this.entries) {
      if (now - seenAt < this.ttlMs) break
      this.entries.delete(key)
    }
  }

  private trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** 按 msgId 独立递增的有界被动回复序号。 */
export class ReplySequencer {
  private readonly entries = new Map<string, TimedSequence>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    ttlMs = DEFAULT_MESSAGE_STATE_TTL_MS,
    maxEntries = DEFAULT_MESSAGE_STATE_MAX_ENTRIES,
    now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
  }

  next(msgId: string): number {
    const now = this.now()
    this.prune(now)
    const sequence = (this.entries.get(msgId)?.sequence ?? 0) + 1
    this.entries.delete(msgId)
    this.entries.set(msgId, { sequence, touchedAt: now })
    this.trim()
    return sequence
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt < this.ttlMs) break
      this.entries.delete(key)
    }
  }

  private trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

interface PendingTurnValue<T> {
  sessionId: string
  value: T
}

/**
 * 将已识别的入站消息精确关联到 Harness turn。
 * 可避免后到消息覆盖先到消息的 QQ msgId。
 */
export class TurnReplyRouter<T> {
  private readonly pending = new Map<string, PendingTurnValue<T>>()
  private readonly turnValues = new Map<string, T>()

  queue(sessionId: string, messageId: string, value: T) {
    this.pending.set(messageId, { sessionId, value })
  }

  removePending(messageId: string) {
    this.pending.delete(messageId)
  }

  claim(sessionId: string, messageId: string, turn: number): boolean {
    const pending = this.pending.get(messageId)
    if (!pending || pending.sessionId !== sessionId) return false

    this.pending.delete(messageId)
    this.turnValues.set(this.key(sessionId, turn), pending.value)
    return true
  }

  get(sessionId: string, turn: number): T | undefined {
    return this.turnValues.get(this.key(sessionId, turn))
  }

  endTurn(sessionId: string, turn: number) {
    this.turnValues.delete(this.key(sessionId, turn))
  }

  clearSession(sessionId: string) {
    for (const key of this.turnValues.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.turnValues.delete(key)
    }
    for (const [messageId, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.pending.delete(messageId)
    }
  }

  private key(sessionId: string, turn: number) {
    return `${sessionId}:${turn}`
  }
}

/** 按 key 串行执行异步发送，避免同一 msgId 的 msg_seq 乱序抵达 QQ。 */
export class KeyedSerialTaskQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    this.tails.set(key, current)
    return current.finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key)
    })
  }

  async drain() {
    await Promise.allSettled([...this.tails.values()])
  }
}
