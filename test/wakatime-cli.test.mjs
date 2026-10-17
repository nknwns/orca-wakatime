import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHeartbeatArgs,
  cliBinaryName,
  compareVersions,
  fetchLatestCliTag,
  installCli,
  locateCli
} from '../src/wakatime-cli.mjs'
import { extractFileByPrefix, listZipEntries } from '../src/zip.mjs'
import { parseIni, readWakatimeConfig } from '../src/wakatime-config.mjs'

/** Минимальный zip-архив (method 8 / 0) для тестов распаковки. */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, content, store = false } of files) {
    const nameBuf = Buffer.from(name)
    const data = store ? content : deflateRawSync(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt32LE(crc32(content) >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('cliBinaryName по платформе и архитектуре', () => {
  assert.equal(cliBinaryName('win32', 'x64'), 'wakatime-cli-windows-amd64.exe')
  assert.equal(cliBinaryName('darwin', 'arm64'), 'wakatime-cli-darwin-arm64')
  assert.equal(cliBinaryName('linux', 'ia32'), 'wakatime-cli-linux-386')
})

test('compareVersions', () => {
  assert.equal(compareVersions('v2.26.15', 'v2.26.15'), 0)
  assert.equal(compareVersions('v2.27.0', 'v2.26.15'), 1)
  assert.equal(compareVersions('2.9.0', 'v2.10.0'), -1)
  assert.equal(compareVersions('v3.0.0-beta.1', 'v2.99.99'), 1)
})

test('buildHeartbeatArgs: файл с сохранением', () => {
  const args = buildHeartbeatArgs(
    {
      entity: 'C:/work/app/a.ts',
      entityType: 'file',
      category: 'coding',
      time: 1792256672.0569,
      isWrite: true,
      projectFolder: 'C:/work/app'
    },
    'orca/1.4.222 orca-wakatime/0.1.0'
  )
  assert.deepEqual(args, [
    '--entity=C:/work/app/a.ts',
    '--entity-type', 'file',
    '--time', '1792256672.057',
    '--plugin', 'orca/1.4.222 orca-wakatime/0.1.0',
    '--timeout', '30',
    '--category', 'coding',
    '--write',
    '--project-folder', 'C:/work/app'
  ])
})

test('buildHeartbeatArgs: удалённый файл — alternate-* и is-unsaved-entity', () => {
  const args = buildHeartbeatArgs(
    {
      entity: 'src/a.ts',
      entityType: 'file',
      category: 'coding',
      time: 1,
      project: 'srv',
      alternateBranch: 'main',
      language: 'typescript',
      isUnsavedEntity: true
    },
    'p'
  )
  assert.ok(args.includes('--is-unsaved-entity'))
  assert.equal(args[args.indexOf('--alternate-project') + 1], 'srv')
  assert.equal(args[args.indexOf('--alternate-branch') + 1], 'main')
  assert.equal(args[args.indexOf('--alternate-language') + 1], 'typescript')
  assert.ok(!args.includes('--write'))
  assert.ok(!args.includes('--project-folder'))
})

test('zip: распаковка deflate и store', () => {
  const binary = Buffer.from('MZ fake binary '.repeat(100))
  const zip = makeZip([
    { name: 'docs/', content: Buffer.alloc(0), store: true },
    { name: 'wakatime-cli-windows-amd64.exe', content: binary }
  ])
  assert.equal(listZipEntries(zip).length, 2)
  const { name, content } = extractFileByPrefix(zip, 'wakatime-cli-windows-amd64')
  assert.equal(name, 'wakatime-cli-windows-amd64.exe')
  assert.deepEqual(content, binary)
  const stored = makeZip([{ name: 'x/wakatime-cli-linux-amd64', content: Buffer.from('elf'), store: true }])
  assert.equal(extractFileByPrefix(stored, 'wakatime-cli-linux').content.toString(), 'elf')
  assert.throws(() => extractFileByPrefix(zip, 'nope'), /no file/)
  assert.throws(() => listZipEntries(Buffer.from('not a zip at all, definitely not')), /zip/)
})

test('fetchLatestCliTag: тег из редиректа /releases/latest', async () => {
  const fetchImpl = async () => ({
    headers: new Headers({ location: 'https://github.com/wakatime/wakatime-cli/releases/tag/v2.30.1' })
  })
  assert.equal(await fetchLatestCliTag(fetchImpl), 'v2.30.1')
})

test('fetchLatestCliTag: запасной путь через GitHub API', async () => {
  const fetchImpl = async (url) =>
    url.includes('api.github.com')
      ? { ok: true, json: async () => ({ tag_name: 'v2.31.0' }) }
      : { headers: new Headers() }
  assert.equal(await fetchLatestCliTag(fetchImpl), 'v2.31.0')
})

test('installCli скачивает, распаковывает и кладёт бинарник в ~/.wakatime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-wakatime-'))
  try {
    const binary = Buffer.from('#!/bin/sh\necho v9.9.9\n')
    let requested = null
    const fetchImpl = async (url) => {
      requested = url
      const zip = makeZip([{ name: 'wakatime-cli-linux-amd64', content: binary }])
      return { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }
    }
    const target = await installCli({ tag: 'v9.9.9', home, platform: 'linux', arch: 'x64', fetchImpl })
    assert.equal(requested, 'https://github.com/wakatime/wakatime-cli/releases/download/v9.9.9/wakatime-cli-linux-amd64.zip')
    assert.equal(target, join(home, '.wakatime', 'wakatime-cli-linux-amd64'))
    assert.deepEqual(await readFile(target), binary)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('locateCli находит бинарник своей платформы', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-wakatime-'))
  try {
    assert.equal(await locateCli({ home }), null)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, '.wakatime'))
    const path = join(home, '.wakatime', cliBinaryName())
    await writeFile(path, 'x', { mode: 0o755 })
    assert.equal(await locateCli({ home }), path)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('parseIni и readWakatimeConfig', async () => {
  const ini = parseIni('; comment\n[settings]\napi_key = waka_abc\ndebug = true\nexclude =\n  ^COMMIT_EDITMSG$\n[git]\nsubmodules = false\n')
  assert.equal(ini.settings.api_key, 'waka_abc')
  assert.equal(ini.git.submodules, 'false')

  const home = await mkdtemp(join(tmpdir(), 'orca-wakatime-'))
  try {
    assert.deepEqual((await readWakatimeConfig(home)).hasApiKey, false)
    await writeFile(join(home, '.wakatime.cfg'), '[settings]\r\napi_key = waka_123\r\ndebug = TRUE\r\n')
    const config = await readWakatimeConfig(home)
    assert.equal(config.hasApiKey, true)
    assert.equal(config.debug, true)
    await writeFile(join(home, '.wakatime.cfg'), '[settings]\napi_key_vault_cmd = pass show waka\n')
    assert.equal((await readWakatimeConfig(home)).hasApiKey, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('buildHeartbeatArgs: human-line-changes только для положительного целого', () => {
  const base = { entity: 'a', entityType: 'file', time: 1 }
  const args = buildHeartbeatArgs({ ...base, humanLineChanges: 3 }, 'p')
  assert.equal(args[args.indexOf('--human-line-changes') + 1], '3')
  assert.ok(!buildHeartbeatArgs({ ...base, humanLineChanges: 0 }, 'p').includes('--human-line-changes'))
  assert.ok(!buildHeartbeatArgs({ ...base }, 'p').includes('--human-line-changes'))
})

test('runner: второй sync-ai в очереди не добавляется, ошибки не роняют очередь', async () => {
  const { createCliRunner } = await import('../src/wakatime-cli.mjs')
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const results = []
  let calls = 0
  const runner = createCliRunner({
    getCliPath: async () => {
      calls += 1
      if (calls === 1) await gate
      if (calls === 2) throw new Error('boom')
      return null
    },
    pluginString: () => 'p',
    onResult: (r) => results.push(r.reason ?? r.code)
  })
  assert.equal(runner.syncAiActivity(), true)
  assert.equal(runner.syncAiActivity(), false)
  runner.sendHeartbeat({ entity: 'a', time: 1 })
  runner.sendHeartbeat({ entity: 'b', time: 2 })
  release()
  await runner.whenIdle(2000)
  // 1) sync — cli нет; 2) heartbeat 'a' — getCliPath бросил, залогировано; 3) 'b' — cli нет.
  assert.deepEqual(results, ['cli-missing', 'cli-missing'])
  assert.equal(runner.syncAiActivity(), true)
  await runner.whenIdle(2000)
  runner.sendHeartbeat({ entity: 'c', time: 3 })
  assert.deepEqual(runner.takeQueuedHeartbeats().map((h) => h.entity), [])
})

test('zip: повреждённое содержимое отклоняется по CRC32', () => {
  const zip = makeZip([{ name: 'wakatime-cli-linux-amd64', content: Buffer.from('payload'), store: true }])
  const corrupted = Buffer.from(zip)
  corrupted[30 + 'wakatime-cli-linux-amd64'.length] ^= 0xff
  assert.throws(() => extractFileByPrefix(corrupted, 'wakatime-cli-linux'), /CRC32 mismatch/)
})
