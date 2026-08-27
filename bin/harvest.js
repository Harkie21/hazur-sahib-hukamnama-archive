#!/usr/bin/env node
'use strict'

/**
 * One-pass harvester. Fetches a date range from hazursahib.com exactly once,
 * caches every raw response to disk, resolves each against the corpus, and
 * writes both the archive files and an analysis log.
 *
 *   node bin/harvest.js 2022-01-07 2026-08-26
 *
 * Design goals, in priority order:
 *
 *  1. NEVER fetch the same date twice. Raw responses land in cache/ and are
 *     reused forever. If thresholds change later, re-run bin/analyse.js
 *     against the cache — offline, instant, zero further load on their server.
 *  2. Resumable. Ctrl-C or a crash costs you the current date, nothing more.
 *     Re-running skips everything already cached.
 *  3. Distinguish "no hukamnama published" from "the network failed".
 *     Conflating those two corrupts the dataset silently.
 *
 * Env:
 *   SHABADOS_DB   path to database.sqlite
 *   DELAY_MS      politeness delay between fetches (default 2500)
 *   CACHE_DIR     default ./cache
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')
const { fetchJsonForDate, parseJson, NoHukamnamaError } = require('../lib/scrape')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache')
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archive')
const RESULTS = path.join(__dirname, '..', 'harvest-results.jsonl')
const DELAY_MS = Number(process.env.DELAY_MS || 2500)
const MAX_RETRIES = 3

const sleep = ms => new Promise(r => setTimeout(r, ms))
const cachePath = d => path.join(CACHE_DIR, d.slice(0, 4), `${d}.json`)

function* eachDate(from, to) {
  const end = new Date(to)
  for (const d = new Date(from); d <= end; d.setDate(d.getDate() + 1)) {
    yield d.toISOString().slice(0, 10)
  }
}

/**
 * Returns { raw, fromCache } or throws. Retries transient failures with
 * backoff; a genuine empty result is NOT an error and gets cached as such,
 * so we never re-ask for a date the gurdwara simply didn't publish.
 */
async function getRaw(dateISO) {
  const cp = cachePath(dateISO)
  if (fs.existsSync(cp)) {
    return { raw: fs.readFileSync(cp, 'utf8'), fromCache: true }
  }

  let lastErr
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await fetchJsonForDate(dateISO)
      fs.mkdirSync(path.dirname(cp), { recursive: true })
      fs.writeFileSync(cp, raw)
      return { raw, fromCache: false }
    } catch (err) {
      lastErr = err
      if (attempt < MAX_RETRIES) {
        const wait = DELAY_MS * Math.pow(3, attempt)
        process.stderr.write(` [retry ${attempt}/${MAX_RETRIES - 1} in ${wait / 1000}s]`)
        await sleep(wait)
      }
    }
  }
  throw lastErr
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

async function main() {
  const [ from, to ] = process.argv.slice(2)
  if (!from || !to) {
    console.error('usage: harvest.js YYYY-MM-DD YYYY-MM-DD')
    process.exit(2)
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
    process.exit(2)
  }

  const dates = [ ...eachDate(from, to) ]
  const resolver = new Resolver(DB_PATH)
  const out = fs.createWriteStream(RESULTS, { flags: 'a' })

  let stopping = false
  process.on('SIGINT', () => {
    console.error('\n\nStopping after this date. Re-run the same command to resume.')
    stopping = true
  })

  const started = Date.now()
  let fetched = 0, cached = 0, empty = 0, failed = 0
  const conf = { high: 0, medium: 0, low: 0 }

  console.error(`Harvesting ${dates.length} days: ${from} .. ${to}`)
  console.error(`Cache: ${CACHE_DIR}\nDelay: ${DELAY_MS}ms\n`)

  for (let i = 0; i < dates.length; i++) {
    if (stopping) break
    const date = dates[i]
    const pct = ((i + 1) / dates.length * 100).toFixed(1)

    let raw, fromCache
    try {
      ({ raw, fromCache } = await getRaw(date))
    } catch (err) {
      failed++
      out.write(JSON.stringify({ date, status: 'fetch_failed', error: err.message }) + '\n')
      console.error(`[${pct}%] ${date}  FETCH FAILED: ${err.message}`)
      continue
    }
    fromCache ? cached++ : fetched++

    let sections
    try {
      sections = parseJson(raw)
    } catch (err) {
      if (err instanceof NoHukamnamaError) {
        // The server answered correctly; nothing was published that day.
        // Data, not failure. Common in the sparse 2022 portion of the archive.
        empty++
        out.write(JSON.stringify({ date, status: 'no_hukamnama', detail: err.message }) + '\n')
        console.error(`[${pct}%] ${date}  (no hukamnama published)${fromCache ? '  (cached)' : ''}`)
      } else {
        failed++
        out.write(JSON.stringify({ date, status: 'parse_failed', error: err.message }) + '\n')
        console.error(`[${pct}%] ${date}  PARSE FAILED: ${err.message}`)
      }
      if (!fromCache) await sleep(DELAY_MS)
      continue
    }

    const record = { date, status: 'ok', granths: {} }
    for (const s of sections) {
      const key = s.source_id === SOURCE_SGGS ? 'sggs' : 'dsg'
      const r = resolver.resolve(s.heading, s.bani, s.source_id)
      conf[r.confidence]++
      record.granths[key] = {
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
    out.write(JSON.stringify(record) + '\n')

    const elapsed = Date.now() - started
    const remaining = fetched > 0
      ? fmtDuration((elapsed / (i + 1)) * (dates.length - i - 1))
      : '?'
    const sg = record.granths.sggs
    const dg = record.granths.dsg
    console.error(
      `[${pct}%] ${date}  ` +
      `SGGS ${sg ? (sg.shabad_ids.join('+') || '-') + '/' + sg.confidence[0] : '--'}  ` +
      `DSG ${dg ? (dg.shabad_ids.join('+') || '-') + '/' + dg.confidence[0] : '--'}` +
      (fromCache ? '  (cached)' : `  eta ${remaining}`)
    )

    if (!fromCache) await sleep(DELAY_MS)
  }

  out.end()
  console.error('\n=== harvest summary ===')
  console.error(`days processed : ${fetched + cached}`)
  console.error(`  newly fetched: ${fetched}`)
  console.error(`  from cache   : ${cached}`)
  console.error(`no hukamnama   : ${empty}`)
  console.error(`failures       : ${failed}`)
  console.error(`resolutions    : high=${conf.high} medium=${conf.medium} low=${conf.low}`)
  console.error(`elapsed        : ${fmtDuration(Date.now() - started)}`)
  console.error(`\nRaw responses cached in ${CACHE_DIR} — re-analysis never needs the network.`)
  console.error(`Results log: ${RESULTS}`)
  if (failed) console.error(`\n${failed} failures: re-run the same command to retry only those.`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
