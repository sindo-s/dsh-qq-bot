import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** 暂停连接 QQ，保留配置供桌面端首次安装使用。 */
  enabled?: boolean
  enableImages?: boolean
  maxImagesPerMessage?: number
  maxImageBytes?: number
  imageDownloadTimeoutMs?: number
  /** QQ 开放平台机器人 AppID。 */
  appId?: string
  /** QQ 开放平台机器人 AppSecret。 */
  clientSecret?: string
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
  enabled: Schema.boolean().default(true).description('启用 QQ 连接；首次安装未填写凭据时可关闭'),
  enableImages: Schema.boolean().default(true).description('接收图片并传给支持视觉的模型'),
  maxImagesPerMessage: Schema.number().step(1).min(1).max(20).default(4).description('单条消息最多图片数；同时受 DSH 附件限制'),
  maxImageBytes: Schema.number().step(1).min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024).description('单张图片最大字节数'),
  imageDownloadTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(15000).description('整条消息的图片下载超时（毫秒）'),
  appId: Schema.string().default('').description('QQ 机器人 AppID；留空使用 QQ_BOT_APP_ID 环境变量'),
  clientSecret: Schema.string().default('').role('secret').description('AppSecret；留空使用 QQ_BOT_APP_SECRET 环境变量'),
  sandbox: Schema.boolean().default(false).description('使用 QQ 沙箱 API'),
  publicMode: Schema.boolean().default(false).description('允许所有 QQ 用户访问；公开部署前请确认 Agent 工具权限'),
  allowGroups: Schema.array(String).default([]).description('允许访问的群聊 group_openid'),
  allowUsers: Schema.array(String).default([]).description('允许访问的单聊 user_openid'),
  enableWhoami: Schema.boolean().default(true).description('允许白名单外用户使用 /whoami 或 /id 查询 OpenID'),
  allowedTools: Schema.array(String).default([]).description('QQ Agent 可继承的宿主全局工具名'),
  maxSessions: Schema.number().step(1).min(1).default(100).description('同时保留的最大 QQ 会话数'),
  sessionIdleMinutes: Schema.number().step(1).min(1).default(60).description('空闲会话自动销毁时间（分钟）'),
  requestTimeoutMs: Schema.number().step(1).min(1000).default(10_000).description('QQ REST API 请求超时（毫秒）'),
})


export function normalizeList(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Shared by startup and offline doctor. Do not include credential values in errors. */
export function resolveConfig(input: Config, env: NodeJS.ProcessEnv = process.env) {
  let config: Config
  try { config = Config(input) }
  catch { throw new Error('配置格式无效：检查字段类型，以及会话数、空闲分钟和超时是否为范围内的整数。') }
  const appId = (config.appId?.trim() || env.QQ_BOT_APP_ID?.trim()) ?? ''
  const clientSecret = (config.clientSecret?.trim() || env.QQ_BOT_APP_SECRET?.trim()) ?? ''
  if (!appId || !clientSecret || appId === 'YOUR_APP_ID' || clientSecret === 'YOUR_APP_SECRET') {
    throw new Error('缺少 QQ 凭据：运行 npm run setup，或设置 QQ_BOT_APP_ID 和 QQ_BOT_APP_SECRET 环境变量。')
  }
  return { ...config, appId, clientSecret,
    allowGroups: normalizeList(config.allowGroups),
    allowUsers: normalizeList(config.allowUsers),
    allowedTools: normalizeList(config.allowedTools),
  }
}
