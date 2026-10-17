// Оркестрация: раз в TICK_MS опрашиваем фокус/ввод и состояние вкладок Orca,
// решаем по правилам WakaTime, что отправить, и кормим очередь wakatime-cli.

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import {
  activityKey,
  collectFileTabs,
  countChangedLines,
  createHeartbeatGate,
  describeActivity,
  detectNewEdits,
  detectSaves,
  findSnapshot,
  pickActiveWorktree
} from './activity.mjs'
import { createFocusProbe } from './focus-probe.mjs'
import { createRuntimeClient } from './runtime-client.mjs'
import { readWakatimeConfig } from './wakatime-config.mjs'
import { createTranslator } from './i18n.mjs'
import {
  EXIT,
  compareVersions,
  createCliRunner,
  fetchLatestCliTag,
  getCliVersion,
  installCli,
  locateCli
} from './wakatime-cli.mjs'

export const TICK_MS = 5000
const KEEPALIVE_MS = 60_000
const AI_SYNC_DEBOUNCE_MS = 15_000
const AI_SYNC_MIN_INTERVAL_MS = 2 * 60_000
const AI_SYNC_WHILE_WORKING_MS = 10 * 60_000
const CLI_UPDATE_INTERVAL_MS = 24 * 60 * 60_000
const CLI_RETRY_MS = 10 * 60_000
// Запас на расхождение mtime и момента опроса, когда вкладку видели «грязной».
const SAVE_MTIME_SLACK_MS = 2000
const PROBE_TIMEOUT_MS = 4000
const RPC_WORKTREE_LIMIT = 1000
const AGENT_STALE_MS = 30 * 60_000
const CLI_FAILED_RETRY_MS = 6 * 60 * 60_000
const SHUTDOWN_WAIT_MS = 1200
// Команда, вызванная сразу после запуска воркера, ждёт конца старта, но укладывается в 30 с Orca.
const COMMAND_STARTUP_WAIT_MS = 6000
const PENDING_STORAGE_KEY = 'pendingHeartbeats'
const PENDING_MAX = 200
const MAX_BASELINE_BYTES = 2 * 1024 * 1024
const ERROR_LOG_THROTTLE_MS = 5 * 60_000
const DASHBOARD_URL = 'https://wakatime.com/dashboard'

function formatTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toTimeString().slice(0, 8)
}

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function openUrl(url) {
  const [file, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (error) => resolve(!error))
  })
}

export function createTracker(orca, { pluginVersion, deps = {} } = {}) {
  const rpc = deps.rpc ?? createRuntimeClient({ log: (m) => debugLog(m) })
  const probe = deps.probe ?? createFocusProbe({ log: (m) => logThrottled('probe', m) })
  const gate = createHeartbeatGate()
  const { t, setLocale } = createTranslator('en')

  let debug = false
  let paused = false
  let stopped = false
  let ticking = false
  let lastTickAt = 0
  let lastActivityKey = null
  let previousFileTabs = new Map()
  let fileTabsInitialized = false
  // По пути файла: исходный текст на момент «стал грязным» и когда его последний раз видели грязным.
  const baselines = new Map()
  const lastSeenDirtyAt = new Map()
  const timers = []

  let orcaVersion = null
  let cliPath = null
  let cliVersion = null
  let cliReady = null
  let preparing = false
  let lastPrepareAt = 0
  let configState = { exists: false, hasApiKey: false }

  const workingAgents = new Map()
  let aiSyncTimer = null
  let lastCliRunAt = 0

  const stats = {
    heartbeats: 0,
    lastHeartbeatAt: 0,
    lastEntity: null,
    lastWasWrite: false,
    lastCliCode: null,
    lastProbe: { focused: null, idleMs: null },
    runtimeOk: null
  }
  const notified = new Set()
  const lastErrorLogAt = new Map()

  function log(message) {
    orca.log(`[wakatime] ${message}`)
  }

  function debugLog(message) {
    if (debug) log(message)
  }

  function logThrottled(key, message) {
    const now = Date.now()
    if (now - (lastErrorLogAt.get(key) ?? 0) < ERROR_LOG_THROTTLE_MS) return
    lastErrorLogAt.set(key, now)
    log(message)
  }

  async function notify(title, body) {
    try {
      await orca.host.call('notifications.show', { title: title.slice(0, 120), body: body?.slice(0, 1000) })
    } catch (error) {
      log(`notification failed: ${error?.message ?? error}`)
    }
  }

  function notifyOnce(key, title, body) {
    if (notified.has(key)) return
    notified.add(key)
    void notify(title, body)
  }

  async function storageGet(key) {
    try {
      const result = await orca.host.call('storage.get', { key })
      return result?.value ?? null
    } catch {
      return null
    }
  }

  async function storageSet(key, value) {
    try {
      await orca.host.call('storage.set', { key, value })
    } catch (error) {
      log(`failed to save ${key}: ${error?.message ?? error}`)
    }
  }

  function pluginString() {
    return `orca/${orcaVersion ?? '0.0.0'} orca-wakatime/${pluginVersion}`
  }

  // ---------- wakatime-cli ----------

  async function prepareCli(options) {
    preparing = true
    try {
      return await prepareCliUnguarded(options)
    } finally {
      preparing = false
    }
  }

  async function prepareCliUnguarded({ forceCheck = false } = {}) {
    lastPrepareAt = Date.now()
    cliPath = await locateCli()
    const checkedAt = Number(await storageGet('cliCheckedAt')) || 0
    if (!cliPath || forceCheck || Date.now() - checkedAt > CLI_UPDATE_INTERVAL_MS) {
      try {
        const latest = await fetchLatestCliTag()
        const current = cliPath ? await getCliVersion(cliPath) : null
        if (!current || compareVersions(latest, current) > 0) {
          log(current ? `updating wakatime-cli ${current} → ${latest}` : `installing wakatime-cli ${latest}`)
          cliPath = await installCli({ tag: latest })
        }
        await storageSet('cliCheckedAt', Date.now())
      } catch (error) {
        // Обновление не критично: если старый бинарник есть — работаем на нём.
        log(`wakatime-cli update check failed: ${error?.message ?? error}`)
        // Не качаем заново при каждом старте воркера: следующая попытка — через несколько часов.
        if (cliPath) await storageSet('cliCheckedAt', Date.now() - CLI_UPDATE_INTERVAL_MS + CLI_FAILED_RETRY_MS)
        if (!cliPath) {
          notifyOnce('cli-missing', t('cli-missing.title'), t('cli-missing.body'))
        }
      }
    }
    cliVersion = cliPath ? await getCliVersion(cliPath) : null
    debugLog(`wakatime-cli: ${cliPath ?? 'not found'} ${cliVersion ?? ''}`)
    return cliPath
  }

  const runner =
    deps.runner ??
    createCliRunner({
      getCliPath: async () => {
        if (cliReady) await cliReady
        if (!cliPath && Date.now() - lastPrepareAt > CLI_RETRY_MS) {
          cliReady = prepareCli()
          await cliReady
        }
        return cliPath
      },
      pluginString,
      log,
      onResult: ({ job, code, reason }) => {
        lastCliRunAt = Date.now()
        stats.lastCliCode = code
        if (reason === 'cli-gone') {
          cliPath = null
          lastPrepareAt = 0
        }
        if (reason) return
        if (code === EXIT.AUTH) {
          notifyOnce('auth', t('auth.title'), t('auth.body'))
        } else if (code === EXIT.CONFIG_PARSE || code === EXIT.CONFIG_READ) {
          notifyOnce('config', t('config.title'), t('config.body'))
        }
        if (job.type === 'heartbeat' && (code === EXIT.SUCCESS || code === EXIT.API_ERROR || code === EXIT.BACKOFF)) {
          // 102/112 — нет сети или бэкофф: heartbeat сохранён в офлайн-очередь wakatime-cli.
          stats.heartbeats += 1
        }
      }
    })

  // ---------- heartbeats ----------

  function emit(activity, now, isWrite = false) {
    const key = activityKey(activity)
    if (!gate.shouldSend(key, now, isWrite)) return
    gate.markSent(key, now)
    const heartbeat = {
      entity: activity.entity,
      entityType: activity.entityType,
      category: activity.category,
      time: now / 1000,
      isWrite,
      projectFolder: activity.projectFolder,
      project: activity.project,
      alternateBranch: activity.alternateBranch,
      language: activity.language,
      humanLineChanges: activity.humanLineChanges,
      isUnsavedEntity: activity.isUnsavedEntity || (activity.entityType === 'file' && activity.kind === 'file' && !existsSync(activity.entity))
    }
    stats.lastHeartbeatAt = now
    stats.lastEntity = activity.entity
    stats.lastWasWrite = isWrite
    debugLog(`heartbeat ${heartbeat.category} ${heartbeat.entityType}:${heartbeat.entity}${isWrite ? ' write' : ''}`)
    runner.sendHeartbeat(heartbeat)
  }

  async function readSmallFile(filePath) {
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size > MAX_BASELINE_BYTES) return null
      return await readFile(filePath, 'utf8')
    } catch {
      return null
    }
  }

  /** Файл записан на диск после того, как его последний раз видели несохранённым. */
  async function writtenSince(filePath, since) {
    try {
      const info = await stat(filePath)
      return info.mtimeMs >= since - SAVE_MTIME_SLACK_MS
    } catch {
      return false
    }
  }

  function resetFileState() {
    previousFileTabs = new Map()
    fileTabsInitialized = false
    baselines.clear()
    lastSeenDirtyAt.clear()
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      const now = Date.now()
      const elapsed = lastTickAt ? now - lastTickAt : TICK_MS
      lastTickAt = now
      if (paused) return

      // Пробник не должен подвесить цикл опроса, что бы ни случилось с ОС-утилитами.
      const sample = await Promise.race([
        probe.sample().catch(() => ({ focused: null, idleMs: null })),
        delay(PROBE_TIMEOUT_MS, { focused: null, idleMs: null })
      ])
      stats.lastProbe = sample
      const probeKnown = sample.focused !== null && sample.idleMs !== null
      const inputSinceLastTick = sample.idleMs !== null && sample.idleMs <= elapsed + 1000
      // Orca в фоне — пользователь в ней ничего не делает. Сохранения, сделанные перед уходом,
      // поймаем при возвращении: окно сравнения mtime привязано к последнему опросу, а не к «сейчас».
      if (probeKnown && !sample.focused) return

      const [ps, tabs] = await Promise.all([
        rpc.call('worktree.ps', { limit: RPC_WORKTREE_LIMIT }),
        rpc.call('session.tabs.listAll', null)
      ])
      stats.runtimeOk = true

      const fileTabs = collectFileTabs(tabs, ps)
      const firstPoll = !fileTabsInitialized
      fileTabsInitialized = true
      const saves = detectSaves(previousFileTabs, fileTabs)
      const edits = detectNewEdits(previousFileTabs, fileTabs)
      previousFileTabs = fileTabs

      // Буфер редактора Orca правит только человек (агенты пишут прямо на диск), поэтому
      // строки, изменённые между «стал грязным» и «сохранён», — это human line changes.
      for (const edit of edits) {
        const baseline = await readSmallFile(edit.filePath)
        if (baseline !== null) baselines.set(edit.filePath, baseline)
      }
      let savedCount = 0
      for (const save of saves) {
        const baseline = baselines.get(save.filePath)
        baselines.delete(save.filePath)
        const dirtySeenAt = lastSeenDirtyAt.get(save.filePath) ?? now
        lastSeenDirtyAt.delete(save.filePath)
        // Без записи на диск — это «отменить изменения» или закрытие без сохранения.
        if (!(await writtenSince(save.filePath, dirtySeenAt))) continue
        savedCount += 1
        const saved = baseline === undefined ? null : await readSmallFile(save.filePath)
        emit(
          {
            kind: 'file',
            entity: save.filePath,
            entityType: 'file',
            category: 'coding',
            projectFolder: save.projectFolder,
            humanLineChanges: saved === null ? undefined : countChangedLines(baseline, saved)
          },
          now,
          true
        )
      }
      const dirtyNow = new Set()
      for (const tab of fileTabs.values()) if (tab.isDirty) dirtyNow.add(tab.filePath)
      for (const filePath of dirtyNow) lastSeenDirtyAt.set(filePath, now)
      for (const filePath of [...baselines.keys()]) if (!dirtyNow.has(filePath)) baselines.delete(filePath)
      for (const filePath of [...lastSeenDirtyAt.keys()]) if (!dirtyNow.has(filePath)) lastSeenDirtyAt.delete(filePath)

      const worktree = pickActiveWorktree(ps, tabs)
      const activity = describeActivity(worktree, findSnapshot(tabs, worktree?.worktreeId))
      // Смена объекта без учёта категории: агент, начавший или закончивший работу,
      // не должен сам по себе засчитывать время в запасном режиме.
      const changeKey = activity ? activityKey({ ...activity, category: '' }) : null
      const changed = !firstPoll && changeKey !== lastActivityKey
      lastActivityKey = changeKey

      const userActive = probeKnown
        ? sample.focused && inputSinceLastTick
        : changed || (!firstPoll && edits.length > 0) || savedCount > 0
      if (activity && userActive) emit(activity, now)
    } catch (error) {
      stats.runtimeOk = false
      logThrottled('tick', `polling Orca failed: ${error?.message ?? error}`)
    } finally {
      ticking = false
    }
  }

  // ---------- AI-агенты ----------

  function scheduleAiSync(delay = AI_SYNC_DEBOUNCE_MS) {
    if (aiSyncTimer) clearTimeout(aiSyncTimer)
    aiSyncTimer = setTimeout(() => {
      aiSyncTimer = null
      if (stopped || paused) return
      const sinceLastRun = Date.now() - lastCliRunAt
      if (sinceLastRun < AI_SYNC_MIN_INTERVAL_MS) {
        // Любой запуск wakatime-cli и так разбирает логи агентов — ждём интервал.
        scheduleAiSync(AI_SYNC_MIN_INTERVAL_MS - sinceLastRun)
        return
      }
      debugLog('syncing AI agent activity')
      runner.syncAiActivity()
    }, delay)
  }

  function onAgentStatus(payload) {
    if (!payload || typeof payload.paneKey !== 'string') return
    if (payload.state === 'working') {
      workingAgents.set(payload.paneKey, Date.now())
      return
    }
    if (workingAgents.delete(payload.paneKey)) scheduleAiSync()
  }

  function syncWhileAgentsWork() {
    // Панель могли закрыть без финального статуса — не синхронизируем вечно.
    const now = Date.now()
    for (const [paneKey, since] of workingAgents) if (now - since > AGENT_STALE_MS) workingAgents.delete(paneKey)
    if (paused || workingAgents.size === 0) return
    if (Date.now() - lastCliRunAt >= AI_SYNC_WHILE_WORKING_MS) scheduleAiSync(0)
  }

  // ---------- жизненный цикл ----------

  let startup = null

  function start() {
    startup ??= startUnguarded()
    return startup
  }

  async function waitForStartup() {
    if (startup) await Promise.race([startup.catch(() => {}), delay(COMMAND_STARTUP_WAIT_MS)])
  }

  async function startUnguarded() {
    paused = (await storageGet('paused')) === true
    configState = await readWakatimeConfig()
    debug = configState.debug
    // Язык уведомлений — язык интерфейса ОС (Intl в воркере Electron всегда en-US).
    setLocale(await Promise.race([probe.locale?.().catch(() => null) ?? null, delay(PROBE_TIMEOUT_MS * 4, null)]))
    if (!configState.hasApiKey) notifyOnce('no-key', t('no-key.title'), t('no-key.body'))
    try {
      orcaVersion = (await rpc.call('status.get', null))?.appVersion ?? null
      stats.runtimeOk = true
    } catch (error) {
      stats.runtimeOk = false
      log(`Orca runtime unavailable: ${error?.message ?? error}`)
    }
    if (stopped) return
    // Heartbeat'ы, пойманные до готовности CLI, подождут в очереди (getCliPath ждёт cliReady).
    cliReady = prepareCli()
    timers.push(setInterval(() => void tick(), TICK_MS))
    timers.push(setInterval(() => void orca.host.call('workspace.readContext').catch(() => {}), KEEPALIVE_MS))
    timers.push(setInterval(syncWhileAgentsWork, 60_000))
    timers.push(
      setInterval(() => {
        cliReady = prepareCli()
      }, CLI_UPDATE_INTERVAL_MS)
    )
    await replayPendingHeartbeats()
    await cliReady
    log(`started: ${pluginString()}, wakatime-cli ${cliVersion ?? 'not found'}${paused ? ', paused' : ''}`)
    // Догоняем время агентов, накопившееся, пока воркер не работал.
    scheduleAiSync(5000)
  }

  /** Heartbeat'ы, не успевшие уйти до выключения воркера прошлый раз. */
  async function replayPendingHeartbeats() {
    const pending = await storageGet(PENDING_STORAGE_KEY)
    if (!Array.isArray(pending) || pending.length === 0) return
    await storageSet(PENDING_STORAGE_KEY, [])
    log(`sending ${pending.length} heartbeat(s) saved at last shutdown`)
    for (const heartbeat of pending) {
      if (heartbeat && typeof heartbeat.entity === 'string' && typeof heartbeat.time === 'number') {
        runner.sendHeartbeat(heartbeat)
      }
    }
  }

  async function stop() {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    if (aiSyncTimer) clearTimeout(aiSyncTimer)
    probe.dispose()
    // Orca даёт воркеру 2 с на выход, потом SIGKILL: ждём недолго, остаток сохраняем.
    await runner.whenIdle(SHUTDOWN_WAIT_MS)
    const left = runner.takeQueuedHeartbeats?.() ?? []
    if (left.length > 0) {
      const previous = (await storageGet(PENDING_STORAGE_KEY)) ?? []
      await storageSet(PENDING_STORAGE_KEY, [...(Array.isArray(previous) ? previous : []), ...left].slice(-PENDING_MAX))
    }
  }

  async function setPaused(value) {
    paused = value
    gate.reset()
    lastActivityKey = null
    // Пока стояла пауза, вкладки не опрашивались — старое состояние не годится для сравнения.
    resetFileState()
    await storageSet('paused', value)
    await notify('WakaTime', value ? t('paused') : t('resumed'))
    return { paused }
  }

  function statusText() {
    const probeState =
      stats.lastProbe.focused === null
        ? t('status.probeUnavailable')
        : t(stats.lastProbe.focused ? 'status.probeFocused' : 'status.probeBackground')
    const runtime = stats.runtimeOk === false ? t('status.error') : stats.runtimeOk ? t('status.ok') : '—'
    const last = stats.lastEntity
      ? `${formatTime(stats.lastHeartbeatAt)} — ${stats.lastEntity}${stats.lastWasWrite ? t('status.saved') : ''}`
      : '—'
    return [
      t('status.tracking', { value: t(paused ? 'status.paused' : 'status.active') }),
      t('status.cli', { value: cliVersion ?? t('status.notFound') }),
      t('status.apiKey', { value: t(configState.hasApiKey ? 'status.yes' : 'status.no') }),
      t('status.probe', { value: probeState }),
      t('status.runtime', { value: runtime }),
      t('status.heartbeats', { value: stats.heartbeats }),
      t('status.last', { value: last })
    ].join('\n')
  }

  return {
    start,
    stop,
    tick,
    onAgentStatus,
    commands: {
      async status() {
        await waitForStartup()
        const text = statusText()
        await notify(t('status.title'), text)
        return { text }
      },
      async today() {
        await waitForStartup()
        if (preparing) {
          await notify(t('today.title'), t('today.preparing'))
          return { text: null }
        }
        const { code, text } = await runner.today()
        const body = text ?? (code === null ? t('today.noCli') : t('today.code', { value: code }))
        await notify(t('today.title'), body)
        return { text: body }
      },
      async dashboard() {
        const opened = await openUrl(DASHBOARD_URL)
        if (!opened) await notify('WakaTime', DASHBOARD_URL)
        return { opened }
      },
      pause: () => setPaused(true),
      resume: () => setPaused(false)
    },
    get stats() {
      return { ...stats, paused, cliPath, cliVersion, orcaVersion }
    }
  }
}
