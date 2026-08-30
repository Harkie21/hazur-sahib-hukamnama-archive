'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { writeDay, writeLatest } = require('../lib/write')
const { buildPayload } = require('../bin/fetch-today')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

function tmpArchiveDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-latest-test-'))
}

const OK_RESULT = {
  ok: true, shabad_ids: [ 'PLN' ], line_ids: [ 'ABCD' ], confidence: 'high',
  score: 1.0, margin: 0.588, ang_scraped: 711, ang_delta: 0, counters: [ 2 ],
}
const FAILED_RESULT = {
  ok: false, confidence: 'low', score: 0.2, margin: 0.05, ang_scraped: 711,
  ang_delta: 5, counters: [],
}

console.log('archive/latest.json')

check('key set matches the dated file exactly', () => {
  const dir = tmpArchiveDir()
  const payload = buildPayload('2026-08-26', { sggs: OK_RESULT, dsg: OK_RESULT }, '4.8.7')
  writeDay(dir, payload)
  writeLatest(dir, payload)

  const dated = JSON.parse(fs.readFileSync(path.join(dir, '2026', '08', '26.json'), 'utf8'))
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'))

  assert.deepStrictEqual(Object.keys(latest).sort(), Object.keys(dated).sort())
  assert.deepStrictEqual(Object.keys(latest.sggs).sort(), Object.keys(dated.sggs).sort())
  assert.deepStrictEqual(latest, dated)
})

check('buildPayload throws on a failed SGGS resolution, before any write is reachable', () => {
  assert.throws(
    () => buildPayload('2026-08-27', { sggs: FAILED_RESULT, dsg: OK_RESULT }, '4.8.7'),
    /sggs_unresolved/
  )
})

check('a stale latest.json survives a failed run untouched', () => {
  const dir = tmpArchiveDir()
  const stale = buildPayload('2026-08-20', { sggs: OK_RESULT, dsg: OK_RESULT }, '4.8.7')
  writeLatest(dir, stale)
  const before = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  assert.throws(() => buildPayload('2026-08-27', { sggs: FAILED_RESULT }, '4.8.7'))

  const after = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')
  assert.strictEqual(after, before)
})

check('no field varies between two consecutive runs on the same day', () => {
  const dir = tmpArchiveDir()

  const run1 = buildPayload('2026-08-26', { sggs: OK_RESULT, dsg: OK_RESULT }, '4.8.7')
  writeDay(dir, run1)
  writeLatest(dir, run1)
  const day1 = fs.readFileSync(path.join(dir, '2026', '08', '26.json'), 'utf8')
  const latest1 = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  // Simulate a second cron run the same day, e.g. the 05:00 IST retry.
  const run2 = buildPayload('2026-08-26', { sggs: OK_RESULT, dsg: OK_RESULT }, '4.8.7')
  writeDay(dir, run2)
  writeLatest(dir, run2)
  const day2 = fs.readFileSync(path.join(dir, '2026', '08', '26.json'), 'utf8')
  const latest2 = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  assert.strictEqual(day1, day2)
  assert.strictEqual(latest1, latest2)
  assert.strictEqual(day1, latest1)
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
