// Минимальный разбор ~/.wakatime.cfg (INI). Сами настройки (exclude, hide_file_names,
// proxy и т. п.) применяет wakatime-cli — плагину нужно только проверить ключ и debug.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function configPath(home = homedir()) {
  return join(home, '.wakatime.cfg')
}

export function parseIni(text) {
  const sections = {}
  let current = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      current = section[1].trim()
      sections[current] ??= {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1 || current === null) continue
    sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

export function isTruthy(value) {
  return typeof value === 'string' && /^(true|1|yes|on)$/i.test(value.trim())
}

export async function readWakatimeConfig(home = homedir()) {
  let text
  try {
    text = await readFile(configPath(home), 'utf8')
  } catch {
    return { exists: false, hasApiKey: false, debug: false, settings: {} }
  }
  const settings = parseIni(text).settings ?? {}
  return {
    exists: true,
    hasApiKey: Boolean(settings.api_key || settings.apikey || settings.api_key_vault_cmd),
    debug: isTruthy(settings.debug),
    settings
  }
}
