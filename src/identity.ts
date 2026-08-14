/** QQ OpenID 自助发现命令；不依赖 Agent，也不放宽白名单。 */

export interface QQIdentityTarget {
  chatId: string
  isGroup: boolean
}

export function isIdentityCommand(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return command === '/whoami' || command === '/id'
}

function quoteYamlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function formatIdentityReply(target: QQIdentityTarget): string {
  if (target.isGroup) {
    return [
      '当前群的开放平台标识（不是群号）：',
      `group_openid: ${target.chatId}`,
      '仅对当前机器人 AppID 有效。',
      '',
      '复制到插件配置：',
      'allowGroups:',
      `  - ${quoteYamlString(target.chatId)}`,
    ].join('\n')
  }

  return [
    '你在当前机器人下的开放平台标识（不是 QQ 号）：',
    `user_openid: ${target.chatId}`,
    '仅对当前机器人 AppID 有效。',
    '',
    '复制到插件配置：',
    'allowUsers:',
    `  - ${quoteYamlString(target.chatId)}`,
  ].join('\n')
}
