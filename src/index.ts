/**
 * dsh-qq-bot：QQ 官方机器人 ↔ DeepSeek Harness 桥接插件。
 * 每个 QQ 群/用户绑定一个独立 Agent，会话与工具权限彼此隔离。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { QQApi } from './api.ts'
import { QQGateway, type QQMessageEvent } from './gateway.ts'
import { formatIdentityReply, isIdentityCommand } from './identity.ts'
import {
  KeyedSerialTaskQueue,
  MessageDeduplicator,
  ReplySequencer,
  TurnReplyRouter,
  splitQQContent,
} from './message-state.ts'
import { createQQSendTool } from './qq-send.ts'
import { formatToolStatus, normalizeAllowedTools } from './tool-access.ts'

export const name = 'dsh-qq-bot'
export const inject = ['agents', 'agentDefaultModel', 'tools']

export interface Config {
  /** QQ 开放平台机器人 AppID。 */
  appId: string
  /** QQ 开放平台机器人 AppSecret。 */
  clientSecret: string
  /** 使用沙箱环境。 */
  sandbox?: boolean
  /** 显式允许所有 QQ 用户；默认关闭。 */
  publicMode?: boolean
  /** 允许响应的 group_openid；publicMode=false 时生效。 */
  allowGroups?: string[]
  /** 允许响应的 user_openid；publicMode=false 时生效。 */
  allowUsers?: string[]
  /** 允许白名单外用户通过 /whoami 或 /id 查询自己的 OpenID。 */
  enableWhoami?: boolean
  /** QQ Agent 可以继承使用的宿主全局工具名；默认不继承任何工具。 */
  allowedTools?: string[]
  /** 同时保留的最大 QQ 会话数。 */
  maxSessions?: number
  /** 空闲会话自动销毁时间（分钟）。 */
  sessionIdleMinutes?: number
  /** QQ REST API 请求超时（毫秒）。 */
  requestTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  appId: Schema.string().required().description('QQ 开放平台机器人 AppID'),
  clientSecret: Schema.string().required().role('secret').description('QQ 开放平台机器人 AppSecret'),
  sandbox: Schema.boolean().default(false).description('使用 QQ 沙箱 API'),
  publicMode: Schema.boolean().default(false).description('允许所有 QQ 用户访问；公开部署前请确认 Agent 工具权限'),
  allowGroups: Schema.array(String).default([]).description('允许访问的群聊 group_openid'),
  allowUsers: Schema.array(String).default([]).description('允许访问的单聊 user_openid'),
  enableWhoami: Schema.boolean().default(true).description('允许白名单外用户使用 /whoami 或 /id 查询 OpenID'),
  allowedTools: Schema.array(String).default([]).description('QQ Agent 可继承的宿主全局工具名'),
  maxSessions: Schema.number().min(1).default(100).description('同时保留的最大 QQ 会话数'),
  sessionIdleMinutes: Schema.number().min(1).default(60).description('空闲会话自动销毁时间（分钟）'),
  requestTimeoutMs: Schema.number().min(1000).default(10_000).description('QQ REST API 请求超时（毫秒）'),
})

function createHelpText(enableWhoami: boolean) {
  return [
    '可用命令：',
    '/new — 结束当前对话，下条消息开启新会话',
    '/stop — 取消正在执行的任务和排队消息',
    '/tools — 查看当前工具配置和加载状态',
    ...(enableWhoami ? ['/whoami 或 /id — 查看当前 user_openid/group_openid'] : []),
    '/help — 显示本帮助',
  ].join('\n')
}

interface ChatTarget {
  chatId: string
  isGroup: boolean
}

interface ChatBinding {
  sessionId: ReturnType<typeof SessionId>
  target: ChatTarget
  handle: AgentHandle | null
  creating: Promise<AgentHandle> | null
  disposed: boolean
  lastActiveAt: number
}

function chatKeyOf(event: QQMessageEvent) {
  return `${event.isGroup ? 'group' : 'c2c'}:${event.chatId}`
}

function textFromAssistantMessage(event: SessionEvent<'assistant/message'>) {
  return event.data.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export function apply(ctx: Context, config: Config) {
  const api = new QQApi({
    appId: config.appId,
    clientSecret: config.clientSecret,
    sandbox: config.sandbox,
    requestTimeoutMs: config.requestTimeoutMs,
  })

  const bindings = new Map<string, ChatBinding>()
  const sessionToChat = new Map<string, ChatTarget>()
  const turnRouter = new TurnReplyRouter<QQMessageEvent>()
  const deduplicator = new MessageDeduplicator()
  const replySequencer = new ReplySequencer()
  const sendQueue = new KeyedSerialTaskQueue()
  const maxSessions = config.maxSessions ?? 100
  const sessionIdleMs = (config.sessionIdleMinutes ?? 60) * 60_000
  const allowedToolNames = normalizeAllowedTools(config.allowedTools)
  let closing = false

  function sendPassive(target: ChatTarget, text: string, msgId: string) {
    return sendQueue.run(`passive:${msgId}`, async () => {
      for (const chunk of splitQQContent(text)) {
        const msgSeq = replySequencer.next(msgId)
        if (target.isGroup) {
          await api.replyGroupMessage(target.chatId, chunk, msgId, msgSeq)
        } else {
          await api.replyC2CMessage(target.chatId, chunk, msgId, msgSeq)
        }
      }
    })
  }

  function sendProactive(target: ChatTarget, text: string) {
    const key = `proactive:${target.isGroup ? 'group' : 'c2c'}:${target.chatId}`
    return sendQueue.run(key, async () => {
      for (const chunk of splitQQContent(text)) {
        if (target.isGroup) {
          await api.sendGroupMessage(target.chatId, chunk)
        } else {
          await api.sendC2CMessage(target.chatId, chunk)
        }
      }
    })
  }

  function clearSessionRouting(sessionId: string) {
    sessionToChat.delete(sessionId)
    turnRouter.clearSession(sessionId)
  }

  async function destroyAgent(chatKey: string) {
    const binding = bindings.get(chatKey)
    if (!binding) return

    binding.disposed = true
    bindings.delete(chatKey)
    clearSessionRouting(String(binding.sessionId))

    if (binding.handle) {
      const handle = binding.handle
      binding.handle = null
      await handle.dispose()
      return
    }

    if (binding.creating) {
      try {
        const handle = await binding.creating
        await handle.dispose()
      } catch {
        // 创建流程在看到 disposed 后会自行回滚；这里无需重复抛错。
      }
    }
  }

  async function ensureCapacity() {
    if (bindings.size < maxSessions) return

    const candidate = [...bindings.entries()]
      .filter(([, binding]) => !binding.creating && binding.handle?.agent.status !== 'running')
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)[0]
    if (!candidate) {
      throw new Error(`all ${maxSessions} QQ sessions are currently busy`)
    }
    await destroyAgent(candidate[0])
  }

  function createScopedQQTool(agentCtx: Context, target: ChatTarget) {
    return agentCtx.tools.register(createQQSendTool((text) => sendProactive(target, text)))
  }

  async function createAgentForBinding(chatKey: string, binding: ChatBinding): Promise<AgentHandle> {
    if (closing) throw new Error('dsh-qq-bot is shutting down')
    const defaultModel: AgentDefaultModelConfig = ctx.agentDefaultModel
    const selection = defaultModel.currentSelection()
    if (!selection.provider || !selection.model) {
      throw new Error('dsh default provider/model is not configured')
    }

    const allowedTools = new Set(allowedToolNames)
    const deniedInheritedTools = ctx.tools.schemas()
      .map((schema) => schema.name)
      .filter((toolName) => toolName !== 'run_code'
        && toolName !== 'qq_send'
        && !allowedTools.has(toolName))

    const handle = await ctx.agents.create({
      sessionId: binding.sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup(agentCtx) {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        if (deniedInheritedTools.length) {
          agentCtx.tools.restrict({ deny: deniedInheritedTools })
        }

        // run_code 只是 Code Mode 的传输层；其子调用仍会再次经过此 guard。
        const executableTools = new Set([...allowedTools, 'qq_send', 'run_code'])
        agentCtx.tools.guard((execution) => executableTools.has(execution.name)
          ? undefined
          : `Tool ${execution.name} is not allowed for QQ bot agents`)
        createScopedQQTool(agentCtx, binding.target)
      },
    })

    if (closing || binding.disposed || bindings.get(chatKey) !== binding) {
      await handle.dispose()
      throw new Error(`QQ chat binding ${chatKey} was replaced during agent creation`)
    }

    binding.handle = handle
    sessionToChat.set(String(binding.sessionId), binding.target)
    console.log(`[dsh-qq-bot] created agent session ${String(binding.sessionId)}`)
    return handle
  }

  /** 确保同一 QQ 会话只有一个创建流程和一个 live Agent。 */
  async function ensureAgent(event: QQMessageEvent): Promise<Agent> {
    if (closing) throw new Error('dsh-qq-bot is shutting down')
    const chatKey = chatKeyOf(event)
    let binding = bindings.get(chatKey)
    if (!binding) {
      await ensureCapacity()
      if (closing) throw new Error('dsh-qq-bot is shutting down')
      binding = bindings.get(chatKey)
      // 多个不同聊天可能同时通过第一次容量检查；创建前再次封顶。
      if (!binding && bindings.size >= maxSessions) {
        await ensureCapacity()
        binding = bindings.get(chatKey)
      }
      if (!binding) {
        binding = {
          sessionId: SessionId(`qq-${randomUUID()}`),
          target: { chatId: event.chatId, isGroup: event.isGroup },
          handle: null,
          creating: null,
          disposed: false,
          lastActiveAt: Date.now(),
        }
        bindings.set(chatKey, binding)
      }
    }

    binding.lastActiveAt = Date.now()
    const existing = ctx.agents.get(binding.sessionId)
    if (existing) {
      sessionToChat.set(String(binding.sessionId), binding.target)
      return existing
    }

    if (!binding.creating) {
      binding.creating = createAgentForBinding(chatKey, binding)
    }
    const creating = binding.creating
    try {
      return (await creating).agent
    } finally {
      if (binding.creating === creating) binding.creating = null
    }
  }

  function allowed(event: QQMessageEvent) {
    if (config.publicMode) return true
    const allowlist = event.isGroup ? (config.allowGroups ?? []) : (config.allowUsers ?? [])
    return allowlist.includes(event.chatId)
  }

  async function handleCommand(event: QQMessageEvent, text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false
    const chatKey = chatKeyOf(event)
    const target = { chatId: event.chatId, isGroup: event.isGroup }
    const cmd = text.split(/\s+/)[0].toLowerCase()

    switch (cmd) {
      case '/new':
        await destroyAgent(chatKey)
        await sendPassive(target, '已结束当前对话。你的下一条消息会开启新会话。', event.msgId)
        return true
      case '/stop': {
        const binding = bindings.get(chatKey)
        const agent = binding && ctx.agents.get(binding.sessionId)
        if (agent) {
          agent.cancel({ kind: 'user' })
          await sendPassive(target, '已取消当前任务和排队消息。', event.msgId)
        } else {
          await sendPassive(target, '当前没有进行中的任务。', event.msgId)
        }
        return true
      }
      case '/help':
        await sendPassive(target, createHelpText(config.enableWhoami !== false), event.msgId)
        return true
      case '/tools':
        await sendPassive(
          target,
          formatToolStatus(allowedToolNames, ctx.tools.schemas().map((schema) => schema.name)),
          event.msgId,
        )
        return true
      case '/whoami':
      case '/id':
        if (config.enableWhoami === false) {
          await sendPassive(target, '身份查询命令已被管理员禁用。', event.msgId)
        } else {
          await sendPassive(target, formatIdentityReply(target), event.msgId)
        }
        return true
      default:
        return false
    }
  }

  async function processInbound(event: QQMessageEvent, text: string) {
    if (await handleCommand(event, text)) return

    const agent = await ensureAgent(event)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const messageId = String(message.id)
    turnRouter.queue(String(agent.id), messageId, event)
    try {
      agent.followup(message)
    } catch (err) {
      turnRouter.removePending(messageId)
      throw err
    }
  }

  const gateway = new QQGateway(api, {
    onLog: (line) => console.log(line),
    onMessage: (event) => {
      if (closing) return
      const text = event.isGroup
        ? event.content.replace(/^\s*<@!?\S+>\s*/, '').trim()
        : event.content.trim()
      if (!text) return

      // 身份发现只开放一个无 Agent、无宿主工具的固定响应端点。
      const identityDiscovery = config.enableWhoami !== false && isIdentityCommand(text)
      if (!identityDiscovery && !allowed(event)) return

      const dedupeKey = `${chatKeyOf(event)}:${event.msgId}`
      if (!deduplicator.accept(dedupeKey)) {
        console.log(`[dsh-qq-bot] ignored duplicate message ${event.msgId}`)
        return
      }

      void processInbound(event, text).catch(async (err) => {
        console.warn(`[dsh-qq-bot] inbound failed: ${err}`)
        try {
          await sendPassive(
            { chatId: event.chatId, isGroup: event.isGroup },
            '处理消息失败，请稍后重试。',
            event.msgId,
          )
        } catch (replyError) {
          console.warn(`[dsh-qq-bot] failure reply failed: ${replyError}`)
        }
      })
    },
  })

  // Inbox claim 携带精确 turn；丢弃的排队消息也会及时清理。
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    turnRouter.claim(String(agent.id), String(message.id), turn)
  })
  ctx.on('agent/inbox/discarded', ({ message }) => {
    turnRouter.removePending(String(message.id))
  })

  // 用 user message identity → turn → assistant message 建立精确的回复关联。
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)

    switch (event.type) {
      case 'assistant/message': {
        const target = sessionToChat.get(sessionId)
        const inbound = turnRouter.get(sessionId, event.data.turn)
        if (!target || !inbound) return
        const text = textFromAssistantMessage(event)
        if (!text) return
        void sendPassive(target, text, inbound.msgId).catch((err) => {
          console.warn(`[dsh-qq-bot] reply failed: ${err}`)
        })
        break
      }
      case 'turn/end':
        turnRouter.endTurn(sessionId, event.data.turn)
        break
    }
  })

  async function sweepIdleSessions() {
    const expiredBefore = Date.now() - sessionIdleMs
    const expired = [...bindings.entries()]
      .filter(([, binding]) => binding.lastActiveAt <= expiredBefore
        && !binding.creating
        && binding.handle?.agent.status !== 'running')
      .map(([chatKey]) => chatKey)
    await Promise.allSettled(expired.map((chatKey) => destroyAgent(chatKey)))
  }

  if (!config.publicMode && !(config.allowGroups?.length || config.allowUsers?.length)) {
    const whoamiNote = config.enableWhoami === false ? '' : '; only /whoami and /id remain available'
    console.warn(`[dsh-qq-bot] publicMode is disabled and both allowlists are empty; ordinary inbound messages will be ignored${whoamiNote}`)
  }

  ctx.effect(() => {
    void gateway.start()
    const sweepTimer = setInterval(() => {
      void sweepIdleSessions().catch((err) => console.warn(`[dsh-qq-bot] idle session sweep failed: ${err}`))
    }, Math.min(Math.max(Math.floor(sessionIdleMs / 2), 60_000), 5 * 60_000))

    return async () => {
      closing = true
      clearInterval(sweepTimer)
      gateway.stop()
      await Promise.allSettled([...bindings.keys()].map((chatKey) => destroyAgent(chatKey)))
      await sendQueue.drain()
    }
  })
}
