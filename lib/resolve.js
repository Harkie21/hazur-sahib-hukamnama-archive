'use strict'

const Database = require('better-sqlite3')
const { toUnicode } = require('gurmukhi-utils')

const SOURCE_SGGS = 1
const SOURCE_DSG = 2

// Adjacent shabads may be separated by 1 in order_id; allow a little slack for
// intervening headings without permitting genuinely distant matches to chain.
const MAX_CHAIN_GAP = 2

const GURMUKHI_DIGITS = '੦੧੨੩੪੫੬੭੮੯'
// The source occasionally mixes in DEVANAGARI digits (U+0966-096F) instead of
// Gurmukhi ones (U+0A66-0A6F) — a keyboard slip on their side. Seen on
// 2025-04-05 and 2025-07-08, where "ਅੰਗ-੬੨\u0966" parsed as 62 rather than 620
// and produced an impossible -558 delta on an otherwise correct match.
const DEVANAGARI_DIGITS = '०१२३४५६७८९'
// Any digit we accept, for use inside character classes.
const DIGIT_CLASS = '੦-੯०-९0-9'

function parseNumeral(str) {
  let out = ''
  for (const ch of str) {
    const g = GURMUKHI_DIGITS.indexOf(ch)
    if (g >= 0) { out += String(g); continue }
    const d = DEVANAGARI_DIGITS.indexOf(ch)
    if (d >= 0) { out += String(d); continue }
    if (ch >= '0' && ch <= '9') out += ch
  }
  return out.length ? parseInt(out, 10) : null
}

function extractAng(bani) {
  // The digits of the ang are sometimes separated by a space or a zero-width
  // character in the source, e.g. "ਅੰਗ-੬੨ ੦". A digits-only capture stops at
  // the gap and silently yields 62 instead of 620 — observed on 2025-04-05 and
  // 2025-07-08, both reported as an impossible -558 delta. Allow separators
  // inside the run and let parseNumeral() discard them.
  const re = new RegExp(`ਅੰਗ\\s*[-–—:]?\\s*([${DIGIT_CLASS}][${DIGIT_CLASS}\\s\\u200b\\u200c\\u00a0]*)`)
  const m = String(bani).match(re)
  return m ? parseNumeral(m[1]) : null
}

function stripAngSuffix(bani) {
  return String(bani).replace(new RegExp(`ਅੰਗ\s*[-–—:]?\s*[${DIGIT_CLASS}\s]+$`), '')
}

/** Every counter in the passage, e.g. ॥੧੫੯੬॥ … ॥੧੫੯੭॥ -> [1596, 1597]. */
function extractCounters(text) {
  return [ ...String(text).matchAll(/[॥\]]\s*([੦-੯0-9]+)\s*[॥\]]/g) ]
    .map(m => parseNumeral(m[1]))
    .filter(n => n != null)
}

/**
 * Canonical comparison form. Matching happens in UNICODE, never ASCII:
 * the 4.8.7 `lines.gurmukhi` column is visual-order ASCII (the sihari glyph
 * precedes its consonant), `toUnicode()` performs the reorder, and `toAscii()`
 * does not reproduce that column going back — it is not a round trip.
 *
 * Also discarded: mangal, counters, danda, vishraam marks, addak, nukta,
 * whitespace. Editions disagree on all of them.
 */
function canon(unicodeText) {
  let s = String(unicodeText || '').normalize('NFC')
  s = s.replace(/ੴ/g, ' ')
  // The FULL Mool Mantar, not just its opening. Some Nanded headings carry it
  // in full; Shabad OS holds it as its own shabad at ang 1 (DMP), so leaving it
  // in makes ang 1 the best match for any such day. Observed producing
  // ang_delta of +659, +720 and +1167 across the 2022-2026 archive.
  s = s.replace(/ਸਤਿ\s*ਨਾਮੁ[\s\S]{0,80}?ਗੁਰ\s*ਪ੍ਰਸਾਦਿ/g, ' ')
  s = s.replace(/ਸਤਿ\s*ਨਾਮੁ/g, ' ')
  s = s.replace(/ਸਤਿਗੁਰ\s*ਪ੍ਰਸਾਦਿ/g, ' ')
  s = s.replace(new RegExp(`[${DIGIT_CLASS}]`,'g'), ' ')
  s = s.replace(/[॥।;,.\]\u0A71\u0A3C]/g, ' ')
  s = s.replace(/\s+/g, '')
  return s
}

/**
 * Nanded runs a whole passage into one Bani cell. Split it back into lines on
 * the danda, folding short fragments into their neighbour so that headings
 * like "ਦੋਹਰਾ ॥" or "ਰਹਾਉ ॥" never become standalone query lines — they match
 * thousands of places and contribute nothing but noise.
 */
function splitLines(bani) {
  const parts = stripAngSuffix(bani)
    .split(/॥/)
    .map(s => s.trim())
    .filter(Boolean)
  const out = []
  for (const part of parts) {
    if (canon(part).length < 8) {
      if (out.length) out[out.length - 1] += ' ' + part
    } else out.push(part)
  }
  return out
}

function bigrams(str) {
  const m = new Map()
  for (let i = 0; i < str.length - 1; i++) {
    const g = str.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

/**
 * Sorensen-Dice over character bigrams.
 *
 * The corpus side is compared millions of times per run and never changes, so
 * its bigram maps are built once at load (see Resolver constructor) and passed
 * in here. Rebuilding them per comparison dominated runtime.
 */
function dicePre(aGrams, aLen, bGrams, bLen) {
  if (aLen < 2 || bLen < 2) return 0
  // Iterate the smaller map; intersection is symmetric.
  const [ small, large ] = aGrams.size <= bGrams.size ? [ aGrams, bGrams ] : [ bGrams, aGrams ]
  let inter = 0
  for (const [ g, n ] of small) {
    const o = large.get(g)
    if (o !== undefined) inter += n < o ? n : o
  }
  return (2 * inter) / ((aLen - 1) + (bLen - 1))
}

function dice(a, b) {
  if (!a.length || !b.length) return 0
  return dicePre(bigrams(a), a.length, bigrams(b), b.length)
}


const THRESHOLDS = {
  lineMatch: 0.72,     // a query line counts as found in the corpus
  lineStrong: 0.88,    // …and found convincingly
  minCoverage: 0.60,   // fraction of query lines that must be found
  highCoverage: 0.85,
  // Raised from 0.10 on evidence from an 87-day backfill (2026-06-01..08-26).
  // Margin — not score — is the only signal that separates good matches from
  // bad ones. The four bad rows scored 0.843, 0.843, 0.975 and 1.000, i.e.
  // score was useless; their margins were 0.138-0.177 while every correct row
  // sat at >=0.290. Nothing at all landed between 0.177 and 0.290, so this
  // threshold sits in an empty band: it rejects 4/4 known-bad and 0 known-good.
  // All four failures were formulaic metrical passages (Rasaaval Chhand,
  // Sangeet Bhujang Prayaat Chhand) that recur near-identically across the
  // granth, so the matcher found the same lines in several places at once.
  minMargin: 0.25,
  // Beyond this, a scraped ang and the corpus ang cannot describe the same
  // reading. Edition drift is real but bounded: measured -41..+38 for Dasam
  // Granth and -24..+1 for Guru Granth across 1,692 days. Anything past 50 is
  // a different part of the book, i.e. a guaranteed-wrong match.
  maxAngDelta: 50,
  // How the hukamnama is taken: the granth is opened, and reading starts from
  // the top of the left page. If a shabad is already in progress there, the
  // reader turns BACK to its heading. So the shabad's start ang is always
  // <= the ang cited, i.e. (cited - corpus) >= 0. A negative delta means the
  // matched shabad starts AFTER the page it was supposedly read from, which
  // cannot happen. Small slack for off-by-one citation practice.
  // Applies to GURU GRANTH ONLY. Nanded and Shabad OS paginate SGGS
  // identically (measured: delta 0 on every clean day of 1,692), so this rule
  // is safe there. Dasam Granth pagination genuinely drifts negative — a
  // hand-verified correct match on 2026-08-24 sits at -2 — so DSG keeps only
  // the symmetric +/-50 bound.
  minAngDeltaSggs: -1,
  // The same rule from the other end. The reader opens the granth at the cited
  // ang, so that page is one the reading actually occupies; the shabad may
  // begin well before it but cannot end well before it. Measured over 1,668
  // published SGGS days, (cited - reading's last ang) is -1 or 0 on 1,666 and
  // +1 on two (a shabad wholly on ang 614 cited as 615, twice). Expressing the
  // bound against the LAST ang rather than as a flat delta keeps the handful of
  // SGGS shabads spanning up to 9 angs resolvable while still rejecting a
  // +12 jump onto an unrelated page.
  maxAngPastEndSggs: 1,
  // A counter only earns the right to stand in for margin when it actually
  // narrows the field. In Dasam Granth 1472, 1596 and 1597 each occur on one
  // line in the whole granth, which is why the override exists. In Guru Granth
  // the counter 1 sits on 6,043 lines and 2 on 3,523 — carrying no information
  // at all, yet enough to wave a perfect tie between two textual duplicates
  // through the margin gate (YLS/K26, the Gurdev Mata salok that both opens and
  // closes Bavan Akhri). Counted in lines, not occurrences: what matters is how
  // many rival lines survive the anchor. Of the four published days that lean on
  // the override, three sit at 1, 5 and 5 lines and one at 68, so this clears
  // the working anchors with slack and refuses the one that never narrowed
  // anything (2025-09-24 DSG, counters 35 and 36, now graded low).
  maxCounterLines: 8,
}

class Resolver {
  constructor(dbPath) {
    this.db = new Database(dbPath, { readonly: true })

    const hasUnicodeCol = this.db
      .prepare('PRAGMA table_info(lines)').all()
      .some(c => c.name === 'gurmukhi_unicode')
    const col = hasUnicodeCol ? 'l.gurmukhi_unicode' : 'l.gurmukhi'

    const rows = this.db.prepare(`
      SELECT l.id          AS line_id,
             l.shabad_id   AS shabad_id,
             s.source_id   AS source_id,
             s.order_id    AS shabad_order,
             l.order_id    AS line_order,
             l.source_page AS ang,
             ${col}        AS text
      FROM lines l
      JOIN shabads s ON s.id = l.shabad_id
    `).all()

    this.lines = rows.map(r => ({
      line_id: r.line_id,
      shabad_id: r.shabad_id,
      source_id: r.source_id,
      shabad_order: r.shabad_order,
      line_order: r.line_order,
      ang: r.ang,
      canon: canon(hasUnicodeCol ? r.text : toUnicode(r.text)),
      counters: extractCounters(r.text),
    }))
    for (const l of this.lines) {
      l.grams = bigrams(l.canon)
      l.len = l.canon.length
    }

    // Start ang of each shabad. `lines.source_page` is the ang of an individual
    // LINE, which is not the same thing: a shabad spanning two angs has lines on
    // both. The hukamnama rule is about where the shabad BEGINS (the reader
    // turns back to its heading), so comparisons must use the minimum.
    this.shabadStartAng = new Map()
    // Where the shabad ENDS, for the mirror-image bound: the cited ang is a page
    // the reading was physically open at, so it cannot fall past the last page
    // the reading occupies.
    this.shabadEndAng = new Map()
    for (const l of this.lines) {
      const lo = this.shabadStartAng.get(l.shabad_id)
      if (lo === undefined || l.ang < lo) this.shabadStartAng.set(l.shabad_id, l.ang)
      const hi = this.shabadEndAng.get(l.shabad_id)
      if (hi === undefined || l.ang > hi) this.shabadEndAng.set(l.shabad_id, l.ang)
    }

    this.bySource = new Map()
    for (const l of this.lines) {
      if (!this.bySource.has(l.source_id)) this.bySource.set(l.source_id, [])
      this.bySource.get(l.source_id).push(l)
    }

    // How many lines of each granth carry each counter, so the counter override
    // can ask whether an anchor is actually rare rather than merely present.
    this.counterFreq = new Map()
    for (const [ sourceId, lines ] of this.bySource) {
      const freq = new Map()
      for (const l of lines) {
        for (const c of new Set(l.counters)) freq.set(c, (freq.get(c) || 0) + 1)
      }
      this.counterFreq.set(sourceId, freq)
    }
  }

  /**
   * Resolve a scraped passage to the shabad(s) containing it.
   *
   * Matching is LINE-level, not shabad-level. Nanded's unit is a *reading*;
   * Shabad OS's unit is a *shabad*, and the two do not align. Observed on real
   * data: 2026-08-25's single swaiya is one chhand out of a 29-line Shabad OS
   * shabad spanning two angs, while 2026-08-23's cell spans two whole Shabad OS
   * shabads. Comparing whole texts fails in both directions.
   */
  resolve(heading, bani, sourceId) {
    const ang = extractAng(bani)
    const counters = extractCounters(stripAngSuffix(bani))
    const queryLines = splitLines(bani)
    const pool = this.bySource.get(sourceId) || []

    if (!queryLines.length) {
      return { ok: false, reason: 'query_too_short', confidence: 'low', ang, counters }
    }

    // The granth repeats itself in places: the Gurdev Mata salok both opens and
    // closes Bavan Akhri, so its lines score 1.000 in two places at once and no
    // amount of text can separate them. The cited ang can. This only ever picks
    // between candidates that already scored EXACTLY equal, so it cannot pull a
    // weaker match ahead of a stronger one, and it leaves the margin at zero —
    // the tie is resolved, not hidden. Distance is measured to the shabad's ang
    // RANGE, not its start: a shabad spanning several angs may legitimately be
    // cited from any of them.
    const angPenalty = (line) => {
      if (ang == null) return 0
      const start = this.shabadStartAng.get(line.shabad_id)
      const end = this.shabadEndAng.get(line.shabad_id)
      if (start == null || end == null) return 0
      if (ang < start) return start - ang
      if (ang > end) return ang - end
      return 0
    }

    let matches = []

    for (const raw of queryLines) {
      const q = canon(raw)
      const qLen = q.length
      const qGrams = bigrams(q)
      let best = null
      let bestPenalty
      let second = 0
      for (const line of pool) {
        // Cheap prefilter: Dice cannot exceed 2*min/(sum) on length alone, so
        // wildly mismatched lengths can never clear the threshold. Cuts ~85%
        // of comparisons on a 141k-line index.
        const lLen = line.len
        if (lLen < qLen * 0.5 || lLen > qLen * 2) continue
        const sim = dicePre(qGrams, qLen, line.grams, lLen)
        if (!best || sim > best.sim) {
          second = best ? best.sim : second
          best = { line, sim }
          bestPenalty = undefined
        } else if (sim === best.sim) {
          second = sim
          // Only among lines that actually matched. Thousands of unrelated
          // lines tie at 0.000 and resolving those ties costs a lookup each.
          if (sim >= THRESHOLDS.lineMatch) {
            if (bestPenalty === undefined) bestPenalty = angPenalty(best.line)
            const penalty = angPenalty(line)
            if (penalty < bestPenalty) {
              best = { line, sim }
              bestPenalty = penalty
            }
          }
        } else if (sim > second) second = sim
      }
      if (best && best.sim >= THRESHOLDS.lineMatch) {
        matches.push({ ...best.line, sim: best.sim, lineMargin: best.sim - second })
      }
    }

    if (!matches.length) {
      return { ok: false, reason: 'no_candidate', confidence: 'low', ang, counters }
    }

    // Counters are near-unique in Dasam Granth — 1472, 1596 and 1597 each occur
    // exactly once in the whole granth — and are the strongest anchor available.
    const grouped = new Map()
    for (const m of matches) {
      if (!grouped.has(m.shabad_id)) {
        grouped.set(m.shabad_id, { order: m.shabad_order, ang: m.ang, lines: 0 })
      }
      grouped.get(m.shabad_id).lines++
    }
    // A real multi-shabad hukamnama is always CONTIGUOUS in the granth — a vaar
    // is salok + salok + pauri in sequence (verified: 123+0QQ+06U at orders
    // 2473-2475, CJ2+CRJ+N2T, ME8+GHL+WW4 at 2461-2463). Shabads hundreds of
    // positions apart are never one reading; they are common phrasing matching
    // in several places at once (SC1 order 2779 + HCR order 3331 recurred 20
    // times across the archive, Tilang M5 spuriously chained to Ramkali M5).
    //
    // Anchor on the shabad contributing the most matched lines, then keep only
    // the run of shabads adjacent to it.
    const entries = [ ...grouped.entries() ].sort((a, b) => a[1].order - b[1].order)
    const anchorIdx = entries.reduce(
      (bi, e, i) => (e[1].lines > entries[bi][1].lines ? i : bi), 0
    )
    const kept = [ entries[anchorIdx] ]
    for (let i = anchorIdx - 1; i >= 0; i--) {
      if (entries[i + 1][1].order - entries[i][1].order <= MAX_CHAIN_GAP) kept.unshift(entries[i])
      else break
    }
    for (let i = anchorIdx + 1; i < entries.length; i++) {
      if (entries[i][1].order - entries[i - 1][1].order <= MAX_CHAIN_GAP) kept.push(entries[i])
      else break
    }
    const keptIds = new Set(kept.map(([ id ]) => id))
    const droppedShabads = entries.length - kept.length
    const linesBefore = matches.length
    matches = matches.filter(m => keptIds.has(m.shabad_id))
    const shabadIds = kept.map(([ id ]) => id)

    // Coverage, score and margin MUST be computed from the surviving matches
    // only. Computing them first counted lines that were then discarded as
    // spurious, so a day where 8 of 10 lines supported the answer and 2 matched
    // an unrelated shabad reported coverage 1.00 and claimed high confidence on
    // evidence that had just been thrown away.
    const coverage = matches.length / queryLines.length
    const avgMargin = matches.reduce((a, m) => a + m.lineMargin, 0) / matches.length
    const avgSim = matches.reduce((a, m) => a + m.sim, 0) / matches.length

    // Counters are near-unique in Dasam Granth — 1472, 1596 and 1597 each occur
    // exactly once in the whole granth — and are the strongest anchor available.
    // Also computed post-filter, so a counter found only in a discarded shabad
    // no longer counts as agreement.
    const matchedCounters = new Set(matches.flatMap(m => m.counters))
    const countersFound = counters.filter(c => matchedCounters.has(c))
    const counterAgrees = counters.length > 0 && countersFound.length === counters.length

    // …but only when the counter narrows the field. Agreement on a counter that
    // sits on thousands of lines is not evidence, and letting it stand in for
    // margin waved a perfect tie between two textual duplicates through as high
    // confidence. The rarest counter in the passage is the anchor; the rest add
    // nothing it does not already have.
    const freq = this.counterFreq.get(sourceId)
    const counterLines = counters.length && freq
      ? Math.min(...counters.map(c => freq.get(c) ?? 0))
      : 0
    const counterDiscriminates = counterAgrees
      && counterLines > 0
      && counterLines <= THRESHOLDS.maxCounterLines

    // Compare against where the FIRST shabad of the reading begins — not the
    // ang of whichever query line happened to match first, which varies with
    // query order and can sit on the shabad's second page.
    const angCorpus = this.shabadStartAng.get(shabadIds[0]) ?? null
    const angEndCorpus = this.shabadEndAng.get(shabadIds[shabadIds.length - 1]) ?? null
    const angDelta = (ang != null && angCorpus != null) ? ang - angCorpus : null
    // A physically impossible ang gap is ground truth that the match is wrong,
    // independent of how confident the text similarity looks. These scored up
    // to 1.000 with margins near 0.47, so no similarity threshold can catch them.
    const angImpossible = angDelta != null && (
      Math.abs(angDelta) > THRESHOLDS.maxAngDelta ||
      (sourceId === SOURCE_SGGS && angDelta < THRESHOLDS.minAngDeltaSggs) ||
      (sourceId === SOURCE_SGGS && angEndCorpus != null
        && ang - angEndCorpus > THRESHOLDS.maxAngPastEndSggs)
    )

    const ok = coverage >= THRESHOLDS.minCoverage
      && avgSim >= THRESHOLDS.lineMatch
      && (avgMargin >= THRESHOLDS.minMargin || counterDiscriminates)
      && !angImpossible

    const confidence = (ok
      && !angImpossible
      && coverage >= THRESHOLDS.highCoverage
      && avgSim >= THRESHOLDS.lineStrong
      && (counterAgrees || counters.length === 0)) ? 'high'
      : ok ? 'medium' : 'low'

    return {
      ok,
      reason: angImpossible ? 'ang_impossible' : undefined,
      shabads_dropped_from_chain: droppedShabads,
      lines_dropped_from_chain: linesBefore - matches.length,
      shabad_ids: shabadIds,
      line_ids: matches.map(m => m.line_id),
      lines_matched: matches.length,
      lines_total: queryLines.length,
      coverage: Number(coverage.toFixed(3)),
      score: Number(avgSim.toFixed(3)),
      margin: Number(avgMargin.toFixed(3)),
      confidence,
      counters,
      counters_found: countersFound,
      counter_agrees: counterAgrees,
      counter_lines: counters.length ? counterLines : null,
      counter_discriminates: counterDiscriminates,
      ang_scraped: ang,
      ang_corpus: angCorpus,
      ang_corpus_end: angEndCorpus,
      // Nanded and Shabad OS paginate Dasam Granth differently and the offset
      // is NOT constant — observed 0, +2 and +3 on consecutive real days, and
      // both editions total 1428 angs so the drift must begin and end at zero.
      // Recorded for measurement; never used to filter or correct.
      ang_delta: angDelta,
    }
  }
}

module.exports = {
  Resolver, canon, dice, dicePre, bigrams, splitLines,
  extractAng, extractCounters, stripAngSuffix, parseNumeral,
  SOURCE_SGGS, SOURCE_DSG, THRESHOLDS,
}
