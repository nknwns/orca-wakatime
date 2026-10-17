// Клиент локального рантайма Orca — тот же канал (named pipe / unix socket + токен
// из orca-runtime.json), что использует `orca` CLI. Публичный API плагинов пока не
// отдаёт активный файл, поэтому читаем состояние вкладок отсюда, только на чтение.

import { createConnection } from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const USER_DATA_DIR_NAMES = ['orca', 'Orca', 'orca-dev']
const RUNTIME_METADATA_FILE = 'orca-runtime.json'

export function userDataBaseDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'win32') {
    // Воркеру плагина не передают APPDATA — восстанавливаем стандартный путь.
    return [env.APPDATA, join(home, 'AppData', 'Roaming')].filter(Boolean)
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  return [env.XDG_CONFIG_HOME, join(home, '.config')].filter(Boolean)
}

export function runtimeMetadataCandidates(platform, home, env) {
  const seen = new Set()
  const result = []
  for (const base of userDataBaseDirs(platform, home, env)) {
    for (const name of USER_DATA_DIR_NAMES) {
      const path = join(base, name, RUNTIME_METADATA_FILE)
      if (!seen.has(path)) {
        seen.add(path)
        result.push(path)
      }
    }
  }
  return result
}

function pickEndpoint(metadata) {
  const transports = Array.isArray(metadata?.transports) ? metadata.transports : []
  return transports.find((t) => t && (t.kind === 'named-pipe' || t.kind === 'unix'))?.endpoint ?? null
}

/**
 * Ищет метаданные рантайма того процесса Orca, который запустил этот воркер
 * (pid совпадает с ppid), чтобы не подключиться к чужому экземпляру (например, dev-сборке).
 */
export async function findRuntimeMetadata({ ppid = process.ppid, platform, home, env } = {}) {
  let fallback = null
  for (const path of runtimeMetadataCandidates(platform, home, env)) {
    let metadata
    try {
      metadata = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (!pickEndpoint(metadata) || typeof metadata.authToken !== 'string') continue
    if (metadata.pid === ppid) return { ...metadata, path }
    fallback ??= { ...metadata, path }
  }
  return fallback
}

export class RuntimeRpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function createRuntimeClient({ log = () => {}, timeoutMs = 5000 } = {}) {
  let metadata = null

  async function ensureMetadata(force = false) {
    // Запасной кандидат (pid не совпал с родителем) не кешируем: это может быть чужой
    // экземпляр Orca, а свой ещё не успел записать метаданные.
    if (!metadata || force || metadata.pid !== process.ppid) {
      metadata = await findRuntimeMetadata()
      if (!metadata) throw new RuntimeRpcError('runtime_unavailable', 'orca-runtime.json not found')
    }
    return metadata
  }

  function send(meta, method, params) {
    return new Promise((resolve, reject) => {
      const endpoint = pickEndpoint(meta)
      const socket = createConnection(endpoint)
      let buffer = ''
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(
        () => finish(new RuntimeRpcError('runtime_timeout', `${method}: no response in ${timeoutMs} ms`)),
        timeoutMs
      )
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({ id: randomUUID(), authToken: meta.authToken, method, params })}\n`
        )
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            finish(new RuntimeRpcError('invalid_response', `${method}: invalid runtime response`))
            return
          }
          if (frame && frame._keepalive) continue
          if (frame?.ok === true) {
            finish(null, frame.result)
          } else {
            const code = frame?.error?.code ?? 'rpc_error'
            const message = frame?.error?.message ?? 'runtime error'
            finish(new RuntimeRpcError(code, `${method}: ${message}`))
          }
          return
        }
      })
      socket.on('error', (error) =>
        finish(new RuntimeRpcError('runtime_unavailable', `${method}: ${error.message}`))
      )
      socket.on('close', () =>
        finish(new RuntimeRpcError('runtime_unavailable', `${method}: connection closed`))
      )
    })
  }

  return {
    async call(method, params = null) {
      const meta = await ensureMetadata()
      try {
        return await send(meta, method, params)
      } catch (error) {
        // Метаданные могли устареть (рантайм перезапустился) — перечитываем один раз.
        if (error?.code !== 'runtime_unavailable') throw error
        const fresh = await ensureMetadata(true)
        if (fresh.authToken === meta.authToken && pickEndpoint(fresh) === pickEndpoint(meta)) {
          throw error
        }
        log('runtime metadata changed, retrying request')
        return await send(fresh, method, params)
      }
    },
    get metadataPath() {
      return metadata?.path ?? null
    },
    get runtimePid() {
      return metadata?.pid ?? null
    }
  }
}
