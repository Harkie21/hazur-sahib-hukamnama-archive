'use strict'

const cheerio = require('cheerio')
const { SOURCE_SGGS, SOURCE_DSG } = require('./resolve')

const PAGE_URL = 'https://hazursahib.com/web/hukaamnama'
const SEARCH_URL = 'https://hazursahib.com/web/search_hukaamnama'
const USER_AGENT =
  'hazur-sahib-hukamnama-archive/0.1 (+https://github.com/Harkie21/hazur-sahib-hukamnama-archive; contact: harkiratsingh135790@gmail.com)'

class LayoutChangedError extends Error {
  constructor(detail) {
    super(`layout_changed: ${detail}`)
    this.name = 'LayoutChangedError'
  }
}

/** ISO "YYYY-MM-DD" -> the site's "DD-MM-YYYY". */
function toSiteDateFormat(dateISO) {
  const [ y, m, d ] = dateISO.split('-')
  if (!y || !m || !d) throw new Error(`bad date: ${dateISO}`)
  return `${d}-${m}-${y}`
}

/** IST date, "YYYY-MM-DD". The hukamnama is read at Nanded, so its day
 *  boundary governs "today", not the machine's local clock. */
function todayIST() {
  const now = new Date(Date.now() + (5.5 * 60 * 60 * 1000))
  return now.toISOString().slice(0, 10)
}

/**
 * IST date of the latest daily slot at or before `now`, "YYYY-MM-DD", or null
 * when `cron` is not a daily "M H * * *" line. GitHub starts slots hours late,
 * so a late run's own clock can already be on the next IST day. A run more
 * than 24 h late would get the next slot's day, which GitHub's lag never reaches.
 * @param {string} cron  github.event.schedule
 * @param {Date} now     when the run started, never before its slot
 */
function slotDayIST(cron, now) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(cron ?? '').trim())
  if (!m) return null
  let slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[2]), Number(m[1]))
  if (slot > now.getTime()) slot -= 24 * 60 * 60 * 1000
  return new Date(slot + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10)
}

function classifyGranthType(text) {
  const t = String(text).toLowerCase()
  if (t.includes('dasam')) return SOURCE_DSG
  if (t.includes('guru granth')) return SOURCE_SGGS
  return null
}

/**
 * search_hukaamnama does not return an HTML page — it returns a JSON array,
 * one object per granth, despite being served with a text/html Content-Type
 * header. Confirmed by hitting it directly (2026-08-26):
 *
 *   [
 *     { "id": "3238", "heading": "...", "bani": "line one\r\nline two\r\n...",
 *       "punjabi_meaning": "...", "english_meaning": "...",
 *       "granth_type": "Guru Granth", "date": "01-06-2026" },
 *     { "granth_type": "Dasam Granth", ... }
 *   ]
 *
 * `bani` lines are already newline-separated — real line breaks, not the
 * double-spaced single string the rendered HTML page shows. resolve.js's
 * splitLines() still works fine on this: it splits on the danda (॥), not on
 * whitespace, so flattening \r\n to spaces here keeps that contract intact.
 *
 * @param {string} raw  the response body (JSON text)
 * @returns {Array<{source_id:number, heading:string, bani:string, ...}>}
 */
class NoHukamnamaError extends Error {
  constructor(detail) {
    super(`no_hukamnama: ${detail}`)
    this.name = 'NoHukamnamaError'
  }
}

/** The server answered with a 5xx after every retry. */
class ServerUnavailableError extends Error {
  constructor(detail) {
    super(`server_unavailable: ${detail}`)
    this.name = 'ServerUnavailableError'
  }
}

/**
 * Distinguishes three outcomes, which must never be conflated:
 *
 *   returns sections   -> a hukamnama was published and parsed
 *   NoHukamnamaError   -> the server answered fine, but published nothing
 *                         that day. This is DATA, not a failure.
 *   LayoutChangedError -> the response shape is not something we understand.
 *                         This is a real failure and must go red.
 *
 * The early archive (2022) is sparse: many days return an empty payload.
 * Recording those as failures would both corrupt the dataset and hide a
 * genuine future breakage in the noise.
 */
function parseJson(raw) {
  // An empty or whitespace-only body is the server's way of saying nothing
  // was published. Seen in the 2022 portion of the archive.
  if (raw == null || String(raw).trim() === '') {
    throw new NoHukamnamaError('empty response body')
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new LayoutChangedError(`response is not valid JSON: ${e.message}`)
  }

  // null / false / 0 / "" — all seen from PHP endpoints meaning "no rows".
  if (data == null || data === false || data === 0 || data === '') {
    throw new NoHukamnamaError(`falsy payload (${JSON.stringify(data)})`)
  }

  // Some CodeIgniter handlers wrap rows, e.g. {"data":[...]} or {"result":[]}.
  if (!Array.isArray(data) && typeof data === 'object') {
    const wrapped = [ 'data', 'result', 'records', 'rows' ]
      .map(k => data[k])
      .find(Array.isArray)
    if (wrapped) data = wrapped
    else if (Object.keys(data).length === 0) {
      throw new NoHukamnamaError('empty object payload')
    } else {
      throw new LayoutChangedError(
        `expected an array, got object with keys: ${Object.keys(data).join(',')}`
      )
    }
  }

  if (!Array.isArray(data)) {
    throw new LayoutChangedError(`expected a JSON array, got ${typeof data}`)
  }
  if (data.length === 0) {
    throw new NoHukamnamaError('empty array')
  }

  const sections = []
  const seen = new Set()
  let known = 0
  for (const rec of data) {
    if (!rec || typeof rec !== 'object') continue
    const sourceId = classifyGranthType(rec.granth_type)
    if (sourceId) known++
    if (!sourceId || seen.has(sourceId)) continue
    if (!rec.bani || !String(rec.bani).trim()) continue
    seen.add(sourceId)
    sections.push({
      source_id: sourceId,
      heading: rec.heading || '',
      bani: String(rec.bani).replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim(),
      punjabi_meaning: rec.punjabi_meaning || '',
      english_meaning: rec.english_meaning || '',
      remote_id: rec.id,
      remote_date: rec.date,
    })
  }

  if (!known) {
    // No granth_type we recognise means the field was renamed or reworded,
    // which must go red rather than read as an empty day.
    const types = [ ...new Set(data.map(r => r && r.granth_type)) ]
    throw new LayoutChangedError(`${data.length} row(s) with no known granth_type: ${JSON.stringify(types)}`)
  }
  if (!sections.length) {
    // Rows of a granth we know came back with no bani. The shape was fine,
    // so treat it as nothing published rather than breakage.
    throw new NoHukamnamaError(`${data.length} row(s) but no usable granth record`)
  }
  // NOTE: a Dasam Granth-only day is possible and legitimate; do not require
  // SGGS here. The caller decides whether a missing SGGS is acceptable.
  return sections
}

// --- HTML fallback -----------------------------------------------------
// Kept in case the JSON endpoint ever changes shape or disappears. Not
// currently used by fetchForDate below — parseJson() is primary.

const norm = s => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()

function extractRows($, $scope) {
  const out = {}
  $scope.find('tr').each((_, tr) => {
    const cells = $(tr).find('td, th')
    if (cells.length < 2) return
    const label = norm($(cells[0]).text()).toLowerCase()
    const value = norm($(cells[1]).text())
    if (!value) return
    if (label === 'heading') out.heading = value
    else if (label === 'bani') out.bani = value
    else if (label === 'punjabi meaning') out.punjabi_meaning = value
    else if (label === 'english meaning') out.english_meaning = value
  })
  return out
}

function classifySource(text) {
  const t = norm(text).toLowerCase()
  if (/dasam/.test(t)) return SOURCE_DSG
  if (/guru\s*granth/.test(t)) return SOURCE_SGGS
  return null
}

/** @deprecated superseded by parseJson(); retained as a fallback parser. */
function parsePage(html) {
  if (!html || html.length < 200) throw new LayoutChangedError('empty response')

  const $ = cheerio.load(html)
  const sections = []
  const seen = new Set()

  $('table').each((_, table) => {
    const $table = $(table)
    let sourceId = classifySource($table.find('th').first().text())
    if (!sourceId) sourceId = classifySource($table.prevAll('h1,h2,h3,h4,h5,a').first().text())
    if (!sourceId) sourceId = classifySource($table.parent().prevAll('h1,h2,h3,h4,h5,a').first().text())
    if (!sourceId) return
    if (seen.has(sourceId)) return

    const rows = extractRows($, $table)
    if (!rows.bani) return

    seen.add(sourceId)
    sections.push({ source_id: sourceId, ...rows })
  })

  if (!sections.length) {
    throw new LayoutChangedError('no table matched a known granth with a Bani row')
  }
  if (!sections.some(s => s.source_id === SOURCE_SGGS)) {
    throw new LayoutChangedError('Guru Granth Sahib Ji section missing')
  }
  return sections
}

// --- HTTP ----------------------------------------------------------------

// The server has taken more than 30 s to answer a run's first request, so
// each attempt gets a minute.
const REQUEST_TIMEOUT_MS = 60_000
// Waits before each retry. One slow reply otherwise costs the day its file
// until the next slot, which GitHub's queue runs hours late.
const RETRY_DELAYS_MS = [ 5_000, 15_000, 45_000 ]

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Timeouts and dropped connections are worth another try; any other error is final. */
function isTransient(err) {
  if (!err) return false
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  return err instanceof TypeError && /fetch failed|terminated/i.test(err.message)
}

/** Reads the whole body inside the attempt, so a reply that stalls mid body is retried too. */
async function readWhole(res) {
  const text = await res.text()
  return { status: res.status, ok: res.ok, headers: res.headers, text: async () => text }
}

/**
 * Calls `attempt` until it gives a response below 500, waiting each of
 * `delays` before a retry of a transient error or a 5xx. Once the delays run
 * out the last error is thrown, or the last 5xx response returned.
 * @param {() => Promise<Response>} attempt builds a fresh request, timeout included, on every call
 */
async function withRetry(attempt, { delays = RETRY_DELAYS_MS, wait = sleep, log = msg => console.error(msg) } = {}) {
  for (let i = 0; ; i++) {
    let res
    try {
      res = await attempt()
    } catch (err) {
      if (!isTransient(err) || i >= delays.length) throw err
      log(`retry ${i + 1}/${delays.length} after ${err.name}: ${err.message}`)
      await wait(delays[i])
      continue
    }
    if (res.status < 500 || i >= delays.length) return res
    log(`retry ${i + 1}/${delays.length} after http_${res.status}`)
    await wait(delays[i])
  }
}

function sessionCookie(res) {
  const raw = res.headers.get('set-cookie') || ''
  const m = raw.match(/ci_session=[^;]+/)
  return m ? m[0] : null
}

// The ci_session cookie is valid for 7200s (Max-Age from the Set-Cookie
// header). Re-fetching the landing page for every date doubles the request
// count against a gurdwara's server for no benefit — a multi-year backfill
// would be thousands of avoidable hits. Cache it, refresh only when stale or
// when the server rejects it.
let cachedCookie = null
let cachedCookieAt = 0
const COOKIE_TTL_MS = 90 * 60 * 1000   // 90 min, comfortably inside the 120 min Max-Age

async function getSessionCookie({ force = false, retry } = {}) {
  const fresh = cachedCookie && (Date.now() - cachedCookieAt) < COOKIE_TTL_MS
  if (fresh && !force) return cachedCookie

  const pageRes = await withRetry(() => fetch(PAGE_URL, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(readWhole), retry)
  if (pageRes.status >= 500) throw new ServerUnavailableError(`http_${pageRes.status}_on_page_load`)
  if (!pageRes.ok) throw new Error(`http_${pageRes.status}_on_page_load`)
  const cookie = sessionCookie(pageRes)
  if (!cookie) throw new Error('no_session_cookie: hazursahib.com response had no ci_session')

  cachedCookie = cookie
  cachedCookieAt = Date.now()
  return cookie
}

async function postForDate(dateISO, cookie, retry) {
  const body = new URLSearchParams({ date: toSiteDateFormat(dateISO) })
  return withRetry(() => fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE_URL,
      'Origin': 'https://hazursahib.com',
      'Cookie': cookie,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(readWhole), retry)
}

/**
 * @param {string} dateISO "YYYY-MM-DD"
 * @param {{delays?: number[]}} [retry] `{ delays: [] }` for a caller with its own retry loop
 * @returns {Promise<string>} raw JSON response body
 */
async function fetchJsonForDate(dateISO, retry) {
  let cookie = await getSessionCookie({ retry })
  let res = await postForDate(dateISO, cookie, retry)

  // An expired session surfaces as 401/403 (or a redirect to the landing
  // page). Retry exactly once with a forced-fresh cookie.
  if (res.status === 401 || res.status === 403 || res.status === 302) {
    cookie = await getSessionCookie({ force: true, retry })
    res = await postForDate(dateISO, cookie, retry)
  }

  if (res.status >= 500) throw new ServerUnavailableError(`http_${res.status}`)
  if (!res.ok) throw new Error(`http_${res.status}`)
  return res.text()
}

/**
 * parseJson, plus a check that every record is for `dateISO`. A record for
 * another day, such as yesterday's answered for a day not posted yet, means
 * nothing is published for `dateISO`.
 */
function parseJsonForDate(raw, dateISO) {
  const sections = parseJson(raw)
  const want = toSiteDateFormat(dateISO)
  for (const s of sections) {
    if (!s.remote_date) throw new LayoutChangedError('record has no date')
    if (s.remote_date !== want) {
      throw new NoHukamnamaError(`site answered ${s.remote_date} for ${want}`)
    }
  }
  return sections
}

/**
 * @param {string} [dateISO] "YYYY-MM-DD". Omit for today.
 * @param {{delays?: number[]}} [retry] as for fetchJsonForDate
 * @returns {Promise<Array>} parsed sections
 */
async function fetchForDate(dateISO, retry) {
  const date = dateISO || todayIST()
  return parseJsonForDate(await fetchJsonForDate(date, retry), date)
}

/** A failure a later run may get past: retries ran out on a timeout, a dropped connection or a 5xx. */
function isUnavailable(err) {
  return err instanceof ServerUnavailableError || isTransient(err)
}

module.exports = {
  parseJson, parseJsonForDate, parsePage, NoHukamnamaError, ServerUnavailableError,
  fetchForDate, fetchJsonForDate, toSiteDateFormat, todayIST, slotDayIST, withRetry, isTransient,
  isUnavailable, readWhole, LayoutChangedError, PAGE_URL, SEARCH_URL, USER_AGENT, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS,
}
