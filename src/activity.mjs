// Чистые функции: из снимков рантайма Orca получаем «что сейчас делает пользователь»
// и решаем, когда отправлять heartbeat. Без ввода-вывода — всё покрыто тестами.

/** Правило WakaTime: один и тот же объект — не чаще раза в 2 минуты. */
export const HEARTBEAT_INTERVAL_MS = 2 * 60_000

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function stripBranchRef(branch) {
  if (typeof branch !== 'string') return ''
  return branch.replace(/^refs\/heads\//, '')
}

export function isLocalHost(hostId) {
  return hostId === undefined || hostId === null || hostId === 'local'
}

/**
 * Сфокусированный в Orca worktree из ответа `worktree.ps`. `isActive` ставится по одному
 * на каждый хост исполнения (локальный, SSH…), поэтому при нескольких кандидатах
 * берём локальный, а среди равных — тот, у которого есть активная вкладка.
 */
export function pickActiveWorktree(psResult, tabsResult = null) {
  const worktrees = psResult?.worktrees
  if (!Array.isArray(worktrees)) return null
  const candidates = worktrees.filter((w) => w && w.isActive === true && typeof w.path === 'string')
  if (candidates.length <= 1) return candidates[0] ?? null
  const hasActiveTab = (w) => Boolean(findSnapshot(tabsResult, w.worktreeId)?.activeTabId)
  const rank = (w) => (isLocalHost(w.hostId) ? 2 : 0) + (hasActiveTab(w) ? 1 : 0)
  return candidates.reduce((best, w) => (rank(w) > rank(best) ? w : best))
}

/** Снимок вкладок нужного worktree из ответа `session.tabs.listAll`. */
export function findSnapshot(tabsResult, worktreeId) {
  const snapshots = tabsResult?.snapshots
  if (!Array.isArray(snapshots) || !worktreeId) return null
  return snapshots.find((s) => s && s.worktree === worktreeId) ?? null
}

/** Активная вкладка снимка. Для терминалов id составной (`tab::leaf`). */
export function findActiveTab(snapshot) {
  const tabs = snapshot?.tabs
  if (!Array.isArray(tabs) || tabs.length === 0) return null
  if (snapshot.activeTabId) {
    const exact = tabs.find((t) => t && t.id === snapshot.activeTabId)
    if (exact) return exact
  }
  const byType = snapshot.activeTabType
    ? tabs.find((t) => t && t.isActive === true && t.type === snapshot.activeTabType)
    : null
  return byType ?? tabs.find((t) => t && t.isActive === true) ?? null
}

export function isAgentWorking(worktree, snapshot) {
  if (worktree?.status === 'working') return true
  const tabs = snapshot?.tabs
  if (!Array.isArray(tabs)) return false
  return tabs.some((t) => t?.type === 'terminal' && t.agentStatus?.state === 'working')
}

export function domainOf(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname || null
  } catch {
    return null
  }
}

export function isLocalDomain(domain) {
  if (!domain) return false
  return LOCAL_HOSTNAMES.has(domain) || domain.endsWith('.localhost') || domain.endsWith('.local')
}

/**
 * Описание текущей активности в фокусе или null, если трекать нечего
 * (не открыт ни один worktree, например экран настроек).
 *
 * Поля совпадают с аргументами wakatime-cli: entity, entityType, category,
 * projectFolder (для локальных worktree), project/alternateBranch (для удалённых).
 */
export function describeActivity(worktree, snapshot) {
  if (!worktree || typeof worktree.path !== 'string') return null
  const local = isLocalHost(worktree.hostId)
  const agentWorking = isAgentWorking(worktree, snapshot)
  const tab = findActiveTab(snapshot)

  const base = local
    ? { projectFolder: worktree.path }
    : {
        project: worktree.repo || worktree.displayName || undefined,
        alternateBranch: stripBranchRef(worktree.branch) || undefined
      }

  if (tab && (tab.type === 'file' || tab.type === 'markdown') && typeof tab.filePath === 'string') {
    const category = tab.mode === 'diff' ? 'code reviewing' : 'coding'
    if (!local) {
      // Файл лежит на удалённом хосте — wakatime-cli не может его прочитать.
      return {
        ...base,
        kind: 'remote-file',
        entity: tab.relativePath || tab.title || tab.filePath,
        entityType: 'file',
        isUnsavedEntity: true,
        language: tab.language,
        category
      }
    }
    return { ...base, kind: 'file', entity: tab.filePath, entityType: 'file', category, tabId: tab.id }
  }

  if (tab && tab.type === 'browser') {
    const domain = domainOf(tab.url)
    if (domain) {
      return {
        ...base,
        kind: 'browser',
        entity: domain,
        entityType: 'domain',
        category: isLocalDomain(domain) ? 'manual testing' : 'browsing'
      }
    }
  }

  if (tab && tab.type === 'agent-session') {
    return { ...base, kind: 'agent', entity: 'Orca Agent', entityType: 'app', category: 'ai coding' }
  }

  // Терминал, пустой worktree или вкладка неизвестного типа: время идёт на проект.
  return {
    ...base,
    kind: tab?.type === 'terminal' ? 'terminal' : 'workspace',
    entity: tab?.type === 'terminal' ? 'Orca Terminal' : 'Orca',
    entityType: 'app',
    category: agentWorking ? 'ai coding' : 'coding'
  }
}

export function activityKey(activity) {
  if (!activity) return null
  return [
    activity.entityType,
    activity.entity,
    activity.category,
    activity.projectFolder ?? '',
    activity.project ?? ''
  ].join('|')
}

/**
 * Решение по правилам WakaTime: отправляем, если сменился объект, прошло
 * 2 минуты с прошлой отправки того же объекта, или это сохранение.
 */
export function createHeartbeatGate(intervalMs = HEARTBEAT_INTERVAL_MS) {
  let lastKey = null
  let lastSentAt = 0
  return {
    shouldSend(key, now, isWrite = false) {
      if (!key) return false
      return isWrite || key !== lastKey || now - lastSentAt >= intervalMs
    },
    markSent(key, now) {
      lastKey = key
      lastSentAt = now
    },
    reset() {
      lastKey = null
      lastSentAt = 0
    }
  }
}

/** Все вкладки-файлы локальных worktree: tabId → { filePath, isDirty, projectFolder }. */
export function collectFileTabs(tabsResult, psResult) {
  const result = new Map()
  const snapshots = tabsResult?.snapshots
  if (!Array.isArray(snapshots)) return result
  const worktreesById = new Map()
  for (const w of psResult?.worktrees ?? []) {
    if (w?.worktreeId) worktreesById.set(w.worktreeId, w)
  }
  for (const snapshot of snapshots) {
    const worktree = worktreesById.get(snapshot?.worktree)
    if (!worktree || !isLocalHost(worktree.hostId)) continue
    for (const tab of snapshot.tabs ?? []) {
      if ((tab?.type === 'file' || tab?.type === 'markdown') && typeof tab.filePath === 'string') {
        result.set(`${snapshot.worktree}\u0000${tab.id}`, {
          filePath: tab.filePath,
          isDirty: tab.isDirty === true,
          projectFolder: worktree.path
        })
      }
    }
  }
  return result
}

/** Состояние по файлам: файл «грязный», если грязна хоть одна его вкладка (редактор, превью, дифф). */
export function fileStates(fileTabs) {
  const byPath = new Map()
  for (const tab of fileTabs.values()) {
    const existing = byPath.get(tab.filePath)
    if (existing) existing.isDirty ||= tab.isDirty
    else byPath.set(tab.filePath, { ...tab })
  }
  return byPath
}

/**
 * Сохранения между двумя опросами (по файлам, а не по вкладкам — одно сохранение
 * не считается дважды): файл был «грязным», а теперь чистый или его вкладку закрыли
 * («Сохранить» в диалоге закрытия). Отличить сохранение от «отменить изменения»
 * помогает проверка mtime файла — её делает вызывающий код.
 */
export function detectSaves(previous, current) {
  const before = fileStates(previous)
  const now = fileStates(current)
  const saves = []
  for (const [filePath, was] of before) {
    if (!was.isDirty) continue
    const state = now.get(filePath)
    if (!state) saves.push({ ...was, isDirty: false, closed: true })
    else if (!state.isDirty) saves.push({ ...state })
  }
  return saves
}

const MAX_LCS_CELLS = 4_000_000

function splitLines(text) {
  const value = String(text)
  return value === '' ? [] : value.split(/\r?\n/)
}

function longestCommonSubsequence(a, b) {
  let previous = new Uint32Array(b.length + 1)
  let current = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    ;[previous, current] = [current, previous]
  }
  return previous[b.length]
}

/**
 * Добавленные + удалённые строки между двумя версиями файла (как `git diff --numstat`) —
 * значение для --human-line-changes. Общие начало и конец отрезаются сразу, середина
 * сравнивается через LCS; слишком большую середину считаем целиком изменённой.
 */
export function countChangedLines(before, after) {
  if (before === after) return 0
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  if (middleA.length === 0 || middleB.length === 0) return middleA.length + middleB.length
  if (middleA.length * middleB.length > MAX_LCS_CELLS) return middleA.length + middleB.length
  const common = longestCommonSubsequence(middleA, middleB)
  return middleA.length + middleB.length - 2 * common
}

/** Вкладки, которые с прошлого опроса стали «грязными» — признак набора текста. */
export function detectNewEdits(previous, current) {
  const before = fileStates(previous)
  const edits = []
  for (const [filePath, state] of fileStates(current)) {
    if (state.isDirty && !before.get(filePath)?.isDirty) edits.push(state)
  }
  return edits
}
