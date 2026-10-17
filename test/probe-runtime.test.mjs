import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFocusProbe, parseMacFrontPid, parseMacIdleMs, parseWindowsProbeLine } from '../src/focus-probe.mjs'
import { findRuntimeMetadata, runtimeMetadataCandidates } from '../src/runtime-client.mjs'

test('parseWindowsProbeLine: номер запроса, простой, pid', () => {
  assert.deepEqual(parseWindowsProbeLine('7 1234 24680\r'), { seq: 7, idleMs: 1234, foregroundPid: 24680 })
  assert.deepEqual(parseWindowsProbeLine('8 -1 0'), { seq: 8, idleMs: null, foregroundPid: 0 })
  assert.equal(parseWindowsProbeLine('1234 24680'), null)
  assert.equal(parseWindowsProbeLine('garbage'), null)
})

test('Windows: PowerShell не запускается — sample() быстро отвечает «неизвестно», а не виснет', { skip: process.platform !== 'win32' }, async () => {
  const logs = []
  const probe = createFocusProbe({ platform: 'win32', targetPid: 1, env: { SystemRoot: 'C:\\nonexistent-root' }, log: (m) => logs.push(m) })
  const started = Date.now()
  assert.deepEqual(await probe.sample(), { focused: null, idleMs: null })
  assert.ok(Date.now() - started < 3000)
  // После неудачи — backoff, без повторного запуска на каждом опросе.
  assert.deepEqual(await probe.sample(), { focused: null, idleMs: null })
  assert.equal(logs.length, 1)
  probe.dispose()
})

test('Windows: настоящий PowerShell отвечает на запросы', { skip: process.platform !== 'win32' }, async () => {
  const probe = createFocusProbe({ platform: 'win32', targetPid: process.pid })
  try {
    const first = await probe.sample()
    assert.equal(typeof first.focused, 'boolean')
    assert.equal(typeof first.idleMs, 'number')
    const second = await probe.sample()
    assert.equal(typeof second.idleMs, 'number')
  } finally {
    probe.dispose()
  }
})

test('macOS: HIDIdleTime в наносекундах и pid фронтального приложения', () => {
  assert.equal(parseMacIdleMs('    |   "HIDIdleTime" = 2500000000\n'), 2500)
  assert.equal(parseMacIdleMs('nothing'), null)
  assert.equal(parseMacFrontPid('"pid"=4321\n'), 4321)
  assert.equal(parseMacFrontPid(''), null)
})

test('runtimeMetadataCandidates по платформам', () => {
  const win = runtimeMetadataCandidates('win32', 'C:\\Users\\me', {})
  assert.ok(win[0].endsWith(join('AppData', 'Roaming', 'orca', 'orca-runtime.json')))
  const mac = runtimeMetadataCandidates('darwin', '/Users/me', {})
  assert.ok(mac[0].includes(join('Library', 'Application Support', 'orca')))
  const linux = runtimeMetadataCandidates('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })
  assert.equal(linux[0], join('/cfg', 'orca', 'orca-runtime.json'))
})

test('findRuntimeMetadata предпочитает рантайм родительского процесса', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-wakatime-'))
  try {
    const base = join(home, '.config')
    const write = async (dir, pid) => {
      await mkdir(join(base, dir), { recursive: true })
      await writeFile(
        join(base, dir, 'orca-runtime.json'),
        JSON.stringify({ pid, authToken: `t${pid}`, transports: [{ kind: 'unix', endpoint: `/tmp/${pid}.sock` }] })
      )
    }
    await write('orca', 111)
    await write('orca-dev', 222)
    const own = await findRuntimeMetadata({ ppid: 222, platform: 'linux', home, env: {} })
    assert.equal(own.pid, 222)
    const fallback = await findRuntimeMetadata({ ppid: 999, platform: 'linux', home, env: {} })
    assert.equal(fallback.pid, 111)
    const none = await findRuntimeMetadata({ ppid: 1, platform: 'linux', home: join(home, 'nope'), env: {} })
    assert.equal(none, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
