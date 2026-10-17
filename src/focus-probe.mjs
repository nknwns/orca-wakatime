// Фокус окна Orca и время с последнего ввода (клавиатура/мышь) на уровне ОС.
// Аналог того, как IDE-плагины шлют heartbeat только на события в активном редакторе.
//
// sample() → { focused: boolean|null, idleMs: number|null }; null — «не удалось узнать».

import { spawn, execFile } from 'node:child_process'
import { join } from 'node:path'

const UNKNOWN = Object.freeze({ focused: null, idleMs: null })
const SAMPLE_TIMEOUT_MS = 3000
const READY_TIMEOUT_MS = 15_000

const WINDOWS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OrcaWakaTimeProbe {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static long IdleMs() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
  public static long ForegroundPid() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return 0;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return pid;
  }
}
"@
[Console]::Out.WriteLine("ready $([System.Globalization.CultureInfo]::CurrentUICulture.Name)")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $seq = $line.Trim()
  [Console]::Out.WriteLine("$seq $([OrcaWakaTimeProbe]::IdleMs()) $([OrcaWakaTimeProbe]::ForegroundPid())")
  [Console]::Out.Flush()
}
`

/** Ответ пробника: «<номер запроса> <idleMs> <pid окна на переднем плане>». */
export function parseWindowsProbeLine(line) {
  const match = /^(\d+)\s+(-?\d+)\s+(\d+)$/.exec(line.trim())
  if (!match) return null
  const idleMs = Number(match[2])
  return { seq: Number(match[1]), idleMs: idleMs >= 0 ? idleMs : null, foregroundPid: Number(match[3]) }
}

export function parseMacIdleMs(ioregOutput) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput)
  return match ? Math.floor(Number(match[1]) / 1e6) : null
}

/** Первый язык из `defaults read -g AppleLanguages`: `(\n    "ru-RU",\n    "en-RU"\n)`. */
export function parseMacLanguages(output) {
  return /([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)/.exec(String(output).replace(/^\s*\(/, ''))?.[1] ?? null
}

export function parseMacFrontPid(lsappinfoOutput) {
  const match = /"pid"\s*=\s*(\d+)/.exec(lsappinfoOutput)
  return match ? Number(match[1]) : null
}

function run(file, args, timeout = SAMPLE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout))
    })
  })
}

/**
 * Постоянный процесс PowerShell: в stdin пишем номер запроса, в ответ приходит строка
 * с тем же номером — запоздавший ответ не перепутается со следующим запросом.
 */
function createWindowsProbe({ targetPid, log, env }) {
  let proc = null
  let ready = false
  let starting = null
  let disposed = false
  let failures = 0
  let disabledUntil = 0
  let nextSeq = 1
  let uiLocale = null
  let buffer = ''
  const pending = new Map()

  function resolvePending(seq, value) {
    const entry = pending.get(seq)
    if (!entry) return
    pending.delete(seq)
    clearTimeout(entry.timer)
    entry.resolve(value)
  }

  function failAll() {
    for (const seq of [...pending.keys()]) resolvePending(seq, null)
  }

  function onGone(current, reason) {
    if (proc !== current) return
    proc = null
    ready = false
    starting = null
    buffer = ''
    failAll()
    if (disposed) return
    failures += 1
    // Не перезапускаем CLR + Add-Type каждые 5 секунд, если PowerShell падает.
    disabledUntil = Date.now() + Math.min(2 ** (failures - 1), 30) * 60_000
    log(`focus probe stopped (${reason}); retrying in ${Math.round((disabledUntil - Date.now()) / 60_000)} min`)
  }

  function start() {
    if (starting) return starting
    starting = new Promise((resolve) => {
      const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const encoded = Buffer.from(WINDOWS_PROBE_SCRIPT, 'utf16le').toString('base64')
      let current
      try {
        current = spawn(
          powershell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
      } catch (error) {
        failures += 1
        disabledUntil = Date.now() + Math.min(2 ** (failures - 1), 30) * 60_000
        log(`focus probe failed to start: ${error.message}`)
        starting = null
        resolve(false)
        return
      }
      proc = current
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        resolve(value)
      }
      const readyTimer = setTimeout(() => {
        current.kill()
        onGone(current, 'no response in 15 s')
        settle(false)
      }, READY_TIMEOUT_MS)

      current.stdout.setEncoding('utf8')
      current.stdout.on('data', (chunk) => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!ready) {
            if (line === 'ready' || line.startsWith('ready ')) {
              uiLocale = line.slice('ready'.length).trim() || null
              ready = true
              failures = 0
              settle(true)
            }
            continue
          }
          const parsed = parseWindowsProbeLine(line)
          if (parsed) resolvePending(parsed.seq, parsed)
        }
      })
      current.stderr.setEncoding('utf8')
      current.stderr.on('data', (chunk) => {
        // PowerShell сериализует служебные потоки в CLIXML — это не ошибки.
        const text = chunk.trim()
        if (text && !text.startsWith('#< CLIXML') && !text.startsWith('<Objs')) {
          log(`focus probe: ${text.slice(0, 500)}`)
        }
      })
      current.stdin.on('error', () => {})
      // При ошибке запуска (ENOENT, AppLocker) Node шлёт 'error' и 'close', но не 'exit'.
      current.on('error', (error) => {
        onGone(current, error.message)
        settle(false)
      })
      current.on('close', (code) => {
        onGone(current, `exit code ${code}`)
        settle(false)
      })
    })
    return starting
  }

  return {
    async sample() {
      if (disposed || Date.now() < disabledUntil) return UNKNOWN
      if (!ready && !(await start())) return UNKNOWN
      const current = proc
      if (!current || !ready) return UNKNOWN
      const seq = nextSeq++
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolvePending(seq, null), SAMPLE_TIMEOUT_MS)
        pending.set(seq, { resolve, timer })
        current.stdin.write(`${seq}\n`)
      })
      if (!result) return UNKNOWN
      return {
        focused: result.foregroundPid === 0 ? false : result.foregroundPid === targetPid,
        idleMs: result.idleMs
      }
    },
    /** Язык интерфейса Windows (CurrentUICulture) — его сообщает пробник при старте. */
    async locale() {
      if (!ready && Date.now() >= disabledUntil && !disposed) await start()
      return uiLocale
    },
    dispose() {
      disposed = true
      const current = proc
      proc = null
      ready = false
      failAll()
      if (current) {
        current.stdin.end()
        current.kill()
      }
    }
  }
}

function createMacProbe({ targetPid }) {
  return {
    async sample() {
      const [ioreg, front] = await Promise.all([
        run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime']),
        run('/usr/bin/lsappinfo', ['front'])
      ])
      const idleMs = ioreg ? parseMacIdleMs(ioreg) : null
      let focused = null
      const asn = front?.trim()
      if (asn) {
        const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn])
        const pid = info ? parseMacFrontPid(info) : null
        if (pid !== null) focused = pid === targetPid
      }
      return { focused, idleMs }
    },
    async locale() {
      const out = await run('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'])
      return out ? parseMacLanguages(out) : null
    },
    dispose() {}
  }
}

function createLinuxProbe({ targetPid, env }) {
  return {
    async sample() {
      const [idle, pid] = await Promise.all([
        run('xprintidle', []),
        run('xdotool', ['getactivewindow', 'getwindowpid'])
      ])
      const idleMs = idle && /^\d+\s*$/.test(idle) ? Number(idle) : null
      const focusedPid = pid && /^\d+\s*$/.test(pid) ? Number(pid) : null
      return { focused: focusedPid === null ? null : focusedPid === targetPid, idleMs }
    },
    async locale() {
      return env.LC_ALL || env.LANG || null
    },
    dispose() {}
  }
}

/**
 * targetPid — pid главного процесса Orca: им владеет окно приложения,
 * и он же родитель воркера плагина.
 */
export function createFocusProbe({
  platform = process.platform,
  targetPid = process.ppid,
  log = () => {},
  env = process.env
} = {}) {
  if (platform === 'win32') return createWindowsProbe({ targetPid, log, env })
  if (platform === 'darwin') return createMacProbe({ targetPid })
  return createLinuxProbe({ targetPid, env })
}
