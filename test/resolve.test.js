'use strict'

const assert = require('assert')
const {
  Resolver, canon, splitLines, extractAng, extractCounters,
} = require('../lib/resolve')
const { parsePage, parseJson, toSiteDateFormat } = require('../lib/scrape')
const fixtures = require('./fixtures.json')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('extraction')
check('gurmukhi ang', () => assert.strictEqual(extractAng('… ॥੨॥੧॥ ਅੰਗ-੭੧੧'), 711))
check('ascii ang', () => assert.strictEqual(extractAng('… ਅੰਗ-711'), 711))
check('no ang', () => assert.strictEqual(extractAng('ਸੰਤਨ ਅਵਰ ਨ ਕਾਹੂ ਜਾਨੀ ॥'), null))
check('all counters', () => assert.deepStrictEqual(
  extractCounters('… ॥੧੫੯੬॥ … ॥੧੫੯੭॥'), [ 1596, 1597 ]))
check('dsg counter', () => assert.deepStrictEqual(extractCounters('… ॥੧੪੭੨॥'), [ 1472 ]))

console.log('\ncanon')
check('mangal dropped', () => assert.strictEqual(canon('ੴ ਸਤਿਗੁਰ ਪ੍ਰਸਾਦਿ ॥'), ''))
check('vishraam-insensitive', () => assert.strictEqual(
  canon('ਹਰਿ ਕੈ; ਜਾ ਕੋ'), canon('ਹਰਿ ਕੈ  ਜਾ ਕੋ')))
check('counter-insensitive', () => assert.strictEqual(
  canon('ਮਨੁ ਮਾਨੀ ॥੨॥੧॥'), canon('ਮਨੁ ਮਾਨੀ ॥')))

console.log('\nsplitLines')
check('short headings fold into neighbours', () => {
  const l = splitLines('ਦੋਹਰਾ ॥ ਦੇਖਿ ਜੁਧਿਸਟਰਿ ਓਰਿ ਪ੍ਰਭੁ ਅਪਨੋ ਭਗਤਿ ਬਿਚਾਰਿ ॥ ਰਹਾਉ ॥')
  assert.ok(l.length >= 1, 'expected at least one usable line')
  assert.ok(l.every(x => canon(x).length >= 8), 'no stub lines may survive')
})

console.log('\nscrape parser')
const FIXTURE_HTML = `
<html><body>
<h4><a href="#collapseOne">Guru Granth Sahib Ji</a></h4>
<table><tr><th colspan="2">Guru Granth Sahib Ji</th></tr>
<tr><td>Heading</td><td>ਟੋਡੀ ਮਹਲਾ ੫ ॥</td></tr>
<tr><td>Bani</td><td>ਸੰਤਨ ਅਵਰ ਨ ਕਾਹੂ ਜਾਨੀ ॥ ਅੰਗ-੭੧੧</td></tr>
</table>
<h4><a href="#collapseTwo">Dasam Granth Sahib Ji</a></h4>
<table><tr><th colspan="2">Dasam Granth Sahib Ji</th></tr>
<tr><td>Heading</td><td>ਸ੍ਵੈਯਾ ॥</td></tr>
<tr><td>Bani</td><td>ਆਯੁਧ ਲੈ ਸਬ ਹੀ ॥੧੪੭੨॥ ਅੰਗ-੪੪੬</td></tr>
</table>
</body></html>`

check('parses both granths', () => {
  const s = parsePage(FIXTURE_HTML)
  assert.strictEqual(s.length, 2)
  assert.strictEqual(s[0].source_id, 1)
  assert.strictEqual(s[1].source_id, 2)
})
check('fails loud on unknown layout', () => {
  assert.throws(
    () => parsePage('<html><body><table><tr><td>x</td><td>y</td></tr></table></body></html>'),
    /layout_changed'?/
  )
})

console.log('\njson parser (the real endpoint — search_hukaamnama returns JSON,')
console.log('mislabelled text/html; confirmed live 2026-08-26)')
const JSON_FIXTURE = JSON.stringify([
  {
    id: '3238', granth_type: 'Guru Granth', date: '01-06-2026',
    heading: 'ਟੋਡੀ ਮਃ ੫ ॥',
    bani: 'ਕਿਰਪਨ ਤਨ ਮਨ ਕਿਲਵਿਖ ਭਰੇ ॥\r\nਸਾਧਸੰਗਿ ਭਜਨੁ ਕਰਿ ਸੁਆਮੀ \r\nਢਾਕਨ ਕਉ ਇਕੁ ਹਰੇ ॥੧॥ ਰਹਾਉ ॥\r\nਅੰਗ-੭੧੪',
    punjabi_meaning: '', english_meaning: '',
  },
  {
    id: '3239', granth_type: 'Dasam Granth', date: '01-06-2026',
    heading: 'ਸ੍ਵੈਯਾ ॥',
    bani: 'ਪਾਨ ਸੰਭਾਰ ਬਡੋ ਧਨੁ ਭੂਪਤ\r\nਰੁਦ੍ਰ ਲਿਲਾਟ ਮੈ ਬਾਨ ਲਗਾਯੋ ॥੧੫੬੩॥\r\nਅੰਗ-੪੫੬',
    punjabi_meaning: '', english_meaning: '',
  },
])
check('parses the real JSON shape', () => {
  const s = parseJson(JSON_FIXTURE)
  assert.strictEqual(s.length, 2)
  assert.strictEqual(s[0].source_id, 1)
  assert.strictEqual(s[1].source_id, 2)
  assert.match(s[0].bani, /ਅੰਗ-੭੧੪/)
  assert.ok(!s[0].bani.includes('\r\n'), 'newlines should be flattened to spaces')
})
check('json parser rejects non-array payloads', () => {
  assert.throws(() => parseJson('{"error":"not found"}'), /layout_changed/)
})
check('json parser rejects garbage', () => {
  assert.throws(() => parseJson('<html>not json</html>'), /layout_changed/)
})
check('date format DD-MM-YYYY (confirmed via devtools payload)', () => {
  assert.strictEqual(toSiteDateFormat('2026-08-26'), '26-08-2026')
})

console.log('\nreal scrapes (verified by hand against 4.8.7)')
const R = new Resolver(DB_PATH)

for (const c of fixtures.cases) {
  check(`${c.date} ${c.source_id === 1 ? 'SGGS' : 'DSG'} — ${c.why}`, () => {
    const r = R.resolve(c.heading, c.bani, c.source_id)
    assert.ok(r.ok, `refused: ${JSON.stringify(r)}`)
    assert.deepStrictEqual(r.shabad_ids, c.expect, JSON.stringify(r))
    assert.strictEqual(r.coverage, 1, `incomplete coverage: ${JSON.stringify(r)}`)
    assert.ok(r.line_ids.length > 0, 'line_ids must be populated')
  })
}

console.log('\ninvariants')
check('ang disagreement never vetoes a strong text match', () => {
  const c = fixtures.cases.find(x => x.date === '2026-08-23')
  const r = R.resolve(c.heading, c.bani, c.source_id)
  assert.notStrictEqual(r.ang_delta, 0, 'this fixture is chosen because ang disagrees')
  assert.ok(r.ok)
})
check('ang_delta takes both signs across real days', () => {
  const deltas = fixtures.cases
    .filter(c => c.source_id === 2)
    .map(c => R.resolve(c.heading, c.bani, c.source_id).ang_delta)
  assert.ok(deltas.some(d => d > 0), `expected a positive delta, got ${deltas}`)
  assert.ok(deltas.some(d => d < 0), `expected a negative delta, got ${deltas}`)
  assert.ok(deltas.some(d => d === 0), `expected a zero delta, got ${deltas}`)
})
check('multi-shabad readings return every shabad, in order', () => {
  const c = fixtures.cases.find(x => x.date === '2026-08-23')
  const r = R.resolve(c.heading, c.bani, c.source_id)
  assert.strictEqual(r.shabad_ids.length, 2)
})
check('garbage refuses rather than guessing', () => {
  const r = R.resolve('', 'ਕ ਖ ਗ ਘ ਙ ਚ ਛ ਜ ਝ ਞ ਟ ਠ ਡ ਢ ਣ ਤ ਥ ਦ ਧ ਨ ਪ ਫ ਬ ਭ ਮ', 1)
  assert.ok(!r.ok, `should not resolve: ${JSON.stringify(r)}`)
  assert.strictEqual(r.confidence, 'low')
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
