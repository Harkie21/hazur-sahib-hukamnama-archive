#!/usr/bin/env node
'use strict'

/**
 * Finds how far back hazursahib.com's hukamnama archive actually goes,
 * using a binary search rather than a linear crawl — ~12 requests instead
 * of thousands. Run this BEFORE committing to a long backfill so you know
 * what range is worth asking for.
 *
 *   node bin/probe-range.js
 *   node bin/probe-range.js 2015-01-01     # optional earliest date to test
 */

const { fetchForDate } = require('../lib/scrape')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const iso = d => d.toISOString().slice(0, 10)

async function hasData(dateISO) {
  try {
    const sections = await fetchForDate(dateISO)
    return sections.length > 0
  } catch {
    return false
  }
}

async function main() {
  const floor = new Date(process.argv[2] || '2010-01-01')
  const today = new Date()

  console.error(`Probing how far back the archive goes (${iso(floor)} .. ${iso(today)})`)
  console.error('Binary search — expect ~12 requests, 2s apart.\n')

  // Confirm the recent end works at all before searching.
  const recent = new Date(today); recent.setDate(recent.getDate() - 7)
  process.stderr.write(`  ${iso(recent)} (sanity check) ... `)
  const ok = await hasData(iso(recent))
  console.error(ok ? 'has data' : 'NO DATA — something is wrong, stop here')
  if (!ok) process.exit(1)
  await sleep(2000)

  let lo = new Date(floor)      // presumed empty
  let hi = new Date(recent)     // known to have data

  while ((hi - lo) > 24 * 3600 * 1000) {
    const mid = new Date((+lo + +hi) / 2)
    process.stderr.write(`  ${iso(mid)} ... `)
    const found = await hasData(iso(mid))
    console.error(found ? 'has data' : 'empty')
    if (found) hi = mid
    else lo = mid
    await sleep(2000)
  }

  console.error(`\nEarliest date with data is on or about: ${iso(hi)}`)
  const days = Math.round((today - hi) / 86400000)
  console.error(`That is ~${days} days (~${(days / 365).toFixed(1)} years) of archive.`)
  console.error(`\nA full backfill would be ~${days} requests at 2s each`)
  console.error(`= roughly ${Math.round(days * 2 / 60)} minutes.`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
