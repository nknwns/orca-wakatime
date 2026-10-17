// Поиск, установка/обновление и запуск wakatime-cli по гайду WakaTime:
// бинарник живёт в ~/.wakatime/wakatime-cli-<os>-<arch>[.exe] и общий для всех плагинов.

import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractFileByPrefix } from './zip.mjs'

const RELEASES_URL = 'https://github.com/wakatime/wakatime-cli/releases'
const CLI_TIMEOUT_SECONDS = 30
const MAX_QUEUE = 100

export const EXIT = {
  SUCCESS: 0,
  API_ERROR: 102,
  CONFIG_PARSE: 103,
  AUTH: 104,
  CONFIG_READ: 110,
  BACKOFF: 112
}

export function cliOsArch(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform
  const archMap = { x64: 'amd64', ia32: '386', arm64: 'arm64', arm: 'arm' }
  return { os, arch: archMap[arch] ?? arch }
}

export function cliBinaryName(platform = process.platform, arch = process.arch) {
  const { os, arch: a } = cliOsArch(platform, arch)
  return `wakatime-cli-${os}-${a}${platform === 'win32' ? '.exe' : ''}`
}

export function resourcesDir(home = homedir()) {
  return join(home, '.wakatime')
}

async function isExecutableFile(path) {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function locateCli({ home = homedir(), platform = process.platform, arch = process.arch } = {}) {
  const dir = resourcesDir(home)
  const candidates = [
    join(dir, cliBinaryName(platform, arch)),
    join(dir, platform === 'win32' ? 'wakatime-cli.exe' : 'wakatime-cli')
  ]
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

// Каждый запуск wakatime-cli заодно разбирает логи AI-агентов. После долгого перерыва
// это минуты (на чистой истории Claude — ~4 мин), поэтому лимит щедрый.
const CLI_PROCESS_TIMEOUT_MS = 10 * 60_000

function runCli(cliPath, args, { input, timeoutMs = CLI_PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cliPath,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let code = 0
        if (error) code = typeof error.code === 'number' ? error.code : -1
        const timedOut = Boolean(error?.killed)
        resolve({ code, timedOut, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
      }
    )
    child.stdin?.on('error', () => {})
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

export async function getCliVersion(cliPath) {
  const result = await runCli(cliPath, ['--version'], { timeoutMs: 15_000 })
  const match = /v?\d+\.\d+\.\d+[^\s]*/.exec(result.stdout)
  return result.code === 0 && match ? (match[0].startsWith('v') ? match[0] : `v${match[0]}`) : null
}

export function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** Тег последнего релиза. Через редирект /releases/latest — без лимитов GitHub API. */
export async function fetchLatestCliTag(fetchImpl = fetch) {
  const response = await fetchImpl(`${RELEASES_URL}/latest`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'orca-wakatime' },
    signal: AbortSignal.timeout(20_000)
  })
  const location = response.headers.get('location') ?? ''
  const match = /\/tag\/([^/?#]+)$/.exec(location)
  if (match) return decodeURIComponent(match[1])
  const api = await fetchImpl('https://api.github.com/repos/wakatime/wakatime-cli/releases/latest', {
    headers: { 'User-Agent': 'orca-wakatime', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!api.ok) throw new Error(`GitHub API: HTTP ${api.status}`)
  const body = await api.json()
  if (typeof body?.tag_name !== 'string') throw new Error('GitHub API: no tag_name')
  return body.tag_name
}

/** Подчищает наши временные файлы прошлых установок (воркер могли убить посреди загрузки). */
async function removeStaleInstallFiles(dir, binaryName) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(`${binaryName}.orca-`)) {
      await rm(join(dir, name), { force: true }).catch(() => {})
    }
  }
}

/**
 * Скачивает релиз и атомарно кладёт бинарник на место. На Windows запущенный exe нельзя
 * перезаписать, но можно переименовать — поэтому старый файл сначала отодвигаем в сторону.
 */
export async function installCli({ tag, home = homedir(), platform = process.platform, arch = process.arch, fetchImpl = fetch }) {
  const { os, arch: a } = cliOsArch(platform, arch)
  const url = `${RELEASES_URL}/download/${encodeURIComponent(tag)}/wakatime-cli-${os}-${a}.zip`
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'orca-wakatime' },
    signal: AbortSignal.timeout(120_000)
  })
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`)
  const zip = Buffer.from(await response.arrayBuffer())
  const { content } = extractFileByPrefix(zip, `wakatime-cli-${os}-${a}`)
  const dir = resourcesDir(home)
  await mkdir(dir, { recursive: true })
  const binaryName = cliBinaryName(platform, arch)
  await removeStaleInstallFiles(dir, binaryName)
  const target = join(dir, binaryName)
  const stamp = `${process.pid}-${Date.now()}`
  const temp = `${target}.orca-${stamp}.tmp`
  const old = `${target}.orca-${stamp}.old`
  let movedOld = false
  try {
    await writeFile(temp, content, { mode: 0o755 })
    if (platform !== 'win32') await chmod(temp, 0o755)
    if (platform === 'win32') {
      try {
        await rename(target, old)
        movedOld = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await rename(temp, target)
  } catch (error) {
    if (movedOld) await rename(old, target).catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  // Если старый exe ещё запущен, удалить не выйдет — подчистим при следующей установке.
  if (movedOld) await rm(old, { force: true }).catch(() => {})
  return target
}

/** Аргументы wakatime-cli для одного heartbeat. */
export function buildHeartbeatArgs(heartbeat, pluginString) {
  const args = [
    // Форма с «=»: путь вида «-foo» не примут за флаг.
    `--entity=${heartbeat.entity}`,
    '--entity-type',
    heartbeat.entityType ?? 'file',
    '--time',
    heartbeat.time.toFixed(3),
    '--plugin',
    pluginString,
    '--timeout',
    String(CLI_TIMEOUT_SECONDS)
  ]
  if (heartbeat.category) args.push('--category', heartbeat.category)
  if (heartbeat.isWrite) args.push('--write')
  if (heartbeat.projectFolder) args.push('--project-folder', heartbeat.projectFolder)
  if (heartbeat.project) args.push('--alternate-project', heartbeat.project)
  if (heartbeat.alternateBranch) args.push('--alternate-branch', heartbeat.alternateBranch)
  if (heartbeat.language) args.push('--alternate-language', heartbeat.language)
  if (heartbeat.isUnsavedEntity) args.push('--is-unsaved-entity')
  if (Number.isInteger(heartbeat.humanLineChanges) && heartbeat.humanLineChanges > 0) {
    args.push('--human-line-changes', String(heartbeat.humanLineChanges))
  }
  return args
}

/**
 * Последовательная очередь вызовов wakatime-cli: одновременно работает один процесс,
 * у каждого heartbeat своё время (--time), так что задержка очереди не искажает учёт.
 *
 * Пачкой (--extra-heartbeats) не отправляем: в extra-heartbeats нет project_folder,
 * и app-heartbeat'ы терминала потеряли бы проект.
 */
export function createCliRunner({ getCliPath, pluginString, log = () => {}, onResult = () => {} }) {
  const queue = []
  let running = false
  let syncPending = false
  let idleWaiters = []

  async function runJob(job) {
    const cliPath = await getCliPath()
    if (!cliPath) {
      onResult({ job, code: null, reason: 'cli-missing' })
      return
    }
    const args = job.type === 'heartbeat' ? buildHeartbeatArgs(job.heartbeat, pluginString()) : job.args(pluginString())
    const result = await runCli(cliPath, args)
    if (result.error?.code === 'ENOENT') {
      // Бинарник удалили или подменили — пусть вызывающий код поищет его заново.
      log('wakatime-cli disappeared from disk')
      onResult({ job, code: null, reason: 'cli-gone' })
      return
    }
    if (result.timedOut) {
      log(`wakatime-cli did not finish in ${CLI_PROCESS_TIMEOUT_MS / 60_000} min and was stopped`)
    } else if (result.code !== EXIT.SUCCESS) {
      const details = (result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)
      log(`wakatime-cli exited with code ${result.code}${details ? `: ${details}` : ''}`)
    }
    onResult({ job, code: result.code, stdout: result.stdout })
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const job = queue.shift()
        try {
          await runJob(job)
        } catch (error) {
          // Необработанный reject убил бы воркер (Orca завершает его на unhandledRejection).
          log(`failed to run wakatime-cli: ${error?.message ?? error}`)
        } finally {
          if (job.type === 'sync-ai') syncPending = false
        }
      }
    } finally {
      running = false
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  function enqueue(job) {
    if (queue.length >= MAX_QUEUE) {
      // Сеть «висит» — не копим бесконечно: выкидываем самый старый не-write heartbeat.
      const index = queue.findIndex((j) => j.type === 'heartbeat' && !j.heartbeat.isWrite)
      const dropped = queue.splice(index === -1 ? 0 : index, 1)[0]
      if (dropped?.type === 'sync-ai') syncPending = false
      log(`queue full, dropped ${dropped?.heartbeat?.entity ?? dropped?.type}`)
    }
    queue.push(job)
    void drain()
  }

  return {
    sendHeartbeat(heartbeat) {
      enqueue({ type: 'heartbeat', heartbeat })
    },
    syncAiActivity() {
      // Любой запуск разбирает логи агентов — второй sync в очереди ничего не добавит.
      if (syncPending) return false
      syncPending = true
      enqueue({ type: 'sync-ai', args: (plugin) => ['--sync-ai-activity', `--plugin=${plugin}`, '--timeout', String(CLI_TIMEOUT_SECONDS)] })
      return true
    },
    async today() {
      const cliPath = await getCliPath()
      if (!cliPath) return { code: null, text: null }
      // Команды Orca обрываются через 30 с — укладываемся раньше.
      const result = await runCli(cliPath, ['--today', `--plugin=${pluginString()}`, '--timeout', '20'], {
        timeoutMs: 25_000
      })
      return { code: result.timedOut ? 'timeout' : result.code, text: result.stdout.trim() || null }
    },
    get pending() {
      return queue.length + (running ? 1 : 0)
    },
    get busy() {
      return running
    },
    /** Забирает ещё не начатые heartbeat'ы (при выключении — чтобы сохранить и отправить позже). */
    takeQueuedHeartbeats() {
      const heartbeats = queue.filter((j) => j.type === 'heartbeat').map((j) => j.heartbeat)
      queue.length = 0
      syncPending = false
      return heartbeats
    },
    whenIdle(timeoutMs = 5000) {
      if (!running && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => {
        idleWaiters.push(resolve)
        setTimeout(resolve, timeoutMs)
      })
    }
  }
}
