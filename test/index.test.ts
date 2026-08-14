import assert from 'node:assert/strict'
import test from 'node:test'
import { QQApi } from '../src/api.ts'
import { QQGateway, gatewayClosePolicy } from '../src/gateway.ts'
import { formatIdentityReply, isIdentityCommand } from '../src/identity.ts'
import {
  KeyedSerialTaskQueue,
  MessageDeduplicator,
  ReplySequencer,
  TurnReplyRouter,
  splitQQContent,
} from '../src/message-state.ts'

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeWebSocket(): WebSocket {
  const socket = {
    readyState: 1,
    onclose: null,
    onerror: null,
    onmessage: null,
    close() {
      socket.readyState = 3
    },
    send() {},
  }
  return socket as unknown as WebSocket
}

async function waitFor(predicate: () => boolean, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('active messages omit reply credentials while passive replies include them', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/getAppAccessToken')) {
      return jsonResponse({ access_token: 'token', expires_in: '7200' })
    }
    requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return jsonResponse({ id: 'sent' })
  }) as typeof fetch

  const api = new QQApi({ appId: 'app', clientSecret: 'secret', fetch: fetchMock })
  await api.replyGroupMessage('group/with/slash', 'passive', 'message-1', 2)
  await api.sendC2CMessage('user/with/slash', 'active')

  assert.match(requests[0].url, /groups\/group%2Fwith%2Fslash\/messages$/)
  assert.deepEqual(requests[0].body, {
    content: 'passive',
    msg_type: 0,
    msg_id: 'message-1',
    msg_seq: 2,
  })
  assert.match(requests[1].url, /users\/user%2Fwith%2Fslash\/messages$/)
  assert.deepEqual(requests[1].body, { content: 'active', msg_type: 0 })
})

test('access-token refresh is single-flight', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let tokenRequests = 0
  const fetchMock = (async () => {
    tokenRequests++
    await gate
    return jsonResponse({ access_token: 'shared-token', expires_in: '7200' })
  }) as typeof fetch

  const api = new QQApi({ appId: 'app', clientSecret: 'secret', fetch: fetchMock })
  const first = api.getAccessToken()
  const second = api.getAccessToken()
  assert.equal(tokenRequests, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), ['shared-token', 'shared-token'])
  assert.equal(tokenRequests, 1)
})

test('a 401 invalidates the token and retries exactly once', async () => {
  let tokenRequests = 0
  let gatewayRequests = 0
  const authorizations: string[] = []
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/getAppAccessToken')) {
      tokenRequests++
      return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: '7200' })
    }
    gatewayRequests++
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '')
    return gatewayRequests === 1
      ? jsonResponse({ error: 'expired' }, 401)
      : jsonResponse({ url: 'wss://gateway.example' })
  }) as typeof fetch

  const api = new QQApi({ appId: 'app', clientSecret: 'secret', fetch: fetchMock })
  assert.equal(await api.getGatewayUrl(), 'wss://gateway.example')
  assert.equal(tokenRequests, 2)
  assert.equal(gatewayRequests, 2)
  assert.deepEqual(authorizations, ['QQBot token-1', 'QQBot token-2'])
})

test('message state preserves content, deduplicates, and sequences per msgId', () => {
  assert.deepEqual(splitQQContent('a😀bc', 2), ['a😀', 'bc'])
  assert.equal(splitQQContent('a😀bc', 2).join(''), 'a😀bc')

  let now = 0
  const dedupe = new MessageDeduplicator(100, 2, () => now)
  assert.equal(dedupe.accept('one'), true)
  assert.equal(dedupe.accept('one'), false)
  now = 100
  assert.equal(dedupe.accept('one'), true)

  const sequencer = new ReplySequencer(100, 2, () => now)
  assert.equal(sequencer.next('message-a'), 1)
  assert.equal(sequencer.next('message-a'), 2)
  assert.equal(sequencer.next('message-b'), 1)
  now = 201
  assert.equal(sequencer.next('message-a'), 1)
})

test('identity discovery recognizes only explicit commands and returns copyable config', () => {
  assert.equal(isIdentityCommand('/whoami'), true)
  assert.equal(isIdentityCommand('  /WHOAMI  '), true)
  assert.equal(isIdentityCommand('/id please'), true)
  assert.equal(isIdentityCommand('/identity'), false)
  assert.equal(isIdentityCommand('hello /whoami'), false)

  const userReply = formatIdentityReply({ chatId: "user'openid", isGroup: false })
  assert.match(userReply, /user_openid: user'openid/)
  assert.match(userReply, /allowUsers:\n  - 'user''openid'/)

  const groupReply = formatIdentityReply({ chatId: 'group-openid', isGroup: true })
  assert.match(groupReply, /group_openid: group-openid/)
  assert.match(groupReply, /allowGroups:/)
})

test('turn router keeps concurrent inbound messages correlated to their own turn', () => {
  const router = new TurnReplyRouter<string>()
  router.queue('session', 'message-a', 'QQ-A')
  router.queue('session', 'message-b', 'QQ-B')

  assert.equal(router.claim('session', 'message-a', 1), true)
  assert.equal(router.get('session', 1), 'QQ-A')
  router.endTurn('session', 1)

  assert.equal(router.claim('session', 'message-b', 2), true)
  assert.equal(router.get('session', 2), 'QQ-B')
  router.clearSession('session')
  assert.equal(router.get('session', 2), undefined)
})

test('keyed send queue preserves order without blocking other keys', async () => {
  const queue = new KeyedSerialTaskQueue()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })

  const first = queue.run('same', async () => {
    events.push('first:start')
    await gate
    events.push('first:end')
  })
  const second = queue.run('same', async () => {
    events.push('second')
  })
  const other = queue.run('other', async () => {
    events.push('other')
  })

  await Promise.resolve()
  await other
  assert.deepEqual(events, ['first:start', 'other'])
  release()
  await Promise.all([first, second, queue.drain()])
  assert.deepEqual(events, ['first:start', 'other', 'first:end', 'second'])
})

test('gateway close codes produce safe reconnect policies', () => {
  assert.deepEqual(gatewayClosePolicy(4004), {
    fatal: false,
    clearToken: true,
    clearSession: true,
    minimumDelayMs: 0,
  })
  assert.equal(gatewayClosePolicy(4008).minimumDelayMs, 60_000)
  assert.equal(gatewayClosePolicy(4009).clearSession, true)
  assert.equal(gatewayClosePolicy(4014).fatal, true)
  assert.equal(gatewayClosePolicy(4915).fatal, true)
})

test('stopping during gateway discovery cannot create a late socket', async () => {
  let resolveUrl!: (url: string) => void
  const gatewayUrl = new Promise<string>((resolve) => { resolveUrl = resolve })
  const api = {
    getGatewayUrl: () => gatewayUrl,
    getAccessToken: async () => 'token',
    invalidateAccessToken: () => {},
  } as unknown as QQApi
  let socketsCreated = 0
  const gateway = new QQGateway(api, {
    onMessage: () => {},
    createWebSocket: () => {
      socketsCreated++
      throw new Error('a socket must not be created after stop')
    },
  })

  const starting = gateway.start()
  gateway.stop()
  resolveUrl('wss://gateway.example')
  await starting
  assert.equal(socketsCreated, 0)
})

test('an initial gateway discovery failure enters the reconnect loop', async () => {
  let discoveryAttempts = 0
  let socketsCreated = 0
  const api = {
    getGatewayUrl: async () => {
      discoveryAttempts++
      if (discoveryAttempts === 1) throw new Error('temporary discovery failure')
      return 'wss://gateway.example'
    },
    getAccessToken: async () => 'token',
    invalidateAccessToken: () => {},
  } as unknown as QQApi
  const gateway = new QQGateway(api, {
    onMessage: () => {},
    reconnectDelaysMs: [1],
    createWebSocket: () => {
      socketsCreated++
      return fakeWebSocket()
    },
  })

  await gateway.start()
  await waitFor(() => socketsCreated === 1)
  assert.equal(discoveryAttempts, 2)
  gateway.stop()
})

test('a socket that never receives HELLO is closed and scheduled for reconnect', async () => {
  const socket = fakeWebSocket()
  const logs: string[] = []
  const api = {
    getGatewayUrl: async () => 'wss://gateway.example',
    getAccessToken: async () => 'token',
    invalidateAccessToken: () => {},
  } as unknown as QQApi
  const gateway = new QQGateway(api, {
    onMessage: () => {},
    onLog: (line) => logs.push(line),
    helloTimeoutMs: 1,
    reconnectDelaysMs: [1_000],
    createWebSocket: () => socket,
  })

  await gateway.start()
  await waitFor(() => socket.readyState === 3)
  assert.equal(logs.some((line) => line.includes('HELLO timed out')), true)
  gateway.stop()
})
