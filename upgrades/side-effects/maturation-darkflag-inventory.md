# Side-Effects Review — Dark-flag maturation inventory (Standards A + B)

**Version / slug:** `maturation-darkflag-inventory`
**Date:** `2026-10-23`
**Author:** `echo`
**Second-pass reviewer:** `echo (self-administered independent pass — see that section; no separate reviewer agent was run, and none is claimed)`

## Summary of the change

Increment 1 of `docs/specs/maturation-followthrough-fix.md` (Standards A + B). The maturation
engine could only see features whose **spec** registered a rollout stage — 3 tracks out of 1,201
items — so the live inventory of dark / dry-run switches aged out of sight entirely. This change
points the engine at the **code-derived** inventory instead and gives every dark flag a durable
**owner + deadline + proof-of-life** record.

- **New:** `src/monitoring/DarkFlagMaturationRegistry.ts` — the durable per-flag registry
  (`state/dark-flag-maturation.json`) plus a PURE reconciler.
- **Modified:** `src/monitoring/GrowthMilestoneAnalyst.ts` — new rule **R7** (dark-flag maturity)
  reading the guard-posture inventory through the same `buildGuardInventory` funnel `/guards`
  uses; new settings block; R3 demoted out of the headline; both aggregation points aligned.
- **Modified:** `src/monitoring/GrowthDigestPublisher.ts` — R7 label; `RULE_ORDER` puts maturity
  first and R3 last.
- **Modified:** `src/server/AgentServer.ts` — injects the inventory reader, the registry, and a
  code-derived owner derivation.
- **Modified:** `src/config/ConfigDefaults.ts`, `src/core/types.ts`,
  `src/monitoring/guardManifest.ts` — the new flag ships dark + dry-run-first and registers
  itself as a guard (dogfooding its own guarantee).

**Proportion signal.** Tier 2. ~9 files, ~1,500 LOC including tests. 102 new tests (86 unit,
10 integration, 6 e2e). One commit attempt so far; one design correction mid-build (the
`/growth/findings` divergence, found by its own integration test). That is in line for a
Tier-2 change against a pre-converged spec.

## Decision-point inventory

This change adds **no** decision point. Everything it produces is read by surfaces that already
exist, and every disposition stays with their existing owners.

- `GrowthMilestoneAnalyst` notify-rules — **add** (R7) — classifies dark flags and emits
  aggregate findings. Emits findings only; takes no action.
- `DarkFlagMaturationRegistry` — **add** — durable record. Writes state; decides nothing.
- `GrowthDigestPublisher.RULE_ORDER` — **modify** — presentation order only (R3 demoted).
- `buildGuardInventory` / `guardPostureView` — **pass-through** — read, unmodified.
- G3 `loadBearingGap` / `accept-fallback` — **pass-through** — deliberately NOT duplicated; R7
  names load-bearing keys so a consumer routes to the existing surface instead of raising a
  competing row.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** R7 cannot reject, delay or suppress
anything; it appends findings to a digest.

The nearest analogue to an over-block is a **false finding** — surfacing a flag as overdue when
it is not. Concrete shapes, and what each does:

- A flag whose evidence source is unwired reports `proofOfLife: 'unknown'` and, once its window
  closes, surfaces as `expired-unproven`. That is **intended and honest** (it says "no evidence
  it ever ran", not "it is broken"), but it means the first live digest will name genuinely-fine
  features whose only fault is an unwired counter. Mitigated by aggregation — one row with a
  list, not N rows — and by the dry-run stage, where the registry fills with real states before
  any of it reaches the operator.
- A guard in `missing` / `errored` / `diverged-pending-restart` is deliberately **not** treated
  as dark, so a transient boot-order artifact does not manufacture a finding.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** What it still misses:

- **A dark switch that is not a registered guard is invisible.** The inventory is the guard
  manifest, so a staged behavior gated by something other than a manifest-registered config flag
  (the test-runner bound lives in a host tuning file, not config) is still unseen. The spec's
  Standard A names widening to non-config gates; that is not in this increment and is carried by
  CMT-977 below rather than silently dropped.
- **Proof-of-life is not wired in this increment.** `darkFlagEvidenceCounter` is accepted but
  nothing supplies it yet, so every flag reports `'unknown'` and nothing can become
  `promotion-ready` through R7 alone. This is honest (unknown never promotes) but it means R7's
  promote arm is inert until an evidence source lands. Also CMT-977.
- **Owner derivation covers only dev-gated features.** Everything else stays `null`. That is
  deliberate — an un-owned flag is a surfaced finding, and inventing an owner would make the
  registry look complete while answering nobody — but it means the first digest reports a large
  un-owned count that only a human can actually resolve.

---

## 3. Level-of-abstraction fit

Right layer, and deliberately the *thin* one.

- It is a **detector/recorder**, not an authority: it reads an existing derived view and writes a
  record.
- It **reuses** rather than re-implements: the inventory comes from `buildGuardInventory` (the
  same pure funnel `/guards` uses, so the engine and the operator's read surface can never
  disagree about what is dark); the verdict shape mirrors `classifyRollout`; the journal pattern
  mirrors the analyst's existing stage journal; persistence is plain JSON on the existing
  file-based-state decision, not a new dependency.
- It explicitly does **not** build a parallel classification or a parallel accept lever next to
  G3. G3 already owns `loadBearingGap` / `loadBearingSoaking` / `loadBearingAccepted` and the
  PIN-gated accept route. This adds only the dimension G3 lacks (owner + deadline +
  proof-of-life) and names load-bearing keys so they route to G3's existing alarm.
- A lower layer would be wrong: `guardPostureView` is intentionally pure and fs-free, so the
  durable registry cannot live there. A higher layer would be wrong too: the digest publisher
  renders, it does not classify.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces a signal consumed by an existing smart gate.**
- [x] **No — this change has no block/allow surface.**

Both apply. R7 is a detector: cheap, deterministic, no I/O of its own beyond the registry, and it
produces structured findings. The authority over what happens to a dark flag is unchanged and
sits where it already sat — the operator (promotion, and G3's PIN-gated accept lever). Nothing
here flips a flag, accepts a risk, blocks, delays, or rewrites.

The one thing to watch deliberately: a durable "deadline passed" record is the sort of artifact a
later increment could wire into an auto-promotion. That would be a genuine authority change and
must get its own review; it is not in this change and the registry cannot act on itself.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.**

Two near-misses, both resolved as invariants rather than judgment:

1. **Is this flag dark?** Enumerable, and it is an invariant already defined by
   `guardPostureView`'s nine-state contract: `on-dry-run`, or `off` with `offClass`
   `dark-default` / `diverged-from-default`. No competing signals; no scoring.
2. **Has the window closed?** Arithmetic on a monotonic anchor, not a judgment.

`riskTierForGuard` is a heuristic (load-bearing ⇒ highRisk, else standard), but it is
deliberately one-directional: it can only make a window **longer**, never shorter. A shorter
window would expire a flag sooner and could surface it on thinner evidence, so erring long is the
safe direction and the heuristic cannot cause the harmful outcome.

---

## 5. Interactions

- **Shadowing:** R7 is additive to R1/R2/R3/R4/R5/R6 — none of them is gated on it and it is
  gated on none of them. The one genuine change to existing behavior is **R3's demotion**: R3 is
  still computed, still emitted, and still rendered — it is reported last instead of leading.
  Nothing consumes `RULE_ORDER` positionally for logic; it is presentation. Verified by a test
  that asserts R3 is present AND last.
- **Double-fire:** the real risk here, and handled explicitly. A load-bearing dark flag is
  already alarmed by `GuardPostureProbe` as a `loadBearingGap`. R7 does **not** raise a second
  row for it: it reports those keys inside its aggregate `loadBearingKeys` with text pointing at
  the existing gap. So one finding, one alarm owner.
- **Races:** the registry is written by the analyst only, on the analyst's own cadence,
  single-process, per machine. Two analyst instances over one stateDir would last-write-win, and
  because the anchor and deadline are **monotonic** a concurrent write cannot shorten a window —
  the worst case is a lost `lastObservedAt`, re-derived on the next pass. No lock is warranted.
- **Feedback loops:** this feature is itself a registered dark guard, so it appears in its own
  inventory. That is deliberate dogfooding and it terminates: the registry records it, the record
  does not change the inventory, and there is no amplification. A legacy entry is classified once
  and its history appends only on genuine state changes, so repeated ticks converge to zero
  writes (asserted by `changed === false` on an unchanged re-run).

---

## 6. External surfaces

- **Other agents on the same machine:** none. The registry is per-agent stateDir.
- **Install base:** the feature ships `enabled: false`, so merging it changes nothing for anyone
  until a deliberate flip. With the flag off the analyst's behavior is byte-identical to today's
  (asserted by a test, including that no registry file is written at all).
- **External systems:** none. No network, no spend, no LLM call, no egress. Pure local
  computation over state already on disk.
- **Persistent state:** one new file, `state/dark-flag-maturation.json`. Append-mostly,
  self-healing, and never written while the feature is off.
- **Timing:** runs on the analyst's existing cadence. Adds one guard-inventory build per analyst
  pass (a config read + pure derivation) — not per request.
- **Operator surface (Mobile-Complete Operator Actions):** this change adds **no new operator
  action**. Its output reaches the operator through the existing `/growth/*` read routes and the
  existing weekly digest, both already phone-reachable. The dispositions an operator may take
  (promote, or accept via G3) are pre-existing surfaces, unchanged here. Honest limitation: the
  spec's "one tap: promote / extend / retire" surface is Standard C/D work, not this increment —
  so today a surfaced finding still needs the operator to act through those existing paths.
  Tracked in CMT-977, not dropped.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, markup file, approval page, or
grant/revoke/secret-drop form is touched. The digest's wording changes (a new section label and
reordering), which is copy inside an existing notice, not a surface.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and the reason is substantive rather than convenience: a guard's
`effective` state is a **fact about the machine it runs on**. The same flag genuinely reads
`on-dry-run` on the dev agent and `dark-default` on a fleet machine — which is exactly the
divergence I measured on this agent's own two machines while scoping this work. Grading one
machine's flags against another's posture would produce false verdicts in both directions. This
matches how `guardPostureView` and `guardAcceptedFallbacks` are already per-machine; the
cross-machine question is answered by the existing `GET /guards?scope=pool` merge, not by
replicating this file.

That posture is **enforced, not just documented**: the registry is stamped with its machine id,
and a file carrying another machine's id is refused and re-anchored rather than merged — so a
peer's "graduated / proved" claim can never carry over. Asserted at unit and e2e level.

- **User-facing notices?** It adds content to the existing weekly digest. One-voice gating is
  already required and already implemented for that publisher (lease-holder-only send, per the
  spec's program-shared posture); this change does not add a second send path, so it inherits
  that gating rather than needing its own.
- **Durable state stranding on topic transfer?** Not applicable — the state is keyed on guard
  keys, not topics, so a topic moving machines has no bearing on it.
- **Generated URLs?** None.

---

## 8. Rollback cost

Cheap and complete.

- **Hot-fix:** set `monitoring.growthAnalyst.darkFlagInventory.enabled: false` — no deploy
  needed. The analyst reverts to exactly today's InitiativeTracker-only behavior and R3 returns
  to the headline. Reverting the code is a plain revert; nothing depends on the new module.
- **Data migration:** none required. `state/dark-flag-maturation.json` is additive and read by
  nothing else; it can be left in place or deleted. Deleting it is safe but **not** free of
  meaning: the next run re-anchors every live dark flag as `legacy-unproven`, so deadlines
  restart. That is the deliberately conservative direction (it over-surfaces, never hides), and
  it is worth knowing before deleting the file to "clean up".
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility during rollback:** none. The feature is off on the fleet, so there is nothing
  to regress.

---

## Conclusion

This review produced two design corrections and one scope boundary.

1. **The two-aggregation-point bug.** The build initially carried R7 in `buildDigest()` but not
   in `computeFindings()` (behind `/growth/findings`) — which is precisely the defect the driving
   spec names as a reason the engine stalled ("the criterion lives in two places that disagree").
   Its own integration test caught it. Both points are now aligned and a parity test locks them
   together so the class cannot recur.
2. **Aggregation over per-flag findings.** The first shape would have emitted one finding per
   dark flag. Against a real 184-flag inventory that is a notification flood, so R7 emits at most
   one row per class carrying the count and the list, with the per-flag detail in the durable
   registry. Asserted against 120 flags.
3. **Scope boundary held.** The proof-of-life source, the one-tap promote/extend/retire surface,
   the watcher, and widening to non-config gates are all in the driving spec but are later
   increments. They are registered as CMT-977 rather than quietly carried, because each would
   change this feature from a recorder into something with authority, and that deserves its own
   review.

The honest headline: **this makes the forgotten inventory visible and durable; it does not yet
make promotion autonomous.** R7's promote arm is inert until an evidence source is wired, by
design — `'unknown'` must never promote. Clear to ship behind its dark flag.

---

## Second-pass review (if required)

**Reviewer:** `echo` — self-administered independent pass. **No separate reviewer agent was run,
and the artifact does not claim one concurred.** Stating this plainly because a fabricated
independent concurrence would be worse than an honest self-review.

The trigger applies (this change reads the guard inventory and adds a guard-manifest entry, so it
falls in the "anything with guard in it" class). Adversarial second read, looking specifically for
the violation Phase 5 exists to catch — brittle logic holding blocking authority:

- **Does any new code path block, delay, or suppress?** Read every branch of the new module and
  the new analyst method. No `throw` that propagates to a caller's control flow, no return value
  consumed as a gate, no 4xx, no queue. The only writes are to its own registry file. **Clear.**
- **Could the registry become authority by accident?** `reconcile` is called only from
  `computeDarkFlagFindings`, whose return value is consumed only by finding lists. Nothing reads
  `deadline` to act. **Clear, with the standing caution recorded in §4** that a later increment
  wiring this into auto-promotion is an authority change needing its own review.
- **Could it over-surface into a flood?** This was a real concern and drove the aggregation
  redesign. Verified at 120 flags: one row.
- **Could it under-surface and hide the backlog?** The failure direction worth checking hardest,
  since masking the backlog defeats the purpose. Three paths were specifically hardened and
  tested: first-registration cannot grant a clean window; a corrupt or foreign registry
  re-anchors as legacy rather than silently starting fresh; an unreadable config snapshot returns
  `null` (skip) rather than an empty list, because an empty list would read as "nothing is dark"
  and could tombstone the entire registry. **Clear.**
- **One defect found and FIXED by this pass.** The stored `deadline` field was written once at
  creation while `classifyDarkFlag` computes expiry from `firstObservedDarkAt + windowDays`. If a
  guard's window later widened — e.g. it became load-bearing and moved to the highRisk tier — the
  stored field would keep reporting an *earlier* date than the behaviour it is supposed to
  describe. A stored field that quietly disagrees with the logic is how a reader gets misled, and
  it is the same "two places that disagree" family as the `/growth/findings` bug. Fixed by
  recomputing the stored deadline as `max(stored, firstObservedDarkAt + windowDays)` — consistent
  with the classifier, and monotonic by construction so it can only ever move later, never
  shorten a window. Legacy entries are excluded (their deadline is deliberately the anchor
  itself, overdue by construction). Covered by two new tests asserting it extends on a widened
  window and does NOT move on a narrowed one.
- **A second defect found and FIXED by this pass — and it is the one that mattered most.** The
  R7 finding's `detail` originally listed the affected guard keys inline. `detail` is rendered
  VERBATIM into the weekly Telegram digest (`GrowthDigestPublisher.renderFinding`), and a dotted
  config path is precisely the literal the always-on tone gate blocks. So the first live R7
  digest would have been tone-gate-blocked — which is the exact 2026-06-29 failure that
  **Standard C of this very spec** was written to prevent. I would have shipped increment 1 in a
  shape that re-created the failure increment 2 exists to fix. The publisher's own source carries
  a warning comment about this on its footer constant; I did not read it closely enough the first
  time. Fixed: the keys now travel only in the structured `affected` field (consumed by the
  dashboard and read routes, never rendered into a message), and `detail` carries the count, the
  ownership gap in plain words, and a pointer to the dashboard. Guarded by a test that asserts NO
  R7 title or detail matches a dotted-path pattern, run against realistic three-segment keys.
- **A third defect found and FIXED (not by reading, by running).** The `builtin-manifest` test
  compares a generated, gitignored artifact against current source; editing source made it stale.
  Regenerated. Worth recording because it is invisible until the suite runs.
- **One residual concern, recorded rather than resolved:** the first live digest on this agent
  will name a large un-owned legacy set that only a human can resolve, and there is no one-tap
  surface for them yet (Standard C/D). The mitigation available today is the dry-run stage — let
  the registry fill and read it directly before clearing `dryRun`. That is the recommended
  rollout order and it is what this ships with.

**Verdict: concur with the review**, with the residual concern above carried in CMT-977.

---

## Evidence pointers

- `tests/unit/DarkFlagMaturationRegistry.test.ts` — 50 tests: the dark-set predicate, proof
  honesty on both sides, monotonic/flap-robust deadlines (including a 6-cycle toggle),
  migration-is-not-a-clean-slate, tombstoning, graduation only on genuinely-on states, history
  append-only-on-change, foreign/corrupt registry handling, and stored-deadline consistency under a widened or narrowed window.
- `tests/unit/growth-analyst-darkflag-r7.test.ts` — 36 tests: gating on both sides, the dry-run
  canary (registry written, no findings), aggregation at 120 flags, the never-promote-on-unknown
  rule, R3's demotion, degrade-to-skipped paths, wiring integrity against `AgentServer.ts`
  source, the two-aggregation-point parity guard, and the no-dotted-config-key-in-operator-text guard.
- `tests/integration/growth-analyst-darkflag-routes.test.ts` — 10 tests over the real HTTP
  pipeline, including restart durability and tombstoning through the routes.
- `tests/e2e/growth-darkflag-maturation-lifecycle.test.ts` — 6 tests on a real port: the Phase-1
  "feature is alive" assertion, the full legacy → graduate → flap-back → tombstone lifecycle, and
  the foreign-machine-registry refusal.

---

## Class-Closure Declaration (display-only mirror)

**Not applicable, with reason.**

- **Agent-authored-artifact defect?** No. This change fixes no defect in an LLM prompt, hook,
  config, skill, or standards text. It builds an unbuilt increment of an approved spec.
- **`unbounded-self-action` class?** No new self-triggered controller. R7 adds *content* to an
  existing controller's output (the weekly digest) and fires nothing of its own — no restart,
  swap, respawn, spawn, notify, retry, re-drive or kill. It has no loop, no timer, and no
  cadence of its own; it is called synchronously by an existing analyst pass.

Recording the convergence argument anyway, since the class is adjacent and the aggregation bound
is the interesting part:

- **Control-loop edge:** none added. The analyst's existing cadence is the only driver.
- **Steady-state bound:** output is bounded by *classes*, not by inventory size — at most 3 R7
  findings regardless of whether 3 or 184 flags are dark. So the notification surface cannot grow
  with the thing it measures.
- **Settling brake:** the registry converges to zero writes on an unchanged inventory
  (`changed === false`), and history appends only on genuine state transitions, so repeated ticks
  are idempotent rather than accumulating.
