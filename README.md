# Hazur Sahib Hukamnama Archive

A daily record of which shabad was read as the Hukamnama at **Takht Sachkhand Sri Hazur Sahib, Nanded**, published as small JSON files of Shabad OS shabad IDs.

> **Unofficial.** This project is not affiliated with, endorsed by, or connected to Takht Sachkhand Sri Hazur Sahib or its management. It is an independent, community-maintained record. If the Takht or the sangat would prefer this not exist, write to the address in [Contact](#contact) and it will be taken down without argument.

## What this is

Hazur Sahib publishes its daily Hukamnama — from both Sri Guru Granth Sahib Ji and Sri Dasam Granth — as an ordinary web page, with no developer-facing endpoint. This repository reads that page once a day, works out **which shabad** it is, and records the identifier.

**No Gurbani text is stored or served here.** Only pointers. Clients look the shabad up in their own copy of the corpus.

Coverage: **2022-01-07 to present**, ~1,666 files.

## Usage

Files are served straight off GitHub's CDN. There is no server, no API key, and no rate limit worth worrying about.

```
https://raw.githubusercontent.com/Harkie21/hazur-sahib-hukamnama-archive/main/archive/YYYY/MM/DD.json
```

```bash
curl https://raw.githubusercontent.com/Harkie21/hazur-sahib-hukamnama-archive/main/archive/2026/08/26.json
```

```json
{
  "date": "2026-08-26",
  "source": "hazur_sahib",
  "shabad_ids": ["PLN"],
  "sggs": {
    "shabad_ids": ["PLN"],
    "line_ids": ["ABCD", "ABCE", "ABCF"],
    "confidence": "high",
    "score": 1.0,
    "margin": 0.588,
    "ang": 711,
    "ang_delta": 0,
    "counters": [2]
  },
  "dsg": {
    "shabad_ids": ["5DB"],
    "line_ids": ["WXYZ"],
    "confidence": "medium",
    "score": 0.837,
    "margin": 0.475,
    "ang": 446,
    "ang_delta": 2,
    "counters": [1472]
  },
  "corpus": { "name": "@shabados/database", "version": "4.8.7" }
}
```

Dates are **IST** — the hukamnama is read at Nanded, so its day boundary governs.

The top-level `shabad_ids` mirrors [`gurbaninow/hukamnama-archive`](https://github.com/gurbaninow/hukamnama-archive), so a client written for that format works here unmodified. It carries the Guru Granth Sahib Ji shabad only; the Dasam Granth half has no counterpart there.

A missing file means the day has not been published, or the resolver declined to guess. **404 is a normal state — handle it.**

Sri Dasam Granth is not published every day; treat the `dsg` block as optional.

### `confidence`

| Value | Meaning | What a client should do |
|---|---|---|
| `high` | score ≥ 0.90 and margin ≥ 0.30 | Link into your library |
| `medium` | margin ≥ 0.15 and score ≥ 0.55 | Link, but worth logging |
| `low` | anything else | `shabad_ids` is empty. Render nothing, or the source text read-only. **Never guess.** |

`margin` — the gap to the runner-up — is the load-bearing signal, not `score`. Edition differences depress absolute similarity fairly uniformly; they do not create rival candidates.

### `line_ids`

Nanded's reading unit and Shabad OS's shabad boundary do not align in either direction. On 2026-08-25 a single swaiya reading was one chhand inside a 29-line shabad spanning two angs; on 2026-08-23 a single reading spanned two whole shabads. `shabad_id` alone can therefore name a superset of what was actually read — clients that want to display or highlight exactly what was read should bound it with `line_ids`, not just the shabad ID.

## How resolution works

1. Scrape Heading and Bani for each granth (already Unicode Gurmukhi on the source page).
2. Canonicalise: drop the mangal, counters, danda, vishraam marks, addak, nukta, and all whitespace.
3. Score Sørensen–Dice over character bigrams against every shabad in the matching source.
4. Accept only on a wide margin over the runner-up, subject to the ang veto and contiguity rules below.

### Matching happens in Unicode, never ASCII

The `lines.gurmukhi` column in `@shabados/database@4.8.7` is **visual-order ASCII** (AnmolLipi / GurbaniAkhar) — the sihari glyph precedes its consonant. `gurmukhi-utils.toUnicode()` performs the visual-to-logical reorder, but `toAscii()` does **not** reproduce that column going back the other way; it is not a round trip.

Converting a scrape down to ASCII to match therefore fails quietly. Measured on 2026-08-26: a shabad that should score 1.000 scored **0.855**, with the diff isolated to sihari placement (`riMgihr` vs `rMighir`). Converting the corpus **up** to Unicode instead scores 1.000.

### Ang is a veto, never a key

An ang holds several shabads — 3 begin on SGGS ang 711, 8 touch ang 550 — so ang alone can never *select* a match. But it does reject:

- **Both granths reject `|ang_delta| > 50`.** No edition disagrees by fifty pages, so a gap that large is ground truth that a match is wrong regardless of how well the text scores. Before this check was added, 36 such matches scored up to 1.000 and were graded `high`.
- **SGGS only also rejects `ang_delta < -1`.** This follows from how the hukamnama is taken: the granth is opened, reading begins at the top of the left-hand page, and if a shabad is already in progress there the reader turns back to its heading. So a shabad's *start* ang is always at or before the ang cited on the page — a negative delta (start ang after the cited ang) cannot happen. Measured SGGS `ang_delta`: −24…+1, median 0, and the eleven `+1` days are exactly this rule firing correctly.
- **DSG is exempt from that floor.** Nanded's Dasam Granth paginates differently from Shabad OS, and the offset is not constant — measured range −41…+38. Both editions total 1,428 angs, so the drift starts at zero, ends at zero, and accumulates and unwinds across section boundaries in between. No fixed correction is applied; the chhand counter (`॥੧੪੭੨॥`) is the dependable Dasam Granth anchor.

`ang_delta` (scraped − corpus) is recorded on every entry so the drift curve can be tracked over time.

### Multi-shabad readings must be contiguous

A genuine multi-shabad hukamnama is adjacent in the granth — a vaar is salok + salok + pauri in sequence. Because Gurbani reuses phrasing heavily, stray lines can otherwise match unrelated shabads elsewhere in the corpus. One recurring pair — Tilang M5 at ang 724 chaining to Ramkali M5 at ang 894, 552 shabads apart — showed up 20 times before contiguity was enforced. Requiring adjacency halved the reported SGGS multi-shabad rate from 14.3% to 7.0%.

## Measured results

1,692 days, **2022-01-07 to 2026-08-26**, 3,341 resolutions:

| Granth | high | medium | low |
|---|---|---|---|
| Guru Granth Sahib Ji | 1,626 (97.0%) | 41 | 10 |
| Sri Dasam Granth | 1,563 (93.9%) | 79 | 22 |

**4 resolutions (0.12%) are known-wrong, and all 4 are graded `low`.** Nothing incorrect reaches `high` or `medium`. The failure mode is refusal, not error — the correct behaviour for scripture. 13 days published nothing at all.

## Known quirks in the source

- The endpoint returns JSON despite a `text/html` `Content-Type` header.
- A day with nothing published returns the literal `false`, not `[]`.
- Digits are occasionally Devanagari (U+0966–096F) rather than Gurmukhi (U+0A66–0A6F) — e.g. `ਅੰਗ-੬੨` plus a Devanagari zero parsed as 62 instead of 620.
- Some days omit the ang entirely (7 SGGS, 6 DSG); resolution doesn't need it.
- Some days publish only Sri Guru Granth Sahib Ji — treat Sri Dasam Granth as optional.
- A CodeIgniter session cookie is required; the POST fails without one.

## Running it

```bash
npm ci
npm install --no-save @shabados/database@4.8.7
SHABADOS_DB=node_modules/@shabados/database/build/database.sqlite npm test
```

The corpus is 152 MB unpacked and is **never committed** — CI installs it fresh each run, pinned.

The daily job (`bin/fetch-today.js`) writes nothing on failure and exits non-zero, so the workflow goes red rather than publishing something wrong. A missing file is a clean 404; a wrong file is wrong Gurbani in front of someone.

Politeness: requests are spaced 2.5 seconds apart, and the session cookie is reused across a run. This is a gurdwara's server, not a CDN.

### Scripts

| Script | Purpose |
|---|---|
| `bin/fetch-today.js` | Daily job. Writes nothing on failure and exits non-zero. |
| `bin/harvest.js` | Bulk fetch over a date range. Resumable. |
| `bin/build-archive.js` | Rebuild the archive offline from `cache/`. Takes ~13 minutes. |
| `bin/analyse.js` | Produces the confidence/ang-delta report. Instant, reads from disk. |
| `bin/probe-range.js` | Binary-searches the archive's start date. |

## Corpus version

IDs are resolved against `@shabados/database@4.8.7` and every file records the version used. Shabad OS has signalled a v5 rewrite with a new schema and possible identifier changes; **if that lands, regenerate from `cache/` rather than remapping IDs by hand** — that's ~13 minutes with `bin/build-archive.js` and no network requests. Clients should read `corpus.version` rather than assuming.

## Licensing

Three separate layers — worth keeping distinct:

**Code** — MIT, see [LICENSE](LICENSE).

**The published IDs** — these are derived output: short identifiers pointing into [`@shabados/database`](https://github.com/shabados/database) (MIT code, CC0 corpus). No Gurbani text, translation, or transliteration is reproduced anywhere in this repository, so there is nothing here to license beyond the code itself. Use the IDs freely.

**The Hukamnama selection** — the choice of shabad on any given day belongs to Takht Sachkhand Sri Hazur Sahib. This project records that choice; it does not produce it.

Scraping is limited to a single request per day with an identifying User-Agent.

## Acknowledgments

- **Takht Sachkhand Sri Hazur Sahib, Nanded** — for publishing the daily Hukamnama openly.
- **[Shabad OS](https://github.com/shabados)** — for the corpus and for `gurmukhi-utils`, without which none of the encoding work would be tractable.
- **[gurbaninow/hukamnama-archive](https://github.com/gurbaninow/hukamnama-archive)** — for the Sri Darbar Sahib equivalent, and for the ID-pointer format this follows.

## Contact

harkiratsingh135790@gmail.com — for corrections, for breakage, and in particular for any concern from Hazur Sahib or its sangat.
