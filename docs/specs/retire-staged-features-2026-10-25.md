---
title: "Retire five staged features the 2026-10-25 maturation review voted to retire"
slug: retire-staged-features-2026-10-25
status: converged
eli16-overview: docs/specs/retire-staged-features-2026-10-25.eli16.md
commitment: CMT-1004
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
approved: true
approved-by: "echo — standing authority: Justin 2026-10-22 (topic 128732 / observer note), \"I should ONLY have to approve constitution changes\"; no CODEOWNERS file is touched; the retire decision itself is the 2026-10-25 maturation review (CMT-1004, Fable 5.1 + GPT-6 Astra both voted retire)"
review-convergence: "2026-10-25T23:53:37.531Z"
review-iterations: 3
review-completed-at: "2026-10-25T23:53:37.531Z"
review-report: "docs/specs/reports/retire-staged-features-2026-10-25-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Retire five staged features (feature maturation review, 2026-10-25)

## Problem

The 2026-10-25 feature maturation review (topic 128732) asked two model families
(Fable 5.1 and GPT-6 Astra) whether each staged (dark / dry-run / shadow) feature
should graduate, keep soaking, or retire. Both voted **retire** (confidence
0.85–0.99) on five items. Each one costs something while giving nothing: config
surface every agent carries, instruction-file text every session reads, LLM calls
on a development agent, tests every CI run pays for, and — for two of them — the
impression that a server-side recognizer handles a user request that is in fact
handled by the agent through an explicit route.

| # | Item | Evidence it is dead weight |
|---|------|----------------------------|
| a | `cartographer.conformanceAudit.llmEnrichment`, `cartographer.subtreeNav.llmRerank` | Config defaults + two `DARK_GATE_EXCLUSIONS` structural-stub rows; **no runtime code reads either flag** (the only `subtreeNav` reader, `routes.ts` ≈9186, takes the numeric bounds and never touches `llmRerank`). The only component tied to `llmEnrichment`, `StandardsCoverageEnrichment`, has **no call site**. |
| b | `intelligence.jevReviewFlagShadow` (`JevReviewFlagShadow`, `GET /jev-review-flag/summary`) | Shadow measured a 68% would-flag rate against a 25% usefulness bar; already turned off on the only agent that ran it. |
| c | `monitoring.proactiveAutonomousCompaction` (`ProactiveCompactionSentinel`) | Explicit opt-in, never enabled anywhere; context-wall recovery already presses `/compact` first. |
| d | `quotaLimits` (top-level config key) | **Never defined by Instar** — no source reference in the repo's history; it arrived in one agent's config through a config-sync commit, value `{enabled:false}`. |
| e | `MoveIntentClassifier` (`multiMachine.sessionPool.moveIntent`) and `ProfileIntentClassifier` (`topicProfiles.intentClassifier`) | Dry-run only since July; 54% / 64% error rates at a 4 s timeout; the soak logs on the dev agent hold 1,120 / 1,120 and 1,807 / 1,807 `pass` decisions — **zero would-actuate, ever**. The explicit levers (`POST /pool/transfer`, `POST /pool/unpin`, `POST /topic-profile/:id/propose` + the topic-profile write API, the dashboard Machine / Door+model controls, the `/topic` command) already do both jobs, and the agent drives them conversationally. |

Out of scope by decision: `multiMachine.seamlessness.ws21PreferencesPool` is NOT
touched — it stays until `stateSync.preferences` actually replicates.

**Relation to the Maturation Path standard.** The ladder (test agent → development
agent → fleet) governs *promotion*. Retirement is the review's third outcome, not a
skipped rung: none of these five is promoted, and nothing user-facing changes on
the fleet. The decision is recorded (CMT-1004, topic 128732, both model families'
votes) and is reversible by revert.

## What changes

### Source removals

1. **(a)** Delete the `llmEnrichment` and `llmRerank` default blocks from
   `ConfigDefaults.ts` and their two structural-stub rows from
   `DARK_GATE_EXCLUSIONS` in `devGatedFeatures.ts`. **Retire the component that
   only existed for the dark path**: remove `StandardsCoverageEnrichment` from
   `componentCategories.ts`, all five `llmBenchCoverage.ts` registrations, the
   pending census entry in `provenanceCoverage.ts` (`standards-coverage-enrich`),
   `docs/LLM-ROUTING-REGISTRY.md`, and its four tests
   (`standards-coverage-component-category.test.ts` deleted;
   `llm-bench-coverage-ratchet`, `parser-contract-classification-ratchet`,
   `provenance-coverage-ratchet` rows removed).
2. **(b)** Delete `src/core/JevReviewFlagShadow.ts`, its boot wiring in
   `server.ts` (≈19529), the `GET /jev-review-flag/summary` route and its
   `CapabilityIndex.ts` internal-prefix row, the `intelligence.jevReviewFlagShadow`
   type + default + dev-gate row, the `jevReviewFlagShadowAwareness()` template
   function and the inline copy in `generateClaudeMd()`, the `migrateClaudeMd()`
   step that appends it, the `'### Jev Review-Flag Shadow'` marker in
   `migrateFrameworkShadowCapabilities` (the Codex/Gemini mirror), and the
   `feature-delivery-completeness.test.ts` parity row. Its unit, integration and
   e2e tests are deleted; the public docs page
   `site/src/content/docs/features/jev-review-flag-shadow.md` is deleted and the
   two mentions in `architecture/under-the-hood.md` removed.
3. **(c)** Delete `src/monitoring/ProactiveCompactionSentinel.ts`, its boot block
   in `server.ts` (≈13894), the `monitoring.proactiveAutonomousCompaction` type,
   and its `guardManifest.ts` row (safe: the boot guard check walks only keys that
   exist now). Its unit test is deleted with it.
4. **(d)** No source change (none exists); the migration below removes the key.
5. **(e)** Delete `src/core/MoveIntentClassifier.ts` and
   `src/core/ProfileIntentClassifier.ts`, and remove:
   - in the session-pool wiring block of `server.ts` (≈27651–27890): the
     `moveIntent` config read, `_logMoveIntent`, the local `resolveSelfNickname`
     helper, the `_tryNicknameRelocation` assignment, and the imports that become
     unused (`moveIntentMod`, `transferMod`, `autonomousSessionsModule`,
     `pinMutationMod`, `relocSetMod`, `nickAssignMod`). **Kept, unchanged:** the
     `_topicPinStore = new pinMod.TopicPlacementPinStore(...)` construction (used
     by ~20 other sites), the `pinMod` import, and the surrounding try/catch.
     Also removed: the `_tryNicknameRelocation` declaration (≈920) and its call
     in the Telegram dispatch path (≈2861);
   - the `_profileIntent*` module state, `logProfileIntent()`, the classifier
     branch in `handleTopicProfileIngress()` (a message that is not an explicit
     profile trigger now returns `false` — pass to the agent — exactly as the
     dark / dry-run path already did), and the `intentClassifier` config read in
     `startServer`;
   - their defaults, dev-gate rows, `componentCategories` entries, every
     `llmBenchCoverage.ts` / `provenanceCoverage.ts` registration (including the
     `DP_MOVE_INTENT_CLASSIFY` / `DP_PROFILE_INTENT_CLASSIFY` census rows and
     constants), the `moveIntent` row in `COHERENCE_MANIFEST_EXCLUSIONS`
     (`machineCoherenceManifest.ts`), and the two entries in
     `docs/bounded-judgment-input-baseline.json` (its `ceiling` drops by 2 —
     the shrink-only lint refuses a stale entry);
   - their dedicated tests (`MoveIntentClassifier.test.ts`,
     `move-intent-discrimination.test.ts`, `move-intent-relocation-path.test.ts`,
     `ProfileIntentClassifier.test.ts`, `profile-intent-discrimination.test.ts`,
     `profile-intent-ingress-path.test.ts`); and the ratchet / wiring tests that
     pin their presence are updated (`transfer-activation-wiring` keeps its
     pin-store assertion, drops the classifier ones;
     `parser-contract-classification-ratchet`, `keyword-intent-decision-ratchet`,
     `framework-list-drift`, `lint-dev-agent-dark-gate` — whose expected-line map
     is keyed by `ConfigDefaults.ts` line numbers and is re-derived —
     `llm-bench-coverage-ratchet`, `provenance-coverage-ratchet`,
     `metrics-features-routes` fixture names). Consistent-but-unlisted readers
     that stay green without edits: `routing-registry-freshness.test.ts`
     (component keys ↔ doc rows, both sides removed), `CapabilityIndex.test.ts`,
     `lint-guard-manifest.test.ts`; historical mentions under `docs/audits/`,
     `upgrades/` and `docs/specs/` stay.

   `NicknameCommand.ts` (the type), `TransferByNickname.ts` (the planner) and
   `RelocationNicknameSet.ts` stay: `POST /pool/transfer` uses them.
   `HubIntentClassifier` and `permissions/LlmIntentClassifier` are unrelated and
   stay. Comments that cite the removed classifiers as an exemplar
   (`NicknameCommand.ts:14`, `HubIntentClassifier.ts:34`,
   `topicProfileIngress.ts:62`, `topicProfileIngress.test.ts:20-25`,
   `ProfileIntentClassifier` mention in `keyword-intent-decision-ratchet`) are
   reworded to drop the dangling reference. The public docs pages
   `features/topic-profile.md`, `reference/topic-profile-api.md` and
   `docs/LLM-ROUTING-REGISTRY.md` lose their classifier paragraphs.

### Agent awareness (template + migration)

Two instruction-file cards still describe the removed NL path. Both are reworded
in `generateClaudeMd()` and patched in place by `migrateClaudeMd()` — string
replaces and one content-sniffed in-card insert (the precedent is the
`- **Dashboard door + model controls**` insert into this same card,
`PostUpdateMigrator.ts` ≈11969). All idempotent: text absent → no-op.

- **Pool card, transfer bullet.** Two deployed wordings exist and both are
  patched: the template's `but deterministically (no NL recognition).` and the
  migrator copies' `but deterministically.` become `— the lever I call when the
  user asks to move a conversation (the server does not recognise the phrase
  itself).`; the trailing sentence is removed in BOTH its deployed forms —
  ` This is the lever to call directly when a natural-language move didn't catch.`
  (template-generated files) and ` The lever to call directly when a
  natural-language move didn't catch.` (migrator-inserted files) — each with its
  leading space. The migrator's own insert constants for this card
  (`PostUpdateMigrator.ts` ≈9840–9966, six literals) are updated to the new
  wording in the same PR, and the replace step runs AFTER the inserts inside
  `migrateClaudeMd`, so an agent that receives the card by insert and one that
  already has it converge on the same text.
- **Pool card, proactive-triggers bullet.** `"move this to <nickname>" →
  placement/transfer-by-nickname` and `"move it reliably / it didn't move" →
  POST /pool/transfer` collapse to one trigger: the user asks to move / run / pin
  a conversation on a machine → `POST /pool/transfer`.
- **Pool card, post-transfer closeout bullet.** "immediately on an explicit
  move" named the NL closure's immediate close as the only immediate path. There
  are two: `POST /pool/transfer`'s drain leg closes the owner's session inside the
  request whenever the current machine can drain (`routes.ts` ≈22765–22830,
  runner built in `server.ts` ≈24532); only a refused / unhandled / timed-out
  drain degrades to the reconciler + reaper sweep. The bullet now says "closed by
  the transfer's drain step when the current machine can drain, otherwise within
  ~2 reaper ticks".
- **Topic Profile card.** One bullet is inserted after "What is this topic pinned
  to?" naming the agent's write path, exactly as the route behaves
  (`routes.ts` ≈11562): `curl -X POST -H "Authorization: Bearer $AUTH"
  -H "X-Instar-Request: 1" http://localhost:PORT/topic-profile/TOPIC_ID/propose
  -H 'Content-Type: application/json' -d '{"framework":"codex-cli"}'` (fields:
  framework / model / modelTier / thinkingMode / effort / escalationOverride, a
  string or null each; messageOriginDisplay, an object or null). The server renders the echo into
  the topic; the operator's "yes" (the explicit `confirm` trigger in
  `topicProfileIngress`, untouched by this change) converts it into the
  operator-attributed write. Without `X-Instar-Request: 1` → 403; non-Telegram
  topic → 409; malformed field → 400; profiles not wired → 503; proposal churn →
  429; echo undelivered → 502 and the slot is disarmed.

### Behavior for users

- **Fleet agents in the shipped (dark / default) state:** server dispatch is
  byte-identical (the only behavior change is the instruction-card text above). A
  "move this to the Mini" or "use codex here" message is read by the agent, which
  calls the explicit lever — as it already does on the fleet.
- **An installation that had deliberately enabled one of the five** (none is
  known): the behavior stops at update, and the migration says so with a `REVIEW:`
  line (below). An older machine in a mixed-version pool keeps its own behavior
  until its own update; none of the five had cross-machine effects.
- **Development agents:** the two classifiers stop making an LLM call on matching
  inbound messages (they only ever logged), so a message that named a machine or a
  profile signal no longer waits up to 4 s before dispatch — it reaches the
  session slightly sooner. The review-flag shadow was already off.

### Migration (Migration Parity Standard)

One new `PostUpdateMigrator` step, `migrateRetireStagedFeaturesCmt1004()`, on
`.instar/config.json`, following the `migrateRetireDeadMentorConfig` precedent:

- Deletes, when present: `cartographer.conformanceAudit.llmEnrichment`,
  `cartographer.subtreeNav.llmRerank`, `intelligence.jevReviewFlagShadow`,
  `monitoring.proactiveAutonomousCompaction`,
  `multiMachine.sessionPool.moveIntent`, `topicProfiles.intentClassifier`; and
  top-level `quotaLimits` **only when it deep-equals the known junk value
  `{"enabled": false}`** (Instar never defined the key, so any other shape is
  someone else's and is left alone, named in a `REVIEW:` line without its value).
  Parents are left in place; a parent emptied by the deletion is left as `{}`.
- Honors `_instar_noMigrate`: a listed path is skipped and reported, as
  `applyDefaults` does.
- Idempotency: an `_instar_migrations` marker
  (`retire-staged-features-cmt1004-v1`), the precedent — so the step is not a
  perpetual scrubber that would strip a future legitimate feature reusing a name.
- **Every removed block is recorded, never silently dropped**: the `upgraded`
  line lists each removed key with its schema scalars only (`enabled`, `dryRun`,
  `timeoutMs`, `minConfidence`, `modelTier`, `contextWindowTurns`,
  `tickIntervalMs`, `maxChecksPerDay`, `framework`, `egressAcknowledged`,
  `allowClaudeFallback` — never free text, never an undefined-shape key's value,
  because the line reaches the operator's update Telegram notice). A block with
  `enabled: true` or `dryRun: false` gets a `REVIEW:` prefix and the replacement
  lever named.
- Unparseable config → `errors` entry, file untouched (same as sibling steps).

Instruction-file cleanup inside `migrateClaudeMd()` (runs at `run()` ≈1738,
BEFORE `migrateFrameworkShadowCapabilities` at ≈1739, whose mirror loop only
appends missing markers — so with the marker dropped the stripped card is never
re-mirrored), applied to `CLAUDE.md` and to the mirrors `AGENTS.md` / `GEMINI.md`
when they exist:

- The generated card text is **kept as a frozen constant**
  `JEV_REVIEW_FLAG_CARD_RETIRED(port)` (the precedent is
  `NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1`, kept for the Normal-Chrome v1
  retirement at ≈12600), even though the generator is deleted.
- Locate the full heading `### Jev Review-Flag Shadow (log-only "does this reply
  need your review?" measurement)`. The card was appended as
  `'\n\n' + heading + '\n\n' + paragraph + '\n'` and every later append in
  `migrateClaudeMd` starts with `\n`, so the **blank-line-bounded paragraph**
  after the heading is the unit (a heading-bounded compare would mis-match on
  agents where a plain paragraph such as "Queued-message review pacing:" follows).
  After CRLF normalisation and `localhost:\d+` → `localhost:PORT`, strip the
  heading, the blank-line run before it (collapsed to one line terminator, so the
  neighbours keep exactly one blank line between them), and that paragraph **only
  when the paragraph equals the frozen text exactly**. Loop for duplicate
  headings.
- Heading present, paragraph not equal (hand-edited, or extended): nothing is
  removed; one `REVIEW:` line names the file and heading. Honest channel: that
  line lands in the server console (`server.ts` ≈4546) and the operator's update
  notice (`UpdateChecker.ts` ≈324→377 folds `upgraded` into the "Updated from
  vX to vY" text); there is no session-start consumer of migration output.
  Because `migrateClaudeMd` is content-sniffed and runs on every update, the
  line repeats at each update until the card is gone — stated, not hidden. The leftover is stale text about a
  route that now answers 404; it is an accepted residue (zero known instances —
  the card was appended verbatim everywhere), not a chore handed to anyone.
- Heading absent → untouched.

Old soak logs (`logs/move-intent.jsonl`, `logs/profile-intent.jsonl`,
`logs/jev-review-flag-shadow.jsonl`) are left on disk; they are inert history.
Existing decision-quality rows for the removed census points remain in the ledger
and simply drop out of `GET /decision-quality` (the meter iterates
`PROVENANCE_COVERAGE`); the grade pass never walks these points
(`GRADE_PASS_POINTS` is fixed), and a late `annotateOutcome` on one of them is
refused as `unknown-decision-point` (counted, `applied:false`). Measurement-only
rows; no behavior depends on them.

A peer machine that still syncs an older config between updates can re-introduce
a deleted key until its own update; the key has no reader, so this is inert; the
marker-gated step does not re-run, so such a key may persist indefinitely on the
already-migrated machine (accepted: reader-less, harmless), while the older peer
itself is cleaned when it updates.

A release-note fragment `upgrades/next/retire-staged-features-2026-10-25.md` ships
with the usual sections (this change has a user-facing surface: the instruction
cards and the `REVIEW:` lines).

## Decision points touched

> No decision point is added or reclassified. Three enrolled decision points are
> **removed** from the decision-quality census together with their components:

| Decision point | Component | Status before | After | Classification |
|---|---|---|---|---|
| `move-intent-classify` | `MoveIntentClassifier` | wired, dry-run, measurement-only | removed (the explicit `POST /pool/transfer` route carries no classification) | invariant — removed; what remains (`POST /pool/transfer`) is a deterministic planner over an explicit nickname, no competing signals |
| `profile-intent-classify` | `ProfileIntentClassifier` | wired, dry-run, measurement-only | removed (the propose lane is a structured delta + operator confirm; no inference) | invariant — removed; what remains is a structured delta validated against closed enums plus the operator's explicit confirm, no inference |
| `standards-coverage-enrich` | `StandardsCoverageEnrichment` | pending enrolment, no call site | removed | invariant — removed; it had no call site, so nothing decides here at all |

> Each was a would-be authority (it could have hijacked or actuated on an inbound
> message) that never left dry-run; removing it removes a potential authority and
> adds none. Nothing remaining is classified differently.

## Multi-machine posture

Posture: unified — nothing new is introduced. Each machine's own `config.json`
and instruction files are cleaned by its own update (they are machine-local by
`physical-credential-locality` already: the config holds that machine's tokens
and is not git-tracked). The classifiers were per-machine inbound recognizers
with no replicated state; `moveIntent` sat in the coherence manifest's exclusion
list, so the guard never compared it; the manifest is derived per machine from
its own defaults, so removing the row is order-independent. Mixed-version pools during a rolling update
are safe: the old version's paths were dark / dry-run with no cross-machine
effects.

## Maturation plan

A removal plus a config/instruction migration cannot ship dark — a dark deletion
is no deletion — so the plan is a verification ladder, not a gate ladder.

- **test-agent-live:** the migration unit tests run the step against fixture
  configs and instruction files (defaults, enabled block, junk and non-junk
  `quotaLimits`, hand-edited card, mirrors, CRLF, `_instar_noMigrate`, second
  run); the full suite runs once in the worktree before the PR opens.
- **dev-agent-live:** the release that carries it lands on the development agent
  (Echo) first through the normal auto-update; after the update the seven keys
  are absent from its `config.json`, the card is absent from `CLAUDE.md` and
  `AGENTS.md`, the update output names the removed blocks, and the server boots
  clean with no `jev-review-flag` or classifier log lines.
- **fleet:** the same release, ungated (a removal has no flag to hold dark).
- **graduation criterion:** on the development agent, 24 h after the update: zero
  `REVIEW:` lines about this step, zero errors from it in the migration output,
  `grep` over `src/` per acceptance criterion 1 empty, and the pool-transfer and
  topic-profile explicit routes still answering (the agent's levers are intact).
- **dark-window:** 0 days — there is no dark state; the 24 h criterion above is
  the verification window after the live landing.

## Frontloaded Decisions

1. **Scope** — exactly the five voted items plus the component that existed only
   for (a); `ws21PreferencesPool` excluded (decided in the review).
2. **`StandardsCoverageEnrichment` is retired with its flag**, not kept as an
   orphan registration.
3. **Migration idempotency** — the `_instar_migrations` marker precedent (a
   marker-less step would scrub the key names forever).
4. **Operator-enabled values** — removed, with every removed block's schema
   scalars recorded in the update output (`REVIEW:` prefix when it was enabled),
   not kept: the code that read them is gone.
5. **Hand-edited instruction cards** — never deleted; reported on every update
   while present (no per-file marker exists), left as accepted residue (route
   404s; zero known instances).
6. **Old soak logs and old decision-quality rows** — left in place.
7. **Agent-awareness rewording ships in this PR** with its migration, because the
   spec's argument rests on the agent driving the explicit levers.
8. **`quotaLimits`** is deleted only when it equals the known junk value.

## Open questions

*(none)*

## Acceptance criteria

1. `grep` over `src/` for the exact identifiers `JevReviewFlagShadow`,
   `jevReviewFlagShadow`, `ProactiveCompactionSentinel`,
   `proactiveAutonomousCompaction`, `MoveIntentClassifier`,
   `ProfileIntentClassifier`, `classifyRelocationIntent`, `classifyProfileIntent`,
   `StandardsCoverageEnrichment`, `llmEnrichment`, `llmRerank`,
   `topicProfiles.intentClassifier`, `_intentCfg`, `_profileIntent`,
   `sessionPool.moveIntent` finds **only** the retirement migration step's
   literals and the frozen card constant (and nothing in comments). The bare word
   `intentClassifier` is the permissions classifier's variable and is out of
   scope. `jev-review-flag` appears
   only in that step. (`move-intent` as the plain word for a pin in
   `OwnershipReconciler` / `TopicPinReplicatedStore` / `TopicPinFoldView` is
   unrelated and stays.)
2. `npm run build` (tsc) passes; `npm run lint` passes (including the
   bounded-judgment-input and dark-gate lints).
3. The migration unit test covers: keys present at defaults → removed with one
   upgraded line; a block with `enabled: true` → removed with a `REVIEW:` line
   carrying the value; `quotaLimits` → removed, reported as unknown key; second
   run → skip; missing config → skip; unparseable config → error, file unchanged;
   generated card present in CLAUDE.md and in AGENTS.md (followed by a plain
   paragraph) → stripped, neighbours intact; CRLF file → stripped; paragraph with
   the generated first sentence but edited remainder → untouched + `REVIEW:`;
   generated paragraph followed by a custom paragraph → only the generated one
   stripped; card absent → untouched; `_instar_noMigrate` path → skipped;
   `quotaLimits` with a non-junk value → untouched + `REVIEW:` without the value;
   both transfer-card wordings → replaced; closeout + trigger bullets → reworded;
   propose bullet absent → inserted once; second run → no-op.
4. `handleTopicProfileIngress` still handles explicit `/topic` triggers (existing
   `topicProfileIngress` tests stay green) and returns `false` for a plain
   message; `transfer-activation-wiring` still proves the pin store is built.
5. The full suite is green (run once, through the host test-runner limiter).

## Rollback

Revert the PR. Code, routes, registrations and tests return; `ConfigDefaults`
re-adds the **default** blocks on the next `migrateConfig()` pass; the review-flag
card is re-appended by the restored `migrateClaudeMd()` step and re-mirrored.
A re-land after a revert must ship the step as `-v2`: the `-v1` marker survives the
revert, defaults re-add the blocks, and a re-land under the old marker would skip
the cleanup. Honest limit: an operator-set value (`enabled: true`, a custom
timeout) is **not** restored automatically — it survives only in the `REVIEW:` line of the update
output (and in any pre-update config backup the operator keeps). No other state is
touched.
