import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEARTBEAT_INTERVAL_MS,
  activityKey,
  collectFileTabs,
  countChangedLines,
  createHeartbeatGate,
  describeActivity,
  detectNewEdits,
  detectSaves,
  domainOf,
  findActiveTab,
  findSnapshot,
  isLocalDomain,
  pickActiveWorktree,
  stripBranchRef
} from '../src/activity.mjs'

const WT_ID = 'repo-1::C:/work/app'
const worktree = {
  worktreeId: WT_ID,
  hostId: 'local',
  repo: 'app',
  path: 'C:/work/app',
  branch: 'refs/heads/feat/x',
  isActive: true,
  status: 'active'
}

const terminalTab = (extra = {}) => ({
  type: 'terminal',
  id: 'tab-1::leaf-1',
  parentTabId: 'tab-1',
  leafId: 'leaf-1',
  isActive: false,
  ...extra
})
const fileTab = (extra = {}) => ({
  type: 'file',
  id: 'file-1',
  filePath: 'C:\\work\\app\\src\\main.ts',
  relativePath: 'src/main.ts',
  language: 'typescript',
  mode: 'edit',
  isDirty: false,
  isActive: false,
  ...extra
})

test('pickActiveWorktree возвращает worktree в фокусе', () => {
  const ps = { worktrees: [{ ...worktree, isActive: false, worktreeId: 'other', path: 'C:/x' }, worktree] }
  assert.equal(pickActiveWorktree(ps), ps.worktrees[1])
  assert.equal(pickActiveWorktree({ worktrees: [] }), null)
  assert.equal(pickActiveWorktree(null), null)
})

test('findSnapshot ищет снимок по id worktree', () => {
  const tabs = { snapshots: [{ worktree: 'a' }, { worktree: WT_ID, tabs: [] }] }
  assert.equal(findSnapshot(tabs, WT_ID), tabs.snapshots[1])
  assert.equal(findSnapshot(tabs, 'missing'), null)
  assert.equal(findSnapshot(tabs, undefined), null)
})

test('findActiveTab: сначала activeTabId, затем isActive нужного типа', () => {
  const snapshot = {
    activeTabId: 'file-1',
    activeTabType: 'file',
    tabs: [terminalTab({ isActive: true }), fileTab({ isActive: true })]
  }
  assert.equal(findActiveTab(snapshot).id, 'file-1')
  const noId = { activeTabType: 'terminal', tabs: [fileTab({ isActive: true }), terminalTab({ isActive: true })] }
  assert.equal(findActiveTab(noId).type, 'terminal')
  assert.equal(findActiveTab({ tabs: [] }), null)
})

test('describeActivity: открытый файл → file-heartbeat с папкой проекта', () => {
  const snapshot = { activeTabId: 'file-1', tabs: [terminalTab(), fileTab({ isActive: true })] }
  const activity = describeActivity(worktree, snapshot)
  assert.equal(activity.kind, 'file')
  assert.equal(activity.entity, 'C:\\work\\app\\src\\main.ts')
  assert.equal(activity.entityType, 'file')
  assert.equal(activity.category, 'coding')
  assert.equal(activity.projectFolder, 'C:/work/app')
})

test('describeActivity: просмотр диффа → code reviewing', () => {
  const snapshot = { activeTabId: 'file-1', tabs: [fileTab({ isActive: true, mode: 'diff' })] }
  assert.equal(describeActivity(worktree, snapshot).category, 'code reviewing')
})

test('describeActivity: markdown-вкладка считается файлом', () => {
  const md = { type: 'markdown', id: 'md', filePath: 'C:/work/app/README.md', mode: 'edit', isActive: true, isDirty: false }
  const activity = describeActivity(worktree, { activeTabId: 'md', tabs: [md] })
  assert.equal(activity.kind, 'file')
  assert.equal(activity.entity, 'C:/work/app/README.md')
})

test('describeActivity: терминал → app-heartbeat, ai coding пока агент работает', () => {
  const idle = describeActivity(worktree, { activeTabId: 'tab-1::leaf-1', tabs: [terminalTab({ isActive: true })] })
  assert.deepEqual(
    { kind: idle.kind, entity: idle.entity, entityType: idle.entityType, category: idle.category },
    { kind: 'terminal', entity: 'Orca Terminal', entityType: 'app', category: 'coding' }
  )
  const working = describeActivity(worktree, {
    activeTabId: 'tab-1::leaf-1',
    tabs: [terminalTab({ isActive: true, agentStatus: { state: 'working' } })]
  })
  assert.equal(working.category, 'ai coding')
  assert.equal(describeActivity({ ...worktree, status: 'working' }, null).category, 'ai coding')
})

test('describeActivity: браузер → домен; localhost — manual testing', () => {
  const browser = (url) => ({ type: 'browser', id: 'b', url, isActive: true })
  const local = describeActivity(worktree, { activeTabId: 'b', tabs: [browser('http://localhost:3000/plan')] })
  assert.deepEqual([local.entityType, local.entity, local.category], ['domain', 'localhost', 'manual testing'])
  const web = describeActivity(worktree, { activeTabId: 'b', tabs: [browser('https://nuxt.com/docs?q=1')] })
  assert.deepEqual([web.entity, web.category], ['nuxt.com', 'browsing'])
  const blank = describeActivity(worktree, { activeTabId: 'b', tabs: [browser('about:blank')] })
  assert.equal(blank.kind, 'workspace')
})

test('describeActivity: нативная сессия агента → ai coding', () => {
  const tab = { type: 'agent-session', id: 'a', isActive: true }
  assert.equal(describeActivity(worktree, { activeTabId: 'a', tabs: [tab] }).category, 'ai coding')
})

test('describeActivity: пустой worktree всё равно даёт время проекту', () => {
  const activity = describeActivity(worktree, { tabs: [] })
  assert.equal(activity.kind, 'workspace')
  assert.equal(activity.projectFolder, 'C:/work/app')
})

test('describeActivity: удалённый worktree — проект и ветка явно, без чтения файла', () => {
  const remote = { ...worktree, hostId: 'ssh-1', repo: 'server-app' }
  const activity = describeActivity(remote, { activeTabId: 'file-1', tabs: [fileTab({ isActive: true })] })
  assert.equal(activity.kind, 'remote-file')
  assert.equal(activity.entity, 'src/main.ts')
  assert.equal(activity.isUnsavedEntity, true)
  assert.equal(activity.project, 'server-app')
  assert.equal(activity.alternateBranch, 'feat/x')
  assert.equal(activity.projectFolder, undefined)
})

test('describeActivity: нет worktree — нечего трекать', () => {
  assert.equal(describeActivity(null, null), null)
})

test('activityKey различает объект, категорию и проект', () => {
  const a = { entityType: 'app', entity: 'Orca Terminal', category: 'coding', projectFolder: 'C:/a' }
  assert.notEqual(activityKey(a), activityKey({ ...a, category: 'ai coding' }))
  assert.notEqual(activityKey(a), activityKey({ ...a, projectFolder: 'C:/b' }))
  assert.equal(activityKey(a), activityKey({ ...a }))
  assert.equal(activityKey(null), null)
})

test('createHeartbeatGate: смена объекта, 2 минуты и сохранение', () => {
  const gate = createHeartbeatGate()
  const t0 = 1_000_000
  assert.equal(gate.shouldSend('a', t0), true)
  gate.markSent('a', t0)
  assert.equal(gate.shouldSend('a', t0 + 5000), false)
  assert.equal(gate.shouldSend('a', t0 + HEARTBEAT_INTERVAL_MS - 1), false)
  assert.equal(gate.shouldSend('a', t0 + HEARTBEAT_INTERVAL_MS), true)
  assert.equal(gate.shouldSend('b', t0 + 5000), true)
  assert.equal(gate.shouldSend('a', t0 + 5000, true), true)
  assert.equal(gate.shouldSend(null, t0 + 5000, true), false)
  gate.reset()
  assert.equal(gate.shouldSend('a', t0 + 5000), true)
})

test('collectFileTabs берёт файлы только локальных worktree', () => {
  const ps = { worktrees: [worktree, { ...worktree, worktreeId: 'remote', hostId: 'ssh-1', path: '/srv' }] }
  const tabs = {
    snapshots: [
      { worktree: WT_ID, tabs: [terminalTab(), fileTab({ isDirty: true })] },
      { worktree: 'remote', tabs: [fileTab({ id: 'r' })] },
      { worktree: 'unknown', tabs: [fileTab({ id: 'u' })] }
    ]
  }
  const files = collectFileTabs(tabs, ps)
  assert.equal(files.size, 1)
  const [entry] = files.values()
  assert.deepEqual(entry, { filePath: 'C:\\work\\app\\src\\main.ts', isDirty: true, projectFolder: 'C:/work/app' })
})

test('detectSaves: dirty → clean по тому же пути', () => {
  const before = new Map([
    ['k1', { filePath: 'a', isDirty: true }],
    ['k2', { filePath: 'b', isDirty: true }],
    ['k3', { filePath: 'c', isDirty: false }],
    ['k4', { filePath: 'd', isDirty: true }]
  ])
  const after = new Map([
    ['k1', { filePath: 'a', isDirty: false }],
    ['k2', { filePath: 'b', isDirty: true }],
    ['k3', { filePath: 'c', isDirty: false }],
    ['k4', { filePath: 'renamed', isDirty: false }]
  ])
  // 'd' пропал (вкладку закрыли или переименовали) — кандидат, mtime проверит трекер.
  const saves = detectSaves(before, after)
  assert.deepEqual(saves.map((s) => [s.filePath, Boolean(s.closed)]), [['a', false], ['d', true]])
  assert.deepEqual(detectSaves(new Map(), after), [])
})

test('detectNewEdits: вкладка стала dirty', () => {
  const before = new Map([['k1', { filePath: 'a', isDirty: false }], ['k2', { filePath: 'b', isDirty: true }]])
  const after = new Map([
    ['k1', { filePath: 'a', isDirty: true }],
    ['k2', { filePath: 'b', isDirty: true }],
    ['k3', { filePath: 'c', isDirty: true }]
  ])
  assert.deepEqual(detectNewEdits(before, after).map((e) => e.filePath), ['a', 'c'])
})

test('domainOf и isLocalDomain', () => {
  assert.equal(domainOf('https://github.com/a/b'), 'github.com')
  assert.equal(domainOf('file:///C:/x.html'), null)
  assert.equal(domainOf('not a url'), null)
  assert.equal(domainOf(undefined), null)
  assert.equal(isLocalDomain('127.0.0.1'), true)
  assert.equal(isLocalDomain('app.localhost'), true)
  assert.equal(isLocalDomain('printer.local'), true)
  assert.equal(isLocalDomain('example.com'), false)
})

test('stripBranchRef', () => {
  assert.equal(stripBranchRef('refs/heads/feat/PLA-1/x'), 'feat/PLA-1/x')
  assert.equal(stripBranchRef('main'), 'main')
  assert.equal(stripBranchRef(null), '')
})

test('countChangedLines: добавленные + удалённые строки, как git numstat', () => {
  assert.equal(countChangedLines('a\nb\nc', 'a\nb\nc'), 0)
  assert.equal(countChangedLines('a\nb\nc', 'a\nB\nc'), 2)
  assert.equal(countChangedLines('a\nc', 'a\nb1\nb2\nc'), 2)
  assert.equal(countChangedLines('a\nb1\nb2\nb3\nc', 'a\nc'), 3)
  assert.equal(countChangedLines('a\r\nb\r\n', 'a\nb\n'), 0)
  assert.equal(countChangedLines('', 'x\ny'), 2)
  assert.equal(countChangedLines('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n'), 3)
  assert.equal(countChangedLines('a\nb\nc\nd', 'a\nX\nc\nY'), 4)
  // Слишком большая середина — без LCS, считаем всё изменённым.
  assert.equal(countChangedLines('x\n'.repeat(3000), 'y\n'.repeat(3000)), 6000)
})

test('один файл в нескольких вкладках (редактор + превью) — одно сохранение и одна правка', () => {
  const tabs = (dirty) =>
    new Map([
      ['edit', { filePath: 'README.md', isDirty: dirty }],
      ['preview', { filePath: 'README.md', isDirty: dirty }]
    ])
  assert.equal(detectNewEdits(tabs(false), tabs(true)).length, 1)
  assert.equal(detectSaves(tabs(true), tabs(false)).length, 1)
  // Файл остаётся грязным, пока грязна хоть одна вкладка.
  const partly = new Map([
    ['edit', { filePath: 'README.md', isDirty: false }],
    ['preview', { filePath: 'README.md', isDirty: true }]
  ])
  assert.equal(detectSaves(tabs(true), partly).length, 0)
})

test('pickActiveWorktree: при нескольких активных хостах — локальный с активной вкладкой', () => {
  const local = { worktreeId: 'l', hostId: 'local', path: 'C:/l', isActive: true }
  const remote = { worktreeId: 'r', hostId: 'ssh-1', path: '/r', isActive: true }
  const tabs = { snapshots: [{ worktree: 'r', activeTabId: 'x' }, { worktree: 'l', activeTabId: 'y' }] }
  assert.equal(pickActiveWorktree({ worktrees: [remote, local] }, tabs), local)
  const localNoTab = { ...local, worktreeId: 'l2' }
  assert.equal(pickActiveWorktree({ worktrees: [remote, localNoTab, local] }, tabs), local)
})
