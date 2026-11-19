#!/usr/bin/env node
'use strict'

/**
 * Daily job. Scrapes today's Hazur Sahib hukamnama, resolves both granths
 * against the pinned Shabad OS corpus, writes archive/YYYY/MM/DD.json.
 *
 * Exits non-zero on any failure so the workflow goes red and mails you.
 * A day the site has not posted yet is "not yet", exit 0, and so is a site
 * still slow or down once the retries run out, since a later run may get
 * through. Both go red on the day's last scheduled run (FINAL_RUN=1). A
 * scheduled run (SCHEDULE set to its cron line) asks for its slot's IST day,
 * so a slot GitHub starts after IST midnight still judges the day it was
 * meant for. A day already in the archive is left alone, with no request.
 * Writes NOTHING on failure — a missing file is a clean 404 the client
 * already handles; a wrong file is wrong Gurbani in front of someone.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS, SOURCE_DSG } = require('../lib/resolve')
const { fetchForDate, todayIST, slotDayIST, isUnavailable, NoHukamnamaError } = require('../lib/scrape')
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
  now = Date.now,
  env = process.env,
  archiveDir = ARCHIVE_DIR,
  makeResolver = defaultResolver,
  corpusVersion = CORPUS_VERSION,
  log = msg => console.error(msg),
} = {}) {
  const date = slotDayIST(env.SCHEDULE, new Date(now())) ?? today()
  const file = datedPath(archiveDir, date)
  // Every run after the day is written would otherwise ask the gurdwara's
  // server again for a file it already has.
  if (fs.existsSync(file)) {
    log(`already_have ${date}`)
    return 0
  }

  // Before any request, so a wrong SHABADOS_DB goes red on every run.
  const resolver = makeResolver()
  let sections
  try {
    sections = await fetchSections(date)   // throws LayoutChangedError
  } catch (err) {
    // Before the site posts the day it answers with nothing, and a slow or
    // down site may answer a later run. Either is a failure only on the
    // day's last scheduled run.
    if (err instanceof NoHukamnamaError) log(`not_yet ${err.message}`)
    else if (isUnavailable(err)) log(`unavailable ${err.message}`)
    else throw err
    return env.FINAL_RUN === '1' ? 1 : 0
  }

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

  writeDay(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), file)}`)

  // A late slot can write an earlier day than latest.json already holds.
  const latestFile = path.join(archiveDir, 'latest.json')
  const latestDate = fs.existsSync(latestFile) ? JSON.parse(fs.readFileSync(latestFile, 'utf8')).date : ''
  if (latestDate > date) {
    log(`kept latest.json at ${latestDate}`)
    return 0
  }
  writeLatest(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), latestFile)}`)
  return 0
}

if (require.main === module) {
  run().then(code => process.exit(code), err => {
    console.error(`FAILED: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { buildPayload, run }
