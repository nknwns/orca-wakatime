// Тексты уведомлений на языке интерфейса ОС. Названия команд в манифесте Orca не
// локализует, поэтому они на английском; здесь — только то, что показывает воркер.

const MESSAGES = {
  en: {
    'cli-missing.title': 'WakaTime: wakatime-cli is missing',
    'cli-missing.body': 'Could not download wakatime-cli from GitHub. Check your connection; will retry later.',
    'auth.title': 'WakaTime: invalid API key',
    'auth.body': 'Check api_key in ~/.wakatime.cfg (https://wakatime.com/api-key).',
    'config.title': 'WakaTime: config error',
    'config.body': 'Could not read ~/.wakatime.cfg — check the file syntax.',
    'no-key.title': 'WakaTime: API key required',
    'no-key.body': 'Add api_key = waka_… to the [settings] section of ~/.wakatime.cfg. Get your key at https://wakatime.com/api-key',
    paused: 'Tracking paused.',
    resumed: 'Tracking resumed.',
    'status.title': 'WakaTime: status',
    'status.tracking': 'Tracking: {value}',
    'status.active': 'active',
    'status.paused': 'paused',
    'status.cli': 'wakatime-cli: {value}',
    'status.notFound': 'not found',
    'status.apiKey': 'API key: {value}',
    'status.yes': 'present',
    'status.no': 'missing',
    'status.probe': 'Focus & idle detection: {value}',
    'status.probeUnavailable': 'unavailable (tracking tab actions only)',
    'status.probeFocused': 'working, Orca is focused',
    'status.probeBackground': 'working, Orca is in the background',
    'status.runtime': 'Orca runtime: {value}',
    'status.ok': 'ok',
    'status.error': 'error',
    'status.heartbeats': 'Heartbeats this session: {value}',
    'status.last': 'Last: {value}',
    'status.saved': ' (save)',
    'today.title': 'WakaTime: today',
    'today.preparing': 'wakatime-cli is being installed or updated — try again in a minute.',
    'today.noCli': 'wakatime-cli not found.',
    'today.code': 'wakatime-cli exited with code {value}.'
  },
  ru: {
    'cli-missing.title': 'WakaTime: нет wakatime-cli',
    'cli-missing.body': 'Не удалось скачать wakatime-cli с GitHub. Проверьте интернет; повторю попытку позже.',
    'auth.title': 'WakaTime: неверный API-ключ',
    'auth.body': 'Проверьте api_key в ~/.wakatime.cfg (https://wakatime.com/api-key).',
    'config.title': 'WakaTime: ошибка конфига',
    'config.body': 'Не удалось прочитать ~/.wakatime.cfg — проверьте синтаксис файла.',
    'no-key.title': 'WakaTime: нужен API-ключ',
    'no-key.body': 'Добавьте строку api_key = waka_… в секцию [settings] файла ~/.wakatime.cfg. Ключ: https://wakatime.com/api-key',
    paused: 'Отслеживание на паузе.',
    resumed: 'Отслеживание возобновлено.',
    'status.title': 'WakaTime: статус',
    'status.tracking': 'Отслеживание: {value}',
    'status.active': 'активно',
    'status.paused': 'на паузе',
    'status.cli': 'wakatime-cli: {value}',
    'status.notFound': 'не найден',
    'status.apiKey': 'API-ключ: {value}',
    'status.yes': 'есть',
    'status.no': 'нет',
    'status.probe': 'Фокус и простой: {value}',
    'status.probeUnavailable': 'недоступен (учёт по действиям во вкладках)',
    'status.probeFocused': 'работает, Orca в фокусе',
    'status.probeBackground': 'работает, Orca в фоне',
    'status.runtime': 'Рантайм Orca: {value}',
    'status.ok': 'ок',
    'status.error': 'ошибка',
    'status.heartbeats': "Heartbeat'ов за сессию: {value}",
    'status.last': 'Последний: {value}',
    'status.saved': ' (сохранение)',
    'today.title': 'WakaTime: сегодня',
    'today.preparing': 'wakatime-cli устанавливается или обновляется — попробуйте через минуту.',
    'today.noCli': 'wakatime-cli не найден.',
    'today.code': 'wakatime-cli вернул код {value}.'
  }
}

export function normalizeLocale(value) {
  if (typeof value !== 'string') return 'en'
  const language = value.trim().toLowerCase().split(/[-_.@]/)[0]
  return Object.hasOwn(MESSAGES, language) ? language : 'en'
}

export function createTranslator(locale = 'en') {
  let current = normalizeLocale(locale)
  return {
    t(key, params = {}) {
      const template = MESSAGES[current][key] ?? MESSAGES.en[key] ?? key
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
    },
    setLocale(value) {
      current = normalizeLocale(value)
    },
    get locale() {
      return current
    }
  }
}
