// Распаковка одного файла из zip-архива без внешних утилит и зависимостей.
// Релизы wakatime-cli — zip с единственным бинарником, этого достаточно.

import * as zlib from 'node:zlib'

const { inflateRawSync, crc32 } = zlib

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('zip: не найден конец центрального каталога')
}

export function listZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('zip: повреждён каталог')
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, crc, compressedSize, size, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function extractZipEntry(buffer, entry) {
  const offset = entry.localOffset
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw new Error('zip: повреждён локальный заголовок')
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const data = buffer.subarray(start, start + entry.compressedSize)
  let content
  if (entry.method === 0) content = Buffer.from(data)
  else if (entry.method === 8) content = inflateRawSync(data)
  else throw new Error(`zip: неподдерживаемый метод сжатия ${entry.method}`)
  if (content.length !== entry.size) throw new Error('zip: размер распакованного файла не совпал')
  // zlib.crc32 есть с Node 22.2; на более старых проверяем только размер.
  if (typeof crc32 === 'function' && entry.crc !== undefined && crc32(content) >>> 0 !== entry.crc) {
    throw new Error('zip: контрольная сумма не совпала — архив повреждён')
  }
  return content
}

/** Первый файл (не каталог), чьё имя без пути начинается с prefix. */
export function extractFileByPrefix(buffer, prefix) {
  const entry = listZipEntries(buffer).find((e) => {
    if (e.name.endsWith('/')) return false
    const base = e.name.split('/').pop()
    return base.startsWith(prefix)
  })
  if (!entry) throw new Error(`zip: нет файла ${prefix}*`)
  return { name: entry.name.split('/').pop(), content: extractZipEntry(buffer, entry) }
}
