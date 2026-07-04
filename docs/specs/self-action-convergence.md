---
title: "Self-Action Convergence — the Class-Closure Guard for Self-Inflicted Loops"
slug: "self-action-convergence"
author: "echo"
status: "review-convergence + operator-approved (2026-07-04, topic 30837). COMPOSED ON the class-closure system (#1347). Internal multi-lens review + 2 external families (codex gpt-5.5, gemini-2.5-pro) run; round-1 findings (codex 1 CRIT/3 MAJ/1 MIN; gemini 1 CRIT/1 MAJ/1 MIN) ALL folded; codex round-2 confirmation: all 5 resolved, zero new. Operator ratified the Part C standard proposal AND the seed-severity decision (severity: critical, one class) on 2026-07-04 — build authorized."
tags: ["review-convergence"]
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
eli16-overview: "self-action-convergence.eli16.md"
constitution: "Distrust Temporary Success (this registers the self-inflicted-loop CLASS and builds the guard that ends it — the exact mechanical arm #1347's Class-Closure Gate exists to hold); Bounded Blast Radius (the proposed standard is BBR's temporal twin — BBR bounds instantaneous MASS, this bounds steady-state FREQUENCY under feedback); No Unbounded Loops (promotes P19's review-audit duty to a graded live guard); Structure beats Willpower (the convergence proof is a CI ratchet, not discretionary prose)"
lessons-engaged: "#1347 Class-Closure Gate (docs/specs/class-closure-gate.md — this spec is its FIRST product-code application: registers a defect class, builds the live guard it cites, and expands its scope past agent-authored artifacts per Frontloaded Decision 1); Bounded Blast Radius (the spawn-cap funnel + scripts/lint-no-unbounded-llm-spawn.js + tests/unit/host-spawn-semaphore-burst-invariant.test.ts — the ratchet+lint pair this generalizes from LLM-spawn MASS to self-action FREQUENCY); P17 Bounded Notification Surface (tests/integration/notification-flood-burst-invariant.test.ts — the burst-invariant shape); P19 No Unbounded Loops (the Eternal-Sentinel exemption carries over unchanged); Signal vs. Authority (the detector is deterministic — it forces a declaration, it never LLM-guesses); Migration Parity; Distrust Temporary Success — A Recurrence Is a Root Cause (20 same-shaped incidents = one missing CLASS, not 20 bugs)"
earned-from: "2026-07-03 self-inflicted-loops investigation (topic 30837, operator directive). Smoking gun: the SubscriptionPool proactive pre-limit swap (#1035, ff3083a31, 2026-06-09) self-triggered ~72 account swaps/day — a stale-feedback control loop whose corrective action was a quota-POSITIVE kill+respawn — and shipped the LIGHT dev-path with ZERO spec-converge rounds past a side-effects template whose §5 asks 'Feedback loops: does this change input to a system that feeds back into it?' that no gate forced the review to answer. Investigation: docs/investigations/self-inflicted-loops/SYNTHESIS.md + R2/R3. The class-closure SYSTEM that answers 'what class is this and what guard ends it?' landed the SAME day (#1347, dark) — this spec is its first application to a product-code defect class."
supersedes: ""
review-convergence: "2026-07-03"
review-iterations: 2
cross-model-review: "codex-cli:gpt-5.5 (round 1: 5 findings folded; round 2: all resolved, zero new); gemini-2.5-pro (round 1: 3 findings folded)"
approved: true
single-run-completable: false
---

# Self-Action Convergence — the Class-Closure Guard for Self-Inflicted Loops

> One sentence: register **"unbounded / oscillating self-action"** as a formal defect class in the class-closure registry (#1347), build the **live CI ratchet** that ends it (an N-tick sustained-pressure convergence test every self-action controller must pass), and extend the class-closure gate's scope so a diff that adds a self-triggered controller must declare the class and cite that guard — the exact contract #1347 already checks, applied for the first time to product code.

## Why this spec exists (updated framing — the structural cut LANDED; this is its first application)

The self-inflicted-loops investigation (`docs/investigations/self-inflicted-loops/SYNTHESIS.md`) root-caused a **class** of 20 distinct incidents 2026-04-16 → 2026-07-02 — swap-thrash, both topic-floods, the fork-bomb OOM, the test-storm meltdown, the reaper's 17,503 kill-requests/day, the "session paused" inescapable loop, and more — to one common root:

> Every self-triggered action in instar (spawn, notify, restart/respawn, **swap**, retry, re-drive, kill-request) historically shipped with only a **semantic** correctness check and **no default, chokepoint-enforced ceiling on how often it fires under sustained pressure** — each action individually well-formed yet collectively unbounded, and the missing bound reconstructed locally after every incident.

The synthesis originally framed the fix as three missing teeth (a review gate, a CI ratchet, a standard). That framing needs one correction, and it makes this spec far stronger:

**The meta-structural cut is no longer missing — it landed the same day.** On 2026-07-03, PR **#1347** shipped the **Class-Closure Gate** (`docs/specs/class-closure-gate.md`, ships dark/report-only): a registry of defect **classes** (`docs/defect-classes.json` + `src/core/DefectClassRegistry.ts`), a fix-time declaration (`classClosure` block in the instar-dev decision-audit entry + a mirror in the side-effects artifact), and a CI lint (`scripts/class-closure-lint.mjs` + the self-contained grader `scripts/lib/class-closure-grader.mjs`) that verifies each fix cites the **live guard that ENDS its class** — grading the cited guard `ratchet` / `gate` / `lint`, and **downgrading any citation that resolves only to a dark/spec-only artifact** (G3: "a dark feature guards nothing"). #1347 is precisely the mechanical arm of the constitution's *Distrust Temporary Success — A Recurrence Is a Root Cause* that the investigation named as absent.

So the honest framing is: **the self-inflicted-loop class is not yet in that system, and the guard that would close it does not yet exist.** Three concrete gaps remain, and this spec fills exactly them:

1. **The class is unregistered.** `docs/defect-classes.json` holds four seeded classes (all *agent-authored-prompt* defects from the INSTAR-Bench v2 review). "Unbounded / oscillating self-action" — the shape behind swap-thrash, the fork-bomb, the topic-floods — is not among them.
2. **No live guard ends it.** There is no CI ratchet a self-inflicted-loop fix could cite as `closure: guard`. Today such a fix could only file `closure: gap` (a tracked demand for a guard that doesn't exist).
3. **The class-closure gate does not yet SEE product code.** #1347's scope predicate (`isAgentAuthoredArtifact`, its Frontloaded Decision 1) is prompts / hooks / configs / skills / standards text. Self-action controllers live in `src/` **product code** — outside that scope. #1347 explicitly names this: *"Expansion to critical-path product defects is an explicit post-run decision."* This spec is that expansion — the first product-code defect class to join the program.

**Net:** this spec becomes *"the first real self-action application of the class-closure system,"* which is stronger than a standalone proposal because the enforcement substrate (registry + declaration + graded-guard lint + escalator) already exists and is proven. It builds ON #1347 — it does not fork it.

| Part | What | Where it composes | This spec |
|---|---|---|---|
| **0** | Register defect class `unbounded-self-action` | `docs/defect-classes.json` (#1347's registry) | **designed here** |
| **D** | The **live guard** — `self-action-convergence.test.ts` (N-tick sustained-pressure ratchet) + a self-action controller registry + a forcing lint | `tests/`, `src/testing/`, `scripts/` — graded `ratchet` by #1347's grader | **designed here** |
| **E** | The **detector + scope extension** — a shared self-action detector that (a) extends #1347's `isAgentAuthoredArtifact` so a self-action diff is in scope, and (b) fires early at instar-dev commit time | `scripts/lib/`, `scripts/class-closure-lint.mjs`, `scripts/instar-dev-precommit.js`, the side-effects template | **designed here** |
| **C** | The **standard** — "Capacity Safety — No Unbounded Self-Action" = the class's `closureStandard` | `docs/STANDARDS-REGISTRY.md` | **proposed (awaiting ratification)** |
| **B** | Unified default-on backpressure primitive | its own spec | **named follow-on** <!-- tracked: CMT-1911 --> |
| **A** | Swap decoupling / live credential re-pointing | its own spec | **named follow-on** <!-- tracked: CMT-1911 --> |

**Scope discipline.** This spec builds the class registration (0), the guard (D), and the detector/scope (E), and proposes the standard (C). It deliberately does **not** design B (the unified primitive) or A (the real swap fix) — named increments with their own specs, so the enforcement lands first without blocking on the larger refactors.

---

## What already exists (ground truth on `upstream/main`)

- **#1347 — the Class-Closure Gate** (all present on `upstream/main`, ships dark/report-only):
  - `docs/defect-classes.json` + `src/core/DefectClassRegistry.ts` — the class registry (four seeded prompt-defect classes; each carries `id`, `description`, `includes`/`excludes`, `canonicalExamples`, `status`, `severity`, `closureStandard`, and the escalation cache `instanceCount`/`escalatedAt`/`evidenceCountAtLastAck`).
  - `scripts/class-closure-lint.mjs` — the report-only CI lint; `isAgentAuthoredArtifact(file)` is the scope predicate; `isGateSourceFile(file)` the self-wedge exemption.
  - `scripts/lib/class-closure-grader.mjs` — `evaluateGuardClosure` + `classifyFileGuard`: grades a cited guard, **`.test.(ts|js|mjs)` / `no-*` / `-coverage.*` → `ratchet`; `scripts/lint-* → lint`; `.husky/`/`precommit` → `gate`; `docs/** → spec-only`**; a `spec-only`/unresolved citation downgrades `closure: guard` → `gap`. `tests/unit/class-closure-grader-parity.test.ts` pins it equivalent to `src/core/StandardsEnforcementAuditor.ts`.
  - `scripts/class-closure-declare.mjs` — the author helper that merges a `classClosure` block into the most-recent decision-audit entry.
  - The side-effects template (`skills/instar-dev/templates/side-effects-artifact.md`) already carries the **"Class-Closure Declaration"** section (the display-only human mirror of the decision-audit block).
  - Config `prGate.classClosure = { enabled, dryRun, escalatorDrafting }`; repo-gated; guard-manifest registered.
- **Bounded Blast Radius** — the spawn-cap funnel + `scripts/lint-no-unbounded-llm-spawn.js` (the symbol-funnel lint: closed allowlist + grepped construction patterns, fail CI on a bypass) + `tests/unit/host-spawn-semaphore-burst-invariant.test.ts` (10k-attempt storm, live holders never exceed the cap). **This is the exact ratchet+lint pair Part D lifts from LLM-spawn mass to self-action frequency.**
- **P17 Bounded Notification Surface** — `tests/integration/notification-flood-burst-invariant.test.ts` (drive the chokepoint under a label-varying burst; topics created stay under a small constant; "applies to every current and future caller automatically") — the burst-invariant generality shape Part D reuses.
- **P19 No Unbounded Loops** — the duty (backoff + breaker + cap) + the declared four-condition Eternal-Sentinel exemption, which Part D honors verbatim.
- **The instar-dev pre-commit gate** (`scripts/instar-dev-precommit.js`) — already carries two triggered review-section gates (`assertFrameworkGenerality`, `assertOperatorSurfaceQuality`) called at BOTH pass-through points (`enforceTier1` + the Tier-2 fall-through). The Part E early-detector rides that proven shape, and the both-call-sites detail is load-bearing (the light path is where #1035 escaped).

---

## Part 0 — Register the defect class `unbounded-self-action`

Add one entry to `docs/defect-classes.json` (#1347's registry), in the exact schema of the four seeds:

```jsonc
{
  "id": "unbounded-self-action",
  "description": "A self-triggered controller — a loop, monitor tick, sentinel, reaper, scheduler, or recovery path — fires a cost-or-disruption-bearing action (restart, swap, respawn, spawn, notify, retry, re-drive, re-pin, kill/reap) with no chokepoint-enforced ceiling that makes it CONVERGE under sustained pressure, so under a condition that never clears on its own the action count is unbounded (a flood) or the action feeds the pressure that re-triggers it (a spiral).",
  "includes": [
    "a monitor/tick/sweep whose corrective action, under sustained worst-case pressure, does not settle to a small bound",
    "a self-triggered action whose effect re-enters its own trigger input (positive feedback: swap-thrash, live-tail spiral, ack-echo)",
    "a per-tick cap or single-tick guard mistaken for a loop-convergence guarantee",
    "a recovery/self-heal path that re-fires against the same failing condition without dwell/hysteresis/breaker"
  ],
  "excludes": [
    "a one-shot action fired in DIRECT response to a distinct user action (not self-triggered)",
    "a declared Eternal Sentinel meeting the P19 four conditions (constant per-attempt cost + a rate floor that prevents accumulation)",
    "instantaneous concurrency/mass (that is the Bounded Blast Radius class — the spawn cap); this class is about steady-state FREQUENCY under feedback",
    "a repeating behavior already proven to converge by a registered self-action controller test"
  ],
  "canonicalExamples": [
    "swap-thrash (#1035): proactive pre-limit account swap self-triggered ~72 swaps/day via a quota-positive kill+respawn",
    "2026-06-05 reaper age-gate: 17,503 identical kill requests/day (request→veto→re-request every 5s)",
    "2026-06-05 live-tail streamer spiral: the loop's own cost froze the event loop, staling the timestamps that caused the rejections it retried against",
    "topic-flood #1/#2 and the fork-bomb OOM are mass/emit siblings; this class is the FREQUENCY-under-feedback core"
  ],
  "status": "confirmed",
  "severity": "critical",
  "closureStandard": "capacity-safety-no-unbounded-self-action",
  "closureStandardEnforcement": null,
  "instanceCount": 20,
  "escalatedAt": "seeded-closed",
  "evidenceCountAtLastAck": 20,
  "proposalId": null
}
```

Design notes, tied to #1347's registry semantics:

- **`severity: critical`** — the compounding subset (fork-bomb OOM ×2, the 2026-06-26 kernel panic, the live-tail freeze) is SEV-class; under #1347's rule a `critical` class escalates at **1 confirmed post-seed instance**, which is the right sensitivity for a class whose worst members take the host down.
- **`escalatedAt: "seeded-closed"` with `evidenceCountAtLastAck === instanceCount` (20)** — per the registry's own note, this suppresses ONLY historical backfill (the 20 already-fixed instances). A *new* post-seed self-inflicted-loop fix that grows the class past the baseline fires the deterministic re-raise at lint time — exactly what should happen if this shape recurs after we name it.
- **`closureStandard: "capacity-safety-no-unbounded-self-action"`** — points at the Part C standard. `closureStandardEnforcement` stays `null` until the coverage grader records the guard's enforcement type (it will grade `ratchet` once Part D lands).
- **`docs/defect-classes.json` is a PROTECTED PATH** (#1347 program-shared machinery #4) — adding this class routes to the operator through the protected-path gate, which is correct: a new class semantics edit is an operator decision, and this one ships with its standard proposal (Part C).

---

## Part D — The live guard that ENDS the class (`closure: guard` target)

This is the guard a future `unbounded-self-action` fix cites. #1347's grader classifies `tests/unit/self-action-convergence.test.ts` as a **`ratchet`** (a `.test.ts` file) — the strongest enforcement type — so a `closure: guard` declaration citing it passes the G3 "must resolve to a live enforcing guard" check.

### D1. The controller-registration interface — `src/testing/selfActionRegistry.ts`

```ts
export interface PressureFixture {
  clock: { nowMs(): number; advance(ms: number): void };   // virtual, deterministic
  everyAccountHot(): boolean;         // all quota readings ≥ threshold, forever
  everySessionBusy(): boolean;        // all sessions mid-turn / carrying subagents
  targetAlwaysRejects(): boolean;     // the peer/CI/flush the loop retries against
  staleQuotaReading(accountId: string): number;  // a poll value that LAGS real state
}

export interface ActionSink {
  emit(action: { verb: string; target: string }): void;
  count: number;                      // total emitted (the invariant subject)
  perTarget: Map<string, number>;     // for the anti-ping-pong assertion
  considered: number;                 // times an action was CONSIDERED (fired OR refused)
}

export interface SelfActionController {
  id: string;                         // 'proactive-swap-monitor'
  actionVerb: string;                 // 'account-swap' — must be visible to the E detector
  makeUnderPressure(f: PressureFixture, sink: ActionSink): { tick(): void | Promise<void> };
  boundK: number;                     // proven max total actions over `ticks`
  ticks: number;                      // N — the sustained-pressure horizon
  eternalSentinel?: { reason: string; rateFloorMs: number };  // P19 exemption, declared
}

export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [
  // seeded with the enumerated controllers: proactive-swap-monitor,
  // session-reaper/respawn, retry managers, promise-beacon/notify emitters,
  // collaboration-redrive, age-kill (AgeKillBackoff).
];
```

The single list is the direct analog of `lint-no-unbounded-llm-spawn.js`'s one closed set of provider classes and #1347's one `SELF_ACTION_CONTROLLERS`-equivalent registry — one place to look, one thing the ratchet iterates.

### D2. The pressure fixture

`PressureFixture` pins the *sustained worst case that never clears on its own* — the exact condition swap-thrash ran under (every account hot; a polled quota reading that lags real usage so a just-vacated account still reads sub-threshold). It advances a **virtual clock** each tick so dwell / backoff / TTL windows are genuinely crossed. No randomness may hide a ping-pong — a fixed adversary, not a fuzzer. `ActionSink.considered` proves the fixture actually pressured the controller (the brake engaged), so a controller cannot pass by being inertly idle.

### D3. The invariant — `tests/unit/self-action-convergence.test.ts`

For each controller in `SELF_ACTION_CONTROLLERS`:

1. build it under a fresh fixture + sink; drive `controller.ticks` ticks (advancing the clock each tick);
2. **`sink.count <= boundK`** — settled to a small bound under sustained pressure (the direct swap-thrash reproduction: 20 ticks, 2 perpetually-hot accounts, `count` under K, not 72/day);
3. **settle-is-real** — re-run at `2 × ticks`; `count` stays within the *same* `boundK` (a converged loop's action count does NOT scale with the horizon; a ping-pong's does) — the anti-oscillation check R3 §2.2 says was never required to exist;
4. **no single target thrashed** — `max(perTarget.values()) <= smallPerTargetBound` (the A→B→C→A rotation the swap-fix spec modeled);
5. **sanity** — `considered > 0` (the fixture genuinely pressured it);
6. for a declared `eternalSentinel`, replace (2)–(3) with the P19 four-condition assertions (constant per-attempt cost + a rate floor), never a total-count bound.

"Applies to every current and future *registered* controller automatically because it exercises the controllers themselves" — the notification burst-invariant's generality, lifted to the whole self-action class. Completeness (that *every* controller is registered, not just the ones an author remembered) is not the test's job — it is the D4 forcing lint's, which fails CI on any unregistered self-action emit. The two together — the ratchet tests what is registered, the lint forces registration — are what make the closure genuine rather than opt-in.

### D4. The forcing lint — `scripts/lint-no-unregistered-self-action.js`

Structural twin of `lint-no-unbounded-llm-spawn.js`, and — per both external reviewers (codex + gemini, round 1) — **emit-anchored and fail-closed**, NOT shape-heuristic. The first draft keyed on "a repeating-driver shape AND a self-action verb," which both reviewers correctly flagged as trivially evaded (rename `tick()`→`run()`; hide the emit behind a helper) — making registration optional in practice. The spawn lint's strength is that it keys purely on the **construction/emit itself** (`new ProviderClass(` anywhere outside a closed allowlist); this lint adopts the same shape. #1347's grader classifies a `scripts/lint-*` file as a **`lint`** guard.

**The rule (fail-closed):** any `src/` file that contains a `SELF_ACTION_EMIT` verb in an emitting position (the shared detector, Part E1) must EITHER:

- **register** — carry the `/* @self-action-controller: <id> */` marker AND have `<id>` present in `SELF_ACTION_CONTROLLERS` (so the D3 ratchet covers it), OR
- **be allowlisted** — appear in the lint's closed `ALLOWLIST` with an `owner` + a one-line reason that it is a genuine one-shot / user-driven action, not a self-triggered loop.

Anything else — an unregistered, unallowlisted self-action emit in `src/` — fails CI. This is the structural forcing function: a developer cannot dodge it by renaming the driver method, because the trigger is the *emit verb*, not the method name. `ALLOWLIST` is a `new Set([...])` of file paths at the top of the lint file, directly mirroring `scripts/lint-no-unbounded-llm-spawn.js`'s allowlist; a marker's `<id>` cross-check is parsed from `src/testing/selfActionRegistry.ts`. Adding an allowlist entry requires a stated reason (same governance as the spawn lint's), so every escape is auditable and rare.

**Honest coverage limit (both reviewers, recorded).** A string-based lint deters *accidental* unbounded loops; it is not a hard boundary against *deliberate* obfuscation (`const v='swap'; self[v]()`, `Buffer.from(...).toString()`), exactly like every sibling lint (`lint-no-unbounded-llm-spawn.js`, the topic-flood funnel lint). The lint is the accident-deterrent; the *obfuscation-resistant* structural closure is the **funnel** (Part B — a typed chokepoint every self-action must route through, which a rename cannot evade, the way the spawn cap can't be dodged by renaming a call). Until B lands, this lint + the marker + the registry is the enforcement, with the obfuscation limit named as a known gap tracked to B, and deliberate bypass named as a conduct violation in the standard (Part C).

### D5. Tests for Part D

- The convergence test IS the ratchet (D3).
- Lint unit test (`tests/unit/lint-no-unregistered-self-action.test.ts`): unmarked emitter → violation; marked+registered → clean; marked-but-unregistered → violation; allowlisted → clean.
- Wiring-integrity (Testing Integrity): `SELF_ACTION_CONTROLLERS` non-empty; every entry's `makeUnderPressure` returns a live `tick` (no null/no-op controllers smuggled in to pass D3 vacuously).
- Verb-superset coherence (shared with Part E): every registry `actionVerb` is matched by the shared `SELF_ACTION_EMIT` set.

---

## Part E — The detector + scope extension (composes with #1347; does NOT fork it)

The class-closure gate already validates the declaration's SHAPE. What it cannot yet do is (a) SEE that a self-action was introduced in product code, and (b) route that diff into the declaration requirement. Part E supplies exactly that — one shared detector, two enforcement points, threaded through #1347's existing machinery.

### E1. One shared detector — `scripts/lib/self-action-detect.mjs`

A single dependency-free module (mirroring how #1347 shares `class-closure-grader.mjs` as a library used by both the lint and tests). It exports:

```js
// The self-action verb set, seeded from the synthesis taxonomy
// (restart|swap|respawn|spawn|notify|retry|re-drive|kill) and widened to the
// concrete instar symbols those verbs appear as.
export const SELF_ACTION_EMIT = /\b(refresh|respawn|restart|reap|requestKill|kill|swap|proactiveSwap|spawnSession|createForumTopic|createAttentionItem|sendToTopic|reDrive|redrive|rePin|repin|retry|nudge|escalate)\s*\(|\.\s*(refresh|respawn|swap|reap|kill|retry|escalate|nudge)\s*\(/;

// Is a file a self-action controller source file (for scope)?  A src/ file whose
// name matches the controller shape (*Monitor|*Sentinel|*Reaper|*Beacon|*Engine|
// *Scheduler|*Watchdog|*Poller|*Manager .ts) OR that carries the
// @self-action-controller marker.
export function isSelfActionControllerFile(file, contentMaybe) { … }

// Does the ADDED diff text introduce/modify a self-action emit?  (emitting
// position only — a bare noun in a comment/prose line does NOT match.)
export function addedDiffIntroducesSelfAction(addedDiffText) { … }
```

The verb set is the single source; a coherence test (E5) asserts it stays a **superset** of every `actionVerb` in `SELF_ACTION_CONTROLLERS`, so a new controller kind can never register a verb the detector is blind to.

### E2. Scope extension into #1347's CI lint

Extend `class-closure-lint.mjs`'s scope so a self-action diff is IN SCOPE for the class declaration — the concrete realization of #1347 Frontloaded Decision 1 ("expansion to critical-path product defects"). Two minimal, additive changes:

- **Widen the scope predicate.** Add `isSelfActionControllerFile(file)` (Part E1) as a new arm the lint treats as in-scope alongside `isAgentAuthoredArtifact`. A diff touching a self-action controller now requires a `classClosure` declaration.
- **A class-specific well-formedness arm.** When a declaration carries `defectClass: "unbounded-self-action"`:
  - `closure: guard` — the cited guard must grade `ratchet`/`gate`/`lint` (already enforced by #1347's grader; Part D's ratchet satisfies it), AND `guardEvidence.howCaught` must ADDRESS the convergence argument (control-loop edge + steady-state bound + settling brake), detected by a deterministic `CONVERGENCE_ADDRESSED` regex (`converge|steady[- ]?state|bound|dwell|hysteresis|all[- ]?hot|projected.*load|breaker`). A per-tick-cap-only justification does NOT address it.
  - `closure: gap` — the gap item tracks building/registering the guard for this controller; the open gap counts as escalation evidence (#1347's existing rule) and re-surfaces on the evolution-action cadence.

**Enforcement honesty (external-review correction, codex round 1).** Today `class-closure-lint.mjs` treats a *missing* declaration as a report-only finding — it exits nonzero ONLY on a hard structural violation (a malformed registry, or a novel class with no semantics), even when `enabled && !dryRun`. So an in-scope self-action diff with no declaration is currently *logged, not blocked*. This spec adds, as **new enforcement**, two hard-violation conditions to the lint's enforcing mode (`enabled && !dryRun`): (i) an in-scope self-action diff (per the widened scope predicate) with no `unbounded-self-action` declaration, and (ii) a `defectClass: unbounded-self-action` + `closure: guard` whose `howCaught` fails `CONVERGENCE_ADDRESSED` (a per-tick-cap-only justification). Both land **report-only first** under the existing `prGate.classClosure.dryRun` default — the population/accuracy of `unbounded-self-action` declarations is measured before the operator flips enforcing, on #1347's own flip criterion. No new config family; the enforcement rides `prGate.classClosure`.

### E3. Early detection at instar-dev commit time (the light-path close)

The CI lint fires at the PR boundary. The instar-dev pre-commit hook is where #1035 slipped through the LIGHT (Tier-1) path with no adversarial reviewer. Add a thin `assertSelfActionDeclared(addedDiffText, inScopeFiles, trace)` to `scripts/instar-dev-precommit.js`, modeled on `assertFrameworkGenerality`, called at **both** pass-through points (`enforceTier1` + the Tier-2 fall-through).

**The declaration host — the TRACE, not the not-yet-written decision-audit entry (external-review correction, codex CRITICAL round 1).** The decision-audit entry is CREATED by the hook itself (`writeDecisionAudit`), with no `classClosure` field — so the precommit cannot validate a `classClosure` block that does not exist yet, and `class-closure-declare.mjs` only mutates an *already-committed* entry. The buildable path: the author records the `classClosure` block in the **instar-dev trace** (which `/instar-dev` authors before the commit, the same place `specPath`/`tier`/`causalAutopsy` already live). Then:

1. `assertSelfActionDeclared` validates `trace.classClosure` (present + naming `defectClass: "unbounded-self-action"`, guard or gap) AND that the block is mirrored in the staged side-effects artifact (the display-only human mirror — the same two hosts #1347 uses).
2. `writeDecisionAudit` is extended to persist `trace.classClosure` into the decision-audit entry it writes — so the machine-readable counting host (which the CI lint reads) is populated by the same hook run, closing the chicken-and-egg. `class-closure-declare.mjs` gains a `--to-trace` mode so the author helper writes the block into the trace rather than a committed entry.

**Trigger (false-positive-safe — external-review correction, codex MAJOR round 1).** The hook's raw `inScope` set (`src/`, `scripts/`, `.husky/`, skills) is too broad for a bare verb match — a normal user-driven `retry()` in `src/` would fire. So the trigger is an AND: `addedDiffIntroducesSelfAction(addedDiffText)` is true **AND** at least one touched in-scope file is a `src/` file (the emit-anchored scope, matching the D4 lint). And the requirement carries the same escape the D4 lint gives: the author satisfies §E3 with EITHER a real `unbounded-self-action` declaration OR an explicit **negative declaration** in the trace (`{ defectClass: "unbounded-self-action", closure: "n/a", reason: "one-shot user-driven action, not a self-triggered loop" }`) — the trace-level analog of the lint's allowlist entry. A missing declaration AND missing negative → `blockCommit()` pointing at `scripts/class-closure-declare.mjs` and Part D's registry. So a genuine one-shot call costs one attested line, never an unescapable block.

**Fail-OPEN on tooling failure** (the safe asymmetry, mirroring the hook's own "git not available → skip"): empty `addedDiffText`, an unreadable artifact, or an absent trace does NOT fire — the gate never wedges a commit over an infrastructure hiccup; it fails-closed only on a genuine self-action with neither a declaration nor a negative. A false-negative here is backstopped by E2's CI lint; a false-positive that blocked all commits would sever the developer's ability to ship.

**Implementation note (codex MINOR round 1):** `addedDiffText` is computed inside the hook's Step 3.5 block scope; it must be hoisted to an outer-scope binding so it reaches both the `enforceTier1` and the Tier-2 pass-through call sites (both later in the file than Step 3.5).

This is a *thin router into #1347's existing declaration flow*, not a new review section — the author declares the class the same way every other class-closure fix does; the only new thing is that a self-action diff is now DETECTED and required to, at the earliest gate.

### E4. The template — one-line extension, not a new section

#1347 already added the **"Class-Closure Declaration"** section to `skills/instar-dev/templates/side-effects-artifact.md`. Extend its trigger note by one clause so it also names the self-action case:

> **REQUIRED whenever this change FIXES a defect in an agent-authored artifact — OR adds/modifies a self-triggered controller (the `unbounded-self-action` class):** …

No new `## 5b`. The convergence argument (control-loop edge + steady-state bound + settling brake) is authored INTO the existing declaration's `guardEvidence.howCaught` field — exactly where #1347 already asks "how this guard would have caught THIS defect."

### E5. Migration parity

- **The template** (a built-in-skill file, never overwritten by `installBuiltinSkills`) needs an idempotent `PostUpdateMigrator` migration `migrateClassClosureTemplateSelfActionClause` — content-sniff the existing "Class-Closure Declaration" trigger note and append the self-action clause only if absent. Scoped to the instar-dev default-skill allowlist.
- **The hook, the two CI lints, the detector library, and the registry** ride the repo itself (they are the instar source's own `.husky/pre-commit` + `.github/workflows` targets), reaching every checkout on `git pull`. #1347's config is `prGate.classClosure` (repo-gated) — no fleet migration owed for maintainer-only machinery.
- **`docs/defect-classes.json`** is repo-resident registry state; the new class replicates as git (the repo IS the replication medium), matching #1347's declared multi-machine posture.

### E6. Tests for Part E

- Unit (`tests/unit/self-action-detect.test.ts`): the shared detector — emitting-position true positives; comment/prose lines → no match; `isSelfActionControllerFile` on the shape set; `addedDiffText === ''` → false (fail-open).
- Unit (`tests/unit/instar-dev-precommit-self-action.test.ts`): `assertSelfActionDeclared` at both call sites — self-action diff + no `unbounded-self-action` declaration → blocks; + a valid declaration → passes; no self-action keyword → no-op; empty diff → fail-open.
- Integration: `class-closure-lint.mjs` over a synthetic self-action diff — in scope; a `defectClass: unbounded-self-action` + `closure: guard` citing Part D's ratchet → clean; a per-tick-cap-only `howCaught` → flagged; a `closure: gap` → logged gap.
- Coherence (shared with D5): `SELF_ACTION_EMIT` ⊇ every registry `actionVerb`.

---

## Part C — The proposed standard (the class's `closureStandard`)

Positioned as sibling to **Bounded Blast Radius** and **No Unbounded Loops**. This is the `closureStandard` the `unbounded-self-action` class points at (Part 0). Proposed in the exact registry voice; **enforcement ships first** (Parts 0 + D + E), constitution second, per *How a new standard joins* (agent proposes with its story; operator ratifies).

> ### Capacity Safety — No Unbounded Self-Action
> **Rule.** Any **self-triggered** action that bears cost or disruption — a restart, swap, respawn, spawn, notify, retry, re-drive, re-pin, or kill/reap request that a loop, monitor, sentinel, reaper, scheduler, or recovery path fires on its own — must be **proven to CONVERGE under sustained worst-case pressure** before it ships: the number of times it fires must settle to a small bound even when the triggering condition never clears on its own. Safety that reasons only about *correctness* (is each action well-formed / authorized?) and never about *convergence* (does the action count settle, or does it feed the pressure that re-triggers it?) is semantically flawless and dynamically unstable — a control loop that oscillates forever while every individual tick passes review. The temporal twin of *Bounded Blast Radius* (which bounds instantaneous MASS — how many run at once); this bounds steady-state FREQUENCY under feedback. A per-tick cap is not a convergence proof — it bounds one pass, never the loop.
> **In practice.** "Unbounded / oscillating self-action" is a registered defect class (`docs/defect-classes.json`), so the class-closure program (#1347) governs it at fix-time: a diff that adds or modifies a self-triggered controller is in scope for a `classClosure` declaration, which must cite the live guard that ends the class — the CI ratchet `tests/unit/self-action-convergence.test.ts`, which drives every controller in the `SELF_ACTION_CONTROLLERS` registry N ticks under a pinned sustained-pressure fixture and asserts total actions stay under a small constant K (and do NOT scale with the horizon). A forcing lint (`scripts/lint-no-unregistered-self-action.js`), emit-anchored and fail-closed, refuses any unregistered, unallowlisted self-action emit, so a NEW self-action inherits the invariant instead of earning a bespoke brake after its own incident; a shared detector routes a self-action diff into the declaration at both the instar-dev pre-commit gate and the class-closure CI lint. The declared Eternal-Sentinel exemption (*No Unbounded Loops*) carries over unchanged. This is *No Unbounded Loops* promoted from a review-audit duty to a graded, cited live guard — structure, not willpower. The string-based gates deter *accidental* unbounded loops (their honest scope, shared with every sibling lint); the obfuscation-resistant closure is the funnel every self-action routes through (the follow-on primitive), and **deliberately obfuscating an emit to evade these gates is a conduct violation, not a clever workaround** — an agent that games its own capacity guard has defeated the protection and hidden that it did so.
> **Earned from.** 2026-07-03 (topic 30837), the self-inflicted-loops investigation: the operator observed the swap-thrash "three-brakes" fix "looks too simple for a class we keep fighting" and asked how the bug got through review in the first place. Three independent agents + a master-registry verification converged on one root: 20 distinct self-inflicted loops 2026-04-16 → 2026-07-02 (swap-thrash, both topic-floods, the fork-bomb OOM, the test-storm, the reaper's 17,503 kill-requests/day, the inescapable "session paused" loop) were the SAME shape — an unbounded self-triggered action under sustained pressure — yet each earned its own bespoke breaker one incident at a time. The smoking gun: the SubscriptionPool proactive pre-limit swap (#1035, 2026-06-09) self-triggered ~72 account swaps/day via a quota-POSITIVE kill+respawn, and shipped the LIGHT dev-path with ZERO spec-converge rounds past a side-effects template whose §5 asks "Feedback loops: does this change input to a system that feeds back into it?" — a question no gate forced the review to answer. Per *Distrust Temporary Success*: 20 same-shaped incidents is not 20 bugs — it is one missing class. The class-closure system that answers "what class is this, and what guard ends it?" landed the same day (#1347); this standard names the class's convergence invariant and the guard closes it.
> **Traces to the goal.** A persistent, self-evolving agent is *made of* self-triggered loops — that is what autonomy IS. An agent whose own corrective actions can spiral against a degraded environment destroys the machine, the budget, and the trust it exists to earn, precisely when the environment is weakest. Coherence that holds only until two accounts are both hot is luck, not coherence. The agent that acts on itself must be the agent that proves its self-actions settle.
> **Applied through.** The `unbounded-self-action` class in `docs/defect-classes.json`; `src/testing/selfActionRegistry.ts` + `tests/unit/self-action-convergence.test.ts` + `scripts/lint-no-unregistered-self-action.js` (the guard, Part D); `scripts/lib/self-action-detect.mjs` + the scope arm in `scripts/class-closure-lint.mjs` + `assertSelfActionDeclared` in `scripts/instar-dev-precommit.js` (the detector, Part E). Generalizes the per-domain funnels — *Bounded Notification Surface* (topics), *Bounded Blast Radius* (spawns), the test-runner bound (vitest) — into one class-wide invariant, and makes the self-inflicted-loop class the first product-code member of the class-closure program. Full spec: `docs/specs/self-action-convergence.md`. *(Proposed by Echo from the 2026-07-03 self-inflicted-loops investigation; awaiting operator ratification. The unified default-on backpressure primitive and the swap decoupling are named follow-on increments with their own specs.)*

---

## Named follow-on increments (own specs — NOT designed here)

- **B — Unified self-action backpressure primitive** (`docs/specs/self-action-backpressure-primitive.md`, to author) <!-- tracked: CMT-1911 -->. Promote the three per-resource funnels (`AttentionTopicGuard` / the spawn-cap semaphore / the vitest ticket counter) into ONE registered default-on service every self-triggered emitter/spawner/swapper/restarter rides by default — so a new self-action is bounded at its funnel, not after it floods. `SELF_ACTION_CONTROLLERS` (Part D) is the seam it plugs into. Synthesis Part B.
- **A — Swap decoupling / live credential re-pointing** (`docs/specs/swap-decoupling-live-repointing.md`, to author) <!-- tracked: CMT-1911 -->. Make an account swap NOT require a tmux kill + transcript re-hydration — live `CLAUDE_CONFIG_DIR`/credential re-pointing under the running process (the `/credentials/*` WS5.2 machinery already exists), plus hysteresis + projected-post-swap-load gating on BOTH the proactive AND the reactive paths (the reactive path is currently untouched by every brake). Decouple swap from restart and the amplifying edge dies. Synthesis Part A — the durable fix the three brakes don't attempt.

---

## Testing Integrity (this spec's own tiers + the new stability invariant)

- **Tier 1 — Unit.** E6 (the shared detector; `assertSelfActionDeclared` at both call sites; migration idempotency) and D5 (the forcing-lint fixtures; the registry wiring-integrity; the verb-superset coherence).
- **Tier 2 — Integration.** `class-closure-lint.mjs` over a synthetic self-action diff (E6): in scope, a valid `unbounded-self-action` declaration passes, a per-tick-cap-only `howCaught` is flagged.
- **Tier 3 — the new stability invariant.** `tests/unit/self-action-convergence.test.ts` IS the missing *does-it-SETTLE* invariant, alongside the three existing *does-it-WORK* Testing-Integrity invariants. This is the standing ratchet and the class's `closure: guard` target.
- **Grader parity.** A test that #1347's grader classifies the three new guards correctly (`self-action-convergence.test.ts` → `ratchet`; `lint-no-unregistered-self-action.js` → `lint`; the precommit arm → `gate`) — so a `closure: guard` citation is graded truthfully.
- **Meta.** The gate's own bootstrap commit is exempt via the existing Step-3 mechanism (and #1347's `isGateSourceFile` self-wedge exemption covers the class-closure source edits).

## Migration parity

Covered in E5: `migrateClassClosureTemplateSelfActionClause` (idempotent, content-sniffed) for the one-line template extension; the hook / lints / detector / registry ride the repo; the class registry replicates as git.

## Rollback

Additive tooling + one registry entry. Back-out is a code revert of the detector + scope arm + precommit arm + the guard files + the migration, and deleting the `unbounded-self-action` class entry — no persistent runtime state, no user-visible surface, no data migration. Everything lands report-only under #1347's existing `prGate.classClosure` dark default, so nothing blocks a ship until the operator flips enforcing on measured population. The gate arms are fail-open on tooling error by construction.

## Convergence / open items

- **Internal multi-lens review: complete** (security / adversarial / scalability / integration / decision-completeness / lessons-aware). The #1347-integration reshape is the material change from the first draft.
- **External cross-model pass: RUN (round 1), all findings applied.**
  - **codex (`codex-cli 0.137.0`, GPT-tier)** — 1 CRITICAL + 3 MAJOR + 1 MINOR, all applied: (CRITICAL) the E3 precommit declaration write-path was unbuildable — the decision-audit entry is created by the hook with no `classClosure` field → fixed by hosting the block in the TRACE and persisting it via `writeDecisionAudit`; (MAJOR) E2 overclaimed #1347 enforcement (missing declarations are report-only, not hard violations) → fixed with the explicit new-enforcement arm; (MAJOR) the D4 lint's shape-heuristic was evadable → rewritten emit-anchored fail-closed; (MAJOR) the E3 trigger's broad `inScope` set false-positived → fixed with the `src/`-emit AND + negative-declaration escape; (MINOR) `addedDiffText` block-scope hoist noted. Codex marked CLEAN: the Part 0 class schema, the grader classification claims (ratchet/lint/gate), and the declaration-host composition.
  - **gemini (`gemini-2.5-pro`)** — 1 CRITICAL + 1 MAJOR + 1 MINOR, all applied: (CRITICAL) regex detection is obfuscation-evadable → reframed as an accident-deterrent + a conduct clause in the standard + the funnel (Part B) named as the obfuscation-resistant closure; (MAJOR) the D4 shape-AND-verb heuristic let a renamed driver escape → converged with codex on the emit-anchored fail-closed rewrite; (MINOR) the `ALLOWLIST` format/location was unspecified → pinned to `new Set([...])` at the lint head. Gemini marked CLEAN: composition, factual accuracy.
- **Round-2 confirmation: PASSED.** Codex re-reviewed the revised spec and marked all five round-1 findings RESOLVED with "no new critical/major correctness error introduced" — the convergence-recognition step. The spec is tagged `review-convergence`. (Gemini's round-1 findings were folded in the same revision — its MAJOR converged with codex's on the emit-anchored lint rewrite, and its CRITICAL obfuscation reframing is applied; a gemini round-2 confirmation was not separately run, noted for full transparency.)
- **Operator gate (Agent Proposes, Operator Approves): RESOLVED.** The operator (Justin) gave explicit go on 2026-07-04 (topic 30837): ratify the Part C standard into `docs/STANDARDS-REGISTRY.md` AND build the mechanical parts, at the seed severity the spec proposes (`severity: critical`, one class — not split into flood/spiral). `approved: true` is now set; the build lands Parts 0 + D + E report-only and adds the Part C standard text to the registry.
- **Two design judgments RESOLVED by the operator (2026-07-04, topic 30837):**
  1. **`severity: critical`, ONE class.** The operator ratified the seed the spec proposes: a single `unbounded-self-action` class at `severity: critical` (escalates at 1 post-seed instance per #1347), NOT split into flood/spiral. Rationale carried forward: the compounding subset (fork-bomb OOM, kernel panic, live-tail freeze) is SEV-class, and the right sensitivity for a class whose worst members take the host down is the critical arm.
  2. **Detector verb-set: ship as specified, calibrate under soak.** The `notify|escalate|retry` breadth is kept, gated by the emitting-position + `src/`-emit + negative-declaration mitigations. Soak posture: report-only under #1347's `dryRun`; a false-positive costs one attested line, never a blocked ship. Any recalibration rides the same report-only telemetry before the enforcing flip.
