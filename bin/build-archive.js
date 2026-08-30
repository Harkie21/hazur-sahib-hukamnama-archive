#!/usr/bin/env node
'use strict'

/**
 * Generates archive/YYYY/MM/DD.json from the cached raw responses.
 * Pure offline — reads cache/, never touches the network.
 *
 *   node bin/build-archive.js
 *   node bin/build-archive.js --dry-run
 *
 * Deliberately separate from harvest.js. Fetching and publishing are
 * different concerns: after any change to the resolver or its thresholds,
 * re-run this to regenerate the whole archive in seconds, with no further
 * load on hazursahib.com. The cache is the source of truth for what they
 * said; the archive is our interpretation of it, and interpretations change.
 *
 * Only high- and medium-confidence resolutions get shabad_ids. A low or
 * failed resolution still produces a file recording that the day existed —
 * with an empty shabad_ids array — because "we know nothing was resolvable"
 * is different from "we never looked", and clients need to tell them apart.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')
const { parseJson, NoHukamnamaError } = require('../lib/scrape')
const { pack } = require('../lib/pack')
const { datedPath, serialize, writeLatest } = require('../lib/write')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache')
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archive')
const CORPUS_VERSION = process.env.SHABADOS_VERSION || '4.8.7'
const DRY = process.argv.includes('--dry-run')
// Resolution is the expensive step, not disk or network. Writing the analysis
// log here means one pass produces both the archive and the report, instead of
// running harvest.js and this over the same 1,692 days twice.
const RESULTS = path.join(__dirname, '..', 'harvest-results.jsonl')

function cachedDates() {
  const out = []
  if (!fs.existsSync(CACHE_DIR)) return out
  for (const year of fs.readdirSync(CACHE_DIR)) {
    const dir = path.join(CACHE_DIR, year)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) out.push(f.replace(/\.json$/, ''))
    }
  }
  return out.sort()
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
    process.exit(2)
  }

  const resolver = new Resolver(DB_PATH)
  const dates = cachedDates()
  console.error(`${dates.length} cached days in ${CACHE_DIR}`)
  if (DRY) console.error('(dry run — nothing will be written)\n')

  let written = 0, skippedEmpty = 0, broken = 0, changed = 0
  const conf = { high: 0, medium: 0, low: 0 }
  const log = DRY ? null : fs.createWriteStream(RESULTS, { flags: 'w' })
  let latestPayload = null

  for (const date of dates) {
    const raw = fs.readFileSync(path.join(CACHE_DIR, date.slice(0, 4), `${date}.json`), 'utf8')

    let sections
    try {
      sections = parseJson(raw)
    } catch (err) {
      if (err instanceof NoHukamnamaError) {
        skippedEmpty++
        if (log) log.write(JSON.stringify({ date, status: 'no_hukamnama', detail: err.message }) + '\n')
        continue
      }
      broken++
      if (log) log.write(JSON.stringify({ date, status: 'parse_failed', error: err.message }) + '\n')
      console.error(`  ${date}: ${err.message}`)
      continue
    }

    const granths = {}
    const logRec = { date, status: 'ok', granths: {} }
    for (const s of sections) {
      const key = s.source_id === SOURCE_SGGS ? 'sggs' : 'dsg'
      const r = resolver.resolve(s.heading, s.bani, s.source_id)
      conf[r.confidence]++
      granths[key] = pack(r)
      logRec.granths[key] = {
        shabad_ids: r.ok ? r.shabad_ids : [],
        confidence: r.confidence,
        score: r.score ?? null,
        margin: r.margin ?? null,
        coverage: r.coverage ?? null,
        ang_scraped: r.ang_scraped ?? null,
        ang_corpus: r.ang_corpus ?? null,
        ang_delta: r.ang_delta ?? null,
        counters: r.counters ?? [],
        n_shabads: (r.shabad_ids || []).length,
      }
    }
    if (log) log.write(JSON.stringify(logRec) + '\n')

    const payload = {
      date,
      source: 'hazur_sahib',
      // Mirrors gurbaninow/hukamnama-archive's contract so a client written
      // for that format works here unmodified. SGGS only — Dasam Granth has
      // no counterpart there.
      shabad_ids: granths.sggs ? granths.sggs.shabad_ids : [],
      sggs: granths.sggs || null,
      dsg: granths.dsg || null,
      corpus: { name: '@shabados/database', version: CORPUS_VERSION },
    }

    const file = datedPath(ARCHIVE_DIR, date)
    const next = serialize(payload)

    if (fs.existsSync(file)) {
      const prev = fs.readFileSync(file, 'utf8')
      if (prev !== next) {
        changed++
        try {
          const before = JSON.parse(prev)
          if (JSON.stringify(before.shabad_ids) !== JSON.stringify(payload.shabad_ids)) {
            console.error(`  ${date}: shabad_ids changed ` +
              `${JSON.stringify(before.shabad_ids)} -> ${JSON.stringify(payload.shabad_ids)}`)
          }
        } catch { /* unreadable previous file; the rewrite fixes it */ }
      }
    }

    if (!DRY) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, next)
    }
    written++
    // dates is sorted ascending, so the last payload built is the newest.
    latestPayload = payload
  }

  if (!DRY && latestPayload) writeLatest(ARCHIVE_DIR, latestPayload)
  if (log) log.end()
  console.error(`\n=== build summary ===`)
  console.error(`archive files ${DRY ? 'that would be written' : 'written'}: ${written}`)
  console.error(`days with no hukamnama (no file): ${skippedEmpty}`)
  console.error(`unparseable cached responses: ${broken}`)
  console.error(`resolutions: high=${conf.high} medium=${conf.medium} low=${conf.low}`)
  if (changed) console.error(`files whose content changed since last build: ${changed}`)
  if (log) console.error(`\nAnalysis log written to ${RESULTS} — run: node bin/analyse.js`)
}

main()
