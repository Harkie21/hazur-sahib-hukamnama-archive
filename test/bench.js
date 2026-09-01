'use strict'

/**
 * Scale benchmark. Reconstructs Nanded-style input from known corpus shabads
 * (Unicode, vishraams flattened to double spaces, ang appended in Gurmukhi
 * numerals) and checks that the resolver finds its way home.
 *
 * WHAT THIS PROVES: the normalisation, scoring and thresholds are sound, and
 * the resolver does not confidently return the wrong shabad.
 *
 * WHAT THIS DOES NOT PROVE: that the Nanded *edition* agrees with Shabad OS.
 * Input here is corpus-derived, so it carries none of the real orthographic
 * divergence (ਆਪਣੇ/ਅਪਨੇ, ਅਰਿਓ/ਅਰਿਯੋ) seen in live scrapes. Only bin/backfill.js
 * against the live site measures that. Do not treat a green run here as
 * permission to ship.
 */

const Database = require('better-sqlite3')
const { toUnicode } = require('gurmukhi-utils')
const { Resolver } = require('../lib/resolve')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const N = Number(process.env.BENCH_N || 400)
// A random draw made CI a lottery: the YLS/K26 duplicate-salok flaw sat in the
// corpus for weeks and only surfaced when one run happened to draw it. The
// sample is seeded so a green run means the same thing every time; sweep wider
// by running several seeds rather than by hoping.
const SEED = Number(process.env.BENCH_SEED || 1)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Partial Fisher-Yates: the first n of a seeded shuffle, without copying the rest. */
function sample(items, n, rng) {
  const pool = items.slice()
  const take = Math.min(n, pool.length)
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
  }
  return pool.slice(0, take)
}

const GURMUKHI_DIGITS = '੦੧੨੩੪੫੬੭੮੯'
const toGurmukhiNum = n => String(n).split('').map(d => GURMUKHI_DIGITS[+d]).join('')

const db = new Database(DB_PATH, { readonly: true })
const resolver = new Resolver(DB_PATH)
const linesFor = db.prepare(
  'SELECT gurmukhi, source_page FROM lines WHERE shabad_id = ? ORDER BY order_id'
)

function simulateScrape(shabadId) {
  const rows = linesFor.all(shabadId)
  if (!rows.length) return null
  let bani = rows.map(r => toUnicode(r.gurmukhi)).join(' ')
  bani = bani.replace(/[;,]/g, '  ')             // Nanded uses spacing, not marks
  bani += ` ਅੰਗ-${toGurmukhiNum(rows[0].source_page)}`
  return { heading: '', bani }
}

let exitCode = 0

console.log(`seed=${SEED} n=${N} (override with BENCH_SEED / BENCH_N)\n`)

for (const sourceId of [ 1, 2 ]) {
  // ORDER BY id, not random(): the seed alone must determine the draw.
  const all = db.prepare(
    'SELECT id FROM shabads WHERE source_id = ? ORDER BY id'
  ).all(sourceId).map(r => r.id)
  const ids = sample(all, N, mulberry32(SEED + sourceId))

  const stat = { correctConfident: 0, correctFlagged: 0, confidentlyWrong: 0, refused: 0 }
  const wrongExamples = []

  for (const id of ids) {
    const input = simulateScrape(id)
    if (!input) continue
    const r = resolver.resolve(input.heading, input.bani, sourceId)
    const right = Array.isArray(r.shabad_ids) && r.shabad_ids.includes(id)
    if (right && r.ok) stat.correctConfident++
    else if (right) stat.correctFlagged++
    else if (r.ok) {
      stat.confidentlyWrong++
      if (wrongExamples.length < 5) wrongExamples.push({ expected: id, got: r })
    } else stat.refused++
  }

  const label = sourceId === 1 ? 'SGGS' : 'DSG '
  const n = ids.length
  console.log(
    `${label} n=${n}  correct+confident=${stat.correctConfident} ` +
    `(${(100 * stat.correctConfident / n).toFixed(1)}%)  ` +
    `correct-but-flagged=${stat.correctFlagged}  ` +
    `refused=${stat.refused}  CONFIDENTLY WRONG=${stat.confidentlyWrong}`
  )
  for (const w of wrongExamples) {
    console.log(`   expected ${w.expected} got ${JSON.stringify(w.got)}`)
  }
  if (stat.confidentlyWrong > 0) exitCode = 1
}

console.log(exitCode ? '\nBLOCKER: resolver returned a wrong shabad confidently' : '\nno confident errors')
process.exit(exitCode)
