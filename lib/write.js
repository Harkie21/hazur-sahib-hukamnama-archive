'use strict'

/**
 * Shared serialize/place logic for archive/YYYY/MM/DD.json and
 * archive/latest.json. Used by both bin/fetch-today.js and
 * bin/build-archive.js so the two entry points can't drift the way the two
 * copies of pack() once did (see lib/pack.js) — a third divergent write
 * site is exactly how that class of bug repeats.
 */

const fs = require('fs')
const path = require('path')

function serialize(payload) {
  return JSON.stringify(payload, null, 2) + '\n'
}

function datedPath(archiveDir, date) {
  const [ y, m, d ] = date.split('-')
  return path.join(archiveDir, y, m, `${d}.json`)
}

function writeDay(archiveDir, payload) {
  const file = datedPath(archiveDir, payload.date)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serialize(payload))
  return file
}

function writeLatest(archiveDir, payload) {
  const file = path.join(archiveDir, 'latest.json')
  fs.writeFileSync(file, serialize(payload))
  return file
}

module.exports = { serialize, datedPath, writeDay, writeLatest }
