'use strict'

/**
 * Shared cache path/write logic for the raw upstream response.
 *
 * Used by bin/harvest.js only. bin/fetch-today.js deliberately does NOT
 * cache: the GitHub Actions runner is ephemeral and cache/ is gitignored
 * (it holds Hazur Sahib's full text, and this project publishes shabad IDs
 * only), so anything written there during a cron run is discarded.
 *
 * Consequence: days written by the daily job have no cached original. A
 * future re-resolution against a new corpus version needs harvest.js run
 * over the uncached range first. See README, "Corpus version".
 */

const fs = require('fs')
const path = require('path')

const cachePath = (cacheDir, dateISO) =>
  path.join(cacheDir, dateISO.slice(0, 4), `${dateISO}.json`)

function writeCache(cacheDir, dateISO, raw) {
  const cp = cachePath(cacheDir, dateISO)
  fs.mkdirSync(path.dirname(cp), { recursive: true })
  fs.writeFileSync(cp, raw)
  return cp
}

module.exports = { cachePath, writeCache }
