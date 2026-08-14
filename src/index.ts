/**
 * dsh-qq-bot：QQ 官方机器人 ↔ DeepSeek Harness 桥接插件。
 *
 * 协议驱动（protocol driver）形态：
 * - 入站：QQ 网关事件 → 指定 agent 会话的 followup()
 * - 出站：session/event 中已提交的 assistant 文本 → QQ 被动回复
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
  /** 桥接到的 dsh 会话 ID */
  sessionId: string
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
  sessionId: Schema.string().required().description('桥接到的 dsh 会话 ID'),
  sandbox: Schema.boolean().default(false).description('使用沙箱环境'),
  allowGroups: Schema.array(String).default([]).description('群聊白名单（group_openid），空为全部'),
  allowUsers: Schema.array(String).default([]).description('单聊白名单（user_openid），空为全部'),
})

/** QQ 单条消息长度上限保守值，超出截断。 */
const MAX_CONTENT_LENGTH = 1800

export function apply(ctx: Context, config: Config) {
  const api = new QQApi({
    appId: config.appId,
    clientSecret: config.clientSecret,
    sandbox: config.sandbox,
  })

  // 每个群/用户维护被动回复的 msg_seq 与最近一条消息的被动回复凭证。
  // 注意：官方被动回复凭证（msg_id）每月有调用额度，主动消息另有日限额。
  const lastInbound = new Map<string, QQMessageEvent>()
  const msgSeq = new Map<string, number>()

  const sessionId = SessionId(config.sessionId)

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

  function allowed(event: QQMessageEvent) {
    if (event.isGroup) {
      return config.allowGroups!.length === 0 || config.allowGroups!.includes(event.chatId)
    }
    return config.allowUsers!.length === 0 || config.allowUsers!.includes(event.chatId)
  }

  const gateway = new QQGateway(api, {
    onLog: (line) => console.log(line),
    onMessage: (event) => {
      if (!allowed(event)) return
      // 群聊消息去掉 @机器人 前缀
      const text = event.isGroup ? event.content.replace(/^\s*<@!\S+>\s*/, '').trim() : event.content.trim()
      if (!text) return

      lastInbound.set(event.chatId, event)

      const agent = ctx.agents.get(sessionId)
      if (!agent) {
        console.warn(`[dsh-qq-bot] session "${config.sessionId}" not found, message dropped`)
        return
      }
      const prefix = event.isGroup ? `[QQ 群 ${event.chatId}] ` : `[QQ 单聊 ${event.chatId}] `
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prefix + text }],
        source: { kind: 'user' },
      }))
    },
  })

  // 出站：assistant 提交的消息文本 → 回复到最近活跃的 QQ 会话
  ctx.on('session/event', (session, event) => {
    if (String(session) !== String(sessionId)) return
    if (event.type !== 'assistant/message') return
    const text = event.data.message?.content
      ?.filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('')
    if (!text) return

    // 回复最近一条入站消息所在的会话
    const last = [...lastInbound.values()].pop()
    if (!last) return
    replyTo(last.chatId, last.isGroup, text, last.msgId).catch((err) => {
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

  // 网关生命周期纳入插件 effect：插件卸载/热重载时自动断开
  ctx.effect(() => {
    void gateway.start().catch((err) => console.warn(`[dsh-qq-bot] gateway start failed: ${err}`))
    return () => gateway.stop()
  })
}
