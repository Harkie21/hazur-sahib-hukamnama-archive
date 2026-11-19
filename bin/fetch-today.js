#!/usr/bin/env node
'use strict'

/**
 * Daily job. Scrapes today's Hazur Sahib hukamnama, resolves both granths
 * against the pinned Shabad OS corpus, writes archive/YYYY/MM/DD.json.
 *
 * Exits non-zero on any failure so the workflow goes red and mails you.
 * A day the site has not posted yet is "not yet", exit 0, except on the
 * day's last scheduled run (FINAL_RUN=1), where it goes red too.
 * Writes NOTHING on failure — a missing file is a clean 404 the client
 * already handles; a wrong file is wrong Gurbani in front of someone.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS, SOURCE_DSG } = require('../lib/resolve')
const { fetchForDate, todayIST, NoHukamnamaError } = require('../lib/scrape')
const { pack } = require('../lib/pack')
const { datedPath, writeDay, writeLatest } = require('../lib/write')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CORPUS_VERSION = process.env.SHABADOS_VERSION || '4.8.7'
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archive')

// Pure and side-effect free so a failed SGGS resolution never reaches a
// write call — buildPayload throws before run() gets anywhere near
// writeDay/writeLatest.
function buildPayload(date, results, corpusVersion) {
  if (!results.sggs || !results.sggs.ok) {
    throw new Error(`sggs_unresolved: ${results.sggs ? results.sggs.confidence : 'missing'}`)
  }
  return {
    date,
    source: 'hazur_sahib',
    // Mirrors gurbaninow/hukamnama-archive so a client written against that
    // format works here unmodified. SGGS only — the DSG half has no counterpart.
    shabad_ids: results.sggs.shabad_ids,
    sggs: pack(results.sggs),
    dsg: pack(results.dsg),
    corpus: { name: '@shabados/database', version: corpusVersion },
  }
}

function defaultResolver() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
  }
  return new Resolver(DB_PATH)
}

/** @returns {Promise<number>} the process exit code */
async function run({
  fetchSections = fetchForDate,
  today = todayIST,
  env = process.env,
  archiveDir = ARCHIVE_DIR,
  makeResolver = defaultResolver,
  corpusVersion = CORPUS_VERSION,
  log = msg => console.error(msg),
} = {}) {
  const date = today()
  let sections
  try {
    sections = await fetchSections(date)   // throws LayoutChangedError
  } catch (err) {
    if (!(err instanceof NoHukamnamaError)) throw err
    // Before the site posts the day it answers with nothing, which is only a
    // failure on the day's last scheduled run.
    log(`not_yet ${err.message}`)
    return env.FINAL_RUN === '1' ? 1 : 0
  }

  const resolver = makeResolver()
  const results = {}
  for (const section of sections) {
    const r = resolver.resolve(section.heading, section.bani, section.source_id)
    results[section.source_id === SOURCE_SGGS ? 'sggs' : 'dsg'] = r
    log(
      `${date}\t${section.source_id === SOURCE_SGGS ? 'SGGS' : 'DSG '}\t` +
      `${(r.shabad_ids || []).join('+') || '-'}\tscore=${r.score}\tmargin=${r.margin}\t` +
      `ang=${r.ang_scraped}/${r.ang_corpus}\tΔ=${r.ang_delta}\t${r.confidence}`
    )
  }

  // SGGS is the load-bearing half. If it did not resolve, treat the day as a
  // failure rather than publishing a half-empty file. buildPayload throws.
  const payload = buildPayload(date, results, corpusVersion)

  const file = datedPath(archiveDir, date)
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
    const prevIds = JSON.stringify(prev.shabad_ids)
    if (prevIds !== JSON.stringify(payload.shabad_ids)) {
      log(`WARNING: ${date} already published as ${prevIds}, now ${JSON.stringify(payload.shabad_ids)}`)
    }
  }
  writeDay(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), file)}`)

  writeLatest(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), path.join(archiveDir, 'latest.json'))}`)
  return 0
}

if (require.main === module) {
  run().then(code => process.exit(code), err => {
    console.error(`FAILED: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { buildPayload, run }
