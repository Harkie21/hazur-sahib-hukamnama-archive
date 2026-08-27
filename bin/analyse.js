#!/usr/bin/env node
'use strict'

/**
 * Reads harvest-results.jsonl and reports on it. Pure analysis, no network.
 *
 *   node bin/analyse.js
 *
 * The number that decides whether this ships is the margin separation:
 * if bad matches and good matches occupy overlapping margin ranges, no
 * threshold can separate them and the Dasam Granth half is not safe to link.
 */

const fs = require('fs')
const path = require('path')

const RESULTS = process.argv[2] || path.join(__dirname, '..', 'harvest-results.jsonl')

const rows = fs.readFileSync(RESULTS, 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse)

// Last write wins, so a re-run supersedes earlier attempts at the same date.
const byDate = new Map()
for (const r of rows) byDate.set(r.date, r)
const all = [ ...byDate.values() ].sort((a, b) => a.date.localeCompare(b.date))

const ok = all.filter(r => r.status === 'ok')
console.log(`days in log: ${all.length}`)
for (const s of [ 'ok', 'no_hukamnama', 'fetch_failed', 'parse_failed' ]) {
  const n = all.filter(r => r.status === s).length
  if (n) console.log(`  ${s}: ${n}`)
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '-'
const median = a => {
  if (!a.length) return null
  const s = [ ...a ].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

for (const key of [ 'sggs', 'dsg' ]) {
  const G = ok.map(r => r.granths[key]).filter(Boolean)
  if (!G.length) continue
  const label = key.toUpperCase()
  const conf = { high: 0, medium: 0, low: 0 }
  for (const g of G) conf[g.confidence]++

  console.log(`\n=== ${label} ===`)
  console.log(`days: ${G.length}   high=${conf.high} (${pct(conf.high, G.length)})  ` +
              `medium=${conf.medium}  low=${conf.low}`)

  const margins = G.map(g => g.margin).filter(m => m != null).sort((a, b) => a - b)
  console.log(`margin: min=${margins[0]}  p05=${margins[Math.floor(margins.length * 0.05)]}  ` +
              `median=${median(margins)}  max=${margins[margins.length - 1]}`)

  // Largest empty band in the margin distribution — a wide gap means a
  // threshold can cleanly separate ambiguous matches from confident ones.
  let gap = { size: 0, lo: null, hi: null }
  for (let i = 1; i < margins.length; i++) {
    const d = margins[i] - margins[i - 1]
    if (d > gap.size) gap = { size: d, lo: margins[i - 1], hi: margins[i] }
  }
  console.log(`widest empty margin band: ${gap.lo} → ${gap.hi} (width ${gap.size.toFixed(3)})`)

  const deltas = G.map(g => g.ang_delta).filter(d => d != null)
  const sane = deltas.filter(d => Math.abs(d) <= 50)
  const wild = deltas.filter(d => Math.abs(d) > 50)
  console.log(`ang_delta: n=${deltas.length}  ` +
              `plausible(|d|<=50): min=${Math.min(...sane)} median=${median(sane)} max=${Math.max(...sane)}  ` +
              `IMPOSSIBLE(|d|>50): ${wild.length}`)
  if (wild.length) {
    console.log(`  impossible deltas are guaranteed-wrong matches — inspect these dates:`)
    for (const r of ok) {
      const g = r.granths[key]
      if (g && g.ang_delta != null && Math.abs(g.ang_delta) > 50) {
        console.log(`    ${r.date}  delta=${g.ang_delta}  margin=${g.margin}  ` +
                    `score=${g.score}  n=${g.n_shabads}  conf=${g.confidence}`)
      }
    }
  }

  const multi = G.filter(g => g.n_shabads > 1).length
  console.log(`multi-shabad readings: ${multi} (${pct(multi, G.length)})`)
  const noAng = G.filter(g => g.ang_scraped == null).length
  if (noAng) console.log(`days with no ang in source text: ${noAng}`)

  // Ang coverage — which parts of the granth ever actually come up.
  const angs = G.map(g => g.ang_corpus).filter(a => a != null)
  const bands = new Set(angs.map(a => Math.floor(a / 100) * 100))
  console.log(`ang range seen: ${Math.min(...angs)}-${Math.max(...angs)}  ` +
              `(${new Set(angs).size} unique angs, ${bands.size} of 15 hundred-bands)`)
}

// Cross-check: for SGGS the two editions paginated identically in the pilot.
// If that holds at scale, a non-zero SGGS delta is a free error detector.
const sggsNonZero = ok.filter(r => r.granths.sggs && r.granths.sggs.ang_delta)
console.log(`\nSGGS days where ang disagrees: ${sggsNonZero.length}`)
for (const r of sggsNonZero.slice(0, 20)) {
  const g = r.granths.sggs
  console.log(`  ${r.date}  ${g.ang_scraped} vs ${g.ang_corpus} (${g.ang_delta >= 0 ? '+' : ''}${g.ang_delta})  margin=${g.margin}`)
}
