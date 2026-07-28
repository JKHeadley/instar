---
title: "Feature-Maturation Follow-Through Fix — point the engine at the real dark-flag inventory, make delivery un-droppable, and give it a watcher"
slug: "maturation-followthrough-fix"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "maturation-followthrough-fix.eli16.md"
status: "review-convergence (authored 2026-07-03; revised + re-grounded against canonical JKHeadley/main v1.3.735 after multi-angle convergence review — the working tree echo/serve-main is ~108 patches stale at v1.3.626, so a prior finding written against it was corrected here)"
tags: [review-convergence]
origin: "Topic 29723 + audit topic 30668 (2026-07-03). The operator's concern: Instar ships features 'dark' on the promise that a maturation engine (the Growth & Milestone Analyst / Close-the-Loop machinery) guarantees they can never be silently forgotten. A read-only inventory pass found the engine is running but not doing that job — it watches the wrong surface, routes to a silent channel, and fails closed to silence when its one weekly send is blocked. This spec turns the verified defects into structure. Convergence note: all code-ground claims were re-verified against canonical master (JKHeadley/main v1.3.735 — the version builds and the live server run on), which superseded a stale reading of finding #3 and Standard B (G3 machinery + preferredCaptainHandback DO exist on master)."
operator-gate: "This spec mints no new constitutional text on its own authority. Standard E registers a gradeable guard for two ALREADY-RATIFIED standards (Deferral = Deletion, Close the Loop) under the existing amendment loop; the registry marker ships under operator ratification, as with the three-standards-enforcement ship. Finding 3 (a dark mesh-lease-self-heal piece on a critical path) is surfaced as an operator promote-or-accept decision — this spec does NOT flip it."
---

# Spec — Feature-Maturation Follow-Through Fix

**Ships:** the structure that makes "a dark feature can never be silently forgotten"
actually true, by fixing the verified defects in the running maturation engine:

- **A — point the engine at the REAL dark-flag inventory** (`/guards` posture),
  not at InitiativeTracker work-items it mostly can't read.
- **B — every dark flag gets owner + deadline + proof-of-life**, in a durable
  maturation registry; an un-owned/expired dark flag is itself a surfaced finding.
- **C — delivery can never be silently dropped**: a blocked send re-queues + raises an
  attention item instead of consuming its weekly window; the digest content is authored
  so it does not itself trip the tone gate; attention-class findings land where the
  operator actually looks.
- **D — a self-heal-before-notify watcher** for the engine (the ratified Standard B
  applied): verify the engine is registered AND delivering; on silence, attempt a
  bounded, audited self-heal FIRST; escalate to the operator only if self-heal fails.
- **E — turn "Deferral = Deletion" / "Close the Loop" from documented-only into a real
  guard**, so the very principles about not-forgetting are enforced, not remembered.

**Run boundary.** A–E only. This is a fix of known, code-grounded defects that joins a
completion bar — it does NOT rewrite InitiativeTracker, does NOT build the (separate,
still-unbuilt) G3 dark-but-load-bearing guard machinery, and enables nothing on the fleet.

## Glossary (for a reader outside Instar)

- **dark flag / ship-dark** — new runtime code ships disabled (or dry-run) behind a
  `monitoring.*` / `multiMachine.*` config flag, promoted by stages so a change can't hit
  the whole fleet before it's proven.
- **maturation engine** — the running pair `GrowthMilestoneAnalyst` (computes findings)
  + `GrowthDigestPublisher` (sends a weekly digest). Meant to be the structure that
  re-surfaces every dark feature until it's promoted, extended, or killed.
- **`/guards` posture inventory** — the read surface (`guardPostureView.ts`) that already
  grades EVERY guard by verified state: `on-confirmed` / `on-dry-run` / `off` classified
  `dark-default` (ships-dark, quiet) vs `diverged-from-default` (should be on, currently off).
- **InitiativeTracker** — a general work-item tracker (933 items on this agent). A few of
  its items carry a `rollout.stage`; most are ordinary tasks. It is NOT the dark-flag registry.
- **tone gate** — the always-on outbound LLM/deterministic review (`evaluateOutbound`) that
  blocks operator-facing messages containing raw route paths, config keys, or file paths.
- **attention queue** — the durable, operator-visible surface (`/attention`) for things that
  need a decision or a look; distinct from the informational "Agent Updates" topic.
- **conformance audit** — `StandardsEnforcementAuditor` / `GET /conformance/coverage`, which
  grades each constitutional standard `ratchet > gate > lint > spec-only > documented-only`.
  A `documented-only` standard is a **gap**: prose with no structural guard.

## Problem statement — the verified findings (grounded)

Every finding below was re-grounded against **canonical master (`JKHeadley/main`, v1.3.735 — the
version that builds and that the live server runs on)**, not the ~108-patch-stale `echo/serve-main`
working tree (v1.3.626). A prior inventory AND a first-pass reading against that stale tree each
carried WRONG citations; both are corrected inline against master (marked **[RE-GROUNDED
v1.3.735]**) rather than repeated. The four growth-analyst root-cause lines below were re-verified
present on master: FOOTER raw route path (`GrowthDigestPublisher.ts:429`), config-key leak
(`GrowthMilestoneAnalyst.ts:566`), the `send-blocked` entry that still carries `window`
(`GrowthDigestPublisher.ts:321–323`), and the `recordedWindows()` reader that treats any
`window`-bearing entry as decided (the `catchUp()` gate) — so the defects, not just the earlier
line numbers, hold on the version builds actually ship from.

### 1. The engine is NOT dark — it is running, delivering live, and still failing its job.

The prior framing "it's off" is false. On this (development) agent the analyst enable
rides the dev-agent gate — `AgentServer.ts:1716` resolves
`resolveDevAgentGate(config.monitoring?.growthAnalyst?.enabled, config)` LIVE even though
`enabled` is absent from config — and `.instar/config.json` sets
`monitoring.growthAnalyst.digestDelivery: "live"`, so the publisher is constructed and
started (`AgentServer.ts:1755–1792`). The audit log proves real sends:
`.instar/logs/growth-digest.jsonl` holds **3 `sent`** digests (2026-06-10, -15, -22) and
**1 `send-blocked`** (2026-06-29, `reason=tone-gate-blocked`). So the problem is not the
switch. It is three real defects:

**(a) It watches the WRONG surface.** `GrowthMilestoneAnalyst.deps.tracker` is
`InitiativeTracker` (`GrowthMilestoneAnalyst.ts:267`). Its feature-maturity rules — R1/R2,
the KEY "is this dark feature earning its way through the rollout track?" lever — read only
`stagedInitiatives()` = `tracker.list().filter(i => i.rollout && i.rollout.stage)`
(`GrowthMilestoneAnalyst.ts:360–372, 377–430`). **On this agent that filter returns 3 of
933 initiatives** (279 active, 653 archived) — and all 3 are already in stage `live`, not
`dark`. Meanwhile R3 (`computeStallingFindings`, `:433–457`) reads
`tracker.digest().items` filtered to `stale`/`needs-user`, which floods the digest with
~258 of the 279 active work-items. Only R6 (`:543–573`) reads an actual dark-feature list —
and that is `DEV_GATED_FEATURES`, a narrow hardcoded allowlist, not the live
`monitoring.*` flag set. **The `monitoring.*` dark switches — the exact things ship-dark is
about — are invisible to the engine.** Its headline signal is InitiativeTracker work-item
staleness noise, not feature maturity.

**(b) It routes its digest to a channel the operator does not watch for action.** The
publisher's sender is `postToUpdatesTopic` (`routes.ts:1950`, defined `:1921–1944`), which
targets the `agent-updates-topic`. That topic is provisioned as **informational, not
critical** — created with the greeting *"Nothing urgent — just keeping you in the loop
about what's new"* (`server.ts:2643–2666`). Anything that needs a decision (promote?
extend/fix/kill? an expired dark flag) lands in the FYI channel, not the attention surface.

**(c) It FAILS CLOSED to silence.** In the live-send path (`GrowthDigestPublisher.ts:311–338`)
a blocked send builds an audit entry that STILL carries the window
(`:319–326`, `window` field), `record()` writes that window (`:343–353`), and
`recordedWindows()` (`:553–572`) reads any entry with a `window` back — so the next
`catchUp()` treats the window as already decided (`:230`) and never retries. **A blocked
send consumes its weekly window with no retry and no fallback** — no route to the attention
queue, nothing. And the digest content is what trips the gate: the formatter's FOOTER is
the literal `Read the full digest anytime: GET /growth/digest (or the dashboard).`
(`GrowthDigestPublisher.ts:429`, a raw route path) and R6's detail embeds a config key
(`… resolves it DARK at ${feature.configPath}`, `GrowthMilestoneAnalyst.ts:566`). Those are
exactly the raw route-path / config-key patterns the tone gate blocks — which is why the
2026-06-29 window was lost to `tone-gate-blocked` with no recovery. The one guarantee it
exists to provide — "a dark feature can never be silently forgotten" — was silently dropped.

### 2. META-FINDING: the not-forgetting principles have zero enforcement.

The conformance audit (`StandardsEnforcementAuditor.ts:31, 80–99`; route
`routes.ts:4953, 4991`) grades each standard, and a `documented-only` standard is a gap.
The two standards that ARE the promise being broken above have no structural guard:
`docs/STANDARDS-REGISTRY.md:98` (**Deferral = Deletion**) and `:104` (**Close the Loop**)
carry no "Applied through:" guard reference — contrast `:118–120` (No Silent Degradation)
which cites a CI ratchet + spec. **Close the Loop's own text names "features shipped dark
ride a maturation track that re-surfaces them" as its mechanism — the exact machinery
finding 1 shows is broken, and the standard has no guard to catch that.** The conformance
audit reports ~26 of ~51 standards as `documented-only`; this spec confirms the two
load-bearing ones directly and gives them teeth (Standard E).

### 3. One load-bearing dark guard worth surfacing — an operator decision, not a flip. **[RE-GROUNDED v1.3.735]**

Re-grounded against canonical `JKHeadley/main` (v1.3.735 — the version builds and the live server
run on; the `echo/serve-main` working tree is ~108 patches stale at v1.3.626). A prior
"[CORRECTED]" note — written against that stale tree — claimed
`multiMachine.leaseSelfHeal.preferredCaptainHandback` "resolves NOWHERE." **That is wrong on
master, where the flag DOES exist and IS emitted:** it is a real `GUARD_MANIFEST` entry
(`guardManifest.ts` — `key/configPath multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled`,
`dryRunConfigPath …preferredCaptainHandback.dryRun`), marked `loadBearing: true`,
`criticalPath: 'serving-lease returns to intended captain (mesh drifts off the always-on machine
after failover)'`, backed by `LeaseHandbackReconciler.ts`. So the finding's original SHAPE **and**
its citation both stand: it is a dark, load-bearing mesh-lease-self-heal piece on a critical path.
Because the G3 dark-but-load-bearing machinery IS built on master (see Standard B, re-grounded),
this flag is ALREADY classified `loadBearingSoaking` / `loadBearingGap` / `loadBearingAccepted` by
`guardPostureView` + `GuardPostureProbe`, and the operator's promote-or-accept lever ALREADY exists
(`POST/DELETE /guards/:key/accept-fallback`). **This spec therefore builds no surface for it and
does NOT flip it** — it is surfaced by the existing G3 machinery, and Standard B composes WITH that
machinery rather than duplicating it.

## Program-shared posture (binding on A–E)

- **Signal + Authority, not new brittle authority.** The engine reads the deterministic
  `/guards` posture inventory (the signal) and the watcher (D) NOTIFIES; neither grants
  itself authority to change a flag or accept a risk — promotion and acceptance stay the
  operator's. This mirrors the constitutional *Signal vs. Authority* split and the sibling
  `three-standards-enforcement.md`.
- **Composes with *No Silent Degradation*.** C and D refine *to whom / with what retry* a
  failure is reported (into a re-queue + attention item + bounded self-heal, all audited) —
  they never license swallowing. Every detection, block, retry, and heal attempt is written
  to an audit trail; the operator is the last resort, never the silent-drop alternative.
- **Dark-first, and its own first compliant example.** Every runtime piece here ships behind
  a new flag, dry-run first. This spec's OWN dark flags (A/B `darkFlagInventory`, D `watcher`)
  are registered in the new maturation registry (B) with owner + deadline + proof-of-life at
  ship — the feature dogfoods the guarantee it builds.
- **Cross-Machine Coherence (posture is declared, not assumed).** The `monitoring.*` /
  `multiMachine.*` dark flags AND the `/guards` posture that grades them are **per-machine**
  (a guard's live `effective` state is a fact about the machine it runs on; the pool read is
  `GET /guards?scope=pool`). Therefore every durable surface this spec adds is **machine-local
  BY DESIGN, with reason**: the maturation registry (`state/dark-flag-maturation.json`), the
  guard-observation journal, and the watcher each grade THIS machine's own dark flags — a
  peer's registry is neither authoritative for nor merged into this machine's (matching how
  `guardPostureView` is already per-machine). This is not a single point of failure for a
  shared graph; there is no shared graph — each machine owns its own maturation state, and the
  cross-machine view is the existing `/guards?scope=pool` merge, not a replicated file. **One
  voice on send:** the weekly digest and any watcher escalation are emitted only by the machine
  that holds the serving lease (`syncStatus.holdsLease`); a standby machine computes and audits
  locally but does NOT publish, so a two-machine agent never double-notifies. Attention items
  (C/D) carry a machine-scoped `dedupe-key` and rely on the existing pooled-attention P17
  coalescing so the same pool-wide finding raised by two machines collapses to one row.
  **The `dedupe-key` encodes `machineId` (`<machineId>:growth:<findingKind>:<subjectKey>`)** so
  that two machines with DIFFERENT dark-flag inventories never collapse each other's DISTINCT
  findings — P17 coalesces only genuinely identical pool-wide events (and HIGH/URGENT always stay
  individually visible), never one machine's real finding behind another's.

## Standard A — point the engine at the real dark-flag inventory

**Where:** `GrowthMilestoneAnalyst` gains a new source adapter and one new notify-rule; the
existing rules are untouched except R3 is demoted (below).

1. **New source: the guard-posture inventory.** The analyst reads the already-built
   `guardPostureView` (the data behind `GET /guards`; `guardPostureView.ts:37, 229–231`) and
   treats every guard whose `offClass` is `dark-default` or `diverged-from-default`, or whose
   `effective` is `on-dry-run`, as a first-class **maturation subject** — the same status a
   `rollout.stage` initiative has today, but keyed on the guard key. This is additive: the
   InitiativeTracker rollout rules (R1/R2) stay, but the dark `monitoring.*` switches finally
   become visible.
2. **New rule R7 — dark-flag maturity.** For each dark subject: is it inside its incubation
   window (incubating), past its window with proof-of-life (promotion-ready → promote?), or
   past its window without proof (expired-unproven → extend/fix/kill?)? Reuses the existing
   `classifyRollout` verdict shape (`GrowthMilestoneAnalyst.ts:238–257`) verbatim, so
   proof-of-life honesty (`proved: 'unknown'` never counts as proved) carries over unchanged.
3. **Demote R3 (initiative-stalling) out of the headline.** R3's ~258-item flood is
   InitiativeTracker work-item noise, not feature maturity. It stays computable but moves out
   of the digest headline/summary — the maturity signal (R1/R2/R7) leads; R3 is a tail section
   or off by default. This is the difference between "the engine watches the right surface"
   and "the engine is loud about the wrong one."

**Config / rollback.** `monitoring.growthAnalyst.darkFlagInventory.enabled` (dark-first,
default off; on a dev agent it rides the dev-agent gate, dry-run first). Off → the engine
reverts to today's InitiativeTracker-only behavior exactly.

## Standard B — every dark flag gets owner + deadline + proof-of-life

**A durable per-flag maturation registry** (`state/dark-flag-maturation.json`), keyed on the
guard key from A, carrying for each dark subject:
- **owner** — who is accountable for graduating or killing it (agent or operator).
- **deadline** — the incubation window's close. Derived from **first-observed-dark** via a
  guard-observation journal (reusing the exact stage-journal pattern the analyst already runs,
  `GrowthMilestoneAnalyst.ts:186–197, 341–358`), because a flag's original ship date is not
  always recoverable and first-observed-dark is robust and free.
- **proof-of-life criteria** — the checkable signal that the feature actually ran: the guard's
  runtime-confirmed posture from `guardPostureView`, and/or its `fireRate` from the per-feature
  LLM metrics surface (`/metrics/features`) where the flag drives an LLM feature; honest
  `unknown` when neither is wired (never asserted-proved).

**Registry lifecycle + reconciliation (not just a keyed blob).** Each entry carries an explicit
`state` — `incubating` / `promotion-ready` / `expired-unproven` / `graduated` (flag went
`on-confirmed`) / `killed` (flag removed with a kill disposition) / `superseded` (renamed/merged
guard) — and every state change appends to the registry audit. The registry is **reconciled
against the live `/guards` inventory** on each analyst run: a guard key present in the registry
but ABSENT from `/guards` (removed/renamed) is not silently dropped — it is tombstoned as
`killed`/`superseded` (retained, not deleted) so history survives; a guard that transitions
`dark → on-confirmed` is marked `graduated`, not stranded as forever-expired. This closes the
drift where a renamed/removed guard would otherwise generate false `expired` findings or lose
its record.

**Deadline is flap-robust (adversarial).** The deadline is anchored to **first-observed-dark**
and is NEVER reset by a transient `on → dark` re-entry: a guard that toggles back to dark is a
**continuation** of its existing window, not a fresh incubation (the observation journal records
the toggle, but `deadline` is monotonic per guard key). Without this rule a flapping guard could
reset its window indefinitely and never reach `expired-unproven`, escaping the very finding B
exists to raise.

**Migration is not a clean slate (protects the north-star).** On the FIRST run against a tree
that already carries dark flags, those pre-existing flags MUST NOT each be granted a fresh clean
incubation window — that would mask the exact already-forgotten inventory this spec exists to
surface. Any dark flag observed at first-registration whose first-observed-dark cannot be
anchored to a recent journal entry is classified `legacy-unproven` (owner unset, deadline
`overdue`) and surfaced **immediately** as an un-owned finding, not treated as newly incubating.
The forgotten backlog is the headline of the first digest, by construction.

**An un-owned or past-deadline dark flag is itself a surfaced finding** — routed to the
attention queue (C), because an un-owned dark feature is precisely the Close-the-Loop gap this
whole spec closes. **These findings AGGREGATE** (Bounded Notification Surface): the whole set of
un-owned/expired dark flags is ONE digest section and, at most, ONE coalesced attention item
carrying the count + the list — never one attention item per flag (the 2026-06-05 worktree-
detector flood is the lesson; the existing attention-topic guard + topic-creation budget are the
backstop, but the design AGGREGATES so it never leans on them).

**Build-vs-buy (why a file, not a queue/flag platform).** The registry + observation journal are
deliberately file-based JSON on the existing `StateManager` + stage-journal patterns, NOT an
external feature-flag platform or message broker (SQS/RabbitMQ). This is the project's load-
bearing *"File-based state — no database dependency"* design decision: instar must run with zero
external infra, survive on a single laptop, and keep every durable surface auditable as plain
JSON. The maintenance cost is accepted for that guarantee; the registry reuses machinery that
already exists rather than adding a dependency.

**[RE-GROUNDED v1.3.735] — this REUSES the existing G3 accept-fallback machinery, which IS built
on canonical master.** A prior "[CORRECTED]" note (written against the ~108-patch-stale
`echo/serve-main` tree, v1.3.626) claimed the "Dark-but-Load-Bearing Guards (G3)" surface was "not
built" and told B to invent new machinery on top of `/guards`. **That is wrong on canonical master
(v1.3.735), where G3 is fully present and emitted:**
- `guardManifest.ts` — `GuardManifestEntry` carries `loadBearing?: boolean` + `criticalPath?:
  string` (REQUIRED when `loadBearing`) per guard.
- `guardPostureView.ts` — every `GuardRow` emits `loadBearing` / `loadBearingGap` /
  `loadBearingSoaking` / `loadBearingAccepted` + `acceptedFallbackReason`, and `GuardsSummary`
  carries `loadBearingGapKeys` / `loadBearingSoakingKeys` / `loadBearingAcceptedKeys`; the
  soak-window evaluation is already implemented.
- `guardAcceptedFallbacks.ts` — the durable **per-machine** accept store
  (`state/guard-accepted-fallbacks.json`, keyed `<machineId>:<guardKey>` → `{reason, owner,
  acceptedAt}`; missing/corrupt ⇒ empty map = the SAFE direction, so no phantom accept can suppress
  a real gap).
- `GuardPostureProbe.ts` — classifies the three load-bearing states and raises ONE per-episode
  deduped attention item (healthKey dedup), with a rollback lever
  (`monitoring.guardPostureProbe.alertLoadBearingGaps`).
- `POST/DELETE /guards/:key/accept-fallback` (`routes.ts`) — the operator's owned-accept lever
  (both `reason` + `owner` required; dashboard-PIN-gated).

**Therefore B does NOT invent a parallel gap/soaking/accepted classification or a parallel accept
lever.** The maturation registry adds ONLY the dimension G3 does not carry — per-flag **owner +
deadline + proof-of-life** — and COMPOSES with G3:
- A dark flag the registry finds un-owned/expired that is ALSO `loadBearing` is surfaced as the
  EXISTING `loadBearingGap` (GuardPostureProbe's deduped item, per-machine, safe-direction) — not a
  second, competing attention row.
- Its promote-or-accept disposition is the EXISTING `accept-fallback` route; the registry supplies
  owner/deadline/proof-of-life, G3 supplies classification + the accept lever.
- New dark flags this spec ships (`darkFlagInventory`, `blockedDigestEscalation`, `watcher`) are
  added as `GUARD_MANIFEST` entries so `/guards` already grades them; the watcher (D) entry is
  `loadBearing: true`, `criticalPath: 'dark-feature maturation follow-through'`, so a watcher that
  itself sits forgotten-dark past its soak window is a LOUD `loadBearingGap` — reusing G3 as the
  engine-independent backstop (see Standard D, *who-watches-the-watcher*).

Reusing this avoids the two-surfaces-for-one-decision drift and inherits G3's per-machine
safe-direction posture for free. (Historical note: the `soloCaptainHold` / U4.4 lease-handback
items the stale note mentioned are ALSO real on master — `preferredCaptainHandback` is a live G3
guard, see Problem #3.)

**Config / rollback.** Same `darkFlagInventory.enabled` flag as A (they are one increment). The
observation journal is bounded (append-only with a retention window on the same pattern the
existing stage-journal uses — old observations compact once a guard's deadline is anchored, so
the file cannot grow without bound); the registry itself is one entry per live-or-tombstoned
guard key (O(#guards), not O(#observations)).

## Standard C — delivery can never be silently dropped

Three sub-fixes to `GrowthDigestPublisher` + the formatter. Each is bounded and buildable.

- **C1 — a retryable block never consumes its window; it re-queues + escalates.** In the
  live-send path (`GrowthDigestPublisher.ts:311–338`), on `result.ok === false` with a
  *retryable* reason (tone-block / provider-down / send-error), DO NOT record the window as
  decided. Record a distinct `send-deferred` audit action WITHOUT a `window` field (so
  `recordedWindows()` does not swallow it and `catchUp()` retries next boot/cadence), AND raise
  **one deduped attention item** ("this week's growth digest couldn't send — <plain reason>;
  it will retry, and the findings are at the dashboard"). A *terminal* non-send (calm/off/no
  updates-topic) still records its window as today — only a retryable block changes. Idempotency
  is preserved: a delivered or dry-run window still consumes exactly once.
  - **Bounded delivery-attempt contract (not an open-ended retry).** The deferred window is a
    durable delivery-attempt record `{ windowId, attemptCount, nextAttemptAt, lastReason,
    attentionDedupeKey }`. Retries carry a backoff and a bounded ceiling, concrete defaults:
    **`max-attempts: 5`**, **`max-age: 1_209_600_000` (14 days = two weekly windows)**, backoff
    exponential from a **`60s` base** (written to `nextAttemptAt`). A **poison window** that
    exhausts EITHER ceiling transitions to a *terminal-failed* state that consumes the window (so
    it stops retrying forever) but raises ONE escalated attention item recording the exhaustion —
    a poison digest is surfaced, never a silent infinite loop and never a silent drop. This single
    record is also the shared idempotency ledger the watcher's `replay-window` / `drain-deferred`
    self-heals (D) read and advance, so watcher-drain and cron-retry can never both fire the same
    window. This gives C1 its own brakes independent of the watcher (D).
  - **Security — the attention item never re-leaks what C2 removed.** The deferred/exhausted
    attention item carries a **generic plain-English reason only** (e.g. "blocked by the outbound
    safety filter", "the messaging provider was unreachable"). It NEVER embeds the raw rejected
    digest body or the tone gate's cited offending pattern (which contains the very route path /
    config key C2 strips) — otherwise the escalation would re-introduce the leak C2 fixed and
    could itself trip the tone gate. The raw detail stays in the local audit
    (`growth-digest.jsonl` / dashboard), not in the operator-facing notice.
- **C2 — author the content so it does not trip the tone gate (root-cause fix).** The formatter
  must not put raw route paths / config keys / file paths in operator-facing text. FOOTER
  `Read the full digest anytime: GET /growth/digest …` → plain English ("Full digest in your
  dashboard"). R6/R7 detail's `… resolves it DARK at ${feature.configPath}` → name the feature
  in plain words, not the config path (`GrowthMilestoneAnalyst.ts:566` /
  `GrowthDigestPublisher.ts:429, 503–508`). This is the direct fix for the 2026-06-29 block and
  follows the outbound-advisory rules (restate jargon; publish a private view for detail).
  **Tested, not assumed (Testing Integrity):** C2 is not a wording-intent guess — it ships with
  a preflight fixture suite that runs representative digest content (every rule's formatted
  detail, incl. R6/R7 examples and the footer) through the real `evaluateOutbound` tone gate and
  asserts a PASS. A formatter change that reintroduces a raw route/config/file path is caught by
  that test, not by a future live block. (The tone gate itself is unchanged — Non-goal.)
- **C3 — attention-class findings land where the operator looks (ratified Standard C).**
  Anything needing a decision (R1 promote, R7 promote/expired, an un-owned/expired dark flag)
  routes through the attention queue / alerts hub — NOT the informational Updates topic. The
  calm/FYI digest may still post to Updates; attention-class findings go to `/attention`.

**Config / rollback.** C1 gets `monitoring.growthAnalyst.blockedDigestEscalation` (default the
new safe behavior; `false` restores the legacy consume-and-drop as an explicit rollback lever).
**The rollback is not a silent re-introduction of the anti-pattern (Close the Loop):** because
it is a `monitoring.*` flag, flipping it OFF is an `enabled → disabled` transition caught by the
Guard-Posture Tripwire (loud boot log + one HIGH attention item) and shows in `GET /guards` as
`diverged-from-default`. Turning off the un-droppable-delivery guarantee is therefore itself a
surfaced, acknowledged act — "louder legacy," not silent abandonment. This is the direct answer
to the conformance-gate concern that a rollback lever could re-enable the exact silent-drop this
spec closes. C2 is a pure content fix (no flag). C3 reuses the existing attention-queue routing.

## Standard D — self-heal-before-notify watcher (the ratified Standard B, applied)

**A watcher-for-the-watcher.** It verifies, on a cadence, that the maturation engine is
(1) **registered** (publisher started, cron scheduled — `isStarted()`,
`GrowthDigestPublisher.ts:160`) AND (2) **delivering**. The delivering criterion distinguishes
the engine being *alive* from the operator actually being *reached*: a `sent` / `dry-run` entry
in `growth-digest.jsonl` within the last window + grace proves genuine delivery; a `send-deferred`
entry proves the engine is ALIVE and attempting, but the operator is reached only by C1's paired
attention item, so a `send-deferred` counts toward "delivering" **only if its C1 attention item
was successfully raised** — a defer whose attention raise ALSO failed is treated as
NOT-delivering (the engine is alive but the operator is silent), which is exactly the case the
watcher must catch, not smooth over.

**Cadence + delivering-window (concrete).** The watcher ticks on the existing monitoring cadence
(default **`checkIntervalMs: 3_600_000` — hourly**; the digest cron is weekly, so hourly is ample
and cheap). "Delivering" = a genuine `sent` / `dry-run` entry (or an attention-backed
`send-deferred`) in `growth-digest.jsonl` within the last digest window **plus a `graceMs`
default of `129_600_000` (36h)** — a full weekly window may legitimately span a machine bounce, so
grace absorbs a late-but-real send before the watcher acts.

If the engine goes quiet (publisher not started, or no genuine delivery / no attention-backed
attempt past window + grace), it attempts a **bounded, audited self-heal FIRST**. The self-heal
declares — per the ratified **Standard B (self-heal-before-notify)** review-check — its
`remediation-actions` (the deterministic anti-no-op floor), each with a declared **idempotency
guard** and **compensation/rollback**, because a heal retried over a half-completed side-effect is
exactly how these loops corrupt state (a double-sent digest, a torn window record):

| `remediation-action` | side effect | idempotency guard | compensation |
|---|---|---|---|
| `re-register-publisher` | (re)start the cron + publisher (`isStarted()`) | no-op if `isStarted()` already true (start is idempotent) | none needed (start is convergent) |
| `replay-window` (`catchUp()`) | may emit a digest for a missed window | **routes through C1's single durable delivery-attempt record `{windowId, attemptCount, nextAttemptAt}`** — a replay is refused if that record shows the window already `sent`/`dry-run` or `nextAttemptAt` is in the future, so watcher-replay can never race the publisher's own cron into a **double-send** | the attempt record is the compensation ledger — a failed replay increments `attemptCount`, never re-emits |
| `drain-deferred` | retries a C1 `send-deferred` window | **same single `{windowId, attemptCount, nextAttemptAt}` record** shared with cron-retry — drain and cron-retry are mutually exclusive by construction (whoever advances `attemptCount`+`nextAttemptAt` first wins the slot) | attempt record; a drain that exhausts the C1 ceiling defers to C1's terminal-failed path, it does not invent a new one |

The self-heal carries P19 brakes, all declared and enforced: `max-attempts` (default **3**),
`max-wall-clock` (default **10 min** per episode), `backoff` (exponential, base **60s**),
`dedupe-key` (`<machineId>:growth-watcher:<episode>`), `breaker` (stop-and-surface after sustained
failure), **`max-notification-latency` (default 24h — the recoverable-watcher VISIBILITY CEILING:
once an unhealed episode has been open this long the operator is told EVEN IF self-heal is still
retrying, so a slow-but-not-yet-exhausted heal can never hide the outage indefinitely)**, and
`audit-location` (`logs/growth-watcher.jsonl`, metadata-only/scrubbed).

**It escalates to the operator (ONE deduped attention item) when the self-heal fails or exhausts
(`breaker` open / `max-attempts` hit) — OR when `max-notification-latency` elapses first,
whichever comes first.** Severity class: **RECOVERABLE** (heal-then-notify) — EXCEPT a **flapping**
heal (heals then re-breaks repeatedly within the window) escalates immediately per *Distrust
Temporary Success* (P14): the recurrence is the signal, not something to keep silently re-healing.

**Who watches the watcher (engine-independent regress terminator — the origin bug of this whole
spec).** The prior maturation watchdog was itself a forgotten dark feature; D must not recreate
that. Self-registration in the B registry (dogfooding) is good but **circular** — if
`darkFlagInventory` never promotes, R7 never runs, so the registry can't surface its own
forgotten-ness; and if the engine is down, the engine can't surface D. The real terminator is
**engine-independent**: D and the A/B engine are `monitoring.growthAnalyst.*` guards in
`GUARD_MANIFEST`, so they are graded by the **Guard-Posture Tripwire** (an `enabled → disabled`
transition at boot ⇒ loud boot log + one HIGH attention item, independent of the growth engine) and
by the **GuardPostureProbe** (`/guards` classifies a should-be-on flag `diverged-from-default`, and
a dark load-bearing one past soak `loadBearingGap`). Because D's manifest entry is
`loadBearing: true` / `criticalPath: 'dark-feature maturation follow-through'` (Standard B,
re-grounded), a watcher that sits forgotten-dark is a LOUD `loadBearingGap` raised by machinery that
does not depend on the watcher, the engine, or the digest running at all. That closes the regress
without an infinite tower of watchers.

**Signal vs. Authority (load-bearing).** The watcher NOTIFIES and self-heals its OWN engine; it
NEVER grants itself authority to promote a feature, flip a flag, or accept a risk — those stay
the operator's. This is the applied surface of the ratified Standard B and composes with the
self-heal-gate pattern documented in `three-standards-enforcement.md` §Standard B.

**Config / rollback.** `monitoring.growthAnalyst.watcher.enabled` (dark-first, dry-run first:
in dry-run it logs "would self-heal / would escalate" without acting). Off → no watcher. On a
multi-machine agent the watcher runs per-machine over its OWN engine but only the serving-lease
holder escalates to the operator (Cross-Machine Coherence, above), so a two-machine agent never
double-escalates.

## Standard E — turn "Deferral = Deletion" / "Close the Loop" into a real guard

The direct answer to the meta-finding (#2). Two moves, both the same signal-vs-authority shape
as `three-standards-enforcement.md`:

1. **A `/spec-converge` review-check + deterministic marker.** A spec that DEFERS work — a
   "tracked follow-up", a "later", a "ships dark" with no promotion path — MUST bind that
   deferral to a durable cadence (a commitment, a **maturation-registry entry with owner +
   deadline** (B), or a scheduled review). An un-cadenced deferral is a MATERIAL FINDING. The
   deterministic floor: the conformance audit grades the PRESENCE of that binding.
2. **Register the guard so the audit can grade it.** Add an "Applied through:" guard reference
   to the `Deferral = Deletion` and `Close the Loop` registry entries
   (`docs/STANDARDS-REGISTRY.md:98, 104`) pointing at the review-check + this spec's
   maturation registry, so `StandardsEnforcementAuditor.classifyFileGuard`
   (`StandardsEnforcementAuditor.ts:85–99`) grades them `gate`/`lint` instead of
   `documented-only`. The two not-forgetting principles stop being gaps.

**The tight link:** the dark-flag maturation registry (B) IS the structural cadence Close the
Loop demands for "a feature shipped dark." So building A/B is itself part of enforcing Close the
Loop; E adds the review-check + registry marker that makes the standard mechanically gradeable.

**Migration Parity (P3) & operator gate.** The review-check is `/spec-converge` skill content —
existing agents receive it via an idempotent `PostUpdateMigrator` entry scoped to the
spec-converge default-skill allowlist (same shape as the three-standards ship). The two registry
"Applied through" markers are constitution edits and ship under **operator ratification** (this
spec mints no new standard text; it gives an already-ratified standard its guard).

## Rollout increments (dark-first; each registers itself in the B registry)

Each increment is a focused PR against canonical; no batching. Each ships behind its flag,
dry-run first, and — dogfooding B — is entered in the maturation registry with owner + deadline
+ proof-of-life at ship, so this feature is the first thing its own guarantee re-surfaces.

| # | Increment | Config flag | Owner | Deadline | Proof-of-life |
|---|-----------|-------------|-------|----------|---------------|
| 1 | **A + B** — dark-flag source + maturity rule R7 + owner/deadline/proof-of-life registry + observation journal. Demote R3. | `monitoring.growthAnalyst.darkFlagInventory.enabled` | agent (echo) | 7d (standard) | R7 lists the live `monitoring.*` dark flags in a dry-run digest; registry has ≥1 real entry |
| 2 | **C** — C1 re-queue + attention escalation; C2 tone-safe content; C3 attention-class routing. | `monitoring.growthAnalyst.blockedDigestEscalation` (C1) | agent (echo) | 7d | a synthetic blocked send re-queues + raises exactly one attention item; a live send passes the tone gate |
| 3 | **D** — self-heal-before-notify watcher with P19 brakes. | `monitoring.growthAnalyst.watcher.enabled` | agent (echo) | 7d | watcher (dry-run) logs a "would self-heal" on an induced engine stall; escalates only on induced exhaustion |
| 4 | **E** — spec-converge review-check + registry "Applied through" markers (operator-ratified). | `/spec-converge` skill content (next review run) | operator + agent | at ratification | `GET /conformance/coverage` no longer classes `Deferral = Deletion` / `Close the Loop` as `documented-only` |

Increment 1 is the highest-leverage (it makes the engine watch the right thing); 2 makes its
voice un-droppable; 3 guards the engine itself; 4 closes the meta-gap.

## Success metrics

- **Zero silently-dropped digests.** After increment 2, a `tone-gate-blocked` window is never
  consumed without a retry + an attention item (the 2026-06-29 failure mode is impossible).
  Measured in `growth-digest.jsonl` (no `send-blocked` window without a paired `send-deferred`
  + attention item) and the attention log.
- **The dark switches are visible.** After increment 1, the digest's maturity section reflects
  the live `monitoring.*` dark-flag set, not 3-of-933 InitiativeTracker items. Measured by R7
  count vs `/guards` dark-flag count.
- **Every dark flag has an owner + deadline.** Registry coverage of the live dark-flag set → 1.0
  (an un-owned dark flag is a finding, never invisible).
- **The meta-gap closes.** `GET /conformance/coverage?status=gap` no longer lists
  `Deferral = Deletion` / `Close the Loop`.
- **North-star:** operator-found dark-feature escapes (a shipped-dark feature the operator
  discovers was forgotten) → zero.

## Non-goals

- **Not** rewriting InitiativeTracker or removing R1–R6 — A/B are additive; R3 is demoted, not
  deleted.
- **Not** re-building or forking the G3 dark-but-load-bearing guard machinery
  (`loadBearing`/`criticalPath`/`accept-fallback`) — it is ALREADY built on canonical master
  (v1.3.735); B COMPOSES with it (registry = owner/deadline/proof-of-life; G3 = classification +
  accept lever) and adds only manifest entries for the new flags, never touching G3 core.
- **Not** changing the tone gate — C2 makes the digest content compliant with it, not the reverse.
- **Not** enabling anything on the fleet — every runtime piece ships dark, dry-run first, dev
  agent only until soaked.
- **Not** minting new constitutional text — E gives an already-ratified standard a guard;
  finding 3 is surfaced as an operator decision, not flipped.

## Frontloaded Decisions

1. **Deadline source = first-observed-dark (not ship date).** [in *Standard B*] Ship date is not
   reliably recoverable; the existing stage-journal pattern makes first-observed-dark robust and
   free. *Cheap-to-change-after:* NO — it defines the deadline contract every dark subject uses.
2. **Proof-of-life = runtime-confirmed posture + LLM `fireRate`, honest `unknown` otherwise.**
   [in *Standard B*] Reuses the analyst's existing `proved:'unknown'`-never-promotes honesty.
   *Cheap-to-change-after:* NO — it is the promotion gate's evidence contract.
3. **A retryable block does NOT consume its window; a terminal non-send does.** [in *Standard C1*]
   This is the exact idempotency boundary that made 2026-06-29 unrecoverable. *Cheap-to-change-
   after:* NO — it is the delivery-correctness contract the watcher (D) also relies on.
4. **B REUSES the built G3 accept-fallback + `loadBearing` machinery on master (does NOT build a
   parallel surface).** [in *Standard B*] Re-grounded v1.3.735: G3 IS on canonical master (the
   prior "converge later" decision was written against the stale working tree). B composes with it —
   the registry adds owner/deadline/proof-of-life; G3 supplies `loadBearingGap`/`Soaking`/`Accepted`
   classification + the operator `accept-fallback` lever. *Cheap-to-change-after:* NO — it sets the
   increment's dependency boundary (build-ON, not build-around).
5. **Finding 3 is an operator promote-or-accept decision, not a flip.** [in *Problem #3*]
   Capability ≠ authority; a dark critical-path piece is the operator's call. *Cheap-to-change-
   after:* NO — it is a safety/authority boundary.

## Open questions

*(none open. Convergence pressure-tested the corrections in #3 and Standard B and found the OPPOSITE
of the stale-tree reading: G3 + `preferredCaptainHandback` ARE built on canonical master, so both
were re-grounded to REUSE the existing machinery. Lesson banked for this project: ground code
claims against `JKHeadley/main` (the build/deploy source), never the local working tree — a prior
finding asserted a wrong root cause the operator caught, and this spec's own first pass repeated the
shape against a stale tree until re-grounded.)*
