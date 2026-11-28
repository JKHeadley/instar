---
title: Judgment-call rating — log each judgment-bound call with its context where it is made, and rate it
slug: judgment-call-rating
tier: 2
status: verification rounds in progress (CoS ruling (a)); not stamped converged
author: echo (topic 33368, M5)
countdown: STD-SUBCOUNTDOWN-judgment-call-rating (2026-12-21)
spec-due: 2026-12-07
build-due: 2026-12-16
eli16-overview: docs/specs/judgment-call-rating.eli16.md
---

# Judgment-call rating

## Problem

The registry labels some rules **Judgment-bound**. Each carries two obligations: the call is made
with the context it needs, and the call is logged with that context and periodically rated. The
countdown `STD-SUBCOUNTDOWN-judgment-call-rating` names the gap: "nothing yet forces a
judgment-bound call to be logged with its context at the moment it is made — so the rating loop has
no guaranteed input. The decision journal is the durable surface it writes to and it is queryable
today; what is missing is the write at the chokepoint."

**Denominator.** On main 4185b65174, `docs/STANDARDS-REGISTRY.md` has ten `**Judgment-bound.**`
occurrences: one is the summary paragraph above the countdown, nine are labels in place. The
summary paragraph says eight are labelled; the ninth is the tone-gate article's label, added after
that paragraph was written. The mismatch is recorded for the article's next edit; this spec counts
nine.

## Scope: six of the nine labels

| Label (the judgment) | Where the call is made | Covered by |
|---|---|---|
| consequential or reversible decision | instar-dev commit: the declared tier | part A |
| work serves a standard | instar-dev commit: the spec or artifact it cites | part A |
| audit-shaped, thorough sweep | instar-dev commit: second pass, convergence tag | part A |
| machinery warranted | instar-dev commit: tier against size and risk | part A |
| review genuinely considered | instar-dev commit: the artifact's answers, the second pass | part A |
| could the agent act instead / does the human need this message | tone gate, at runtime | part B |
| one capability / equivalent surfaces | inside session reasoning | out of scope |
| insight worth preserving | inside session reasoning | out of scope |
| duties to notice | inside session reasoning | out of scope |

The last three are judgments made in ordinary reasoning, and their "no" side (not preserving, not
noticing) leaves no event, so no write can be forced. They go to the owner in Pipeline Strategy's
group re-date decision (recorded 2026-11-27, message b41a965f). This spec does not re-date them.

Each label's other obligation, **context sufficiency** (the call is made with the context it
needs), is not built here. The rating measures it after the fact; it does not change what an
author has at the time.

## Part A — the commit-time record

### What exists today

`scripts/instar-dev-precommit.js` runs on every commit. A commit is **in scope** when it reaches
`writeDecisionAudit()` (merge commits leave at Step 0; release cuts run with hooks off; the
feedback executor commits with hooks off). `writeDecisionAudit()` writes one record per gate run
to `.instar/instar-dev-decisions/<ts>-<slug>.json` with `verdict: pending` and stages it; the
process exit handler then sets `verdict` (`pass` / `blocked`), rewrites the file and stages it again.
Both writes swallow their errors today, so a commit can land with no record or a `pending` one.

The judgment context (the tier reasoning, the second-pass claim) lives in the instar-dev trace. The
trace is often committed too — 2,972 traces are tracked although the folder is in `.gitignore` —
but only by the author's own `git add -f`, often in a later commit, and some traces are rewritten in
place (`class-closure-declare.mjs`). The CI check `decision-audit`
(`scripts/decision-audit-presence-check.mjs:97-150`) requires, per pull request, that the records'
scopes together cover the in-scope paths; it ignores the verdict.

So the context is written at the chokepoint but **not reliably kept with the record**, the record
write can fail silently, and nothing rates the calls.

### Change 1: the record keeps the call's context

A new pure module, `scripts/lib/judgment-context.mjs`, builds a `judgment` block (version 1) from
the **same trace the record's other fields come from** — the hook's `freshestTrace` (top-level
`slug`, `declaredTier`, `causalAutopsy` and `classClosure` already come from it). It is called once
for the Tier 1 path (inside `enforceTier1()`, before its own exit) and once for the Tier 2+ path
(after Step 5), and patches `pendingAuditEntry.entryData.judgment` before the exit handler's final
write. It reads only what the hook already reads, plus `git` reads of the index; it adds no network
call.

- `tierReasoning`: copied from the trace. The secret scan (`scanForSecrets`,
  `scripts/audit-secret-patterns.mjs:40`, already imported by the hook) runs on the **whole** text
  first; a match stores `{ "redacted": "<pattern name>" }`. Otherwise the text is stored up to
  4,000 characters (four times the longest of the 2,972 tracked traces, 994); a longer text is
  stored to 4,000 with `tierReasoningTruncated: <original length>`. A trace with none records
  `"missing"`. The text is public once committed, so `write-trace.mjs --tier-reasoning` help and
  the instar-dev skill say so at authoring time.
- `trace`: `{ path, hash, staged }` — `git hash-object --stdin --path=<path>` of the exact buffer the
  hook parsed,
  and whether that path is staged.
- `validatedTrace`: for Tier 2+, the trace Step 5 accepted; if it is a different file from
  `freshestTrace`, its path and hash are recorded and `traceDiffers: true` (the grader then
  `excludes` the call from every question, because the record would otherwise mix two calls).
- `artifact`: `{ path, hash, stagedHash }` from the trace's `artifactPath` (Tier 2+) or
  `sideEffectsPath` (Tier 1): `hash` = `git hash-object --stdin --path=<path>` of the buffer the hook checked, `stagedHash` =
  the staged blob's object id (`git rev-parse :<path>`). Every `stagedHash` in this spec means that
  object id. The existing sha checks are **not** changed, so no new refusal comes from this.
- `spec`: `{ path, hash, stagedHash, staged }` from the trace's `specPath` when declared (none on
  Tier 1; when the spec is not staged, `stagedHash` is the object id at `HEAD`, and `null` if it
  is in neither), plus `convergenceReport`: `{ path, stagedHash }` of the spec's convergence report as it
  stands in the index at gate time, or `null`.
- `template`: the hash of `skills/instar-dev/templates/side-effects-artifact.md` as read.
- `headings`: for each required heading of **that template**, `{ present, chars }` or `missing`.
  Required: the eight numbered questions (`1. Over-block` to `8. Rollback cost`), and `4b.
  Judgment-point check` when the template has it (added 2026-07-11, #1436). Conditional, recorded
  when present and never `missing`: `6b`, `6c`, `Second-pass review`. Not scored, by design:
  `Summary of the change`, `Decision-point inventory`, `Conclusion`, `Evidence pointers`,
  `Class-Closure Declaration`. Matching: a leading number with an optional letter (`4b.`) and any
  parenthesized suffix are removed, case ignored.
- `secondPass`: a new `secondPassStatus(trace)`, mapping the forms found in real traces:

  | trace `secondPass` | `reviewerConcurred` | status |
  |---|---|---|
  | `not-required` | any | `not-required` |
  | `true` / `"true"` / `"required"` | `true` / `"true"` | `required-concurred` |
  | `true` / `"true"` / `"required"` | anything else | `required-not-concurred` |
  | `false` / `"false"` | any | `not-done` |
  | missing, null or free text | any | `unknown` |

  It is the author's self-attestation and is labelled so; the trace does not say whether a second
  pass was *required*, so no finding is scored from `not-done` alone.
- `perFileLines`: `[{ path, added, deleted, baseBlob, stagedBlob }]` for the record's in-scope
  files: the blob at `HEAD` and the staged blob, so the call's own diff can be rebuilt later (see
  "What the judges see").

`headCommit` — the sha of `HEAD` when the gate ran — is written at the **top level** of the record,
outside `judgment`, so it is present even when the block fails.

If building the block throws, the record gets `judgment: { error: "<message>" }` and the commit
proceeds; the error is counted by the grader. The block is a record of the call, never a reason to
refuse it.

### Change 2: a passing commit's record must actually be saved

In the exit handler, when the hook is exiting with success and the final write or `git add` of the
record fails, it prints the file and the error and sets `process.exitCode = 1` (a Node `exit`
listener's `exitCode` replaces the code, and `.husky/pre-commit` passes it to git), so the commit
is refused rather than landing with a `pending` or missing record. If the write succeeded and only
`git add` failed, it first rewrites the file's verdict to `blocked`, best-effort, so a later
`git add -A` cannot commit a `pass` record for a refused commit. A failure of the first write in
`writeDecisionAudit()` sets a module flag that the exit handler checks on a success exit **before**
its early return for a missing entry, with the same result; the judgment patch is skipped when there
is no entry. A blocked commit is already refused; its record stays best-effort. This is the only
new refusal in this spec.

### Change 3: what the judges receive is scrubbed

The judges are external model providers. Every text sent to them (reasoning, artifact, spec, diff)
passes `scanForSecrets` first; a match drops that piece and marks the affected answers
`insufficient-evidence`.

The grader's network use is named here: the judge calls, the documents service, and one read-only
fetch of a PR's head ref from the public repository per rated PR. Nothing else, and nothing at
commit time.

## The decision journal

This spec writes **no** journal rows (it does write the rating totals as documents; see "Totals"). On main, `DecisionJournal.log` rotates its file at 10 MB and
keeps the newest 75% of rows; the journal is kept per machine with no pool-wide read; and
`IntentDriftDetector`, `/intent/journal/stats`, `src/commands/intent.ts` and `OrgActionCheck` read
every row, so automated rows would distort the record of decisions agents log themselves. The
committed record is more durable than the journal and is replicated by git.

**The countdown's wording** names the journal as the durable surface. The registry edit that closes
the countdown will propose the change (the committed decision record is the durable surface; the
totals documents are where ratings are read). That edit needs Justin's approval on GitHub and is
proposed only after the first published rating run for both parts.

## Part B — the tone gate

Each tone-gate decision is already recorded in the judgment provenance log; PR 4026 adds the
scrubbed replay input on development agents. Rating is the benchmark Milestone 1 grader (two judge
families, due 2026-12-05), first run on the Studio when 4026 and 3993 merge, then weekly in the same
job as part A. Its totals hold counts and codes only, never replay text, and use the same manifest
rules as part A, except for the cursor: tone decisions accumulate while main stands still, so Part B's
manifest carries its own **provenance cursor** (the last rated row's day file, id and timestamp) and
the ids of rows carried over or awaiting retry, never a main sha. **Denominator:** each run reports, for the same period, every tone-gate decision
row in the provenance log, how many carry captured replay input, how many are replayable exactly,
and how many were rated, with the refusal reasons for the rest (the grader's existing plan counts:
rows, captured, replayable, exact, refused by reason). A decision with no replay input is counted
and never silently left out.

## Rating loop for part A

A new grader mode `instar-dev-grade` reuses the Milestone 1 grader's run folder, route pinning,
resume, per-call code and two-judge agreement.

### Which calls are rated

Main is squash-merged (of the last 200 first-parent commits: 95 release cuts, 100 squash commits
ending `(#N)`, 5 `Merge pull request #N`). Each run walks first-parent commits since its cursor,
joins each to its PR by that number (diffing a merge commit against its first parent), and counts a
commit without one as `no-pr`.

Within a PR, **every `verdict: pass` record the PR adds is a call**, subject to the checks below,
applied **in this order** and each decided from recorded evidence rather than inferred from scope:

- **Retry.** An earlier pass record is `superseded` when a later pass record with the same slug has
  the same `headCommit` — the same commit was attempted again (the usual cause is a check that runs
  after the gate in `.husky/pre-commit`, such as `check-rule3-coverage`, refusing the first
  attempt). Two successive real commits have different `headCommit` values and both stay calls.
- **Record format first.** A record with `judgment.error` is `excluded` before any matching. A
  legacy record (no `judgment` block) goes to the legacy path below. Only records with a `judgment`
  block go through the landing check.
- **Landing.** A call's **carrying commit** is the PR commit that introduced its record file. The
  record lands when that commit's **complete set of in-scope paths equals the record's** and, at
  every one of them, it makes the transition the record describes (`baseBlob` → `stagedBlob`, a
  deletion counting as a transition to absent); a carrying commit that also changes other in-scope
  paths is a mismatch, so a refused attempt cannot be credited with a larger landed change. If the carrying
  commit's transition differs — an amend (the gate runs with `HEAD` at the commit being amended, so
  the record describes B→C while the surviving commit makes A→C; the original commit's record is
  mismatched the same way, so an amended change gets no tier or proportionality rating), or a
  refused attempt whose record rode a later, different commit — the call is `transition-mismatch`: it is still rated in stage 2,
  and the diff-dependent answers (stage 1 and the proportionality question) are
  `insufficient-evidence`, rather than a small amend being judged as the whole call. A record whose
  PR history cannot be fetched is `history-unavailable`, counted and not rated.

Legacy records carry no `headCommit`, so for
them an earlier same-slug pass record is `superseded` only when a later one's scope contains it
(13 of 111 on the 69 recent in-scope PRs), and the totals say this weaker rule was used. Records
without `ts` (9 today) are counted `no-ts` and not rated. A PR is **covered** when its calls' scopes
together cover the PR's in-scope paths.

The in-scope rule is moved out of the hook (`inScope()`, which cannot be imported from a script with
top-level side effects) into `scripts/lib/instar-dev-scope.mjs`, imported by both the hook and the
grader so they agree. The CI presence check has its own copy (`isInScopeFile`) that already lacks the
hook's user-facing-surface branch; this spec names that drift and does not change the CI check, and
the coverage report uses the hook's rule, today's version, for every PR it reports.

For each call, the grader reads the artifact and spec from the PR's landed tree. A document counts
as the call's evidence only when the hook checked the same content it staged: `hash` is taken with
`git hash-object --path=<path>`, which applies the repository's line-ending normalization, so a
CRLF checkout of an LF blob hashes equal while a real unstaged edit does not (`hash` equals
`stagedHash`; otherwise `checked-differs-from-staged`) **and** the landed git object id equals
`stagedHash` (git objects, so a checkout's line-ending conversion never reads as a difference): a differing artifact makes the review questions `insufficient-evidence`; a
differing spec makes the standard question `insufficient-evidence`.

**Legacy records** (5,190 tracked on 2026-11-27 at 4185b65174, written before this change) have no
`judgment` block. A legacy call is rated through a rebuilt view only when exactly one trace in the
landed tree has its slug and a `coveredFiles` superset of its scope (62 of 69 recent in-scope PRs
match exactly one); headings are checked against the template in that same tree. Otherwise the call
is `unmatched`, counted, and not rated.

### What the judges see, in two stages

Fenced as data with a fresh per-call code (the SEC-097 nonce lesson):

1. **Stage 1, tier** — the changed paths, `perFileLines`, the tier definitions from the instar-dev
   skill, and **that call's own diff**: rebuilt from each path's
   `baseBlob` and `stagedBlob` in the record, read from the PR's head ref (`refs/pull/<N>/head`,
   fetched read-only from the public repository, at most one fetch per PR, because squash merges
   drop the intermediate blobs from main). A blob **resolves** only if it is reachable from that
   ref, not merely present in a local object store; a missing base on an added file or a missing
   staged blob on a deleted file means "absent", not "unresolvable". An unresolvable blob makes the
   diff-dependent answers (stage 1 and the proportionality question) `insufficient-evidence`, so a later call's edits to the same file are never shown
   as this call's; unresolvable counts are reported in the totals.
   Legacy calls have no blob ids and use their scope's diff in the landed PR only when no other call
   in the PR touches the same paths; otherwise the diff-dependent answers are `insufficient-evidence`. Bounded at
   60,000 characters (about 15,000 tokens: far inside either judge's context, and chosen to keep
   each call's prompt near 20,000 tokens so the weekly cost estimate below holds) with the cut
   disclosed; a cut diff makes the
   diff-dependent answers `insufficient-evidence`, never a verdict on part of a change. The diff excludes
   `.instar/instar-dev-traces/`, `.instar/instar-dev-decisions/`, `upgrades/side-effects/` and
   `docs/specs/`. **No declared tier, no suggested tier, no `riskFloor` number or its reasons (the
   gate's suggestion is `max(sizeTier, riskFloor)` and could be rebuilt from them), no tier
   reasoning and no artifact text.** Every rated call gets the same view,
   so the calibration groups below see the same evidence.
2. **Stage 2, the rest** — built only after the stage 1 answers are recorded: the whole stage 1
   view, `declaredTier`, `riskFloor` and `riskFloorReasons`, the tier reasoning, the artifact
   text, the spec frontmatter (including `review-convergence`) and its body as staged at gate time
   (read by `spec.stagedHash`, bounded at 80,000 characters — the 95th percentile of the 1,024
   specs on main is 76,008, the median 15,245 — with the cut disclosed; a cut or
   unavailable body makes the standard question `insufficient-evidence`), the convergence report captured at
   gate time (`spec.convergenceReport`, never one added later in the PR), `secondPassStatus` labelled as the author's attestation, and
   the `headings` result. When the call's diff is missing or cut, stage 2 says so, and the review
   question ("engage this change's real risks") is `insufficient-evidence` too; the grader-forced
   reasons in "Agreement and retries" apply to exactly the questions named in each rule.

**Later history is withheld from the judges in both stages.**

### What they answer

| Label | Stage | Question | Codes |
|---|---|---|---|
| consequential or reversible | 1 | Which tier does this change warrant? The judge answers **without seeing the declared or the gate's suggested tier**; the grader then compares mechanically: same as declared → `right`, higher → `too-low`, lower → `too-high`. | judge: `1`, `2`, `3`, `insufficient-evidence` |
| machinery warranted | 2 | Shown the declared tier only now, after the stage 1 answer is recorded: is the process that tier prescribes proportionate to this change? (The work actually done is not asked here.) | `proportionate`, `over`, `under`, `insufficient-evidence` |
| work serves a standard | 2 | Does the cited spec or artifact name the standard the change serves, and does the change match it? | `serves`, `unclear`, `none-cited`, `insufficient-evidence` |
| review genuinely considered | 2 | Do the artifact's answers engage this change's real risks, rather than template text? | `engaged`, `boilerplate`, `missing`, `insufficient-evidence` |
| audit-shaped sweep | 2 | If the change is a sweep, did a second pass or convergence run? | `convergence-recorded` (decided from the record, not by the judges: a convergence tag and a convergence report both present at gate time — evidence that the review was recorded, not proof of its quality), `attested-only` (the author's second-pass claim alone), `no`, `not-a-sweep`, `insufficient-evidence` |
| context sufficiency | 2 | From what the record shows the author had (the scope, the spec, the artifact), was something the call needed missing? | `none-missing`, `spec-missing`, `risk-not-surfaced`, `unknown` |

Each judge also reports what **its own** view lacked (`none`, `scrubbed`, `truncated`), so the
grader's gaps are never read as the author's. Mechanical facts are scored from the record, not by
judges: a required heading `missing`. A call whose author text contains instruction-shaped content
aimed at the judge is classed `injection-suspect` and excluded from findings if either judge flags
it.

### Agreement and retries

Each question on each sampled call ends in exactly one disposition:

- `agreed`: both families give the same code and echo the per-call code; for the tier question
  agreement is on the **judges' proposed tier** (1, 2 or 3), and `right` / `too-low` / `too-high` are
  derived from the agreed tier, so two judges proposing 2 and 3 against a declared 1 are
  `disagreed`, not an agreed `too-low`;
- `disagreed`: both answered validly, with different codes;
- `insufficient-evidence`: both judges said so, **or** the grader forced it before asking (an
  unresolvable blob, a scrubbed or truncated input, a checked/staged or landed mismatch); the two
  sources are counted separately inside this disposition;
- `incomplete`: a family was unavailable or failed the code this run (retried later);
- `gave-up`: still incomplete after two retries, with the cause of each failed attempt (family
  unavailable, code not echoed, unparseable) kept in the ledger, so a run of one cause is visible;
- `excluded`: `injection-suspect`, `traceDiffers`, or `judgment.error`.

Dispositions sum to the sampled calls for every question. A **rate** is the count of an agreed code
divided by `agreed + disagreed` for that question and group, and is always published with both
numbers. A finding counts only when the disposition is `agreed`. An
`incomplete` call's id is carried in the manifest for retry next run. If a family is
unavailable for a whole run, the run publishes its counts with every rate marked `unavailable`, and
the next run compares against the last run that had rates.

### Calibration (outcome check, judges blind)

Calibration compares **landing cohorts after a fixed follow-up**: the calls of PRs that landed in
the same four-week window are compared once that window is 30 days old, so every call in a cohort
had the same time to be reverted or blamed. Within a cohort, a call is outcome-implicated when,
within those 30 days, a revert of its PR landed on main or a record's `causalAutopsy` (`origin:
prior-pr`, `relatedPrs`) named its PR (59 such records today, naming 39 PRs). Each call is counted
once per cohort comparison. A revert or a blame is an event on a **whole PR**, not on one call, so
the subject of the comparison is stated as "calls in implicated PRs versus calls in other PRs", the
totals give PR counts beside call counts, and no individual call is ever reported as the cause. The report compares implicated calls with the rest of the cohort,
within the same `belowFloor` stratum: the rates of `too-low`, `under` and `boilerplate`, with every
disposition count (agreed, disagreed, insufficient-evidence, incomplete, gave-up, excluded) shown. The judges rate every
call with the same view and never see the outcome; a call's own diff may contain unrelated reverts
of other work, which is the call's content, not its later history. A blamed or reverted change does
not prove the call was wrong, so this is a retrospective association with its counts, never an
accuracy score, reported only for cohorts with at least 20 implicated calls **from at least 10 distinct implicated
PRs** (an outcome belongs to a whole PR, so one reverted PR with many calls must not satisfy the
minimum alone); the totals publish implicated and comparison PR counts, and eligible and rated calls
per stratum, so the catch-up cap's effect is visible, and print "below minimum" for every other
cohort. At today's rate (the 59 autopsy records name 3 to 25 PRs a
month), most cohorts will not reach 20, and the first possible report is about late January 2027,
after the countdown date. The countdown is not closed on calibration; it is closed on the ratings.

Calibration needs each earlier call's answers, so each totals document also carries a **per-call
ledger**, codes only: call id (record path), PR, landing date, sampling group, `belowFloor`, each question's
disposition and agreed code, and the grader version. Ledger entries are keyed by (call, question,
grader version): a retry adds an entry only for the questions still unresolved, a resolved answer is
carried forward unchanged, and rebuilding takes, per key, the latest entry — so a call has exactly
one disposition per question however many runs touched it. A later run on any machine computes a
cohort's calibration from the ledgers of the totals documents covering it, with no run folder
needed.

### Sampling and cost

Per run, from calls since the cursor: every `belowFloor` call (about 49 records a week today;
capped at 60 — about 20% above the observed weekly rate, so a normal week is taken whole and a
burst is spread over the next runs rather than dropped; overflow carried in the manifest), carried-over and retry ids, a seeded 40 of the
rest (about ±15 points on a rate at 95%: enough to see a class of problem, not to rank authors),
and, for each cohort reaching its 30-day mark, any of its calls not yet rated (the `cohort-catch-up`
group, capped at 40). The seed and sizes are written into the run
plan before any record is read. Estimated cost: about 120 calls × 2 judges × 2 stages, 3–5M tokens
a week with diffs, on the judge routes pinned in the run plan, as in Milestone 1. Each judge call's
route, served model, latency and outcome are recorded in the run folder and summarized in the
totals (the grader calls models through their CLIs, not through the server's funnel; named so it is
not implicit).

### Totals, the manifest and the cursor

Each run publishes one document in the benchmark conversation (`POST /docs` with `primary:
"telegram:33368"`, because a scheduled job's document otherwise lands in the owner's own
conversation) with the totals:
denominators **by sampling group** (`belowFloor`, `random`, `cohort-catch-up`; outcome implication
is a calibration attribute, reported there, not a sampling group), the coverage report and
the counts of `superseded`, `transition-mismatch`, `history-unavailable`, `checked-differs-from-staged`, `no-pr`, `no-ts`, `unmatched`, `incomplete`, `gave-up`,
unresolvable blobs and `judgment.error`, and the per-call ledger. It ends with a **manifest**: the main sha processed to, carried-over and retry ids,
each group's last evaluable rate interval, and `status: published`.

The next run lists that conversation's documents and takes the latest whose manifest says
`published`, that this agent wrote, and whose sha is an ancestor of main. If the documents service
answers 503, the holder is unreachable, or creating the document is refused (409
`primary-wider-than-caller`, if the conversation is not owner-only or the job lacks owner reach),
the run stops without publishing and says why in its run log. Only when the conversation has no totals
document at all does it start from the countdown start (the commit this spec lands in). One line
goes to the benchmark topic only when a group's rate moves outside its last evaluable interval.

**One writer at a time.** The grading job runs only from the Studio's scheduler, whose job lease
already prevents two instances of one job running at once. As a second guard, a run records the id
of the predecessor totals document it started from, and immediately before publishing re-reads the
conversation's documents: if a newer published totals document exists, it does not publish and
says so in its run log. Each totals document carries an idempotency key (predecessor id + run id),
so a publication retried after an ambiguous failure is found, not duplicated.

Findings are signal only: never written into the instar-dev skill, a prompt or an author's context
automatically; any process change they suggest goes through the normal spec path.

### If the Milestone 1 grader slips

Part A's record ships on its own. The rating mode depends on PRs 4026 and 3993 merging; if they have
not merged by 2026-12-10, the countdown itself (not only this spec) goes back to Pipeline Strategy
for a re-date, so the countdown is never closed on records nobody has rated.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Commit gate verdict (pass / block) | invariant; basis: enumerable-domain; evidence: the new module writes fields only, no existing check reads `judgment`, and the sha checks are unchanged | unchanged |
| Record write fails on a passing in-scope commit | invariant; basis: irreversible-consequence; evidence: a call with no record can never be rated later, which is the countdown's named gap | refuses the commit (`process.exitCode = 1`); the only new refusal |
| Building `judgment` throws | invariant; basis: enumerable-domain; evidence: it throws or not | `{ error }` recorded, commit proceeds, counted by the grader |
| Secret scan on `tierReasoning` | invariant; basis: irreversible-consequence; evidence: committed history is public and cannot be withdrawn | redacts, never blocks |
| Validated trace differs from the record's trace | invariant; basis: enumerable-domain; evidence: two paths are equal or not | `traceDiffers: true`; the call is `excluded` from every question |
| Required-heading match | invariant; basis: enumerable-domain; evidence: a fixed list from the hashed template the record names, with a fixed normalization | conditional headings never `missing` |
| `secondPassStatus` mapping | invariant; basis: enumerable-domain; evidence: the table above covers every form found in the 2,972 tracked traces, with `unknown` for the rest | no finding from `not-done` alone |
| Which records of a PR are rated | invariant; basis: enumerable-domain; evidence: every pass record the PR adds, minus retries (a later same-slug record with the same `headCommit`) | `superseded`; errored records `excluded` |
| Carrying commit's transition differs from the record | invariant; basis: enumerable-domain; evidence: two (base, staged) pairs per path are equal or not | `transition-mismatch`; diff-dependent answers `insufficient-evidence` |
| Grader's tier comparison | invariant; basis: enumerable-domain; evidence: an agreed proposed tier is equal to, above or below the declared tier | `right`, `too-low`, `too-high` |
| An answer pair that differs | invariant; basis: enumerable-domain; evidence: two valid codes are equal or not | `disagreed`; counts in the rate denominator, never a finding |
| A call's own diff cannot be rebuilt | invariant; basis: enumerable-domain; evidence: each blob resolves or not | diff-dependent answers (stage 1 and proportionality) `insufficient-evidence` |
| Record with no declared tier | invariant; basis: enumerable-domain; evidence: `declaredTier` is null or not | compared against Tier 2, the gate's own default, and labelled so |
| Landed artifact or spec differs from the record | invariant; basis: enumerable-domain; evidence: two hashes are equal or not | dependent questions `insufficient-evidence` |
| Checked bytes differ from staged bytes | invariant; basis: enumerable-domain; evidence: `hash` equals `stagedHash` or not | `checked-differs-from-staged`; dependent questions `insufficient-evidence` |
| PR history cannot be fetched | invariant; basis: enumerable-domain; evidence: the head ref fetch succeeds or not | `history-unavailable`, counted, not rated |
| Legacy call not uniquely matched | invariant; basis: enumerable-domain; evidence: the candidate count is one or not | `unmatched`, counted |
| Secret-scan drop from a judge's view | invariant; basis: irreversible-consequence; evidence: text sent to a provider cannot be recalled | affected answers `insufficient-evidence` |
| Which calls the grader samples | invariant; basis: enumerable-domain; evidence: a fixed rule over calls since the manifest's sha, seed written before reading | caps disclosed, overflow carried |
| Previous totals not found / service down / creation refused (409) | invariant; basis: enumerable-domain; evidence: the conversation has a published totals document, none, or cannot be read | none → countdown start; unreadable or 409 → stop without publishing |
| The judges' rating of a call | judgment-candidate | floor: closed codes, per-call code echo, two-family agreement, `insufficient-evidence` on a cut, scrubbed or mismatched input; conservative default: `incomplete`, no finding, retried; last rung: a run missing a family publishes rates as `unavailable`; arbiter: the two judges |
| `injection-suspect` class | judgment-candidate | floor: either judge flagging it excludes the call from findings; arbiter: the two judges; the count is reported |
| Whether the topic hears about a run | invariant; basis: enumerable-domain; evidence: a group rate is inside its last evaluable interval or not | |

## Multi-machine posture

- Commit records and their new `judgment` block: **unified**, committed and replicated by git. The
  trace and spec a record names may be unstaged (`staged: false`); the record's copied reasoning
  and hashes stand on their own.
- Rating totals and the manifest that carries the cursor: **unified**, published as documents in the
  benchmark conversation and read through the documents service from any machine (through the
  holder on a standby machine).
- The grader's run folder: scratch for one run, rebuilt from committed data; nothing else depends on
  it.
- No journal rows and no other machine-local surface are added.

## Frontloaded Decisions

1. The committed record is the durable surface; ratings are read from the totals documents; no
   journal rows; the wording change goes with the countdown-closing registry PR for Justin's
   approval.
2. Only the author's short tier reasoning is copied into the record (scanned, bounded, declared
   public at authoring time); no LLM and no new network call at commit time.
3. The only new refusal: a passing in-scope commit whose record cannot be saved.
4. Every passing record in a landed PR is a call, except a retry of the same commit (same slug and
   `headCommit`) and a record that never landed; CI coverage stays as it is and is measured every
   run.
5. Two-stage judging with history withheld and the same view for every rated call; calibration is a
   retrospective association within strata, never an accuracy score.
6. Sample 40, belowFloor cap 60, cohort catch-up cap 40, diff bound 60,000, two retries, calibration
   minimum 20 — cheap-to-change-after: run-plan parameters that touch no stored data. The four-week
   cohort window and 30-day follow-up are cheap to change for future cohorts, but a change breaks
   comparison with earlier cohorts, so it is recorded in the run plan and the totals.
7. Weekly grading on the Studio — cheap-to-change-after: a schedule edit.
8. The Milestone 1 grader is the base; `instar-dev-grade` is a mode of it, not a new tool.

## Acceptance

1. Tier 1 and Tier 2 fixtures: the record carries a `judgment` block built from `freshestTrace`,
   with `artifact.hash` equal to the hash of the bytes the hook checked and `stagedHash` equal to
   `git rev-parse :<path>`; a record whose `judgment` block errored still carries `headCommit`; a Tier 2 fixture where an older trace passes Step 5 records `traceDiffers:
   true`.
2. A failing final write or `git add` on a passing commit refuses it with a message naming the file;
   the same failure on a blocked commit changes nothing.
3. A planted fake token in `tierReasoning` yields `redacted`, also when it sits past character
   4,000; a 5,000-character reasoning yields 4,000 and `tierReasoningTruncated: 5000`; a missing one
   yields `"missing"`; an unstaged trace yields `staged: false` with the reasoning present; a module
   that throws yields `{ error }` and the commit proceeds.
4. Heading matching passes on the real variants ("7. Multi-machine posture (Cross-Machine
   Coherence)", "4b. Judgment-point check (Judgment Within Floors standard)", "Second-pass review
   (if required)"), marks a missing `5. Interactions` `missing`, never marks `6b` missing, and does
   not require `4b` against a template that lacks it.
5. `secondPassStatus` maps every row of its table.
6. The module adds no network call (unit test on the module); the sha checks' refusals are
   unchanged (existing tests).
7. Existing readers still pass: `tests/unit/decision-audit-presence-check.test.ts`,
   `instar-dev-precommit-audit-staging.test.ts`, the `class-closure-lint*` tests,
   `safe-merge-local-floor.test.ts`, and the `readDecisionDeclarations` tests.
8. The grader on a fixture repository: a PR with a Tier 2 runtime commit and a later Tier 1 fixup
   under the **same** slug yields two calls, each judged on its own diff; two successive commits with
   the same slug and the same paths yield two calls, while a retry of one commit (same `headCommit`)
   yields one; two calls that successively edit the same line show each call only its own edit; an
   amend, and separately a refused attempt whose record rode a later commit, are `transition-mismatch`
   with stage 1 and proportionality `insufficient-evidence`; a uniquely matched legacy record and an
   errored record carried by a landed commit take their own paths (rebuilt view; `excluded`); a Windows-style checkout does not read as an artifact difference; a release commit counts
   `no-pr`; an artifact edited after the last gate run, and separately a spec-only edit, make the
   dependent questions `insufficient-evidence`; a legacy PR with two matching traces is `unmatched`.
9. Stage 1's rendered prompt, with unique markers planted in a changed trace and artifact, contains
   neither, and contains neither a marker string planted in `riskFloorReasons` nor the field names
   `declaredTier`, `suggestedTier` or `riskFloor`;
   the stage 2 prompt is built only after the stage 1 answer is stored; no judge input contains later history; a planted injection call is excluded; a planted
   fake token never reaches a judge.
10. With one family off, every call is `incomplete`, rates publish as `unavailable`, ids carry over,
    and the next run retries them and compares against the last evaluable interval.
11. Run as the real scheduled job: the totals document lands in the benchmark conversation; a second
    run on another machine finds it and continues from its manifest, and computes a cohort's
    calibration from the ledgers after the first run folder is deleted; a 409 on document creation
    stops the run without publishing; with the documents service answering 503 it stops without
    publishing; with no totals document it starts from the countdown start.

12. Evidence eligibility: a fixture where the hook checked bytes A while B was staged and B landed is
    `checked-differs-from-staged`; a spec-only edit after the gate run is caught by `spec.stagedHash`;
    a convergence report added in a second commit of the PR does not make the first call `convergence-recorded`;
    a refused attempt that only deleted a file, whose record rode the next commit under a different
    slug, is `transition-mismatch` (under the same slug it is `superseded`, the retry check running
    first); a carrying commit that lands the record's change plus another in-scope path is
    `transition-mismatch`; a standard cited only in the spec body is visible to stage 2, and an
    unavailable body gives `insufficient-evidence`; two workers starting from one manifest publish
    once; a partial retry rebuilds to one disposition per question; a CRLF checkout of an LF artifact is eligible while a real unstaged edit is
    `checked-differs-from-staged`; an unfetchable PR history is
    `history-unavailable`.
13. Each question's dispositions sum to the sampled calls, and every published rate shows its
    numerator and its `agreed + disagreed` denominator.
14. Two weekly tone-gate runs at the same main sha, with new tone decisions between them, rate the new
    rows once each, including after a publication failure and retry; a tone-gate run over a period with a logged decision that has no replay input counts it as not
    replayable, with its reason, and the published denominators add up to the provenance rows.

## Rollback

Revert the hook change: it restores the old best-effort write. Records already written keep their
additive `judgment` block (hashes, counts and the short tier reasoning, public once committed).
Disable the Studio job to stop grading.

## Open questions

*(none)*
