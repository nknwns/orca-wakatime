// Точка входа воркера плагина Orca. activate() должен вернуться быстро (у Orca таймаут
// готовности 10 с), поэтому весь запуск трекера идёт асинхронно после него.

import { readFileSync } from 'node:fs'
import { createTracker } from './src/tracker.mjs'

const manifest = JSON.parse(readFileSync(new URL('./orca-plugin.json', import.meta.url), 'utf8'))

let tracker = null

export default function activate(orca) {
  tracker = createTracker(orca, { pluginVersion: manifest.version })

  orca.commands.register('wakatime.status', () => tracker.commands.status())
  orca.commands.register('wakatime.today', () => tracker.commands.today())
  orca.commands.register('wakatime.dashboard', () => tracker.commands.dashboard())
  orca.commands.register('wakatime.pause', () => tracker.commands.pause())
  orca.commands.register('wakatime.resume', () => tracker.commands.resume())

  // События нужны ещё и затем, что именно они запускают воркер после старта Orca.
  orca.events.on('agent.status.changed', (payload) => tracker.onAgentStatus(payload))
  orca.events.on('worktree.created', () => {})

  setImmediate(() => {
    tracker.start().catch((error) => orca.log(`[wakatime] запуск не удался: ${error?.stack ?? error}`))
  })
}

export async function deactivate() {
  await tracker?.stop()
}
