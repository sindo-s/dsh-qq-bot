import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createOverlay, readConfig, saveOverlay, splitList } from '../scripts/cli.mjs'

test('wizard supports Chinese delimiters, absolute paths and both patch modes', () => {
  assert.deepEqual(splitList(' a，b, a\nc '), ['a', 'b', 'c'])
  const local = createOverlay({})[0].insert[0]
  assert.ok(isAbsolute(local.name))
  assert.ok(!local.name.includes('\\'))
  assert.deepEqual(createOverlay({}, true), [{ id: 'qq-bot', config: {} }])
})
test('generated YAML preserves values and never overwrites an existing config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-config-'))
  try {
    const path = join(dir, 'cordis.yml')
    const config = { appId: '123', clientSecret: 'quote: #\n"value', allowUsers: ['001'] }
    await saveOverlay(path, config)
    assert.deepEqual(readConfig(await readFile(path, 'utf8')), config)
    await assert.rejects(saveOverlay(path, {}), { code: 'EEXIST' })
    assert.deepEqual(readConfig(await readFile(path, 'utf8')), config)
    await writeFile(path, '- id: qq-bot\n  config: {}\n')
    const env = { ...process.env, QQ_BOT_APP_ID: '', QQ_BOT_APP_SECRET: '' }
    const failed = spawnSync(process.execPath, ['scripts/cli.mjs', 'doctor', '--output', path], { encoding: 'utf8', env })
    assert.equal(failed.status, 1)
    const passed = spawnSync(process.execPath, ['scripts/cli.mjs', 'doctor', '--output', path], {
      encoding: 'utf8', env: { ...env, QQ_BOT_APP_ID: 'app', QQ_BOT_APP_SECRET: 'do-not-print-this' },
    })
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, /whoami/)
    assert.ok(!(passed.stdout + passed.stderr).includes('do-not-print-this'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('doctor rejects ambiguous rows and executable YAML', () => {
  assert.throws(() => readConfig('- id: qq-bot\n- id: qq-bot'))
  assert.throws(() => readConfig('- id: qq-bot\n  config: !!js process.env'))
  assert.throws(() => readConfig('- id: another-plugin'))
})

test('non-interactive init creates portable bundle config without copying environment secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-init-'))
  try {
    const path = join(dir, 'cordis.yml')
    const args = ['scripts/cli.mjs', 'init', '--bundle', '--output', path]
    const env = {...process.env, QQ_BOT_APP_ID:'private-app-id', QQ_BOT_APP_SECRET:'private-secret-value'}
    const result = spawnSync(process.execPath, args, {encoding:'utf8',env})
    assert.equal(result.status, 0, result.stderr)
    const text = await readFile(path,'utf8')
    const config = readConfig(text)
    assert.equal(config.enabled,true)
    assert.equal(config.publicMode,false)
    assert.deepEqual(config.allowUsers,[])
    assert.ok(!text.includes('insert:'))
    for (const secret of ['private-app-id','private-secret-value']) assert.ok(!(text+result.stdout+result.stderr).includes(secret))
    const duplicate=spawnSync(process.execPath,args,{encoding:'utf8',env})
    assert.equal(duplicate.status,1)
    assert.equal(await readFile(path,'utf8'),text)
    const check=spawnSync(process.execPath,['scripts/cli.mjs','doctor','--output',path],{encoding:'utf8',env})
    assert.equal(check.status,0,check.stderr)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
