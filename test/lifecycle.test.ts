import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { QQApi } from '../src/api.ts'
import { QQGateway, type QQGatewayOptions, type QQMessageEvent } from '../src/gateway.ts'

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for plugin state')
}
function fixture(t: TestContext, create: (options: CreateAgentOptions) => Promise<AgentHandle>, attachments?: Pick<AttachmentStore, 'imageLimits' | 'saveImages'>) {
  let receive!: (event: QQMessageEvent) => void
  const disposers: Array<() => Promise<void>> = []
  const replies: string[] = []
  t.mock.method(QQGateway.prototype, 'start', async function(this: QQGateway) {
    receive = (this as unknown as { options: QQGatewayOptions }).options.onMessage
  })
  t.mock.method(QQApi.prototype, 'replyC2CMessage', async (_id: string, text: string) => { replies.push(text) })
  t.mock.method(console, 'warn', () => {})
  const ctx = {
    get: (name: string) => name === 'attachments' ? attachments : undefined,
    agents: { create, get: () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    tools: { schemas: () => [{ name: 'search' }, { name: 'bash' }] },
    on: () => () => {},
    effect: (start: () => () => Promise<void>) => { disposers.push(start()) },
  } as unknown as Context
  apply(ctx, { appId: 'app', clientSecret: 'secret', allowUsers: ['first', 'second'], allowedTools: ['search'], maxSessions: 1 })
  const dispose = async () => { for (const fn of disposers.splice(0)) await fn() }
  t.after(dispose)
  return {
    dispose, replies,
    receive(chatId: string, msgId: string, content = 'hello', attachments: QQMessageEvent['attachments'] = []) { receive({ type: 'C2C_MESSAGE_CREATE', isGroup: false, chatId, msgId, content, attachments }) },
  }
}

test('disabled plugin can be installed without credentials or runtime side effects', () => {
  apply(new Proxy({} as Context, { get() { throw new Error('unexpected runtime access') } }), { enabled: false })
})

test('unloading cancels unpublished Agent creation without waiting indefinitely', async (t) => {
  let signal: AbortSignal | undefined
  const f = fixture(t, (options) => new Promise((_resolve, reject) => {
    signal = options.signal
    signal?.addEventListener('abort', () => reject(new Error('creation aborted')), { once: true })
  }))
  f.receive('first', 'one')
  await waitFor(() => signal !== undefined)
  await f.dispose()
  assert.equal(signal?.aborted, true)
})

test('failed creation releases capacity; the next chat retains scoped tool restrictions', async (t) => {
  let attempts = 0
  let followups = 0
  let guard!: (execution: { name: string }) => string | undefined
  let denied: string[] = []
  const f = fixture(t, async (options) => {
    if (++attempts === 1) throw new Error('temporary creation failure')
    const scoped = {
      on: () => () => {},
      tools: {
        restrict: (rule: { deny: string[] }) => { denied = rule.deny },
        guard: (fn: typeof guard) => { guard = fn },
        register: () => () => {},
      },
    } as unknown as Context
    const handle = { agent: { id: options.sessionId, status: 'idle', followup: () => { followups++ } }, dispose: async () => {} } as unknown as AgentHandle
    await options.setup?.(scoped, handle.agent)
    return handle
  })
  f.receive('first', 'one')
  await waitFor(() => f.replies.length === 1)
  f.receive('second', 'two')
  await waitFor(() => followups === 1)
  assert.equal(attempts, 2)
  assert.deepEqual(denied, ['bash'])
  assert.equal(guard({ name: 'search' }), undefined)
  assert.equal(guard({ name: 'qq_send' }), undefined)
  assert.match(guard({ name: 'later-loaded-dangerous-tool' })!, /not allowed/)
})

test('image-only inbound reaches the Agent; unauthorized images are never downloaded', async (t) => {
  const prompts: UserMessage[] = []
  let downloads = 0
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(png) })
  const store = {
    imageLimits: {maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'] as const},
    saveImages: async () => [{attachmentId: 'test-image',mediaType:'image/png',bytes:png.length,width:1,height:1} as ImageAttachmentRef],
  }
  const f = fixture(t, async (options) => ({agent:{id:options.sessionId,status:'idle',followup:(message:UserMessage)=>{prompts.push(message)}},dispose:async()=>{}} as unknown as AgentHandle), store)
  const attachments = [{url:'https://gchat.qpic.cn/image.png',contentType:'image/png'}]
  f.receive('outsider','denied','',attachments)
  f.receive('first','image-only','',attachments)
  await waitFor(()=>prompts.length===1)
  assert.equal(downloads,1)
  assert.deepEqual(prompts[0].content.map(p=>p.type),['text','image'])
})

test('invalid image receives an error reply instead of silently disappearing', async (t) => {
  let followed = false
  const f = fixture(t, async (options) => ({agent:{id:options.sessionId,status:'idle',followup:()=>{followed=true}},dispose:async()=>{}} as unknown as AgentHandle))
  f.receive('first','image-without-store','',[{url:'https://gchat.qpic.cn/image.png'}])
  await waitFor(()=>f.replies.length===1)
  assert.match(f.replies[0],/图片存储服务/)
  assert.equal(followed,false)
})

test('/stop cancels an in-flight image and queued text before model admission', async (t) => {
  const prompts: UserMessage[] = []
  let started = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    started = true
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once:true})
  }))
  const store = {imageLimits:{maxImageBytes:1024,maxImagesPerMessage:4,maxMessageImageBytes:4096,maxImagePixels:100,maxImageDimension:10,mediaTypes:['image/png'] as const},saveImages:async()=>[]}
  const f = fixture(t, async options => ({agent:{id:options.sessionId,status:'idle',followup:(message:UserMessage)=>prompts.push(message)},dispose:async()=>{}} as unknown as AgentHandle),store)
  f.receive('first','image','',[{url:'https://gchat.qpic.cn/image'}])
  await waitFor(()=>started)
  f.receive('first','queued','queued text')
  await new Promise(resolve=>setTimeout(resolve,10))
  f.receive('first','stop','/stop')
  await waitFor(()=>f.replies.length===1)
  f.receive('first','after','after stop')
  await waitFor(()=>prompts.length===1)
  assert.deepEqual(prompts[0].content,[{type:'text',text:'after stop'}])
})
