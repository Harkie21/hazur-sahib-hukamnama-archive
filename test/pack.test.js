'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { pack } = require('../lib/pack')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const EXPECTED_KEYS = [
  'shabad_ids', 'line_ids', 'confidence', 'score', 'margin',
  'ang', 'ang_delta', 'counters',
].sort()

const SAMPLE_RESULT = {
  ok: true,
  shabad_ids: [ '0US' ],
  line_ids: [ 'ABCD', 'EFGH' ],
  confidence: 'high',
  score: 0.975,
  margin: 0.498,
  ang_scraped: 673,
  ang_delta: 0,
  counters: [ 1596, 1597 ],
}

console.log('pack() shape')
check('publishes exactly the archive contract fields', () => {
  assert.deepStrictEqual(Object.keys(pack(SAMPLE_RESULT)).sort(), EXPECTED_KEYS)
})
check('does not leak internal diagnostics', () => {
  const withDiagnostics = { ...SAMPLE_RESULT, counters_found: [ 1596 ], counter_agrees: true }
  const keys = Object.keys(pack(withDiagnostics))
  assert.ok(!keys.includes('counters_found'), 'counters_found must not be published')
  assert.ok(!keys.includes('counter_agrees'), 'counter_agrees must not be published')
})
check('null input packs to null', () => {
  assert.strictEqual(pack(null), null)
})
check('a failed resolution still reports confidence with empty shabad_ids/line_ids', () => {
  const r = pack({ ok: false, confidence: 'low', score: 0.2, margin: 0.01, ang_scraped: 100, ang_delta: 5, counters: [] })
  assert.deepStrictEqual(r.shabad_ids, [])
  assert.deepStrictEqual(r.line_ids, [])
  assert.strictEqual(r.confidence, 'low')
})

console.log('\ndaily job and bulk build share one pack()')
check('fetch-today.js imports the shared pack instead of defining its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'fetch-today.js'), 'utf8')
  assert.match(src, /require\(['"]\.\.\/lib\/pack['"]\)/)
  assert.doesNotMatch(src, /function pack\s*\(/)
})
check('build-archive.js imports the shared pack instead of defining its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'build-archive.js'), 'utf8')
  assert.match(src, /require\(['"]\.\.\/lib\/pack['"]\)/)
  assert.doesNotMatch(src, /function pack\s*\(/)
})
check('same resolver result packs identically wherever it is called from', () => {
  const a = pack(SAMPLE_RESULT)
  const b = pack(SAMPLE_RESULT)
  assert.deepStrictEqual(a, b)
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())
})

console.log('\narchive output is stable across runs')
check('fetch-today.js does not stamp a per-run timestamp into the archive', () => {
  // A generated_at (or any Date.now()/toISOString() field) makes every run's
  // output differ even when nothing about the hukamnama changed, which
  // defeats the workflow's `git diff --staged --quiet` no-op guard and turns
  // every retry cron into a duplicate commit.
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'fetch-today.js'), 'utf8')
  assert.doesNotMatch(src, /generated_at/)
  assert.doesNotMatch(src, /new Date\(\)/)
})
check('build-archive.js does not stamp a per-run timestamp into the archive', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'build-archive.js'), 'utf8')
  assert.doesNotMatch(src, /generated_at/)
  assert.doesNotMatch(src, /new Date\(\)/)
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
