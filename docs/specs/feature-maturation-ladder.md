---
title: "Feature Maturation Ladder — measured thresholds, rich evidence, and a driver from dark to default-on"
slug: "feature-maturation-ladder"
author: "echo"
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
parent-spec: "docs/specs/feature-maturation-recurring-evaluation.md (D7, the one scorer); docs/specs/maturation-board.md (the one view); docs/specs/feature-maturation-discipline.md (D4/D7 arms); docs/specs/maturation-followthrough-fix.md (CMT-977: the guard inventory should feed D7)"
eli16-overview: "feature-maturation-ladder.eli16.md"
approved: true
approved-by: "Echo under Justin's standing delegation (only constitution changes need his approval), within his 2026-11-03 17:11 PST directive in topic 136110. The article amendment in §12 is NOT covered and ships separately after his sign-off."
review-convergence: "2026-11-04T02:44:54.316Z"
review-iterations: 3
review-completed-at: "2026-11-04T02:44:54.316Z"
review-report: "docs/specs/reports/feature-maturation-ladder-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Feature Maturation Ladder

## Problem statement

Operator directive (Justin, 2026-11-03 17:11 PST, topic 136110), verbatim: "ALL features that are shipped off due to being 'not proven' MUST have a plan for growth/maturation that includes robust and intelligent data tracking/logging/auditing with enough rich context to evaluate its performance and with clear thresholds that indicate when it can mature to the next level, with the final level being default deployed ON (unless its specifically determined to be default off due to user preference)".

Measured today (GET /maturation/board and the shipped defaults, 2026-11-03):

| Fact | Value |
|---|---|
| Rows on the board | 224 |
| Rows whose flag is really default-on in shipped defaults | 4, plus 2 default-on but dry-run |
| Rows that are dev-gated (live on development agents, off on the fleet) | 86 |
| Rows default-off for everyone | 29 |
| Rows whose id matches no setting | 90 (33 are D7 `class-review-*` accounting rows; the rest composite or renamed ids) |
| `DEV_GATED_FEATURES` entries | 132; 46 match no board row by id |
| Rows with next step "Nothing planned" | 147 |
| Rows with a numeric target | 9 |
| D7 scored rows | 29: 21 `missing-contract`, 5 `ready`, 2 `hold`, 1 `insufficient-evidence` |
| Review stage label | model-written; 64 say `unknown`, and none says `fleet` |

Four defects follow:

1. **Thresholds are prose.** The plan gate checks that a `graduation criterion` line exists. D7 can check numbers, but only 8 of its 29 rows have a contract, and it can only see features with a spec-born initiative.
2. **Stage is an opinion.** The review writes the stage by hand. Nothing derives it from shipped defaults, so the board cannot state how far a feature really is.
3. **Tracking is unguaranteed.** Some features write rich JSONL. Others have nothing, and `proofOfLife` reads `unknown` for all of them.
4. **Nothing drives a feature upward.** D7 and the board are advisory by design. The review job promotes on its own agent by hand, and files everything else to a feedback queue. Its 2026-11-02 report says it plainly: the fixes filed on 10-31 "reached the feedback store … none has become a work item yet", with 424 items queued. Filing is not moving.

## Non-goals (extend, never duplicate)

- No second scorer: D7 stays the only thing that says `ready`.
- No second database, registry of flags, scheduler or board.
- No second review: `feature-maturation-review` stays the one recurring review, reporting in topic 128732.
- Nothing here flips a fleet default directly. A fleet default stays a reviewed code change (`featureRollout.ts`'s invariant).
- `InitiativeTracker` gets no new records: ladder subjects are in-memory, so the 1,358-initiative digest is not flooded.

## Foundation and what each piece extends

| Concern | Owner today | This spec adds |
|---|---|---|
| Readiness score | D7, `BlockerLifecycleService.evaluateMaturation` | Ladder subjects in its input; contract chosen by next rung |
| Evidence read | D7 `registerMaturationProjection` (the "read-only projection from a feature's counters") | One projection per ladder metric. No ledger schema change: every row stays `source='feature-summary'` |
| Stage derivation | `featureRollout.deriveRolloutStage`, `accountingRung` | `deriveLadderRung`, which also knows the dev gate and a shipped `dryRun: true` |
| Promotion authority | Today a person or the job; D7 says scores never authorize | Unchanged: the job's model decides, the route only enforces floors |
| View | `/maturation/board`, `/dashboard/maturation/` | A `ladder` owner source and a row detail block |
| Decisions and fixes | `feature-maturation-review` job, `maturation:<id>` commitments | Reads ladder state; decides every move; opens a build session rather than only filing |
| Structural gate | `FeatureMaturationPlanGate` | Also requires a `ladder` line naming a real entry |
| Inventory | `GUARD_MANIFEST`, `DEV_GATED_FEATURES`, `ConfigDefaults` | A coverage test over them (`maturationUniverse`) |

## Design

### 1. The ladder registry

`src/data/feature-ladders.json`, schema `feature-ladders/1`, repo-tracked and shipped in the package. One entry per feature:

```ts
interface LadderEntry {
  id: string;                 // the flag path without `.enabled`, or a stable name
  title: string;              // plain name
  aliases?: string[];         // review row ids, spec slugs, guard keys
  subject?: string;           // D7 feature id; `^[a-z0-9][a-z0-9-]{0,62}$`. The spec-born initiative id when one exists, else derived from id
  flag: { path: string; on?: string | boolean } | null; // `on`: the value meaning fully live, default `enabled: true`
  disposition: 'ladder' | 'composed' | 'retire';
  composedInto?: string;      // composed: moves with its parent, no thresholds of its own
  retire?: { reason: string; ref: string };  // includes "no consumer": the flag is read nowhere
  final: 'default-on' | 'default-off-by-preference';
  preference?: { decidedBy: string; reason: string; decidedAt: string; ref: string };
  risk: 'standard' | 'sensitive'; // sensitive: money, credentials, PIN, killing processes, load-bearing paths
  rare?: boolean;             // fires only on incidents, so idle is healthy: `no-opportunity`, not `no-data`
  start?: { set: Record<string, string | number | boolean> }; // how to start it safely when nothing runs it, normally a dry-run
  restartNeeded?: boolean;    // read at boot, so a move needs a restart to take effect
  tracking: { state: 'measured' | 'needed'; plan: string }; // needed: what must be logged, and where
  rungs: {
    'dev-agent-live'?: Rung;  // the bar for acting on development agents
    'fleet'?: Rung;           // the bar for default-on
  };
}
interface Rung {
  soakDays: number;           // consecutive days of D7 `ready`, integer 1..60
  advance: { kind: 'config'; set: Record<string, string | number | boolean> } // only keys under flag.path
         | { kind: 'owner-driver'; driver: string }   // an existing sole writer, e.g. StageAdvancer
         | { kind: 'code' };                          // a reviewed PR
  metrics: LadderMetric[];    // 1..16
}
interface LadderMetric {
  id: string;
  role: 'ran' | 'quality' | 'harm';
  source: 'jsonl-log' | 'feature-metrics' | 'guard-posture' | 'feature-summary';
  ref: Record<string, unknown>; // closed per source, §3
  direction: 'at-least' | 'at-most';
  threshold: number;
  minSamples: number;
  windowDays: number;         // 1..30
}
```

**Enough to judge (structural).** Every rung must carry at least one `ran` metric and at least one `quality` or `harm` metric, and `guard-posture` may only fill the `ran` role. That is clause (b) of the article as a rule: a feature graduates on its own logged behaviour, never on "the guard is on".

**`tracking: needed` is still a real ladder.** Its metrics read the generic evidence log (§4), so the thresholds exist on day one, the feature reads 0 samples, and the state says `no-data` until someone instruments it. No entry can be vague just because the feature is blind.

A `fleet` rung may not be `kind: 'config'`, because a local setting cannot reach a shipped default. A `ladder` entry must have a flag. The parser (`src/monitoring/MaturationLadder.ts`) validates closed fields and refuses a bad file whole: the route reports `ladder-file-invalid`, raising does nothing, and a unit test keeps the shipped file valid. Tests also hold: subject ids are unique; every `DARK_GATE_EXCLUSIONS` entry and `loadBearing` guard is `sensitive`; `advance.set` keys sit under `flag.path` and never touch the session-pool stage path, whose sole writer is `StageAdvancer`.

### 2. The universe and the coverage ratchet

`src/monitoring/maturationUniverse.ts` derives, from code only, the set of switched-off features: every `DEV_GATED_FEATURES` entry; every `GUARD_MANIFEST` entry whose default is off or dry-run; every `enabled: false` or `dryRun: true` path in `getMigrationDefaults`; every `DARK_GATE_EXCLUSIONS` entry; every `ships-staged` spec's flag.

`tests/unit/feature-ladders-coverage.test.ts` fails when a universe member has no entry (by `flag.path`, `id` or alias), when an entry's flag no longer exists, or when `composedInto` names a missing or composed parent. There is no baseline file: the bulk authoring below covers all of them at once, and the test holds it there. A new dark flag now cannot merge without a ladder. This is the same shape as `lint-guard-manifest`.

### 3. Evidence sources

Each is a closed read, computed once per pass.

| Source | `ref` | Value and samples |
|---|---|---|
| `jsonl-log` | `{file, where?, of?, value: 'count'|'ratio', timeField?, dedupe?}` | `count`: rows matching `where` in the window. `ratio`: rows matching `where` over rows matching `of`. For both, samples are the rows matching `of` (every row in the window when `of` is absent), meaning exposure, so a clean harm count of 0 can pass. `dedupe` keeps the last row per that field's value, which is how a re-graded event counts once |
| `feature-metrics` | `{feature, field: 'errorRate'|'fireRate'|'realLlmCalls'}` | `FeatureMetricsLedger.summary`; samples equal `realLlmCalls` |
| `guard-posture` | `{key}` | 1 when the guard's `effective` is `on-confirmed`, else 0; samples 1 |
| `feature-summary` | `{ref}` | An existing D7 projection, for the eight spec contracts that already measure something |

`where` and `of` are flat `field: value` equality maps on top-level fields. A metric on the shared evidence log must name the same `featureId` in both, so another feature's activity can never count as this one's exposure or freshness.

**Confinement.** `file` must match `^(logs|\.instar/logs|\.instar/state)/[A-Za-z0-9._/-]+\.jsonl$`, its real path after symlinks must stay under the agent home, and a name containing `credential`, `secret`, `token`, `account` or `peers/` is refused. Registry entries are reviewed code and outputs are numbers only, so this is a second lock.

**Honest reads (Never Silently Cut the Data).** Files are streamed line by line, off the event loop, one at a time, with a yield between files. All rotated segments (`<file>.<n>`) count; a compressed segment marks the reading partial. A distinct file over 512 MB is not read, and its metrics are absent with reason `file-too-large`. When a log's oldest row is newer than the window start and the log has rotated (or holds a compressed segment), data may be missing. The reading carries `coverageDays`, which the route shows, and the metric is absent with reason `evidence-cut`, unless it is an `at-least` count, where missing rows cannot flip the answer. So a truncated read can never pass a harm or quality bar, and a metric's window must fit what its log keeps.

**Dead reads as dead.** D7 stamps each observation at capture time, so log age is invisible to its staleness rule. So a `ran` metric whose newest row is older than `min(7, windowDays)` days reads 0 samples, and `feature-metrics` reads its `ran` metric over the same span. A burst followed by a crash cannot hold a soak. A `rare` feature uses its whole window instead, since it may fire less than weekly.

Samples are clamped to D7's ledger limit of 100,000. A failed read leaves that metric absent, so D7 says `insufficient-evidence`, never a pass. `refreshLadderEvidence()` runs before each D7 pass, and the synchronous projections only return its cached numbers.

### 4. Rich-context evidence log

`src/monitoring/FeatureEvidenceLog.ts` appends to `logs/feature-evidence.jsonl`, rotated by `maybeRotateJsonlSegment` at 10 MB, keeping 8 segments:

```ts
{ eventId, at, featureId, machine, instarVersion, rung, flagState,
  kind: 'fired' | 'held' | 'error' | 'outcome',
  outcome?: 'right' | 'wrong' | 'unknown',
  gradesEventId?: string,                    // an outcome row grades one earlier event
  gradedBy?: string,                         // 'review', or the feature's own later check
  reason: string,                            // ≤ 240 chars
  context?: Record<string, string | number | boolean | null> } // ≤ 16 keys, values ≤ 240 chars
```

A feature calls `featureEvidence.record(id, …)`; it never throws and never blocks the caller. `POST /maturation/evidence` (Bearer) lets jobs and hook scripts report, and lets the review grade a past decision. The server stamps `eventId`, `at`, `machine` and `instarVersion`, refuses an unknown feature id, and limits to 60 rows a minute per feature. All text goes through `scrubForStore` from `durableSecretScrub` before it is written. Features that already write a good JSONL log keep it: the ladder cites that log, and nothing is migrated.

One grade counts per event, by `dedupe: 'gradesEventId'`. A bearer holder could grade its own work; that is why no count decides a move on its own (§8).

This is not the `DecisionJournal`: that journal records an agent's tradeoff decisions and promotes each to semantic memory with required evidence. Runtime feature events are high-volume and machine-written.

### 5. Rung derivation

`deriveLadderRung(entry, liveConfig, shippedDefaults)`:

| Observation | Rung |
|---|---|
| Shipped default is fully on (the `on` value, or `enabled: true`), with no shipped `dryRun: true` | `fleet` |
| Otherwise resolved on here through `resolveDevAgentGate` or an explicit value, and not dry-run | `dev-agent-live` |
| Otherwise on here, in dry-run | `dry-run` |
| Otherwise | `dark` |

These map directly onto the review's `stage` words (`dev-agent-live` is `dev-live`). No test-agent role can be observed yet: the article itself keeps `DEV_GATED_FEATURES` as "the current runtime floor until the class resolver and later rollout arms graduate". So `dark` means "nobody runs it", not "test agents run it". The test-agent rung stays satisfied the way it is today, by each feature's throwaway-agent e2e test, and this spec adds no new way around it. The rung is always observed, never stored, so a revert is visible at once.

The rung reads config, not runtime: a boot-read flag can claim `dev-agent-live` before a restart. So the rung never counts as progress on its own, and a `dev-agent-live` feature with no `ran` rows reads `no-data`.

`next` is `dev-agent-live` from `dark` or `dry-run` when that rung is written, otherwise `fleet`; `fleet` from `dev-agent-live`; none at `fleet`, or at `dev-agent-live` with a preference final.

### 6. Scoring: D7 gets more subjects, not a new rule

`evaluateMaturation` receives its existing initiatives plus in-memory subjects built from ladder entries whose disposition is `ladder`, whose next rung exists, and whose rung is not `dark` (nothing can run, so a score is meaningless; §7 gives it `not-started`):

- A subject's D7 id is `entry.subject`, which meets D7's id rule. Its contract is `rungs[next]`, converted to the D7 shape with `cadenceHours: 6` and `evidenceMaxAgeHours: 12`. Each metric's D7 `sourceRef` embeds a hash of its source, ref and window, so a changed bar is a new contract hash, which D7 already treats as a new epoch.
- An entry whose `subject` is a spec-born initiative overrides that initiative's contract, so one feature keeps one D7 history.
- `evaluateMaturation` becomes linear: the previous-evaluations read, the observations read, and the factor summaries and trends are each computed at most once per pass, and only when a contract asks. Behaviour is unchanged. Today each of these runs per feature, which is fine at 29 subjects and a stall at 250.

The per-metric view comes from the same cached readings, so the route and D7 agree.

### 7. The ladder state

`computeLadderState` is pure and returns one state, checked in this order:

| State | Meaning |
|---|---|
| `retire-pending` | Disposition `retire` |
| `composed` | Moves with its parent; shows the parent's state |
| `held` | This agent's `maturation.ladder.holds` names it, with a reason |
| `harmed` | Within 14 days of a rung change (a recorded move, or any observed change such as a released code move): a `harm` metric of the rung it crossed fails, or, unless `rare`, its `ran` metric has gone silent for 3 days |
| `at-final` | At `fleet`, or at its recorded preference-off final |
| `not-started` | Rung `dark`: nothing runs, so no number can exist. The first move is to start it |
| `no-opportunity` | `rare`, and the `ran` metric has 0 samples |
| `no-data` | The `ran` metric has 0 samples |
| `hold` | Enough data, and a threshold fails |
| `collecting` | Below `minSamples`, or evidence is absent or stale |
| `soaking` | D7 says `ready`, not yet for `soakDays` |
| `ready-to-advance` | D7 `ready` on every evaluation across `soakDays` under this contract hash |

Any non-`ready` row in the span, including `missed-cadence`, restarts the soak. That is the conservative side, and a restart costs only time. The readings cover the next rung's metrics, plus the crossed rung's `harm` and `ran` metrics with their window starting at the move, so post-move watching needs no D7 subject and works at `at-final`.

### 8. Measure and raise; the review decides

**The server never moves a feature.** The body informs the mind, and past a threshold of importance must never decide for it (*The Body and the Mind*, *Signal vs. Authority*). A flag being reversible does not undo what it did while on. So the deterministic part produces signals, and every move is the job's model's decision.

**Raising.** After each D7 pass, on the serving-lease holder of an agent with `maturation.ladder.reviewTopic` set (128732 on Echo), `raise` opens or reuses commitment `externalKey: maturation:<id>` for each feature newly `ready-to-advance`, `harmed` or `not-started`, at most 5 per pass, worst first, carrying the measured evidence. A closed one is not reopened for 7 days (14 for `not-started`, 1 for `harmed`), so an "extend" decision sticks. Each raise and each observed rung change writes a row to `logs/maturation-advances.jsonl`. Raised commitments have `beaconEnabled: false`: this is a record the review reads, never an operator message, and it cannot crowd the beacon's cap. A `sensitive` feature that is off is not raised: it stays dark until its operator enables it or the review records a preference final, and the report counts them. An agent with no review topic raises nothing and its route still reads true.

The review runs Mon/Wed/Fri, so a `harmed` feature can wait up to 3 days. That is accepted: moves are development-agent settings with a revert route, and the Fleet rung goes through a reviewed release.

**Moving: `POST /maturation/moves`.** The job calls it after deciding:

`{ id, target, from, reason, opinions: [{family, model, verdict, confidence}] }`, where `from` is the current values the job read from the ladder response's `move` block. For `not-started`, the written setting is the entry's `start`.

The route enforces the floors, and refuses by name:

| Floor | Refusal |
|---|---|
| State is `ready-to-advance`, or `not-started` with a `start` | `not-ready` |
| Target rung's `advance.kind` is `config`, or the move is a `start` | `not-a-config-move` |
| `risk: standard`, and not a member of `machineCoherenceManifest` (those must match across machines) | `sensitive` |
| Not named in `maturation.ladder.holds` | `held` |
| Development agent | `not-a-development-agent` |
| Current values equal the expected `from` the job read | `changed-since-read` |

On pass it writes an intent row with a `moveId`, sets through `LiveConfig.set`, re-reads the file to verify, and writes the outcome row with old values (an absent value is recorded as `absent`). A failed verify is reported as such, never as applied. `POST /maturation/moves/:moveId/revert` restores only if current values still equal what that move wrote, otherwise it refuses `changed-since-move`; a reverted move adds the feature to `holds` with the reason, so nothing repeats apply, harm, revert. An entry marked `restartNeeded` says so in the response, and the job restarts only when no live work is affected (its existing rule).

**A code move.** For `kind: 'code'` or `'owner-driver'`, and every `sensitive` feature, there is no write. The job gets the two opinions (its step 3 rules) and, if they agree, opens one build session with `POST /sessions/create`, at most 2 per run, shared between fleet moves and instrumentation. Each session is named `maturation-<subject>-<target>` and recorded on the commitment, so a session or PR that is already live is never duplicated. A refused or dead session retries at most 3 runs, then the report names it as stuck. The commitment closes when the shipped default is observed at the new rung, never at "handed off".

**One provider.** If a second family is not reachable, a fresh context of the same provider gives the second reading, disclosed as such in the review row and the report. This keeps the path whole on a single-provider agent (Single-Provider Functional Floor), and it is weaker than two families, which is why it is disclosed.

**Nothing rots.** A feature `ready-to-advance` with no move for 7 days, `no-data` for 30 days, or `no-opportunity` for 30 days, is named in the review's report as `stuck-ready`, `stuck-blind` or `stuck-rare` (which needs a drill), and the job's existing "three extends, then improve, redesign or retire" floor applies.

**The first move and the 29 that are simply off.** A `dark` feature emits nothing, so no threshold can be met. `not-started` raises it: a standard one with a `start` is started on the development agent through `POST /maturation/moves`; otherwise a build session moves it onto the development-agent gate, or the review retires it. `DARK_GATE_EXCLUSIONS` entries are always `sensitive`, so they never take this path.

### 9. Preference and retire

`final: 'default-off-by-preference'` is the only way to skip default-on. It requires `preference` with a named decider, a reason, a date and a `ref` (topic and date, or commit). The decider is the operator, or the review's two model families agreeing that this feature belongs to a named class: opt-in cost, a personal account, or personal taste. These count on the board, so it cannot become a quiet exit.

Because today's article has one enumerated exit from the ladder, no entry uses this final until the §12 amendment merges (a test holds that, removed by the amendment PR). `maturation.ladder.holds` is different: it says one agent's operator holds a feature on this agent, it stops a move, and it never ends the ladder.

### 10. Route and board

- `GET /maturation/ladder` (Bearer, 503 when gated off): `{schema: 'maturation-ladder/1', advisory: true, counts, features: [{id, title, rung, next, state, final, risk, tracking, soak: {days, needed}, metrics: [{id, role, value, threshold, direction, samples, minSamples, pass, coverageDays?, reason?}], move: {kind, set?, from?, restartNeeded?}, lastMove, stuckDays}]}`. `?id=` narrows it.
- `GET /maturation/moves?limit=` returns the audit rows.
- The board gains owner source `ladder` (added to `OwnerSource` and `OWNER_SOURCES`, machine-tagged like the others; facts are `title`, `rung`, `next`, `state`, `passing`, `total`, `soakDays`, `soakNeeded`), with the entry's flag and aliases as join keys, so `?scope=pool` needs no new fan-out. D7's in-memory ladder subjects do not get their own board owner rows; the ladder owner carries them, so one feature stays one row. A row with no review still appears, which closes the "46 flags on no board row" gap.
- The page gains one tile, "Ready to move up", and a detail block showing thresholds as now vs target. Its first view stays within the existing word budget.
- The `advisory: true, authority: 'none'` on the board is unchanged: the board still decides nothing.

### 11. The job and the plan gate

**Job** (`.instar/jobs/user/feature-maturation-review.md`, agent config, edited on Echo; reads `/maturation/board?scope=pool` so a standby's rows count): step 1 reads `GET /maturation/ladder`. Rows take `stage` from the derived rung, and `goal`, `measure.target` and `measure.now` from thresholds, so a model no longer writes those by hand. Step 4 makes each move through `POST /maturation/moves`, runs the fleet arbiter, opens sessions, and each run grades a small sample of `quality` events per feature through `POST /maturation/evidence`, so "nobody labels the outcomes" stops being a stall. The report gains: moved, ready, stuck, reverted, blind count.

**Plan gate.** In the instar source tree (the repo has `src/data/feature-ladders.json`), `## Maturation plan` gains one required line: `- **ladder:** <entry id>`. The gate checks the line is present and well-formed. The coverage test, at merge, checks it names a real entry, so a spec can converge before its entry exists. Agents' own projects have no instar registry, so the requirement does not apply there. Existing specs are not re-stamped. The migration entry for the gate source must be `alwaysOverwrite` (its `prior` list is empty today, so a changed gate would read as "customized" and be left behind).

### 12. The article amendment (needs Justin; a separate PR)

Everything above works without it. The proposed wording, added to **Maturation Path**'s Rule and In practice:

> **Rule (added).** Default-on for the fleet is the last rung of every staged feature, unless a recorded user-preference decision keeps it off. Every rung has machine-checkable thresholds against the feature's own logged behaviour, and when they are met the feature is raised to the recurring review, which must decide. A threshold met is a floor, never an instruction: structure measures and raises, and the mind decides. A fleet default stays a reviewed code change, which the review opens itself once two independent readings agree.
>
> **In practice (added).** (e) `src/data/feature-ladders.json` holds every staged feature's thresholds. A switched-off feature with no entry fails the build. (f) The rung is derived from shipped defaults, never written by hand. (g) Clauses (b), (c), (d) are now enforced: the "enough to judge" rule enforces (b), the coverage test enforces (c), and the ladder is the single home for (d). (h) A user-preference final requires a named decider, reason, date and reference, and every one is visible on the board.

The `UNENFORCED SUB-OBLIGATION` and `STD-SUBCOUNTDOWN-maturation-bcd` lines come out in the same PR. Delivered with `skills/spec-converge/scripts/publish-spec-review.mjs --spec … --topic 137053 --send`, and merged only after his sign-off.

### 13. Bulk authoring and the first feature

Every universe member gets an entry in this run. A model drafts each one from its spec, its review row and a check that the cited log exists and has rows on Echo. Then the parser, the coverage test and the live read check it, and a second model family reads the whole file for thresholds that are wrong or trivially passable. Composed sub-flags collapse under their parents. Flags read nowhere become `retire`.

**Authoring defaults** where a spec states none: fleet rung `ran` of at least 20 rows in 14 days, harm or error rate at most 5%, soak 7 days; dev rung soak 3 days. Sensitive features get a raised soak of 14 days.

Instrumentation is sorted by the ladder itself. `tracking: needed` entries get build sessions from the shared per-run limit, worst first, each with a `maturation:<id>` commitment, instead of waiting in the feedback queue. This run also instruments as many as quality allows. The count of `no-data` is the headline number this work must drive down.

The first feature through the path is multi-machine rebalancing (topic 137054): its spec's plan carries a `ladder` line, its thresholds are written with that topic, and its state is checked live.

## Verify the State (P20)

| Symbol | Claimed state | Corroboration | Unmeasurable |
|---|---|---|---|
| Rung | Who has the feature configured on | Shipped defaults plus resolved config; separately, `ran` rows show it ran | Flag missing: `flag-missing`, and the coverage test fails |
| `ran` count | The feature actually executed, recently | Its own rows, fresh within 7 days (its window if `rare`), with a `quality` or `harm` metric beside it | 0 samples: `no-data` or `no-opportunity`, never a pass |
| `quality`/`harm` value | It did the right thing | Its rows plus graded `outcome` rows from a reader outside the feature | Below `minSamples`, or a cut read: `collecting` |
| `ready-to-advance` | It is a candidate | Consecutive D7 rows under one contract hash; then a model reads the evidence before anything moves | Any gap restarts the soak |
| Move applied | The setting changed | Re-read from disk after the write; `ran` rows after it | Failed verify is reported; silence for 3 days reads `harmed` |

A log can be written by the feature while the feature is wrong, and a bearer holder can grade its own work. That is why no count moves anything.

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| Rung derivation | invariant | Pure read of defaults and config; no competing signals; the result gates nothing |
| Threshold evaluation | invariant | D7's existing numeric comparison; it only produces a signal |
| Soak restart on a non-ready row | invariant | Conservative and arithmetic; the cost of a false restart is time |
| Enough-to-judge and coverage checks | invariant | Structural presence checks, in tests and the gate; adequacy stays with the lessons-aware reviewer and the second-family read |
| `POST /maturation/moves` floors | invariant | Exact-match safety checks in front of a decision the model already made; they can only refuse |
| Raise a feature | invariant | Records a signal in the commitment store, deduped by key; it decides nothing |
| Move a feature (config, code, or fleet) | judgment-candidate | Floor: thresholds and soak met, `moves` floors, fleet only ever a reviewed PR. Arbiter: the review's model with a second reading. Bounded actions: apply, extend, improve, redesign, retire. Disagreement or low confidence: extend 7 days (existing floor). Final rung: stay. Each call is recorded with its context and graded later |
| Preference final | judgment-candidate | Floor: named decider, reason, date, reference, and blocked until the article allows it. Arbiter: operator or two families. Default: stays `default-on` |

## Frontloaded Decisions

1. Registry is one JSON file in `src/data`, not spec frontmatter: 132+ features have no single spec to hold it, and one file makes coverage testable. Frontmatter contracts keep working for D7 and are overridden only by an entry naming them.
2. Ladder subjects stay in memory, never in `InitiativeTracker`: 150 more active initiatives would flood the digest.
3. All new evidence goes through `feature-summary` projections, so no SQLite schema change.
4. Composed sub-flags have no thresholds of their own.
5. Thresholds default as in §13; soak 3 days to dev, 7 to fleet, 14 for sensitive; entries may set 1..60. Cheap to change after (a reviewed data file).
6. The server never moves a feature; the review's model decides every move. No auto-apply or auto-revert in any version without a separate spec and an article change.
7. Fleet moves and instrumentation open build sessions, at most 2 per review run, not feedback items.
8. Route `/maturation/ladder`, route `/maturation/moves` and schema `maturation-ladder/1` are a published interface for the job; a break bumps it.
9. The article amendment ships separately after sign-off; no entry uses the preference final until then.
10. Raising needs `maturation.ladder.reviewTopic`, so agents without a review stay read-only.

## Open questions

*(none)*

## Multi-machine posture

Posture: **unified**, by derivation and proxied read.

- The registry is repo-tracked, the same everywhere.
- D7 evaluations and observations are origin-local by its approved design; each machine judges its own evidence. The board's existing pool merge shows them machine-tagged and never combines them.
- `logs/feature-evidence.jsonl` and `logs/maturation-advances.jsonl` hold per-machine facts about what ran there. They are read through each machine's route and the board's `ladder` owner source (proxied-on-read), so no machine-local surface stands alone.
- Moves happen where the job runs, on that machine's evidence, because the settings are per-machine (the same posture as `/guards`). A flag that must match across machines (`machineCoherenceManifest`) is refused by the route and takes the code path. Other machines stay where they are, and the board shows it.
- Raises run only on the serving-lease holder, so one voice. `externalKey` dedupes against that machine's own commitments, so a lease move can produce a second record for a feature; the review reuses by key across the merged read, and a duplicate costs one line in a report. A feature ready only on a standby is seen by the job through the pool board, so it is not lost. `reviewTopic` is set in each machine's config.
- No URLs are generated; a topic transfer strands nothing, because commitments already replicate.

## Rollout gate

`maturation.ladder.enabled` in `DEV_GATED_FEATURES`: live on a development agent, 503 and inert on the fleet. `maturation.ladder.reviewTopic` is unset by default and set to 128732 on Echo. A wrong registry entry is one reviewed line. Rollback: set `enabled` false. Applied moves stay as settings, each with its old value in the audit log and a revert route.

## Maturation plan

- **test-agent-live:** a throwaway agent in the e2e test runs the route, a seeded registry, D7 and raising.
- **dev-agent-live:** live on Echo at merge; the first review run after it uses the ladder, and I check its moves by hand.
- **fleet:** default-on once its own ladder is met. A fleet agent gets the measuring and the evidence log; with no review topic it raises nothing.
- **graduation criterion:** the `maturation.ladder` entry: at least 20 D7 passes in 7 days with ladder subjects evaluated, zero wrong-graded moves, the shipped registry valid, and pass time p95 under 5 s.
- **dark-window:** 14 days.
- **ladder:** maturation.ladder

## Tests

- **Unit:** parser (every closed field, enough-to-judge both sides, preference, `set` under flag path, unique subjects); `deriveLadderRung` (each row, dev gate, shipped dry-run, a stage value); `computeLadderState` (every state, both sides, precedence, soak restart, harm after a move, silence after a move); `jsonl-log` reads (count, ratio, dedupe, window, all segments, bad paths, symlink, oversized, cut at-most count, dead `ran`); evidence log (bounds, scrub, never throws, stamps); `moves` floors (every refusal both sides, verify failure, absent old value, revert conditional, revert adds a hold, intent row before write); raising (dedupe, cap of 5, lease, no topic); D7 (one read per pass, same results as before); gate two-sided, in and out of the source tree; coverage test; the preference-final hold.
- **Wiring:** in `AgentServer` the projections are registered on the real service, and the moves route holds real `LiveConfig`.
- **Integration:** routes 200/503, `?id=`, evidence POST bounds and auth, moves auth and refusals, board carries the ladder owner source through `scope=pool` sanitising.
- **E2E:** production init on a dev agent: route alive (200, not 503); a seeded log moves a feature from `no-data` through `soaking` to `ready-to-advance`, raising opens one commitment, and a move applies and then reverts.
- **Live on Echo:** the live counts equal a direct read of the logs for a sample of features; the page, via tunnel, shows a threshold.

## Migration parity

- Config: `maturation.ladder` dev-gated (omitted `enabled`); `reviewTopic` unset for everyone but Echo, which sets it itself.
- `CLAUDE.md` template section plus a `migrateClaudeMd` guard (routes and proactive triggers).
- Gate script: `migrateFeatureMaturationGate` handles the update; the gate source entry becomes `alwaysOverwrite`.
- The registry ships in the package (`package.json` `files` is checked by a test), and resolves relative to the module.

## Rollback

Disable `maturation.ladder.enabled`, read live with no restart: routes 503, raising idle, evidence reads stop, D7 back to spec-born subjects, and the registered projections stay in memory unused. D7 rows for ladder subjects age out through existing retention. Each applied move can be undone through its revert route or from its audit row.
