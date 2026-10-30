---
title: "Maturation Board — one read-only page showing where every maturing feature stands"
slug: "maturation-board"
author: "echo"
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
parent-spec: "docs/specs/feature-maturation-discipline.md (D6 extend-not-duplicate; D4 named as the future owner of the stuck-too-long judgement); docs/specs/feature-maturation-recurring-evaluation.md (D7 measurement substrate)"
eli16-overview: "maturation-board.eli16.md"
approved: true
approved-by: "Echo under Justin's standing delegation (only constitution changes need his approval; this spec touches no constitution file), within his 2026-10-30 08:03 PDT directive in topic 128732 to build this board in a 24h autonomous run"
status: "converged"
review-convergence: "2026-10-30T16:40:58.200Z"
review-iterations: 3
review-completed-at: "2026-10-30T16:40:58.200Z"
review-report: "docs/specs/reports/maturation-board-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Maturation Board

## Problem statement

Operator directive (Justin, Telegram topic 128732, 2026-10-30 08:03 PDT): the weekly feature report
is not satisfying. It must link to a document listing every feature on a maturation path: its
maturation stage, what data is recorded to measure it, what the evidence says, whether it is
progressing, and, if it has stalled, what is being changed to unstall it. With dates, and expected
timelines compared to actual ones. It must be a webapp, both standalone and inside the new dashboard,
giving an at-a-glance sense of progress, with colour codes, filtering and sorting. Comprehensive:
all features.

Today the facts exist but are scattered across four surfaces on the serving machine, none of which
answers "how is feature X maturing, and is it on time?":

| Surface (verified live on the Studio, 2026-10-30) | What it holds |
|---|---|
| `GET /initiatives` (InitiativeTracker; rollout field written by FeatureRolloutReconciler) | 1,358 initiatives, 9 carrying `rollout` data (stage `dark`/`live`) |
| `GET /blocker-lifecycle/summary` → `maturation` (D7 scorer) | 16 eligible features re-scored every 6 h (status ready/hold/insufficient-evidence/missing-contract), plus an `accounting` list of 9 PR-born features with graduation criterion, evidence endpoint, metric descriptors |
| `GET /growth/status`, `/growth/findings`, `/growth/digest` (GrowthMilestoneAnalyst + DarkFlagMaturationRegistry) | incubation windows, expired-unproven features, dev-gated-dark flags, dark-flag inventory counts (25 legacy-unproven, 26 unowned), 632 "stalling" plain-task initiatives |
| `GET /guards` | per-guard effective posture (on-confirmed, dark-default, diverged…) |

## Non-goals (D6 — extend, never duplicate)

The board is a VIEW. It adds no registry, database, table, scheduler, timer, scorer, or authority.
Every value it shows is read at request time from the surfaces above and labelled with its source.
It never changes a flag, stage, initiative, or approval. Where a source is unavailable it says so
("can't tell — <reason>") rather than showing a default.

## Design

### 0. Where the facts come from (verified 2026-10-30)

| Owner | Read how | Gives the board |
|---|---|---|
| `feature-maturation-review` job (Mon/Wed/Fri 11:30 on the Studio; Justin's 2026-10-23 directive; body read via `GET /jobs` on the Studio 2026-10-30 16:20Z, manifestVersion 4 after this spec's edit — its step 3 requires the top model of one family plus a second opinion from a different family for every stalled/blind/regressed feature, and its floors forbid promotion without evidence the job read) | its review files in `docs/research/feature-maturation/reviews/` — `YYYY-MM-DD.json` (`schema: maturation-review/1`, written from the 2026-10-30 run on), with the markdown `## Full table` of older reviews read tolerantly | the feature universe (~183 rows), each feature's verdict, evidence, measures, rule, decision, action, commitment ids, expected-by date; one row per review date = verdict history |
| CommitmentTracker | in-process read of the commitments the review names | remediation status, owner, deadline, delivered/open |
| DarkFlagMaturationRegistry | `load()` (pure read of `state/dark-flag-maturation.json`) | first-seen-dark date, deadline, dated state history per guard key |
| D7 (`BlockerLifecycleService.localSummary/localTrend`) | in-process | live readiness status, passing/total metrics, newest evidence, metric descriptors |
| InitiativeTracker rollouts (FeatureRolloutReconciler) | in-process `list()` | observed runtime stage, promotion criteria, evidence source |
| Guard inventory (`/guards` builder) | in-process | live effective posture per guard key |

`GET /growth/*` is deliberately NOT called: each call runs `buildDigest()`, which writes the stage
journal and reconciles the dark-flag file. The board calls only read methods.

### 1. Which features appear (the universe)

The latest review's table is the universe: the review job already "assesses every staged feature"
against the 184-feature 2026-10-22 audit. A feature tracked by a live owner (rollout initiative, D7
row, dark-flag entry) but absent from the latest review is still listed, marked
"not in the last review" — that gap is itself a finding. Rows join on id: a review id equals a guard
key or a guard key minus its trailing `.enabled`, a rollout `flagPath`, or a D7/initiative slug. The row key is the review id (or, for a feature in no review, the owner's own id). Owner facts
attach to that key through the alias rules above; one feature seen by several owners on several
machines is ONE row with several owner entries, which is the normal case. A join is ambiguous only
when the same owner source on the same machine offers two different ids that both alias to one review
id (e.g. guard keys `x` and `x.enabled` both present), or one owner id aliases to two review ids: the
row then carries the `ambiguous-join` flag, the competing owner entries are listed rather than picked,
and the count is reported in `excluded.ambiguousJoins`.
Plain task initiatives (R3 "stalling") are not features and are only counted. An initiative whose
`rollout` holds only digest bookkeeping is excluded and counted.

### 2. Review file contract (`maturation-review/1`)

Producer: the review job (body updated 2026-10-30). Consumer: the board. Validation is closed:

| Field | Type / cap |
|---|---|
| `schema` | exactly `"maturation-review/1"` |
| `date` | `YYYY-MM-DD`, must equal the file name's date, must not be later than the reading machine's date + 1 day |
| `startedAt`, `finishedAt` | ISO instants or null |
| `machine`, `instarVersion` | strings ≤ 64 chars (display only; the machine shown is the one the file was READ from) |
| `features[]` | 1–1,024 rows, unique `id` (a later duplicate is dropped and counted) |
| `id` | `^[A-Za-z0-9._:+\-/ (),~]{1,160}$` (compound ids such as `routingSpend (.money)` are real review rows; they display but do not join to owners) |
| `title` | string ≤ 160 or null |
| `stage` | string ≤ 32, shown verbatim (never mapped onto another vocabulary) |
| `verdict` | one of `ready on-track blind stalled regressed too-new live retire-pending`; anything else is stored as `other` with the raw text |
| `evidence`, `measures`, `rule`, `decision`, `action` | strings ≤ 4,000 or null |
| `evidenceReadToday` | boolean |
| `commitments[]` | ≤ 16 strings matching `^CMT-\d{1,8}$` |
| `expectedBy`, `shippedAt` | ISO date/instant or null |

A file that fails validation is rejected whole and listed in `sources[]` with the failing field.
Markdown reviews (the format before 2026-10-30) are read from the `## Full table` section: rows
starting with a backticked id and exactly five cells (feature, verdict, evidence, decision, action);
`CMT-n` ids are taken only from the action cell; a row that does not fit is counted as unparsed, never
guessed. (Measured on the two existing reviews: 179/179 and 183/183 rows parse.)

**Which review is "latest":** the newest VALID review by `date`, across both formats; ties prefer
JSON. Every newer file that was rejected is reported in `sources[]`, so a broken newest file is
visible rather than silently replaced by an older one.

### 3. Per-feature record (read model, never persisted)

```ts
interface BoardFeature {
  id: string; title: string | null;
  review: null | {                     // from the latest valid review; null ⇒ "not reviewed"
    date: string; verdict: Verdict; verdictRaw: string; stage: string | null;
    evidence: string | null; evidenceReadToday: boolean | null; measures: string | null; rule: string | null;
    decision: string | null; action: string | null; commitments: string[];
  };
  history: Array<{ date: string; verdict: Verdict }>;   // one per valid review, oldest first, ≤ 52
  shippedAt: { date: string; source: 'review' } | null; // as the review recorded it; null ⇒ "ship date not recorded"
  transitions: Array<{ at: string; from: string | null; to: string; source: 'dark-flag'; machine: string }>;
                                       // dated stage history exists only in the dark-flag registry; rollout records hold the current stage only
  unchangedReviews: number;            // trailing run of identical verdicts
  owners: Array<{                      // live facts, one entry per (machine, source); never merged into one value
    machine: string;                   // nickname from THIS machine's registry, never from a peer body
    source: 'd7' | 'rollout' | 'dark-flag' | 'guard';
    facts: Record<string, string | number | boolean | null>; // the owner's own field names and values, verbatim
    at: string | null;
  }>;
  deadlines: Array<{ date: string; source: 'review' | 'commitment' | 'dark-flag'; ref: string;
                     milestone: string; open: boolean; overdueDays: number | null }>;
  followUp: { state: 'linked' | 'none-linked' | 'unknown'; items: Array<{ ref: string; status: string; label: string; due: string | null }> };
  conflicts: Array<{ rule: string; a: string; b: string }>;
  flags: Array<'carried-evidence' | 'no-evidence' | 'ambiguous-join' | 'not-in-latest-review'>;
}
```

Response: `{ schema: 'maturation-board/1', advisory: true, authority: 'none', generatedAt, scope, reviewDate, sources: [{ name, machine, ok, reason?, at? }], counts, excluded, features }`.

**Stage is never translated.** The review's stage, the rollout's observed stage (`dark|dry-run|live|default-on`),
D7's `rung`, the dark-flag `state` and the guard `effective` posture are each shown under their own
label from their own owner and machine. D7 forbids combining origin-local evaluations into one score;
the board does not combine them into one stage either.

### 4. Progress (pass-through, never a new judgement)

The progress assessment is the latest review's verdict for that feature, shown verbatim with the
review date. The board adds no verdict. Readiness stays D7's (`DarkFlagMaturationRegistry` header:
two components answering "is this ready?" by different rules is the defect). Colour follows the
verdict (live/ready green, on-track teal, too-new grey, blind purple, stalled amber, regressed red,
retire-pending slate); every chip also carries the word, never colour alone.

Every review-sourced cell is labelled "per review <date> (model-assessed)": the verdict, evidence
and any review `expectedBy` are a model session's written assessment, not measurements. Facts from
deterministic owners (commitment records, the dark-flag registry, D7, guards) carry no such label.

**Not D4.** feature-maturation-discipline D4 (a `dark-too-long` attention reason in InitiativeTracker)
owns the "stuck too long" judgement and is not built yet. The board does not make that judgement: it
shows "past date (source: …)" as display arithmetic, raises no attention item, and names D4 as the
future owner; when D4 ships, the board shows D4's reason verbatim instead.

Mechanical facts beside it (arithmetic, not judgement):

- **Deadlines.** Each comes with its source. A review `expectedBy` is open while the latest verdict
  is not `live`/`ready`; a commitment's `checkInAt` (its promised date; NOT `nextUpdateDueAt`, which is PromiseBeacon's moving nudge marker per `CommitmentTracker.ts` ~229, shown only as "next check-in" on the follow-up item, never as a deadline) is open while the commitment's status is `pending` and it has no `resolvedAt` (status enum: `pending verified violated expired withdrawn delivered`)
  (status shown verbatim: a `delivered` commitment is labelled "handed off", never "fixed", because
  delivery means the item was assigned, measured 2026-10-30 on CMT-1117: delivered 50 minutes after
  it was opened); a dark-flag `deadline` is open while the entry's state is not
  `graduated|killed|superseded`. `overdueDays` is set only for an open deadline in the past and is shown as "past date" — red for commitment and dark-flag deadlines (recorded by deterministic owners), amber and labelled "past the review's date" for a review `expectedBy`. No
  deadline written down ⇒ the row shows "no date set", counted in the header ("41 of 183 have a
  date"), never a guessed date.
- **unchangedReviews**: the trailing run of identical verdicts across valid reviews whose row was freshly read (`evidenceReadToday` true, or a markdown row not marked "(carried)"); a carried row breaks the run and the cell reads "carried, not re-checked".
- **flags**: `carried-evidence` when `evidenceReadToday` is false or the markdown row was marked
  "(carried)"; `no-evidence` when the verdict is `ready|on-track|live` and the evidence cell is empty.

**Conflicts (closed table).** Each rule compares recorded states only; it resolves nothing.

| Rule | A | B |
|---|---|---|
| C1 | review verdict `live`, `ready` or `on-track` | a guard row for the same id on any machine reads `errored`, `missing` or `off-runtime-divergent` |
| C2 | review verdict `live` | the rollout's observed stage is `dark` on the machine that ran the review |
| C3 | review verdict `blind` | D7 status `ready` (D7 itself downgrades stale evidence to `stale-evidence`) |
| C4 | review verdict `ready` | D7 status `hold`, `stale-evidence` or `insufficient-evidence` |

Conflicts are computed per machine (each entry names the machine whose owner fact was used). Growth
analyst states (R2 "expired-unproven") are not inputs: the analyst's proof-of-life counter is not
wired (`AgentServer.ts` ~3673), so those states mean "not measured", and the board never calls
`/growth/*`. A dark-flag `proofOfLife: 'unknown'` is shown as "not measured — no evidence source
wired", never as a failure.

`hold` versus `on-track` is NOT a conflict (they answer different questions).

### 5. What is being done (follow-up)

Only explicit links count: the commitment ids the review row names, and initiatives whose `rollout.flagPath`
or id equals the feature id. No text matching (Recall by meaning, not word-match: a literal miss is
not evidence of absence). The state is three-valued:

- `linked` — one or more items, each with its live status and deadline;
- `none-linked` — every source that could hold a link answered and none links this feature;
- `unknown` — a source that could hold a link did not answer (e.g. commitments unreadable).

The page says "No linked follow-up" for `none-linked` and "Can't tell" for `unknown`. It never says
"nothing is being done". Header counts use the same three states.

### 6. Route

`GET /maturation/board` (Bearer). Reads the latest valid review, every older valid review for history
(at most 52), and the live owners in §0 through in-process read methods only: no HTTP to itself, no
LLM, no writes. `GET /growth/*` is never called (it writes). Dark-flag facts are machine-local by the
registry's own design (`load()` returns nothing for another machine's file); they appear as owner
entries tagged with their machine.

Owner access: the commitment tracker, initiative tracker, `blockerLifecycleService` and the guard
inventory builder (`buildGuardInventory` with the same snapshot inputs the `/guards` route uses) are
already on the route context. The dark-flag registry is not: it is built inline for the growth
analyst (`AgentServer.ts` ~3707). The build hoists that instance and adds a read-only
`darkFlagRegistry` field to `RouteContext`; when the growth analyst is off the field is null and the
source reads `ok:false, reason:'registry-not-running'`. `load()` cannot tell a missing file from a corrupt or foreign one (it returns empty entries with
`firstRegistration`/`foreign` set), so those cases are reported as `sources[]` rows ("can't tell" /
"foreign registry"), never as an empty registry that answered. The file's last write time is reported; past
24 hours the dark-flag entries are shown with "registry not refreshed since <time>". Reads use async
file I/O off the request's hot path; a reader error becomes a `sources[]` failure row, never a 500.

Bounds and cost: a 60-second response cache (the blocker-lifecycle pool pattern, `routes.ts` ~33063);
parsed review files cached by (path, mtime, size); at most 52 files and 16 MB read per rebuild; a
file over 2 MB is skipped and reported; ≤ 1,024 features; strings capped per §2.

Reviews directory: `maturationBoard.reviewsDir` (default `docs/research/feature-maturation/reviews`).
The real path (after resolving symlinks) must stay inside the project directory and must not fall
under the never-served key-material list or `.instar/`; only files named `^\d{4}-\d{2}-\d{2}\.(json|md)$`
are read, each realpath-checked again (a symlinked file is refused). Same checks as `fileRoutes.ts` ~261.

`?scope=pool`: asks each online peer for `scope=local&part=owners` through `poolPeerFetch` after
`isPeerUrlAllowedForCredentials` (4 peers per batch, 750 ms per peer, 2.5 s deadline, 512 KB per
peer, 4 MB total, a pool rate limit like `/guards`). A peer answers with its live-owner facts only
(D7, rollout, dark-flag, guard rows for ids it knows) plus a review digest `{date, hash, featureCount}`
of its latest valid review; review rows travel only from the one chosen machine (`part=review`).
Each owner entry also carries, typed and bounded: `transitions` (dark-flag only, ≤ 64 of `{at, from, to}`, ISO `at`, state strings ≤ 32) and `deadline` (`{date, open, milestone}` or null). Peer bodies are re-validated against the §2/§3 field caps (owner `facts` keys `^[A-Za-z][A-Za-z0-9]{0,63}$`, ≤ 32 keys, values string ≤ 512 / number / boolean / null, built on a null-prototype object); peer text is untrusted data. Commitments
named by the review are resolved on the machine that ran the review (they live in its tracker). **Choosing the review machine (one algorithm).** Candidates are the
machines that ANSWERED with a valid review digest (`date` ≤ now + 1 day). Pick the newest `date`; on a
tie take the lowest machine id (stable, independent of the lease). A machine that answered "no reviews"
is a confirmed absence; a machine that did not answer is unavailable, and if it was the machine
chosen on this server's previous build and no answering candidate has a review at least as new, the
offline rule below applies instead of silently choosing an older review. Every candidate (machine,
date, hash) is listed in `sources[]`. The choice depends only on answering machines and their review dates.

**The `part=review` answer** carries exactly: the latest review's rows, a verdict-only history
`[{date, id, verdict, carried}]` of older valid reviews, the commitment projection below, and the
review's `{date, hash}`. Cap 4 MB; over it the answer is refused with reason
`review-payload-too-large` (shown in `sources[]`). The fetched `{date, hash}` must equal the digest
that won selection; on mismatch the board records a `sources[]` failure and does not fall back to
another candidate.

The `part=review` fetch has its own 3 s budget after the 2.5 s owner fan-out. A hash mismatch from a
review rewritten between digest and fetch (e.g. during the 11:30 run) fails that build cleanly and the
next build recovers; it must not be "fixed" into a fallback.

**Commitments travel with the review.** The `part=review` answer includes a bounded projection of
every commitment id the review names, read from that machine's tracker: `{id, status, createdAt,
checkInAt, nextUpdateDueAt, resolvedAt}` (≤ 16,384 entries; past the cap `truncated: true` and the
missing ids read `unknown`, never `none-linked`). An id the tracker does not know is reported as
`unknown-id`; if the projection is missing or fails, every follow-up on the board reads `unknown`,
never `none-linked`. Owner
entries from every machine are appended, machine-tagged. A failed peer is a `sources[]` row with a
reason; the page shows "N of M machines answered".

**Missing machines.** If any registered machine did not answer, the answer line adds "may be
superseded: <machine> did not answer", and verdict counts are labelled as from the chosen review
only. This needs no stored state, so it also holds right after a restart.

**Review source offline.** If the machine holding the latest review does not answer, the board
serves the last review ASSESSMENT it fetched from that machine during this server's life (in-memory
only, at most 7 days old; review rows and verdict history only — the commitment projection is NOT
reused: every follow-up reads `unknown`, with last-known commitment values shown beside it marked
"as of <fetch time>" and excluded from all counts), labelled "review from <machine>, fetched <age> ago — that machine is not
answering". With nothing cached, review fields read "review unavailable: <machine> offline since
<time>" — never `not-reviewed`, and the answer line says it cannot count verdicts right now.

### 7. Page (standalone)

`/dashboard/maturation/` — static files beside `/dashboard/console/` (static files carry no data; the
data route needs the token obtained through the dashboard PIN unlock, `POST /dashboard/unlock`). It
requests `/maturation/board?scope=pool`.

- **First view (Dashboard UX Standard F10):** one headline sentence and at most five labelled
  tiles, under 150 words: "Stalled / regressed / blind (per review)", "No linked follow-up",
  "Past a recorded date", "Sources disagree", "Live (per review)". The board never combines
  verdicts under its own word ("stuck" is D4's judgement). Tapping a tile
  opens the table filtered to it; an "All features" button opens it unfiltered. The table is not part
  of the first view.
- **Headline:** "Per the 28 Oct review: 34 stalled, 5 regressed, 58 blind of 182; 86 of those have no
  linked follow-up. 14 have a written date; 3 are past it." From the response counts.
- **Overview bar:** one segment per verdict; tapping filters.
- **Table** (cards under 720 px): feature (title, id below), verdict + history dots + "for N
  reviews", follow-up (state + items), next open deadline (red when overdue, with days), flags and
  conflicts as small marked chips. Sort on any column; filters for verdict, follow-up state,
  overdue, conflict, flags, machine; free-text search over id/title/evidence/decision/action. Filter
  and sort live in the URL query.
- **Row detail:** review cells (evidence marked "read on <date>" or "carried"), measures, rule,
  every owner entry with machine and source, every deadline with source, and a timeline strip:
  shipped (if recorded) → each dated dark-flag transition → each review's verdict → each deadline marker →
  today; the span past an open deadline is red. Actual dates come only from `shippedAt` and
  `transitions`; where neither exists the strip says "no recorded dates for this feature yet" rather
  than drawing an inferred line.
- **Switched off:** when `/maturation/board` answers 503 the page shows "The maturation board is not
  switched on for this agent" and the console tile is hidden (the tile checks the route once per
  session). Static files are served to every install; they carry no data.
- **Rendering is text-only:** every string goes through `textContent` (console `el()` helper); links
  only to relative routes on this server; no `innerHTML` with data. Light and dark themes.

### 8. Console integration

One module pair: `maturation-board.js` (view) and `maturation-board-model.js` (pure, unit-tested). The
standalone page imports it; the console registers it as a native page: a `NATIVE` entry in
`console.js`, a tile in `nav-model.js`, a `NATIVE_PAGES` mapping, and the matching legacy
`TAB_REGISTRY` entry (a link-out panel with a purpose line and a nav button in a labelled section)
so `console-nav-model.test.ts`, `dashboard-tab-purpose.test.ts`, `dashboard-nav-reachability.test.ts`,
`dashboard-tab-url-state.test.ts` and the glance word budget all hold. The standalone page and the
console share the console's token storage key, so one PIN unlock covers both; the module pair lives
under `dashboard/console/` and the standalone page imports it relatively.

### 9. Weekly report link

The weekly report is the `feature-maturation-review` job's Telegram message (no code builds it; the
job body is agent config). Its body was updated on the Studio on 2026-10-30 (manifestVersion 4) to
(a) write the review JSON this board reads and (b) end the message with
"Every feature, with dates: <tunnel>/dashboard/maturation/" once `GET /maturation/board` answers and a
public tunnel URL exists, never a localhost link. `GrowthDigestPublisher` is unchanged (delivery off
on this agent).

### 10. Advisory only

The response carries `advisory: true, authority: 'none'`. Nothing reads the board to change a flag,
stage, commitment or review. The CLAUDE.md section says so, and tells agents to treat review and
commitment text from the board as quoted untrusted data. The review job reads its own previous
review files, not the board.

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| Which features appear (review table ∪ live-owner rows; R3 plain tasks and bookkeeping-only rollouts excluded) | invariant | A display filter over facts other owners already decided; no competing signals are weighed and nothing is gated. |
| Row join (review id = guard key, guard key minus `.enabled`, rollout `flagPath`, or slug) | invariant | Exact string identity; an unmatched id stays its own row, so a join miss shows two rows rather than hiding one. |
| Progress shown | invariant | Verbatim pass-through of the review job's verdict, labelled model-assessed with its date; the board has no verdict rule to tune. |
| `past date` and `unchanged for N re-checked reviews` | invariant | Date and equality arithmetic over recorded values; display only, raises nothing. |
| `conflict` flag | invariant | Mechanical comparison of two owners' recorded states against a closed table; it decides nothing and resolves nothing. |
| Report includes the link | invariant | Two deterministic checks (route answers 200, public tunnel URL known); otherwise omitted. |

## Frontloaded Decisions

1. Route `GET /maturation/board`; page `/dashboard/maturation/`; console page id `work/maturation`.
2. Universe = latest review table plus live-owner rows; never the 632 plain tasks.
3. Progress = the review verdict verbatim; the board has no scorer.
4. Older markdown reviews are read tolerantly (5-column `## Full table`, rows starting with a backticked id); a row that does not parse is counted in `sources[]` as unparsed, never guessed.
5. Pool view: one selection algorithm (§6): newest valid review among answering machines, ties to the lease holder then lowest machine id; an unavailable previously-chosen machine triggers the offline rule; live facts merged machine-tagged.
6. Gate `maturationBoard.enabled` via the development-agent gate; `maturationBoard.reviewsDir` default `docs/research/feature-maturation/reviews`.
7. Colours per verdict as in §3, colour never the only signal (each chip also carries the word).
8. The weekly link is added by the review job's own body (done 2026-10-30), not by instar code.
9. The URL `/dashboard/maturation/`, the route `/maturation/board` and the response shape are a
   published interface (Justin bookmarks it; the review job's link depends on it): the response
   carries `schema: "maturation-board/1"`, and a breaking change bumps it. Not cheap to change.
10. Review files stay on the machine that ran the review (proxied-on-read, §6); the board does not
    copy or replicate them.
11. Fleet: live-owner-only board, stated as such (Rollout gate).

## Open questions

*(none)*

## Multi-machine posture

Posture: **unified via proxied-on-read** (no machine-local surface is introduced).

- Review rows: read from the machine that ran the review, merged into every machine's pool view (§6);
  holder offline → cached or labelled unavailable, never silently older or `not-reviewed`.
- Live owner facts (D7, rollout, dark-flag, guards, commitments): each machine reports its own,
  machine-tagged; never combined into one value (D7's origin-local rule).
- The page always requests the pool view, so the same answer appears whichever machine the tunnel
  reaches, subject to which machines answered (shown as "N of M machines answered").
- Single-machine agents: local only.
- Known limit, not introduced by this spec: review files are written by the review job on one machine
  and are not replicated, so losing that machine loses review history. The board reports this
  honestly (offline rule); making the review job commit its files to a replicated location is queued
  as a separate change to the job (evolution action ACT-006, opened 2026-10-30, due 2026-11-06).

## Rollout gate

`maturationBoard.enabled`, registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`, with a
justification) and omitted from ConfigDefaults so the development-agent gate decides: live on a
development agent, 503 on the fleet. On a fleet agent that later enables it without a review job,
the board is live-owner-only and every row says "no maturation review runs on this agent" — stated in
the answer line, not shown as `not-reviewed` failures. Rollback: set the flag false → the route 503s,
the page and tile show the off state, the review job leaves the link out; nothing persisted to revert.

## Maturation plan

- **test-agent-live:** the route and page run on a throwaway agent with seeded owners and seeded
  review files in the e2e test.
- **dev-agent-live:** live on Echo's machines; the weekly review links it.
- **fleet:** default-on after two weekly reviews linked a board whose parity check (below) passed and
  no data defect was reported.
- **graduation criterion:** for two consecutive reviews, the deterministic parity test passes against
  that review's files (every board cell equals its owner's own read: review row, commitment record,
  dark-flag entry, D7 row, guard row), and zero rows show a value with no source.
- **dark-window:** 14 days.

## Tests

- Unit (`maturation-board-model`, server-side builder): §2 validation (every field cap, date later
  than tomorrow refused, file-name/date mismatch refused, newest-invalid reported), markdown parsing
  (five-cell rows, carried marker, CMT only from the action cell), every §4 deadline rule both sides,
  unchangedReviews with carried rows, every conflict rule C1–C4 both sides plus `hold`/`on-track`
  not a conflict, follow-up three states, ambiguous join, bounds.
- Parity: a fixture of real owner reads; every board cell equals its owner's value (the graduation
  check and the report-link precondition).
- Integration: route 200 with seeded owners; 503 when gated off; `scope=pool` with one failed peer, a
  peer whose review is dated in the future (refused), and the review machine offline (cached /
  unavailable states); reviewsDir symlink and `.instar` refusal.
- E2E: production wiring on a dev agent — route alive (200, not 503); `darkFlagRegistry` on the
  context is a real instance (wiring integrity); page and console tile served.
- Live user-role proof (Live-User-Channel Proof Before Done): before the review job links it, a
  user-role headless browser opens `<tunnel>/dashboard/maturation/` from outside, unlocks with the PIN,
  checks the 360 px card layout, applies a filter and reloads the URL to confirm it reproduces, opens
  the console tile, and saves screenshots of the SERVED page. Scenario matrix: happy path, offline
  review machine, gate off, phone width, dark theme.

## Migration parity

New config key with a dev-gate default (no `migrateConfig` write needed); CLAUDE.md template section
plus `migrateClaudeMd` guard so existing agents learn the route and page.
