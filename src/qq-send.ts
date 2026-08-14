import { defineTool } from '@deepseek-ai/dsh-tools'

export function createQQSendTool(sendText: (text: string) => Promise<void>) {
  return defineTool({
    name: 'qq_send',
    description: [
      'Send text to the current QQ conversation only.',
      'A successful call ends the current turn, so do not send or describe a confirmation afterward.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: '要发送的文本内容' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, execution) {
      await sendText(args.text)
      execution.concludeTurn()
      return '已发送到当前 QQ 会话'
    },
  })
}
