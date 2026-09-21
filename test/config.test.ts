import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'

const credentials = { appId: 'app', clientSecret: 'secret' }
test('config uses env credentials, with explicit config taking precedence', () => {
  const env = { QQ_BOT_APP_ID: ' env-app ', QQ_BOT_APP_SECRET: 'env-secret' }
  assert.equal(resolveConfig({}, env).appId, 'env-app')
  assert.equal(resolveConfig(credentials, env).clientSecret, 'secret')
  assert.equal(resolveConfig({ appId: '  ', clientSecret: '' }, env).clientSecret, 'env-secret')
})
test('config normalizes lists while retaining restrictive defaults', () => {
  const config = resolveConfig({ ...credentials, allowGroups: [' a ', 'a', ''], allowedTools: [' search ', 'search'] }, {})
  assert.deepEqual(config.allowGroups, ['a'])
  assert.deepEqual(config.allowedTools, ['search'])
  assert.equal(config.publicMode, false)
  assert.equal(config.enableWhoami, true)
  assert.equal(config.maxSessions, 100)
})
test('invalid credentials, types and numeric bounds fail without leaking secrets', () => {
  for (const invalid of [
    {}, { appId: 'YOUR_APP_ID', clientSecret: 'YOUR_APP_SECRET' },
    { ...credentials, maxSessions: 1.5 }, { ...credentials, maxSessions: 0 },
    { ...credentials, requestTimeoutMs: 999 }, { ...credentials, sessionIdleMinutes: -1 },
    { ...credentials, publicMode: 'false' }, { ...credentials, allowUsers: 'user' },
  ]) {
    assert.throws(() => resolveConfig(invalid as never, {}), (error: Error) => !error.message.includes('secret'))
  }
})
