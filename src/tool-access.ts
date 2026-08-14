const BUILTIN_TOOL_NAMES = new Set(['qq_send', 'run_code'])

export function normalizeAllowedTools(toolNames: readonly string[] = []) {
  return [...new Set(toolNames
    .map((name) => name.trim())
    .filter((name) => name && !BUILTIN_TOOL_NAMES.has(name)))]
}

export function formatToolStatus(
  allowedToolNames: readonly string[],
  registeredToolNames: readonly string[],
) {
  const configured = normalizeAllowedTools(allowedToolNames)
  const registered = new Set(registeredToolNames)
  const ready = configured.filter((name) => registered.has(name))
  const missing = configured.filter((name) => !registered.has(name))

  return [
    'QQ Agent 工具状态：',
    '- 内置：qq_send（只能发送到当前 QQ 会话；普通回复无需调用）',
    `- 已放行并加载：${ready.length ? ready.join('、') : '无'}`,
    `- 已配置但未加载：${missing.length ? missing.join('、') : '无'}`,
    '',
    '其他工具需先由 DSH 宿主安装并加载，再把准确工具名加入 allowedTools。',
  ].join('\n')
}
