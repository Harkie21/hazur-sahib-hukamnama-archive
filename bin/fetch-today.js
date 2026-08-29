#!/usr/bin/env node
'use strict'

/**
 * Daily job. Scrapes today's Hazur Sahib hukamnama, resolves both granths
 * against the pinned Shabad OS corpus, writes archive/YYYY/MM/DD.json.
 *
 * Exits non-zero on any failure so the workflow goes red and mails you.
 * Writes NOTHING on failure — a missing file is a clean 404 the client
 * already handles; a wrong file is wrong Gurbani in front of someone.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS, SOURCE_DSG } = require('../lib/resolve')
const { fetchToday, todayIST } = require('../lib/scrape')
const { pack } = require('../lib/pack')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CORPUS_VERSION = process.env.SHABADOS_VERSION || '4.8.7'
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archive')

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
  }

  const date = todayIST()
  const sections = await fetchToday()       // throws LayoutChangedError

  const resolver = new Resolver(DB_PATH)
  const results = {}
  for (const section of sections) {
    const r = resolver.resolve(section.heading, section.bani, section.source_id)
    results[section.source_id === SOURCE_SGGS ? 'sggs' : 'dsg'] = r
    console.error(
      `${date}\t${section.source_id === SOURCE_SGGS ? 'SGGS' : 'DSG '}\t` +
      `${(r.shabad_ids || []).join('+') || '-'}\tscore=${r.score}\tmargin=${r.margin}\t` +
      `ang=${r.ang_scraped}/${r.ang_corpus}\tΔ=${r.ang_delta}\t${r.confidence}`
    )
  }

  // SGGS is the load-bearing half. If it did not resolve, treat the day as a
  // failure rather than publishing a half-empty file.
  if (!results.sggs || !results.sggs.ok) {
    throw new Error(`sggs_unresolved: ${results.sggs ? results.sggs.confidence : 'missing'}`)
  }

  const payload = {
    date,
    source: 'hazur_sahib',
    // Mirrors gurbaninow/hukamnama-archive so a client written against that
    // format works here unmodified. SGGS only — the DSG half has no counterpart.
    shabad_ids: results.sggs.shabad_ids,
    sggs: pack(results.sggs),
    dsg: pack(results.dsg),
    corpus: { name: '@shabados/database', version: CORPUS_VERSION },
  }

  const [ y, m, d ] = date.split('-')
  const dir = path.join(ARCHIVE_DIR, y, m)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${d}.json`)

  const next = JSON.stringify(payload, null, 2) + '\n'
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
    const prevIds = JSON.stringify(prev.shabad_ids)
    if (prevIds !== JSON.stringify(payload.shabad_ids)) {
      console.error(`WARNING: ${date} already published as ${prevIds}, now ${JSON.stringify(payload.shabad_ids)}`)
    }
  }
  fs.writeFileSync(file, next)
  console.error(`wrote ${path.relative(process.cwd(), file)}`)
}

main().catch(err => {
  console.error(`FAILED: ${err.message}`)
  process.exit(1)
})
