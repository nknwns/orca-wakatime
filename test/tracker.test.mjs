import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTracker } from '../src/tracker.mjs'

// Сценарии трекера на фейковых рантайме, пробнике и очереди wakatime-cli.
async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-wakatime-tracker-'))
  const wtId = `repo::${dir}`
  const state = {
    probe: { focused: true, idleMs: 100 },
    worktrees: [{ worktreeId: wtId, hostId: 'local', path: dir, repo: 'app', isActive: true, status: 'active' }],
    snapshot: { worktree: wtId, activeTabId: 't::l', tabs: [{ type: 'terminal', id: 't::l', isActive: true }] }
  }
  const heartbeats = []
  const notifications = []
  const storage = new Map()
  const orca = {
    log: () => {},
    host: {
      call: async (method, params) => {
        if (method === 'storage.get') return { value: storage.get(params.key) ?? null }
        if (method === 'storage.set') return storage.set(params.key, params.value), { ok: true }
        if (method === 'notifications.show') return notifications.push(params), { delivered: true }
        return null
      }
    }
  }
  const rpc = {
    call: async (method) => {
      if (method === 'worktree.ps') return { worktrees: state.worktrees }
      if (method === 'session.tabs.listAll') return { snapshots: [state.snapshot] }
      if (method === 'status.get') return { appVersion: '1.4.222' }
      throw new Error(`unexpected ${method}`)
    }
  }
  const runner = overrides.runner?.(heartbeats) ?? {
    sendHeartbeat: (hb) => heartbeats.push(hb),
    syncAiActivity: () => {},
    today: async () => ({ code: 0, text: '1 hr 5 mins' }),
    whenIdle: async () => {}
  }
  const probe = overrides.probe ?? { sample: async () => state.probe, dispose() {} }
  const tracker = createTracker(orca, { pluginVersion: '0.0.0-test', deps: { rpc, runner, probe } })
  const cleanup = async () => {
    await tracker.stop()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, state, heartbeats, notifications, storage, tracker, cleanup }
}

const fileTab = (filePath, isDirty) => ({ type: 'file', id: 'f', filePath, isDirty, isActive: true, mode: 'edit' })

test('в фокусе и с вводом: один heartbeat, повтор только после смены объекта', async () => {
  const t = await setup()
  try {
    await t.tracker.tick()
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 1)
    assert.equal(t.heartbeats[0].entity, 'Orca Terminal')
    assert.equal(t.heartbeats[0].projectFolder, t.dir)

    const file = join(t.dir, 'a.ts')
    await writeFile(file, 'x')
    t.state.snapshot = { worktree: t.state.snapshot.worktree, activeTabId: 'f', tabs: [fileTab(file, false)] }
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 2)
    assert.equal(t.heartbeats[1].entity, file)
    assert.equal(t.heartbeats[1].isWrite, false)
  } finally {
    await t.cleanup()
  }
})

test('Orca в фоне или без ввода — время не идёт', async () => {
  const t = await setup()
  try {
    t.state.probe = { focused: false, idleMs: 100 }
    await t.tracker.tick()
    t.state.probe = { focused: true, idleMs: 60_000 }
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 0)
  } finally {
    await t.cleanup()
  }
})

test('сохранение: write-heartbeat с числом изменённых строк', async () => {
  const t = await setup()
  try {
    const file = join(t.dir, 'main.ts')
    await writeFile(file, 'one\ntwo\nthree\n')
    const wt = t.state.snapshot.worktree
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, false)] }
    await t.tracker.tick() // открыли файл
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, true)] }
    await t.tracker.tick() // начали править — запомнили исходник
    await writeFile(file, 'one\nTWO\nthree\nfour\n')
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, false)] }
    await t.tracker.tick() // сохранили

    const writes = t.heartbeats.filter((h) => h.isWrite)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].entity, file)
    assert.equal(writes[0].humanLineChanges, 3)
    assert.equal(writes[0].category, 'coding')
  } finally {
    await t.cleanup()
  }
})

test('«отменить изменения» без записи на диск — не сохранение', async () => {
  const t = await setup()
  try {
    const file = join(t.dir, 'old.ts')
    await writeFile(file, 'x')
    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(file, old, old)
    const wt = t.state.snapshot.worktree
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, true)] }
    await t.tracker.tick()
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, false)] }
    await t.tracker.tick()
    assert.equal(t.heartbeats.filter((h) => h.isWrite).length, 0)
  } finally {
    await t.cleanup()
  }
})

test('пробник недоступен: учёт по действиям во вкладках', async () => {
  const t = await setup()
  try {
    t.state.probe = { focused: null, idleMs: null }
    await t.tracker.tick() // первый опрос — только запоминаем состояние
    await t.tracker.tick() // ничего не поменялось
    assert.equal(t.heartbeats.length, 0)
    // Агент начал работать — категория сменилась, но пользователь ничего не делал.
    t.state.worktrees = t.state.worktrees.map((w) => ({ ...w, status: 'working' }))
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 0)
    const file = join(t.dir, 'b.ts')
    await writeFile(file, 'x')
    t.state.snapshot = { worktree: t.state.snapshot.worktree, activeTabId: 'f', tabs: [fileTab(file, false)] }
    await t.tracker.tick() // пользователь переключил вкладку
    assert.equal(t.heartbeats.length, 1)
    assert.equal(t.heartbeats[0].entity, file)
  } finally {
    await t.cleanup()
  }
})

test('пауза останавливает учёт и переживает перезапуск через storage', async () => {
  const t = await setup()
  try {
    await t.tracker.commands.pause()
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 0)
    assert.equal(t.storage.get('paused'), true)
    await t.tracker.commands.resume()
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 1)
    assert.equal(t.notifications.length, 2)
  } finally {
    await t.cleanup()
  }
})

test('нет активного worktree — heartbeat не отправляется', async () => {
  const t = await setup()
  try {
    t.state.worktrees = t.state.worktrees.map((w) => ({ ...w, isActive: false }))
    await t.tracker.tick()
    assert.equal(t.heartbeats.length, 0)
  } finally {
    await t.cleanup()
  }
})

test('команда «сегодня» показывает ответ wakatime-cli', async () => {
  const t = await setup()
  try {
    const result = await t.tracker.commands.today()
    assert.equal(result.text, '1 hr 5 mins')
    assert.equal(t.notifications[0].body, '1 hr 5 mins')
  } finally {
    await t.cleanup()
  }
})

test('зависший пробник не останавливает учёт навсегда', async () => {
  let calls = 0
  const t = await setup({ probe: { sample: () => (calls++ === 0 ? new Promise(() => {}) : Promise.resolve({ focused: true, idleMs: 10 })), dispose() {} } })
  try {
    await t.tracker.tick() // первый опрос упирается в таймаут пробника и завершается
    await t.tracker.tick()
    assert.ok(t.heartbeats.length >= 1)
  } finally {
    await t.cleanup()
  }
})

test('сохранение перед уходом из Orca засчитывается при возвращении', async () => {
  const t = await setup()
  try {
    const file = join(t.dir, 'late.ts')
    await writeFile(file, 'a\n')
    const wt = t.state.snapshot.worktree
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, true)] }
    await t.tracker.tick()
    // Сохранили и ушли: пока Orca в фоне, опросы пропускаются.
    await writeFile(file, 'b\n')
    t.state.snapshot = { worktree: wt, activeTabId: 'f', tabs: [fileTab(file, false)] }
    t.state.probe = { focused: false, idleMs: 100 }
    await t.tracker.tick()
    assert.equal(t.heartbeats.filter((h) => h.isWrite).length, 0)
    // Вернулись спустя долгое время — сохранение всё равно найдено.
    t.state.probe = { focused: true, idleMs: 100 }
    await t.tracker.tick()
    assert.equal(t.heartbeats.filter((h) => h.isWrite).length, 1)
  } finally {
    await t.cleanup()
  }
})

test('markdown с превью: одно сохранение — один write-heartbeat', async () => {
  const t = await setup()
  try {
    const file = join(t.dir, 'README.md')
    await writeFile(file, '# a\n')
    const wt = t.state.snapshot.worktree
    const tabs = (dirty) => [
      { type: 'markdown', id: 'edit', filePath: file, isDirty: dirty, isActive: true, mode: 'edit' },
      { type: 'markdown', id: 'preview', filePath: file, isDirty: dirty, isActive: false, mode: 'markdown-preview' }
    ]
    t.state.snapshot = { worktree: wt, activeTabId: 'edit', tabs: tabs(false) }
    await t.tracker.tick()
    t.state.snapshot = { worktree: wt, activeTabId: 'edit', tabs: tabs(true) }
    await t.tracker.tick()
    await writeFile(file, '# b\n')
    t.state.snapshot = { worktree: wt, activeTabId: 'edit', tabs: tabs(false) }
    await t.tracker.tick()
    const writes = t.heartbeats.filter((h) => h.isWrite)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].humanLineChanges, 2)
  } finally {
    await t.cleanup()
  }
})

test('при выключении неотправленные heartbeat\'ы сохраняются и уходят при следующем запуске', async () => {
  const queued = [{ entity: 'C:/x.ts', entityType: 'file', time: 1792000000, isWrite: true }]
  const t = await setup({
    runner: (sent) => ({
      sendHeartbeat: (hb) => sent.push(hb),
      syncAiActivity: () => {},
      today: async () => ({ code: 0, text: '' }),
      whenIdle: async () => {},
      takeQueuedHeartbeats: () => queued.splice(0)
    })
  })
  try {
    await t.tracker.stop()
    assert.deepEqual(t.storage.get('pendingHeartbeats'), [{ entity: 'C:/x.ts', entityType: 'file', time: 1792000000, isWrite: true }])
  } finally {
    await t.cleanup()
  }
  // Новый воркер с тем же storage отправляет сохранённое.
  const next = await setup()
  try {
    next.storage.set('pendingHeartbeats', t.storage.get('pendingHeartbeats'))
    // Без сети и без установки в настоящий ~/.wakatime: обновление CLI уже «проверено».
    next.storage.set('cliCheckedAt', Date.now())
    await next.tracker.start()
    assert.equal(next.heartbeats.some((h) => h.entity === 'C:/x.ts' && h.isWrite), true)
    assert.deepEqual(next.storage.get('pendingHeartbeats'), [])
  } finally {
    await next.cleanup()
  }
})
