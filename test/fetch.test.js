'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  withRetry, isTransient, isUnavailable, readWhole, parseJson, parseJsonForDate, slotDayIST,
  NoHukamnamaError, ServerUnavailableError, LayoutChangedError, REQUEST_TIMEOUT_MS,
} = require('../lib/scrape')
const { run, FINAL_SLOT } = require('../bin/fetch-today')
const { SOURCE_SGGS, SOURCE_DSG } = require('../lib/resolve')
const { pack } = require('../lib/pack')

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
const DSG_RESULT = {
  ok: true, shabad_ids: [ 'D7K' ], line_ids: [ 'Q1W2' ], confidence: 'high',
  score: 0.97, margin: 0.41, ang_scraped: 1201, ang_delta: 0, counters: [ 1 ],
}
const SECTIONS = [ { source_id: SOURCE_SGGS, heading: 'h', bani: 'b' } ]
const BOTH = [ ...SECTIONS, { source_id: SOURCE_DSG, heading: 'dh', bani: 'db' } ]
const byGranth = (sggs = OK_RESULT) => () => ({ resolve: (h, b, id) => id === SOURCE_DSG ? DSG_RESULT : sggs })
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hazur-fetch-test-'))
const files = dir => fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.json')).sort()

function stubRun(dir, fetchSections, env = {}, {
  now = new Date('2026-11-18T01:00:00Z'),
  makeResolver = byGranth(),
} = {}) {
  const asked = []
  const lines = []
  const code = run({
    fetchSections: async date => { asked.push(date); return fetchSections(date) },
    today: () => '2026-11-18',
    now: () => now.getTime(),
    env,
    archiveDir: dir,
    makeResolver,
    corpusVersion: '4.8.7',
    log: msg => lines.push(msg),
  })
  return { code, asked, lines }
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
check('a day already written with dsg: exit 0 with no request and no corpus load', async () => {
  const dir = tmpDir()
  await stubRun(dir, async () => BOTH).code
  const before = fs.readFileSync(path.join(dir, '2026', '11', '18.json'), 'utf8')
  let loads = 0
  const { code, asked, lines } = stubRun(dir, async () => BOTH, { FINAL_RUN: '1' }, {
    makeResolver: () => { loads++; return byGranth()() },
  })
  assert.strictEqual(await code, 0)
  assert.deepStrictEqual(asked, [])
  assert.strictEqual(loads, 0)
  assert.deepStrictEqual(lines, [ 'already_have 2026-11-18' ])
  assert.strictEqual(fs.readFileSync(path.join(dir, '2026', '11', '18.json'), 'utf8'), before)
})
check('a missing corpus fails before any request', async () => {
  const dir = tmpDir()
  const { code, asked } = stubRun(dir, notPosted, {}, {
    makeResolver: () => { throw new Error('corpus not found') },
  })
  await assert.rejects(code, /corpus not found/)
  assert.deepStrictEqual(asked, [])
})
check('a site still down after the retries: exit 0, and 1 on the final run', async () => {
  for (const err of [ timeoutError(), networkError(), new ServerUnavailableError('http_503') ]) {
    const dir = tmpDir()
    const down = async () => { throw err }
    const quietRun = stubRun(dir, down)
    assert.strictEqual(await quietRun.code, 0)
    assert.match(quietRun.lines[0], /^unavailable /)
    assert.strictEqual(await stubRun(dir, down, { FINAL_RUN: '1' }).code, 1)
    assert.deepStrictEqual(files(dir), [])
  }
})
check('any other fetch error still throws', async () => {
  const dir = tmpDir()
  await assert.rejects(stubRun(dir, async () => { throw new Error('http_404') }).code, /http_404/)
  assert.deepStrictEqual(files(dir), [])
})
check('unavailable covers transient errors and a final 5xx only', () => {
  assert.ok(isUnavailable(timeoutError()))
  assert.ok(isUnavailable(new ServerUnavailableError('http_502')))
  assert.ok(!isUnavailable(new Error('http_404')))
  assert.ok(!isUnavailable(new LayoutChangedError('x')))
})

section('\nscheduled slot day')

check('slotDayIST: the slot\'s IST day, however late the run starts', () => {
  // 05:30 UTC is 11:00 IST; a start at 19:00 UTC is already 00:30 IST on the next day.
  assert.strictEqual(slotDayIST('30 05 * * *', new Date('2026-11-17T19:00:00Z')), '2026-11-17')
  assert.strictEqual(slotDayIST('30 05 * * *', new Date('2026-11-17T05:30:00Z')), '2026-11-17')
  assert.strictEqual(slotDayIST('30 05 * * *', new Date('2026-11-18T04:00:00Z')), '2026-11-17')
  // 23:30 UTC is 05:00 IST on the next day.
  assert.strictEqual(slotDayIST('30 23 * * *', new Date('2026-11-17T23:40:00Z')), '2026-11-18')
  assert.strictEqual(slotDayIST('30 23 * * *', new Date('2026-11-18T04:36:00Z')), '2026-11-18')
})
check('slotDayIST: null for a manual run or a non-daily line', () => {
  for (const cron of [ undefined, '', '*/15 * * * *', '30 05 * * 1' ]) {
    assert.strictEqual(slotDayIST(cron, new Date('2026-11-17T19:00:00Z')), null)
  }
})
check('a late final slot after IST midnight asks for its own day and writes it', async () => {
  const dir = tmpDir()
  const { code, asked } = stubRun(dir, async () => SECTIONS,
    { FINAL_RUN: '1', SCHEDULE: '30 05 * * *' }, { now: new Date('2026-11-17T19:00:00Z') })
  assert.strictEqual(await code, 0)
  assert.deepStrictEqual(asked, [ '2026-11-17' ])
  assert.deepStrictEqual(files(dir), [ path.join('2026', '11', '17.json'), 'latest.json' ])
})
check('a late final slot still goes red when its own day never appeared', async () => {
  const dir = tmpDir()
  const { code, asked } = stubRun(dir, notPosted,
    { FINAL_RUN: '1', SCHEDULE: '30 05 * * *' }, { now: new Date('2026-11-17T19:00:00Z') })
  assert.strictEqual(await code, 1)
  assert.deepStrictEqual(asked, [ '2026-11-17' ])
})
check('a dispatched run asks for today', async () => {
  const { asked } = stubRun(tmpDir(), notPosted, { SCHEDULE: '' }, { now: new Date('2026-11-17T19:00:00Z') })
  assert.deepStrictEqual(asked, [ '2026-11-18' ])
})
check('writing an earlier day never takes latest.json backwards', async () => {
  const dir = tmpDir()
  await stubRun(dir, async () => SECTIONS).code
  const latest = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')
  const { code } = stubRun(dir, async () => SECTIONS,
    { FINAL_RUN: '1', SCHEDULE: '30 05 * * *' }, { now: new Date('2026-11-17T19:00:00Z') })
  assert.strictEqual(await code, 0)
  assert.ok(fs.existsSync(path.join(dir, '2026', '11', '17.json')))
  assert.strictEqual(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), latest)
})

check('an unreadable latest.json fails the run before any write', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'latest.json'), '{ not json')
  await assert.rejects(stubRun(dir, async () => SECTIONS).code, SyntaxError)
  assert.deepStrictEqual(files(dir), [ 'latest.json' ])
  assert.strictEqual(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), '{ not json')
})

section('\nfilling a missing dsg')

const dayFile = dir => path.join(dir, '2026', '11', '18.json')
const read = file => fs.readFileSync(file, 'utf8')
/** A day written by the 05:00 IST slot while the site had posted only the Guru Granth half. */
async function sggsOnlyDay() {
  const dir = tmpDir()
  assert.strictEqual(await stubRun(dir, async () => SECTIONS).code, 0)
  assert.strictEqual(JSON.parse(read(dayFile(dir))).dsg, null)
  return dir
}
/** The file as it should read once filled: the null replaced by the dsg block and nothing else. */
const filled = before => before.replace('"dsg": null', `"dsg": ${JSON.stringify(pack(DSG_RESULT), null, 2).replace(/\n/g, '\n  ')}`)

check('before the final slot a missing dsg is filled and nothing else changes', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  const { code, asked, lines } = stubRun(dir, async () => BOTH, {}, { now: new Date('2026-11-18T05:29:59Z') })
  assert.strictEqual(await code, 0)
  assert.deepStrictEqual(asked, [ '2026-11-18' ])
  assert.ok(lines.includes('filled_dsg 2026-11-18'))
  assert.notStrictEqual(filled(before), before)
  assert.strictEqual(read(dayFile(dir)), filled(before))
  assert.strictEqual(read(path.join(dir, 'latest.json')), filled(before))
  assert.deepStrictEqual(Object.keys(JSON.parse(read(dayFile(dir)))), Object.keys(JSON.parse(before)))
})
check('a latest.json already on a later day is left alone', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  const later = before.replace('"date": "2026-11-18"', '"date": "2026-11-19"')
  fs.writeFileSync(path.join(dir, 'latest.json'), later)
  assert.strictEqual(await stubRun(dir, async () => BOTH).code, 0)
  assert.strictEqual(read(dayFile(dir)), filled(before))
  assert.strictEqual(read(path.join(dir, 'latest.json')), later)
})
check('a site still showing only the Guru Granth half writes nothing and stays green', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  for (const env of [ {}, { FINAL_RUN: '1' } ]) {
    const { code, lines } = stubRun(dir, async () => SECTIONS, env)
    assert.strictEqual(await code, 0)
    assert.deepStrictEqual(lines.filter(l => !l.includes('\t')), [ 'dsg_not_yet 2026-11-18' ])
  }
  assert.strictEqual(read(dayFile(dir)), before)
  assert.strictEqual(read(path.join(dir, 'latest.json')), before)
})
check('not yet and unavailable stay green on the final run as well', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  const cases = [ [ notPosted, /^dsg_not_yet 2026-11-18$/ ], [ async () => { throw timeoutError() }, /^dsg_unavailable 2026-11-18 / ] ]
  for (const [ fetchSections, line ] of cases) {
    for (const env of [ {}, { FINAL_RUN: '1' } ]) {
      const { code, lines } = stubRun(dir, fetchSections, env)
      assert.strictEqual(await code, 0)
      assert.match(lines[0], line)
    }
  }
  assert.strictEqual(read(dayFile(dir)), before)
})
check('from the final slot on a dispatched run asks nothing', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  for (const now of [ '2026-11-18T05:30:00Z', '2026-11-18T09:00:00Z' ]) {
    const { code, asked, lines } = stubRun(dir, async () => BOTH, { SCHEDULE: '' }, { now: new Date(now) })
    assert.strictEqual(await code, 0)
    assert.deepStrictEqual(asked, [])
    assert.deepStrictEqual(lines, [ 'already_have 2026-11-18' ])
  }
  assert.strictEqual(read(dayFile(dir)), before)
})
check('a final slot starting late still asks and fills', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  const { code, asked } = stubRun(dir, async () => BOTH,
    { FINAL_RUN: '1', SCHEDULE: FINAL_SLOT }, { now: new Date('2026-11-18T11:00:00Z') })
  assert.strictEqual(await code, 0)
  assert.deepStrictEqual(asked, [ '2026-11-18' ])
  assert.strictEqual(read(dayFile(dir)), filled(before))
})
check('a refetched Guru Granth half that differs is warned about and never rewritten', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  const other = { ...OK_RESULT, shabad_ids: [ 'XYZ' ], line_ids: [ 'ZZZZ' ] }
  const { code, lines } = stubRun(dir, async () => BOTH, {}, { makeResolver: byGranth(other) })
  assert.strictEqual(await code, 0)
  assert.ok(lines.some(l => /^WARNING: 2026-11-18 already published as \["PLN"\], now \["XYZ"\]/.test(l)), lines.join('\n'))
  const after = JSON.parse(read(dayFile(dir)))
  assert.deepStrictEqual(after.shabad_ids, [ 'PLN' ])
  assert.deepStrictEqual(after.sggs, JSON.parse(before).sggs)
  assert.strictEqual(read(dayFile(dir)), filled(before))
})
check('a layout change in the fill path still throws', async () => {
  const dir = await sggsOnlyDay()
  const before = read(dayFile(dir))
  await assert.rejects(stubRun(dir, async () => { throw new LayoutChangedError('x') }, { FINAL_RUN: '1' }).code, /layout_changed/)
  assert.strictEqual(read(dayFile(dir)), before)
})
check('the final slot is the cron line daily.yml marks final', () => {
  const yml = read(path.join(__dirname, '..', '.github', 'workflows', 'daily.yml'))
  const crons = [ ...yml.matchAll(/- cron: '([^']+)'/g) ].map(m => m[1])
  assert.ok(crons.includes(FINAL_SLOT), crons.join(', '))
  const finals = [ ...yml.matchAll(/github\.event\.schedule == '([^']+)'/g) ].map(m => m[1])
  assert.strictEqual(finals.length, 2)
  assert.deepStrictEqual([ ...new Set(finals) ], [ FINAL_SLOT ])
})

section('\nparse')

const record = (over = {}) => ({ id: '1', granth_type: 'Guru Granth', date: '18-11-2026', heading: 'h', bani: 'b', ...over })
check('a record for the asked date is kept', () => {
  assert.strictEqual(parseJsonForDate(JSON.stringify([ record() ]), '2026-11-18').length, 1)
})
check('padded and unpadded dates both match', () => {
  for (const date of [ '01-06-2026', '1-6-2026', '01-6-2026', '1-06-2026' ]) {
    assert.strictEqual(parseJsonForDate(JSON.stringify([ record({ date }) ]), '2026-06-01').length, 1, date)
  }
})
check('an unpadded date for another day is nothing published', () => {
  assert.throws(() => parseJsonForDate(JSON.stringify([ record({ date: '31-5-2026' }) ]), '2026-06-01'),
    e => e instanceof NoHukamnamaError)
})
check('a date not in DD-MM-YYYY is a layout change', () => {
  for (const date of [ '2026-06-01', '01/06/2026', '01-06-26', 'June 1' ]) {
    assert.throws(() => parseJsonForDate(JSON.stringify([ record({ date }) ]), '2026-06-01'),
      e => e instanceof LayoutChangedError, date)
  }
})
check('a record for another date is nothing published for the asked one', () => {
  assert.throws(() => parseJsonForDate(JSON.stringify([ record({ date: '17-11-2026' }) ]), '2026-11-18'),
    e => e instanceof NoHukamnamaError && /17-11-2026/.test(e.message))
})
check('a record with no date is a layout change', () => {
  assert.throws(() => parseJsonForDate(JSON.stringify([ record({ date: undefined }) ]), '2026-11-18'),
    e => e instanceof LayoutChangedError)
})
check('rows with no known granth_type are a layout change', () => {
  assert.throws(() => parseJson(JSON.stringify([ record({ granth_type: 'Adi Granth' }), record({ granth_type: 'SGGS' }) ])),
    e => e instanceof LayoutChangedError && /SGGS/.test(e.message))
})
check('a known granth with no bani is nothing published', () => {
  assert.throws(() => parseJson(JSON.stringify([ record({ bani: '' }) ])), e => e instanceof NoHukamnamaError)
})

;(async () => {
  for (const step of queue) await step()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
