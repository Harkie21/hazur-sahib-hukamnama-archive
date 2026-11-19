'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { withRetry, isTransient, readWhole, NoHukamnamaError, LayoutChangedError, REQUEST_TIMEOUT_MS } = require('../lib/scrape')
const { run } = require('../bin/fetch-today')
const { SOURCE_SGGS } = require('../lib/resolve')

let failures = 0
const queue = []
const check = (name, fn) => queue.push(async () => {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
})

const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const networkError = () => new TypeError('fetch failed')
const res = status => ({ status })

/** An attempt function that plays back `script`, one entry per call. */
function scripted(script) {
  const calls = { n: 0 }
  const attempt = async () => {
    const step = script[calls.n++]
    if (step instanceof Error) throw step
    return step
  }
  return { attempt, calls }
}

const quiet = { wait: async () => {}, log: () => {} }

const section = title => queue.push(async () => console.log(title))

section('retry')

check('each request gets 60 s', () => {
  assert.strictEqual(REQUEST_TIMEOUT_MS, 60_000)
})
check('a timeout then a 200 succeeds on the second attempt', async () => {
  const { attempt, calls } = scripted([ timeoutError(), res(200) ])
  assert.strictEqual((await withRetry(attempt, quiet)).status, 200)
  assert.strictEqual(calls.n, 2)
})
check('network errors and 5xx are retried, waiting 5, 15 and 45 s', async () => {
  const waits = []
  const { attempt, calls } = scripted([ networkError(), res(503), timeoutError(), res(200) ])
  const r = await withRetry(attempt, { wait: async ms => waits.push(ms), log: () => {} })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(calls.n, 4)
  assert.deepStrictEqual(waits, [ 5_000, 15_000, 45_000 ])
})
check('after 3 retries the last timeout is thrown', async () => {
  const { attempt, calls } = scripted([ timeoutError(), timeoutError(), timeoutError(), timeoutError() ])
  await assert.rejects(withRetry(attempt, quiet), { name: 'TimeoutError' })
  assert.strictEqual(calls.n, 4)
})
check('after 3 retries the last 5xx response is returned', async () => {
  const { attempt, calls } = scripted([ res(502), res(502), res(502), res(500) ])
  assert.strictEqual((await withRetry(attempt, quiet)).status, 500)
  assert.strictEqual(calls.n, 4)
})
check('a 4xx is an answer, not retried', async () => {
  const { attempt, calls } = scripted([ res(403) ])
  assert.strictEqual((await withRetry(attempt, quiet)).status, 403)
  assert.strictEqual(calls.n, 1)
})
check('any other error is thrown at once', async () => {
  const { attempt, calls } = scripted([ new Error('boom') ])
  await assert.rejects(withRetry(attempt, quiet), /boom/)
  assert.strictEqual(calls.n, 1)
})
check('a reply that stalls mid body is retried', async () => {
  let n = 0
  const stalled = { status: 200, ok: true, headers: new Map(), text: async () => { throw timeoutError() } }
  const whole = { status: 200, ok: true, headers: new Map(), text: async () => '[]' }
  const r = await withRetry(() => Promise.resolve(n++ === 0 ? stalled : whole).then(readWhole), quiet)
  assert.strictEqual(n, 2)
  assert.strictEqual(await r.text(), '[]')
})
check('no delays means one attempt', async () => {
  const { attempt, calls } = scripted([ timeoutError(), res(200) ])
  await assert.rejects(withRetry(attempt, { delays: [] }), { name: 'TimeoutError' })
  assert.strictEqual(calls.n, 1)
})
check('transient covers timeouts, aborts, fetch failed and terminated only', () => {
  assert.ok(isTransient(timeoutError()))
  assert.ok(isTransient(Object.assign(new Error('x'), { name: 'AbortError' })))
  assert.ok(isTransient(networkError()))
  assert.ok(isTransient(new TypeError('terminated')))
  assert.ok(!isTransient(new TypeError('x is not a function')))
  assert.ok(!isTransient(new LayoutChangedError('x')))
})

section('\nfetch-today run')

const OK_RESULT = {
  ok: true, shabad_ids: [ 'PLN' ], line_ids: [ 'ABCD' ], confidence: 'high',
  score: 1.0, margin: 0.588, ang_scraped: 711, ang_delta: 0, counters: [ 2 ],
}
const SECTIONS = [ { source_id: SOURCE_SGGS, heading: 'h', bani: 'b' } ]
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hazur-fetch-test-'))
const files = dir => fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.json')).sort()

function stubRun(dir, fetchSections, env = {}) {
  const asked = []
  const code = run({
    fetchSections: async date => { asked.push(date); return fetchSections(date) },
    today: () => '2026-11-18',
    env,
    archiveDir: dir,
    makeResolver: () => ({ resolve: () => OK_RESULT }),
    corpusVersion: '4.8.7',
    log: () => {},
  })
  return { code, asked }
}
const notPosted = async () => { throw new NoHukamnamaError('empty array') }

check('not yet: exit 0 and nothing written', async () => {
  const dir = tmpDir()
  assert.strictEqual(await stubRun(dir, notPosted).code, 0)
  assert.strictEqual(await stubRun(dir, notPosted, { FINAL_RUN: '' }).code, 0)
  assert.deepStrictEqual(files(dir), [])
})
check('not yet on the final run: exit 1 and nothing written', async () => {
  const dir = tmpDir()
  assert.strictEqual(await stubRun(dir, notPosted, { FINAL_RUN: '1' }).code, 1)
  assert.deepStrictEqual(files(dir), [])
})
check('a layout change still throws, final run or not', async () => {
  const dir = tmpDir()
  const broken = async () => { throw new LayoutChangedError('x') }
  await assert.rejects(stubRun(dir, broken).code, /layout_changed/)
  assert.deepStrictEqual(files(dir), [])
})
check('a posted day is fetched for today\'s IST date and written', async () => {
  const dir = tmpDir()
  const { code, asked } = stubRun(dir, async () => SECTIONS, { FINAL_RUN: '1' })
  assert.strictEqual(await code, 0)
  assert.deepStrictEqual(asked, [ '2026-11-18' ])
  assert.deepStrictEqual(files(dir), [ path.join('2026', '11', '18.json'), 'latest.json' ])
})

;(async () => {
  for (const step of queue) await step()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
