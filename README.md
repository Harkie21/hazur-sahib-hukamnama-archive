# Hazur Sahib Hukamnama Archive

A daily record of which shabad was read as the Hukamnama at **Takht Sachkhand Sri Hazur Sahib, Nanded**, published as small JSON files of Shabad OS shabad IDs.

> **Unofficial.** This project is not affiliated with, endorsed by, or connected to Takht Sachkhand Sri Hazur Sahib or its management. It is an independent, community-maintained record. If the Takht or the sangat would prefer this not exist, write to the address in [Contact](#contact) and it will be taken down without argument.

## What this is

Hazur Sahib publishes its daily Hukamnama — from both Sri Guru Granth Sahib Ji and Sri Dasam Granth — as an ordinary web page, with no developer-facing endpoint. This repository reads that page once a day, works out **which shabad** it is, and records the identifier.

**No Gurbani text is stored or served here.** Only pointers. Clients look the shabad up in their own copy of the corpus.

Coverage: **2022-01-07 to present**, ~1,666 files.

## Usage

Files are served straight off GitHub's CDN. There is no server, no API key, and no rate limit worth worrying about.

`archive/latest.json` always holds the most recently published day, so a client that just wants "the current hukamnama" doesn't need to construct today's date or handle a 404 for a day that hasn't published yet:

```
https://raw.githubusercontent.com/Harkie21/hazur-sahib-hukamnama-archive/main/archive/latest.json
```

**Check the `date` field rather than assuming it is today.** The cron can run hours late, and some days publish nothing at all — `latest.json` then still points at the last day that *did* resolve, rather than being empty or missing, but that means `date` can be yesterday's or older.

Individual days are addressable directly:

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
| `high` | accepted, and 85% of the reading's lines matched at score ≥ 0.88, with every counter in the passage found | Link into your library |
| `medium` | accepted on weaker evidence than that | Link, but worth logging |
| `low` | not accepted | `shabad_ids` is empty. Render nothing, or the source text read-only. **Never guess.** |

A resolution is *accepted* when 60% of the reading's lines matched, the average score is ≥ 0.72, the ang veto did not fire, and either `margin` ≥ 0.25 or the passage carries a counter rare enough to anchor it on its own.

`margin` — the gap to the runner-up — is the load-bearing signal, not `score`. Edition differences depress absolute similarity fairly uniformly; they do not create rival candidates. The thresholds themselves live in `THRESHOLDS` in `lib/resolve.js`, each with the measurement that set it.

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
- **SGGS only also rejects a cited ang more than 1 past the reading's *last* ang.** The mirror image of the rule above, and the same physical fact: the cited ang is a page the book was actually open at, so the reading cannot have ended well before it. Expressed against the last ang rather than as a flat delta because a Guru Granth shabad may span up to 9 angs and be cited from any of them. Across 1,668 published SGGS days, `cited − last ang` is −1 or 0 on 1,666 and `+1` on two (a shabad wholly on ang 614, cited as 615). The `+50` ceiling was far too loose upward for SGGS: it let a `+12` jump onto an unrelated page through.
- **DSG is exempt from that floor.** Nanded's Dasam Granth paginates differently from Shabad OS, and the offset is not constant — measured range −41…+38. Both editions total 1,428 angs, so the drift starts at zero, ends at zero, and accumulates and unwinds across section boundaries in between. No fixed correction is applied; the chhand counter (`॥੧੪੭੨॥`) is the dependable Dasam Granth anchor.

`ang_delta` (scraped − corpus) is recorded on every entry so the drift curve can be tracked over time.

### The counter override has to earn its keep

A passage's chhand counter can stand in for `margin` — but only when it actually narrows the field. In Sri Dasam Granth `੧੪੭੨`, `੧੫੯੬` and `੧੫੯੭` each sit on **one line** in the whole granth, which is why the override exists at all. In Guru Granth the counter `੧` sits on **6,043** lines and `੨` on 3,523; agreeing on one of those is not evidence of anything.

So the override now requires the rarest counter in the passage to sit on **at most 8 lines** of that granth. Without this, a perfect tie between two textual duplicates — the `ਗੁਰਦੇਵ ਮਾਤਾ` salok, which both opens (`YLS`, ang 262) and closes (`K26`, ang 250) Bavan Akhri — scored 1.000 with `margin` 0.000 and was published as `high`.

### Exact ties are broken by ang, not by luck

Where the granth genuinely repeats itself, two corpus lines score *identically* and text cannot choose between them. The cited ang can, so a tie at exactly equal similarity goes to the candidate whose start ang is consistent with the ang on the page. This only ever picks between candidates that already scored the same, and it does not touch `margin` — a duplicate still has to clear the margin gate on its own, and is refused if it cannot. Refusing a tie is acceptable; guessing is not.

### Multi-shabad readings must be contiguous

A genuine multi-shabad hukamnama is adjacent in the granth — a vaar is salok + salok + pauri in sequence. Because Gurbani reuses phrasing heavily, stray lines can otherwise match unrelated shabads elsewhere in the corpus. One recurring pair — Tilang M5 at ang 724 chaining to Ramkali M5 at ang 894, 552 shabads apart — showed up 20 times before contiguity was enforced. Requiring adjacency halved the reported SGGS multi-shabad rate from 14.3% to 7.0%.

## Measured results

1,692 days, **2022-01-07 to 2026-08-26**, 3,341 resolutions:

| Granth | high | medium | low |
|---|---|---|---|
| Guru Granth Sahib Ji | 1,626 (97.0%) | 41 | 10 |
| Sri Dasam Granth | 1,563 (93.9%) | 79 | 22 |

These counts are the archive **as published**. The counter-rarity gate demotes exactly one of them — 2025-09-24 Sri Dasam Granth, which leaned on counters `੩੫`/`੩੬`, carried by 71 and 68 lines — from `medium` to `low`. No published Guru Granth day relies on the override, and none has a cited ang past its reading's last ang, so neither new gate moves a Guru Granth row. The files on disk are unchanged until the archive is rebuilt from `cache/`.

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

`test/bench.js` draws a **seeded** sample, so a green run means the same thing on every machine and every CI run. Sweep wider with `BENCH_SEED` and `BENCH_N`:

```bash
for seed in 1 2 3 4 5; do BENCH_SEED=$seed node test/bench.js; done
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

`bin/fetch-today.js` (the daily job) does not write to `cache/` — it runs on an ephemeral GitHub Actions runner, so anything it wrote there would be discarded when the job ends, and `cache/` can't be committed since it holds Hazur Sahib's full text and translations, not just the shabad IDs the project publishes. So the days it has published since the last `bin/harvest.js` backfill are uncached. Before a corpus remap, run `bin/harvest.js` over that uncached range first, then `bin/build-archive.js`. This is a manual migration step, not something the daily job should attempt itself.

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
