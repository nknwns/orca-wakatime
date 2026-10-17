import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTranslator, normalizeLocale } from '../src/i18n.mjs'

test('normalizeLocale: язык из ru-RU / ru_RU.UTF-8, неизвестное — en', () => {
  assert.equal(normalizeLocale('ru-RU'), 'ru')
  assert.equal(normalizeLocale('ru_RU.UTF-8'), 'ru')
  assert.equal(normalizeLocale('de-DE'), 'en')
  assert.equal(normalizeLocale(null), 'en')
})

test('translator: подстановка параметров и запасной английский', () => {
  const { t, setLocale } = createTranslator('en')
  assert.equal(t('today.code', { value: 104 }), 'wakatime-cli exited with code 104.')
  setLocale('ru-RU')
  assert.equal(t('status.tracking', { value: t('status.active') }), 'Отслеживание: активно')
  assert.equal(t('missing.key'), 'missing.key')
})
