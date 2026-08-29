'use strict'

/**
 * Shared shape for a resolved granth section as written to archive/YYYY/MM/DD.json.
 * Used by both bin/fetch-today.js and bin/build-archive.js so the daily job
 * and the bulk build always publish byte-identical structure for the same
 * resolver output. counters_found/counter_agrees are internal diagnostics
 * and are deliberately not published.
 */
function pack(r) {
  if (!r) return null
  return {
    shabad_ids: r.ok ? r.shabad_ids : [],
    line_ids: r.ok ? (r.line_ids || []) : [],
    confidence: r.confidence,
    score: r.score ?? null,
    margin: r.margin ?? null,
    ang: r.ang_scraped ?? null,
    ang_delta: r.ang_delta ?? null,
    counters: r.counters ?? [],
  }
}

module.exports = { pack }
