/**
 * dsh-qq-bot：QQ 官方机器人 ↔ DeepSeek Harness 桥接插件。
 *
 * 协议驱动（protocol driver）形态：
 * - 入站：QQ 网关事件 → 每个群/用户一个独立 dsh agent 会话（自动创建）
 * - 出站：session/event 中已提交的 assistant 文本 → 回复到来源 QQ 会话
 * - 命令：/new 重开对话、/stop 取消当前任务、/help 查看命令
 * - 工具：向模型暴露 qq_send 主动发消息工具
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { QQApi } from './api.ts'
import { QQGateway, type QQMessageEvent } from './gateway.ts'

export const name = 'dsh-qq-bot'
export const inject = ['agents', 'tools']

export interface Config {
  /** QQ 开放平台机器人 AppID */
  appId: string
  /** QQ 开放平台机器人 AppSecret */
  clientSecret: string
  /** 使用沙箱环境（机器人未上线时） */
  sandbox?: boolean
  /** 只响应这些群（group_openid 列表）；留空表示全部响应 */
  allowGroups?: string[]
  /** 只响应这些单聊用户（user_openid 列表）；留空表示全部响应 */
  allowUsers?: string[]
}

export const Config: Schema<Config> = Schema.object({
  appId: Schema.string().required().description('QQ 开放平台机器人 AppID'),
  clientSecret: Schema.string().required().description('QQ 开放平台机器人 AppSecret'),
  sandbox: Schema.boolean().default(false).description('使用沙箱环境'),
  allowGroups: Schema.array(String).default([]).description('群聊白名单（group_openid），空为全部'),
  allowUsers: Schema.array(String).default([]).description('单聊白名单（user_openid），空为全部'),
})

/** QQ 单条消息长度上限保守值，超出截断。 */
const MAX_CONTENT_LENGTH = 1800

const HELP_TEXT = [
  '可用命令：',
  '/new — 结束当前对话，新开一个会话',
  '/stop — 取消正在执行的任务',
  '/help — 显示本帮助',
].join('\n')

interface ChatBinding {
  sessionId: ReturnType<typeof SessionId>
  handle: { agent: unknown; dispose(): Promise<void> } | null
}

export function apply(ctx: Context, config: Config) {
  const api = new QQApi({
    appId: config.appId,
    clientSecret: config.clientSecret,
    sandbox: config.sandbox,
  })

  // 每个 QQ 会话（群/用户）绑定一个独立的 dsh agent 会话
  const bindings = new Map<string, ChatBinding>()
  // sessionId 字符串 → QQ 会话，用于把回复路由回来源
  const sessionToChat = new Map<string, { chatId: string; isGroup: boolean }>()
  // 每个 QQ 会话的被动回复 msg_seq 与最近入站消息凭证
  const lastInbound = new Map<string, QQMessageEvent>()
  const msgSeq = new Map<string, number>()

  async function replyTo(chatKey: string, isGroup: boolean, text: string, msgId?: string) {
    const seq = (msgSeq.get(chatKey) ?? 0) + 1
    msgSeq.set(chatKey, seq)
    const content = text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) + '…' : text
    if (isGroup) {
      await api.sendGroupMessage(chatKey, content, msgId ?? '', seq)
    } else {
      await api.sendC2CMessage(chatKey, content, msgId ?? '', seq)
    }
  }

  function chatKeyOf(event: QQMessageEvent) {
    return `${event.isGroup ? 'group' : 'c2c'}:${event.chatId}`
  }

  /** 确保该 QQ 会话有一个 live agent；没有则通过工厂创建。 */
  async function ensureAgent(chatKey: string) {
    let binding = bindings.get(chatKey)
    if (!binding) {
      binding = { sessionId: SessionId(`qq-${chatKey}`), handle: null }
      bindings.set(chatKey, binding)
    }
    let agent = ctx.agents.get(binding.sessionId)
    if (!agent) {
      const handle = await ctx.agents.create({ id: binding.sessionId })
      binding.handle = handle
      agent = handle.agent as typeof agent
      sessionToChat.set(String(binding.sessionId), {
        chatId: chatKey.slice(chatKey.indexOf(':') + 1),
        isGroup: chatKey.startsWith('group:'),
      })
      console.log(`[dsh-qq-bot] created agent session ${String(binding.sessionId)}`)
    }
    return agent!
  }

  /** 销毁该 QQ 会话的 agent（/new 时调用）。 */
  async function destroyAgent(chatKey: string) {
    const binding = bindings.get(chatKey)
    if (!binding) return
    sessionToChat.delete(String(binding.sessionId))
    if (binding.handle) {
      await binding.handle.dispose()
      binding.handle = null
    }
    bindings.delete(chatKey)
  }

  function allowed(event: QQMessageEvent) {
    if (event.isGroup) {
      return config.allowGroups!.length === 0 || config.allowGroups!.includes(event.chatId)
    }
    return config.allowUsers!.length === 0 || config.allowUsers!.includes(event.chatId)
  }

  /** 处理 / 开头的控制命令；返回 true 表示已按命令处理，不再进入 agent。 */
  async function handleCommand(event: QQMessageEvent, text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false
    const chatKey = chatKeyOf(event)
    const cmd = text.split(/\s+/)[0].toLowerCase()

    switch (cmd) {
      case '/new': {
        await destroyAgent(chatKey)
        await ensureAgent(chatKey)
        await replyTo(event.chatId, event.isGroup, '已开启新对话。', event.msgId)
        return true
      }
      case '/stop': {
        const binding = bindings.get(chatKey)
        const agent = binding && ctx.agents.get(binding.sessionId)
        if (agent) {
          agent.cancel({ kind: 'user' })
          await replyTo(event.chatId, event.isGroup, '已取消当前任务。', event.msgId)
        } else {
          await replyTo(event.chatId, event.isGroup, '当前没有进行中的任务。', event.msgId)
        }
        return true
      }
      case '/help': {
        await replyTo(event.chatId, event.isGroup, HELP_TEXT, event.msgId)
        return true
      }
      default:
        return false
    }
  }

  const gateway = new QQGateway(api, {
    onLog: (line) => console.log(line),
    onMessage: (event) => {
      if (!allowed(event)) return
      // 群聊消息去掉 @机器人 前缀
      const text = event.isGroup ? event.content.replace(/^\s*<@!\S+>\s*/, '').trim() : event.content.trim()
      if (!text) return

      lastInbound.set(chatKeyOf(event), event)

      void (async () => {
        if (await handleCommand(event, text)) return
        const agent = await ensureAgent(chatKeyOf(event))
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      })().catch((err) => console.warn(`[dsh-qq-bot] inbound failed: ${err}`))
    },
  })

  // 出站：assistant 提交的消息文本 → 回复到该会话对应的 QQ 群/用户
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const target = sessionToChat.get(String(session))
    if (!target) return
    const text = event.data.message?.content
      ?.filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('')
    if (!text) return

    const inbound = lastInbound.get(`${target.isGroup ? 'group' : 'c2c'}:${target.chatId}`)
    replyTo(target.chatId, target.isGroup, text, inbound?.msgId).catch((err) => {
      console.warn(`[dsh-qq-bot] reply failed: ${err}`)
    })
  })

  // 模型可调用的主动发消息工具
  ctx.tools.register(defineTool({
    name: 'qq_send',
    description: 'Send a text message to a QQ group or user through the official QQ bot.',
    parameters: {
      target: { type: 'string', required: true, description: 'group_openid 或 user_openid' },
      kind: { type: 'string', required: true, description: '"group" 或 "c2c"' },
      text: { type: 'string', required: true, description: '要发送的文本内容' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await replyTo(args.target, args.kind === 'group', args.text)
      return `已发送到 ${args.kind} ${args.target}`
    },
  }))

  // 网关与全部 agent 会话的生命周期纳入插件 effect：卸载/热重载时自动清理
  ctx.effect(() => {
    void gateway.start().catch((err) => console.warn(`[dsh-qq-bot] gateway start failed: ${err}`))
    return () => {
      gateway.stop()
      for (const chatKey of [...bindings.keys()]) {
        void destroyAgent(chatKey).catch(() => {})
      }
    }
  })
}
