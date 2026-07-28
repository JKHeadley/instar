---
title: Dev-Agent Dark-Gate Teeth — retire the deliberate-fleet-default catch-all
status: draft
parent-principle: "Structure beats Willpower"
tags: [side-effects]
author: echo
created: 2026-06-13
eli16-overview: dev-agent-dark-gate-teeth.eli16.md
lessons-engaged:
  - "P2 Signal vs. Authority: the lint is a signal-emitter (closes the invalid/unclassified-category hole); D4 code-grounding + GrowthMilestoneAnalyst R6 are the authority-tier backstop against MIScategorization — the spec does not over-claim the lint prevents that."
  - "P3 Migration Parity: a reclassification that only works for new agents is broken — D5 adds a dev-agent-only one-shot PostUpdateMigrator strip of stale persisted enabled:false for the 4 newly-DEV_GATED paths (mirrors migrateCartographerDevGate), with a test tier."
  - "P4 Testing Integrity: the migration is the most load-bearing change and gets its own unit test (stale-false stripped on dev / untouched on fleet / operator-true preserved / idempotent)."
  - "P7 LLM-Supervised Execution: correctionLearning's per-message Tier-1 distill is exactly why it is classified cost-bearing (held off-on-dev), not observe-only."
  - "P14 Distrust Temporary Success / P16: the deliberate-fleet-default bucket was a temporary success (each mis-park fixed one-off, PR #1105) hiding the root cause — retiring the catch-all is the root-cause fix."
  - "P17 Bounded Notification Surface: releaseReadiness's attention path routes through the budgeted createForumTopic funnel; the two high-volume Telegram senders are held as action-bearing exclusions precisely to avoid an unbounded-on-dev flood."
  - "L6 Side-effects (7 dimensions): the side-effects artifact dimensions over/under-block, abstraction, external surfaces, interactions (esp. shared _instar_migrations namespace with migrateCartographerDevGate), and rollback."
relates_to:
  - DEV-AGENT-DARK-GATE-ENFORCEMENT-SPEC.md
  - DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC.md
  - STANDARDS-REGISTRY.md (standard_development_agent_dark_feature_gate)
approved: true
approval:
  by: Justin
  channel: telegram:12476
  at: 2026-06-13T11:52:34-07:00
  decision: "Build the TEETH guard; move all 7 safe features (parallel-work sentinel, failure-learning, correction/preference sentinel, apprenticeship-SLA, gemini-capacity, release-readiness, read-only boot /health responder) LIVE on Echo."
review-convergence: "2026-06-13T19:44:59.569Z"
review-iterations: 6
review-completed-at: "2026-06-13T19:44:59.569Z"
review-report: "docs/specs/reports/dev-agent-dark-gate-teeth-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 3
---

# Dev-Agent Dark-Gate Teeth

## ELI16 — A feature can only be parked "off even on dev agents" if it proves it would be genuinely unsafe to run there (it kills things, spends money, takes a real external action, or needs config it doesn't have). The vague "off for everyone by policy" bucket is retired, because that's exactly where safe features got hidden by accident.

## Why this exists (grounded requirement)

Justin, 2026-06-12, topic 12476 — immediately after approving Threadline Phase 2:

> "And please make sure we enforce that all features get enabled for dev agents"

My reply (22:40) set the enforceable shape, which he did not push back on:

> "the enforceable rule isn't 'literally everything on,' it's: dev-gated is the
> DEFAULT, and the only way to opt a feature OUT of dev (the 'off even on dev'
> bucket) is to justify why dev-live is genuinely unsafe — destructive,
> action-bearing, or cost-bearing — and have it reviewed."

### What already exists (do not rebuild)

PR #1056 (merged to canonical main 2026-06-10) shipped the machinery:
- `src/core/devAgentGate.ts` — `resolveDevAgentGate(explicit, config)`: omit `enabled`
  from defaults → the flag resolves `true` on a `developmentAgent` agent, `false`
  on the fleet. The single funnel.
- `src/core/devGatedFeatures.ts` — two registries: `DEV_GATED_FEATURES`
  (live-on-dev, dark-on-fleet) and `DARK_GATE_EXCLUSIONS` (off-even-on-dev, each
  tagged with a `DarkGateCategory` + a `reason`).
- `scripts/lint-dev-agent-dark-gate.js` — Assertion C: every literal
  `enabled: false` in `ConfigDefaults.ts` MUST be registered in one bucket or the
  other; an exclusion needs a valid category + a ≥12-char reason. Runs in CI.

So the "unclassified dark default" hole is already closed. **This spec does not
re-open it.**

### The remaining hole (the precise CMT-1438 gap)

The `DarkGateCategory` enum contains a catch-all member:

```
'destructive' | 'optional-integration' | 'cost-bearing' | 'structural-stub'
| 'deliberate-fleet-default'   ← the catch-all with no teeth
```

The lint accepts `deliberate-fleet-default` as a fully-valid category. So a feature
that is perfectly safe to dogfood on a dev agent can be parked off-even-on-dev
with nothing more than a 12-character sentence — no obligation to prove it is
actually unsafe there. The category *is* the escape hatch.

This is not hypothetical. The single-negotiator lease (Phase 1) was mis-parked in
`deliberate-fleet-default` at ship, which starved its FD-7 dry-run telemetry and
would have blocked the feature from ever graduating — caught by Justin, fixed in
PR #1105. The fix was one-off; the bucket that *allowed* it is still open.

**Live evidence in the registry today** — of the 11 current
`deliberate-fleet-default` entries, **6 confess the loophole in their own reason
strings** (each calls itself observe-only and flags itself as a dev-gating candidate
for a later audit): `parallelWorkSentinel`, `failureLearning`, `correctionLearning`,
`apprenticeshipCycleSla`, `geminiCapacityEscalation`, `releaseReadiness`. These
are safe-on-dev features sitting in the off-on-dev bucket because the bucket let
them. **This spec IS that audit; retiring the catch-all closes the
*unclassified/non-reason* hole structurally so it can't recur** — the
*miscategorization* hole (a safe feature parked under a dishonest-but-valid
category) is closed by D4 + the R6 runtime cross-check, not by the lint alone
(Signal vs. Authority — see Security). The audit itself also flagged that 3 of
those 6 "confessed safe" features are NOT actually safe-on-dev once you read their
code (D4) — proof the reason strings are a hypothesis, not the verdict.

## The standard being sharpened

`standard_development_agent_dark_feature_gate` (STANDARDS-REGISTRY.md) already says
dev-gated is the default and a dark default must be a deliberate, classified
choice. This spec gives the "off even on dev" half of that classification **teeth**:
the classification must name a *concrete reason the feature is unsafe on dev*, not
merely assert "policy." A bucket whose only meaning is "off because we said so" is
willpower wearing a category label.

## The design — retire the catch-all, force a concrete unsafe-on-dev reason

### D1. Drop `deliberate-fleet-default` from `DarkGateCategory`.

Every surviving category must name a **concrete reason dev-live is the wrong place
to run the feature** — and that reason is one of two honest kinds: the feature is
*unsafe* on dev (it does something it shouldn't), or it is *not runnable* on dev
(there is nothing to dogfood). What is retired is the *third* kind — "off because we
said so," a non-reason. The valid set:

| category | kind | meaning |
|---|---|---|
| `destructive` | unsafe | kills/deletes/mutates on a heuristic (reapers) |
| `cost-bearing` | unsafe | spends real third-party / LLM money when live |
| `action-bearing` | unsafe | **(new)** when merely *enabled*, automatically produces an outbound side-effect that reaches an external system or the operator — merges a PR, sends a user-facing message/escalation (incl. a Telegram attention topic), mutates a remote. Distinct from a *local* signal/record (an in-process event, a JSONL line, a queried-only attention item). De-dup / rate-limiting reduces severity but does NOT reclassify it — an auto-send is an auto-send. An `action-bearing` **reason should name the action type and whether it is bounded/deduped** (so a reviewer can weigh severity; a future split into `external-mutation` vs `operator-notification` is a possible refinement, not done here). A feature here is held off-on-dev but stays opt-in per agent (an explicit `enabled: true` is always allowed). |
| `optional-integration` | not-runnable | cannot function without per-deployment config/credential/allowlist — live-on-dev would be inert or error, not unsafe. The reason **must name the gating config/credential/allowlist** (so "needs config" can't become the new soft parking spot). |
| `structural-stub` | not-runnable | no runtime consumer wired yet (dead flag) |

There is no "off by policy" member. If a feature is safe AND runnable on a dev
agent, the only correct home is `DEV_GATED_FEATURES`.

**Classification rule (the decision a reviewer applies):** classify by **what is
reachable under normal configured dev operation**, not by the worst thing the code
could do under some other config. A feature whose unsafe path is gated behind a
*second* switch that ships dark (e.g. `releaseReadiness`'s send, behind the
off-by-default `release-readiness-check` job) is classified by its reachable
behavior with that second switch at its default (read-only) — and the dependency is
named explicitly (D4) + pinned by a test (Testing), never left implicit.

**Honest scope (Signal vs. Authority, P2).** Retiring one catch-all does not make
abuse impossible — it relocates the soft surface to the gentlest *valid* category
(`optional-integration` / `structural-stub`), which describe "not runnable," not
"unsafe." The lint adjudicates category *spelling + reason length*, never category
*honesty*; a dishonest-but-valid label still passes CI. The real backstops against
mis-parking a safe feature are **D4 code-grounding** (build-time) and the
**GrowthMilestoneAnalyst R6 runtime cross-check** (flags a registered dev-gated
feature observed dark on a live dev agent) — not this lint. The `optional-integration`
"must name the gating config" rule above is a **review/D4 convention + reason-quality
bar on a CODEOWNERS-reviewed path** (the human-gate model the registry already runs
under, per `devGatedFeatures.ts`'s docstring) — honestly NOT lint-enforced (the lint
validates only category membership + reason length ≥12). Naming it raises the bar a
reviewer checks; it does not pretend the lint adjudicates it.

`action-bearing` is added because four occupants are genuinely unsafe-on-dev for a
reason none of the existing categories captured: `greenPrAutoMerge` (merges PRs),
`threadline.a2aCheckIn` (sends user-facing summaries — floods the operator), and
(found by D4) `apprenticeshipCycleSla` + `geminiCapacityEscalation` (auto-post a
Telegram attention topic on enable). Folding these into `destructive` would be
dishonest; they deserve their own concrete reason.

### D2. Lint teeth (Assertion D, in `lint-dev-agent-dark-gate.js` + `lib/dark-gate-attribution.js`).

- Remove `deliberate-fleet-default` from `VALID_CATEGORIES` **(in
  `scripts/lib/dark-gate-attribution.js`, where the set lives)** AND from the
  `DarkGateCategory` TS union **(in `src/core/devGatedFeatures.ts`)**, adding
  `action-bearing` to both — the two must move together or the lint and the type
  drift. Any `DARK_GATE_EXCLUSIONS` entry still using the retired category fails CI
  with a fix message naming the concrete categories and pointing the author to
  `DEV_GATED_FEATURES` if the feature is actually safe-on-dev.
- **Close the silent-skip gap (round-1 adversarial finding).** `extractRegistry`'s
  `entryRe` only matches exclusion entries whose `reason` is a quote-delimited
  string; an entry written with a **backtick/template-literal reason** is counted
  by the path regex (`configPathOf`) but invisible to the entry regex, so its
  category + reason validation is **silently skipped** — an author could ship a
  bogus category past CI. The lint must assert `exclusionEntries.length ===
  exclusionPaths.length` and fail loudly on mismatch (a parsed-path-without-a-parsed-
  entry means a malformed/unparseable entry that escaped validation). This is the
  honest "the validator must see every entry" guard.
- Otherwise a pure tightening of the existing closed-enum check (Assertion C) — no
  new scan surface, no new line-number map.

### D3. Reclassify the 11 current occupants (the audited one-time pass).

The table below is the **final classification after D4 grounding** (see "D4
grounding result" below). The hypothesis (operator-approved O1) was to move all 7
candidates to DEV_GATED; the per-feature code check held 4 live and kept 3 as
exclusions with honest categories — exactly the D4 override the approved spec
prescribes.

| configPath | new home | category / reason |
|---|---|---|
| `monitoring.parallelWorkSentinel.enabled` | **DEV_GATED** | observe-only overlap councilor; emits an in-process event with no listener wired; local audit log only — no egress/spend |
| `monitoring.failureLearning.enabled` | **DEV_GATED** | observe-only loop; append-only ledger; Telegram escalation unimplemented; all ingestion sources off by default — no egress/spend |
| `monitoring.releaseReadiness.enabled` | **DEV_GATED** | observe-only; constructed but NOT auto-started (a separate off-by-default job drives ticks), so enable alone is inert; repo-gated |
| `monitoring.bootHealthBeacon.enabled` | **DEV_GATED** | minimal read-only /health responder; localhost-only inbound socket, zero outbound |
| `monitoring.correctionLearning.enabled` | EXCLUSION | `cost-bearing` — per-message Tier-1 LLM distill (model 'fast', ≤25¢/day) on every preference/frustration message; ongoing spend (D4 disproved "no spend") |
| `monitoring.apprenticeshipCycleSla.enabled` | EXCLUSION | `action-bearing` — auto-ticks on the always-running token-ledger poller and posts a user-facing Telegram attention topic on each overdue cycle (D4 disproved "no egress") |
| `monitoring.geminiCapacityEscalation.enabled` | EXCLUSION | `action-bearing` — auto-ticks the same cadence and posts a user-facing Telegram escalation when Gemini is capacity-blocked >60min (D4 disproved "no egress") |
| `monitoring.greenPrAutoMerge.enabled` | EXCLUSION | `action-bearing` — merges PRs |
| `threadline.a2aCheckIn.enabled` | EXCLUSION | `action-bearing` — sends user-facing summaries; live-on-dev floods operator |
| `mentor.enabled` | EXCLUSION | `optional-integration` — inert until rollout/allowlist configured |
| `mentee.enabled` | EXCLUSION | `optional-integration` — inert until an allowlisted mentor configured |

**Open decision O1 (operator) — RESOLVED (Justin, telegram:12476, 2026-06-13):**
approved moving all 7 read/observe-only candidates LIVE on Echo. The build then
ran the mandatory D4 code-grounding on each (below); 4 verified clean and moved
live, 3 (`correctionLearning`, `apprenticeshipCycleSla`, `geminiCapacityEscalation`)
proved NOT observe-only and were held as exclusions with honest categories per the
spec's own D4 clause, and the deviation was reported to the operator (topic 12476,
2026-06-13). Holding the 3 does not forbid them — the operator can still flip any
on per-agent with an explicit `enabled: true`.

### D4. Every DEV_GATED move re-grounds against the code, not the reason string.

The reclassification is verified per-feature: the build confirms each moved
feature truly has no egress / no spend / no destructive or external action path
before moving it (the reason strings are the hypothesis, the code is the proof).
A feature whose code contradicts "observe-only" stays an exclusion with the honest
category. This is `verify-claim` discipline applied to the audit.

#### D4 grounding result (build-time, 2026-06-13)

Each of the 7 candidates was traced to its runtime construction + tick/seam:

- **`parallelWorkSentinel`** — VERIFIED clean. `ParallelWorkSentinel.tick()` emits
  an `'overlap'` event with **no listener wired** and appends a local
  `sentinel-events.jsonl` line. No fetch/telegram/LLM. → **DEV_GATED**.
- **`failureLearning`** — VERIFIED clean at default sub-flags. Append-only ledger;
  `insightTelegramEscalation` only flips a reported stage string (send path
  unimplemented); ingestion sources (`ci/revert/regression/…`) all off by default;
  loop creates only draft items needing approval. → **DEV_GATED**.
- **`releaseReadiness`** — VERIFIED inert-on-enable (two-switch dependency, made
  explicit per round-2 codex finding). `server.ts` constructs the sentinel but does
  **not** `.start()` it; ticks are driven by the SEPARATE `release-readiness-check`
  cron job, which ships `enabled: false` and is verified `enabled: false` on Echo
  today. So the dev-gate (switch 1) makes only the READ surface live (routes stop
  503-ing); the SEND capability is reachable only if the operator ALSO enables the
  job (switch 2), and that send is itself P17-bounded (the `createForumTopic` budget
  funnel). We classify by what's reachable under *normal configured dev operation*
  (job off ⇒ no send), and name the dependency openly rather than hide it: if the
  job is later dev-enabled, releaseReadiness's bounded attention path becomes a
  separate, explicit decision. → **DEV_GATED** (read-surface live, send dormant
  behind the dark job).
- **`bootHealthBeacon`** — VERIFIED read-only. Binds a localhost-only inbound
  `/health` socket during boot; zero outbound; cleanly released before the real
  server binds. → **DEV_GATED**.
- **`correctionLearning`** — CONTRADICTED. When enabled, the capture seam runs a
  per-message Tier-1 LLM distill (`sharedIntelligence.evaluate(..., {model:'fast',
  maxTokens:400})` via a dedicated `LlmQueue`, `≤25¢/day`) on every
  preference/frustration-classified inbound message — ongoing LLM spend, gated by
  the base loop, not a sub-flag. The reason string's "no spend" is false. →
  **EXCLUSION `cost-bearing`**.
- **`apprenticeshipCycleSla`** — CONTRADICTED. Constructed on `enabled===true` with
  `raiseAttention` bound to `telegram.createAttentionItem`, auto-ticked by the
  always-started `TokenLedgerPoller.afterTick`; on an overdue cycle it calls
  `createForumTopic` + `sendMessage` (a real user-facing Telegram escalation). →
  **EXCLUSION `action-bearing`**.
- **`geminiCapacityEscalation`** — CONTRADICTED. Same construction + auto-tick +
  Telegram-send pattern when Gemini stays capacity-blocked past the threshold. → **EXCLUSION
  `action-bearing`**.

The deviation (3 of 7 held back) was reported to the operator (topic 12476,
2026-06-13) before building, per the brief. The mechanism that produced it — D4 —
is the operator-approved part of this spec; the override is the spec working as
designed, not a departure from it.

### D5. One-shot strip of stale persisted `enabled: false` on dev agents (the migration the audit forces).

Removing the `enabled: false` literal from defaults only lets the resolver govern
when the key is **absent** from the agent's persisted config. Round-1 grounding
found that is NOT true on Echo: `.instar/config.json` already persists
`monitoring.parallelWorkSentinel.enabled: false` and
`monitoring.releaseReadiness.enabled: false` (baked in by a prior `applyDefaults`
run from the old hardcoded default). `applyDefaults` is add-missing-only, so those
stale `false`s survive and `resolveDevAgentGate(false, …)` short-circuits to dark —
the two flags would **stay dark on the very dev agent meant to dogfood them**. This
is the exact cartographer trap (P3 Migration Parity): a reclassification that only
works for new agents is broken.

The fix is a one-shot, idempotent, **dev-agent-only** `PostUpdateMigrator` step,
mirroring the proven `migrateCartographerDevGate` (`src/core/PostUpdateMigrator.ts`):

- **Marker:** `dev-gate-teeth-strip` in `_instar_migrations` makes the strip
  **run-once**. Be precise about what that buys: the marker does NOT distinguish a
  stale-default `false` from a deliberate pre-migration operator `false` (they are
  byte-identical — this is a deliberately **lossy** migration, see the tradeoff
  decision below). What it guarantees is idempotency — after the one-time strip, a
  *later* operator-set `false` is never touched again.
- **Dev-agent guard:** runs only when `config.developmentAgent === true`. A fleet
  agent is never touched, so fleet behavior stays byte-for-byte (this is *why*
  Finding "fleet unchanged" holds).
- **Allowlist — exactly the 4 newly-DEV_GATED paths, hardcoded** (never "the
  dev-gated ones" dynamically): `monitoring.parallelWorkSentinel.enabled`,
  `monitoring.failureLearning.enabled`, `monitoring.releaseReadiness.enabled`,
  `monitoring.bootHealthBeacon.enabled`. For each, guard the parent object exists
  (`if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.enabled ===
  false) delete obj.enabled`) — an absent/non-object parent is a safe no-op, never a
  throw (mirroring `migrateCartographerDevGate`). Delete only the literal `false`; an
  operator's `true` survives untouched; `failureLearning`/`bootHealthBeacon` already
  persist `true` on Echo so they are no-ops there, but a different dev agent with a
  persisted `false` is correctly freed. The 3 D4-held exclusion paths are NOT in the
  allowlist — they keep their persisted `false`.

**Frontloaded decision — accept the cartographer-parity tradeoff (round-2 codex
finding).** A persisted `false` and a deliberate operator `false` are byte-identical,
so this one-shot strip *can* delete a dev-agent operator's deliberate pre-migration
`false` for one of the 4 paths. This is the **same tradeoff `migrateCartographerDevGate`
already made and the operator already approved (PR #1056)**: on a dev agent, a
persisted `false` for a now-dev-gated feature is treated as the stale old default and
freed ONCE; if the operator genuinely wants it off, they re-set `false` *after* the
migration and the run-once marker makes that choice stick permanently. We deliberately
do NOT add a dry-run/ack/provenance flow — it would diverge from the established
precedent and add exactly the machinery complexity round-2 review flagged. For Echo
specifically the risk is empirically nil: the 4 paths are verifiably stale-default
`false` (parallelWorkSentinel, releaseReadiness) or already `true`
(failureLearning, bootHealthBeacon) — none is a deliberate `false` — and the operator
was told these go live (topic 12476, 2026-06-13). **Visibility mitigation (round-3
codex finding):** the migration **logs one line per path it actually strips** and
includes the stripped set in the `PostUpdateMigrator` result summary (the existing
post-update migration report), so a *non-Echo* dev-agent operator can see exactly
which flags were freed and deliberately re-disable any they want off — turning the
silent strip into a reported one.

## Migration Parity (P3/P10)

- **D5 is the migration** (above). Without it, `migrateConfig()`'s add-missing-only
  semantics leave the stale persisted `enabled: false` in place and the 4 flags
  never go live on an existing dev agent. D5's allowlisted, dev-agent-only,
  run-once strip is what makes "become LIVE on Echo at next session start" actually
  true. An operator who deliberately set one of these `true` keeps it (delete fires
  only on literal `false`); a *later* deliberate `false` is preserved by the
  run-once marker.
- Fleet behavior is **unchanged**: D5 is dev-agent-only, and every reclassified flag
  still resolves `false` on a non-development agent. Only development agents gain
  the 4 live observers.
- The 3 D4-held features keep their `enabled: false` literal in defaults (now
  classified under concrete `cost-bearing`/`action-bearing` exclusions) — byte-for-
  byte unchanged for every agent, dev included; and they are excluded from the D5
  allowlist.
- **Shared-namespace note (L6 interactions):** D5's marker lives in the same
  `_instar_migrations` ledger as `migrateCartographerDevGate`; the new marker key is
  distinct, so the two run independently and idempotently.
- No flag-day, no Dawn-side change.

## Testing (three tiers)

- **Unit:** (1) `DarkGateCategory` no longer includes `deliberate-fleet-default`
  (type + the `VALID_CATEGORIES` set); (2) the lint fails a fixture exclusion that
  uses the retired category, with the fix message; (3) the lint passes the 4 new
  concrete categories; (4) the `action-bearing` category is accepted; (5) wiring
  test — each of the 4 newly-DEV_GATED flags resolves live-on-dev / dark-on-fleet
  through `resolveDevAgentGate` (both sides); (6) **count-match guard** — a fixture
  registry with one exclusion entry written with a backtick/template-literal reason
  trips the `exclusionEntries.length === exclusionPaths.length` assertion (the
  silent-skip gap is closed); (7) **D5 migration** (mirrors
  `PostUpdateMigrator-cartographerDevGate.test.ts`): given a `developmentAgent: true`
  config with the 4 allowlisted paths persisted `enabled: false`, after the migrator
  the keys are deleted (resolver then yields live); a fleet config (`developmentAgent`
  absent/false) is left untouched; an operator-set `enabled: true` is preserved; a
  second run is a no-op (marker idempotency); the 3 D4-held paths are never touched.
- **Integration:** the lint script run over the real `ConfigDefaults.ts` +
  `devGatedFeatures.ts` exits 0 after the reclassification (no occupant left in
  the retired bucket) and the count-match assertion holds on the real registry.
- **Two-switch guard (round-3/5 codex finding):** an assertion that with
  `monitoring.releaseReadiness.enabled` resolving live-on-dev BUT the
  `release-readiness-check` job disabled, the sentinel is constructed (read surface
  alive) and **does NOT `.start()` / tick / send** — proving the DEV_GATED move
  leaves the send capability dormant behind the dark job (its classification's
  load-bearing invariant). The test ALSO asserts the shipped `release-readiness-check`
  job default is `enabled: false` — so if a future change flips that default (or
  dev-gates the job), this test fails loudly and forces the releaseReadiness
  classification to be re-reviewed (drift guard, not just a point-in-time check).
- **E2E:** a `developmentAgent: true` boot **whose persisted config still carries
  the stale `enabled: false`** resolves the 4 reclassified features `enabled` (alive)
  *after migration* — this is the single most important test (it proves D5 actually
  changed dev behavior, not just that new agents work), and a fleet
  (`developmentAgent: false`) boot resolves them `false` — proving the fleet stays
  dark.

## Security / adversarial

- **Can a feature dodge the teeth by inventing a fake concrete category?** No — the
  enum is closed and the lint validates membership; a novel string fails CI. (And
  the D2 count-match guard closes the one way an entry could *evade* validation
  entirely — a backtick-reason entry that the entry-regex didn't parse.)
- **Can a feature dodge the teeth with a dishonest-but-VALID category?** Partly —
  this is the honest residual. Retiring `deliberate-fleet-default` relocates the
  soft surface to `optional-integration` / `structural-stub` ("not runnable"). The
  lint cannot adjudicate honesty. The backstops are: D4 code-grounding at build
  time, the `optional-integration`-must-name-its-gating-config rule (D1), and the
  **GrowthMilestoneAnalyst R6** runtime cross-check that flags a registered
  dev-gated feature observed dark on a live dev agent. The lint closes the
  *invalid/unclassified-category* hole; D4 + R6 close the *miscategorization* hole.
  This is why the spec says the lint makes the *unclassified* hole un-recurrable —
  NOT that it makes all mis-parking impossible (Signal vs. Authority, P2).
- **Could retiring the bucket force a genuinely-unsafe feature into a wrong
  concrete category?** D4's code-grounded verification is the guard: the category
  must match what the code actually does. `action-bearing` was added precisely so
  the four real "unsafe but not destructive/cost" features have an honest home.
- **Residual risk — D4 is point-in-time.** A feature verified observe-only today
  could later grow an egress/spend/action seam (e.g. `failureLearning`'s currently
  unimplemented Telegram path being wired) without anything re-running D4; it is
  already live-on-dev, so the gate re-checks nothing. The R6 runtime cross-check is
  the partial backstop (it flags a dev-gated feature observed *dark*, not one that
  grew a *new send*). A durable per-feature capability-seam lint (a DEV_GATED entry
  may not construct a known send/LLM/action client without an explicit override) is
  the right structural answer but is **out of scope here and named as a follow-up** <!-- tracked: dev-gate-teeth-residuals --> —
  this spec retires the catch-all and adds the migration; it does not claim to close
  the capability-drift hole.
- **Residual risk — the registry parser is hand-rolled regex (round-2 codex finding).**
  `extractRegistry` parses the registry source with regexes, not the TS compiler. The
  D2 count-match guard closes the specific *parsed-path-without-a-parsed-entry* class
  (backtick reasons and several reorderings — round-2 adversarial verified it
  fail-safe, never fail-open), but other source-shape shifts (object spread, imported
  constants, `as const`) remain a theoretical blind spot in pre-existing machinery.
  The structural fix — validate the loaded/exported registry objects (TS compiler API
  or a built-module import in the test harness), or move the registry to a pure-data
  (JSON/YAML) source, instead of parsing TS source text — is a **tracked follow-up
  (owner: echo)** <!-- tracked: dev-gate-teeth-residuals -->, alongside the
  capability-seam lint. This spec adds the cheap high-value guard; it does not rewrite
  the parser. A runtime "your dependent job just made this feature a sender" warning
  (round-3 gemini suggestion) is likewise a named follow-up <!-- tracked: dev-gate-teeth-residuals --> — out of scope here
  because this spec touches gating only, never a feature's internal runtime behavior.
- **Why a bespoke gate rather than an off-the-shelf flag service (round-2 gemini
  finding)?** Instar is file-based with no external-service dependency by core design
  (CLAUDE.md Key Design Decision #1) and the gate must be greppable + CI-lintable in
  the source tree; a LaunchDarkly-style service is the wrong shape here. The registry
  in `devGatedFeatures.ts` IS the add-a-flag checklist (a new dev-gated feature is one
  entry + omit `enabled`); the machinery complexity the reviewer notes is inherent to
  enforcing the convention structurally rather than by memory (Structure > Willpower).
- **Does moving features live-on-dev create risk?** Each candidate is verified
  observe/read/signal-only before the move (D4) — and the check did its job: 3 of 7
  were held back when their code disproved the claim. Dry-run-style features keep
  their own `dryRun` default; this spec only touches `enabled` gating, never a
  feature's internal safety posture.

## Open decisions for the operator — RESOLVED

- **O1** — RESOLVED (Justin, telegram:12476, 2026-06-13): approved moving all 7
  read/observe-only candidates live on Echo. Build-time D4 grounding then held 3
  back as honest exclusions (see "D4 grounding result"); final = 4 live. Reported.
- **O2** — RESOLVED (Justin, telegram:12476, 2026-06-13): `bootHealthBeacon` is
  DEV_GATED (minimal read-only /health responder). D4 confirmed it is localhost-only
  inbound with zero outbound — it moved live.
