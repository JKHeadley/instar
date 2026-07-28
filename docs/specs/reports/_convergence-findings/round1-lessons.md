# Round 1 — Lessons-Aware Review (+ Foundation Audit) — provider-fallback-default-policy

Reviewer lens: (a) contradicts a documented principle/lesson? (b) fails to engage an applicable
lesson? (c) behavioral-lesson violation in an agent-facing surface? (d) FOUNDATION AUDIT — does the
`IntelligenceRouter` engine the spec builds on itself violate a standard or repeat a known mistake?

Grounding: spec read in full; `src/core/IntelligenceRouter.ts`, `src/commands/server.ts:4675-4737`
(construction site), `src/core/componentCategories.ts`, `src/core/CartographerSweepEngine.ts:199-224`,
`src/core/MessagingToneGate.ts:269`, `docs/signal-vs-authority.md`,
`docs/specs/no-silent-degradation-to-brittle-fallback.md`,
`docs/specs/per-component-framework-routing.md`, and `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P1-P19,
L1-L17, B1-B39).

---

## Foundation Audit (mandatory — one layer below the spec)

- **[material] FOUNDATION / Signal-vs-Authority: the router's `failureSwap` blocking authority is CORRECT, not a violation — but the spec inherits it without stating WHY it is sound, and the new default makes that inheritance load-bearing for the FIRST time.** `IntelligenceRouter.evaluate()` re-throws when every swap target is down, so a `gating: true` caller fails CLOSED (`IntelligenceRouter.ts:215-217`). Per P2 (Signal vs Authority) this LOOKS like a brittle low-context component holding blocking authority — but `signal-vs-authority.md` ("When this principle does NOT apply → Safety guards on irreversible actions") and `no-silent-degradation-to-brittle-fallback.md` Standard 1 together resolve it: the router is NOT inventing a verdict; it is REFUSING to substitute a brittle heuristic for a down LLM authority. Fail-closed-on-all-providers-down is exactly the mandated behavior ("FAIL CLOSED … never the permissive verdict"). **Verdict: the engine's fail-closed re-throw is aligned with "No Silent Degradation to Brittle Fallback", not a violation.** The gap is that the spec asserts this in §6 in one line ("the engine already re-throws") without naming that, pre-this-spec, `failureSwap` was almost always EMPTY in production (no shipped default sets it) — so the fail-closed path was rarely exercised. This spec is what first makes a non-empty `failureSwap` the default for every gating call on every multi-provider agent. **Resolution:** add a sentence to §6 stating that the default policy is the first thing to populate `failureSwap` fleet-wide, so the fail-closed tail (all-providers-down → re-throw → gating caller blocks) becomes a HOT path that must be covered by the §7 unit test "all down → re-throws (fail-closed)" AND a test asserting the gating caller's own fail-closed behavior on the re-throw (e.g. MessagingToneGate holds, ExternalOperationGate → show-plan) — not just that the router re-threw.

- **[material] FOUNDATION / active-provider probe is a NEW source of truth that CAN drift from the router's own `resolveProvider` — the spec flags it (§4.2 Q1) but leans the RIGHT way without closing it.** The spec's §4.2 candidate (a) "reuse `buildProvider(fw) !== null`" is the correct call and matches L5 (State-Detection Robustness: "explicit deterministic-vs-LLM rationale + mandatory canary/drift detection"). Candidate (b) `which <cli>` would be a SECOND notion of "available" that drifts from what the router actually resolves at runtime — exactly the drift L5 exists to prevent. **Verdict: (a) is required, not optional — choosing (b) would be an L5 violation.** Critically: the router caches `buildProvider` results (`IntelligenceRouter.ts:88,143`) and the active-set is "computed once at boot" (§4.2/§4.4). If a provider CLI is installed or removed AFTER boot, the boot-frozen active-set and the router's live cache can diverge — the policy resolver would keep a now-dead framework as `primary`, or omit a now-installed one. The router degrades a dead primary gracefully (`evaluate()` line 167-182 degrades to default with an `onDegrade` report), so this fails SAFE, but the spec's §5 "self-heals when the operator later installs/removes a provider CLI" claim is only true if the active-set is recomputed, not frozen at boot. **Resolution:** make §4.2 commit to (a) explicitly (strike (b)), and reconcile the §4.4 "computed once at boot, memoized" with the §5 "self-heals on CLI install/remove" claim — they contradict unless there is a cache-invalidation/recompute trigger. Either drop the self-heal claim (honest: requires a restart) or specify the recompute hook. Add an L5 drift canary: assert the policy resolver's active-set agrees with `router.for(component).available` for each affected component (a wiring-integrity test, per P4).

- **[material] FOUNDATION / cross-feature interaction the spec does NOT engage: the new default silently FLIPS the Cartographer freshness sweep from "refuse to author" to "author on Codex by default."** `CartographerSweep` is category `job` (`componentCategories.ts` — confirmed). The spec's default config (§4.2) sets `categories: { sentinel, gate, job, reflector }` → first active off-Claude framework. `CartographerSweepEngine.probeRouting()` (`:206-215`) refuses to author when `router.for('CartographerSweep').framework === defaultFramework` ("off-Claude routing not configured; refusing to author"). Today, with `componentFrameworks` unset, that probe resolves to default (Claude) and the sweep stays inert unless explicitly configured off-Claude. **Under this spec's default, on any agent with codex/pi/gemini active, that probe will now resolve to a non-default framework and the sweep will author automatically** — a cost-bearing background LLM feature turned on as a SIDE EFFECT of the routing default, not by an operator. The blast radius is bounded (the sweep still rides its own dark gate `cartographer.freshnessSweep.enabled`), but the §10 Q4 framing ("Jobs can be heavy; running them on codex by default may surprise") understates this: it is not "may surprise," it is a concrete interaction with a separate feature's gate that the spec must call out. This is L6 dimension 6 ("Interactions — how does this interact with existing primitives/sentinels?"). **Resolution:** resolve Q4 by EXCLUDING `job` from the internal-default set (route only `sentinel`+`gate`+`reflector` by default), OR explicitly document that enabling this default also activates Cartographer-sweep authoring on active off-Claude agents and add a wiring test pinning `probeRouting()` behavior under the new default. Leaning exclude-`job`: jobs are heavier, more cost-variable, and the sweep interaction shows the default should not silently arm a separately-gated feature. (`StandardsCoverageEnrichment` is also category `job` and dark — same consideration.)

---

## Principle / Lesson Engagement (the spec layer)

- **[material] P3 Migration Parity — runtime-computed default is the right call, but §5 leaves the decision OPEN; P10 forbids shipping with an unresolved-by-design migration choice.** §5 leans "runtime-computed (no persisted block)" — which is correct and self-healing (no frozen active-set in `migrateConfig`, matching the `per-component-framework-routing.md` D6 "do NOT add to ConfigDefaults" trap). But it is stated as "Decision for convergence," and P3 is NON-NEGOTIABLE: the migration mechanism must ship in v0.1, not be deferred. Since the chosen path is "no config write, the migration IS the code shipping," the migration-parity story is genuinely "nothing to migrate" — but the spec must STATE that as the committed decision and verify `migrateConfig()` does NOT write a `componentFrameworks` block (a defensive test that an existing config stays unset post-migrate). **Resolution:** convert §5's "Decision for convergence" into a committed decision (runtime-computed, zero config write) and add the negative migration test (existing config without `componentFrameworks` stays without it after `migrateConfig`).

- **[material] P5 / B1 Agent-Awareness — the spec changes a USER-OBSERVABLE default (sentinels now answer on Codex) but the §8 CLAUDE.md update is under-specified for the proactive trigger.** §8 says to update the "Per-Component Framework Routing" section. Per P5 + B1, the agent must be able to answer "why are my sentinels on Codex?" / "why did my Claude quota stop being spent on background checks?" in plain English, AND the existing CLAUDE.md text ("with no config, everything stays on your default framework") is now FALSE for multi-provider agents and must be corrected, not just appended to. A stale awareness line is worse than a missing one (the agent will confidently tell the user the wrong thing). **Resolution:** §8 must explicitly call out correcting the existing "with no config, everything stays on your default framework" sentence to reflect the new active-filtered default, and add the proactive trigger verbatim. Note the override lever in plain English (no CLI recommendation to the user — B2).

- **[minor] P19 No Unbounded Loops — the spec inherits the router's swap loop; confirm the swap is bounded and a FAILED swap doesn't amplify.** The `failureSwap` loop (`IntelligenceRouter.ts:197-214`) iterates a fixed config list once per call (bounded by `failureSwap.length`, skips open circuits fast) — so per-call cost is bounded and a failed attempt is one extra `evaluate` per healthy target, not amplifying. This SATISFIES P19's three brakes (the per-framework breaker is the breaker; the fixed list is the cap; no backoff needed for a single linear pass). The spec should state this engagement rather than leave it implicit, since the default makes a non-empty swap list universal. **Resolution:** add a one-line P19 engagement note: the swap is a single bounded linear pass over a fixed active-set, each target circuit-gated, no per-call amplification.

- **[minor] L7 / B7 Bug-Fix Evidence Bar — this is framed as the fix for "tonight's delivery strangle," so §6's regression claim needs reproduction-grade evidence, not just a unit test.** §6 asserts that, once shipped, the tone-gate "would have swapped off a slow Claude onto codex instead of sitting the timeout." L7 ("never claim fixed until the original failure is reproduced and verified to stop") + B12 (real-API verification, not unit-only) require more than the §7 wiring test. The §6 claim is GROUNDED on the static fact that `MessagingToneGate.ts:269` is `gating: true` (confirmed), but the END-TO-END claim (a slow/failing Claude → the tone-gate actually swaps and delivery proceeds) is the load-bearing assertion and is only covered by a wiring-integrity test. **Resolution:** add to §7 an integration/e2e test that forces the primary (Claude) provider to fail/timeout for a `gating:true` tone-gate call under the computed default and asserts the call is served by the swap target (codex) and the message proceeds — the actual reproduction of tonight's incident's inverse. (B12: this is the difference between "the wire exists" and "the fix works.")

- **[cosmetic] L9 ELI16 — frontmatter references `provider-fallback-default-policy.eli16.md`; confirm it exists and is ≥800 chars before `approved: true`.** The `/instar-dev` pre-spec-converge gate checks ELI16 presence + length. Not verified in this review (out of the lessons-grep scope), flagged so it isn't missed at stamp time. **Resolution:** verify the ELI16 companion exists and leads with stakes (the delivery-strangle incident), not architecture.

---

## Verdict: Framework-Agnostic — and Framework-Optimizing (Standards-Conformance finding)

**Position: NOT a violation. The opinionated Codex-first/Claude-last default is JUSTIFIED as an
operator-directed, uniformly-applied, fully-overridable default — provided three conditions hold (two
already in the spec, one to add).**

The "Framework-Agnostic — and Framework-Optimizing" standard's concern is privileging one framework
structurally. This default does the opposite of privileging Codex as a *capability*: it is a
*load-shedding* policy that moves background chatter OFF the agent's primary conversational provider
(Claude) precisely to PROTECT the primary path — Claude stays the last resort for background work BY
DESIGN, not deprecated. The chain is:
1. **Operator-directed** — the chain is Justin's explicit 2026-06-15 directive (spec header), not the
   author's preference. That is the legitimizing authority.
2. **Uniformly applied** — every internal gating component routes the same active-filtered chain; no
   single framework gets a privileged carve-out in the resolver.
3. **Fully overridable** — §4.3: an explicit `componentFrameworks` wins verbatim; §9 rollback
   (`componentFrameworks: {}`) restores the agent default. Total operator authority is preserved.
4. **No-op on the affected class** — §4.2: a Claude-only agent is byte-identical to today; the default
   only acts where an off-Claude provider is installed.

The one condition to ADD: the hardcoded order `['codex-cli','pi-cli','gemini-cli','claude-code']` is a
preference baked in code with NO operator-tunable order short of a full `componentFrameworks` override.
The `no-silent-degradation-to-brittle-fallback.md` Standard 1 follow-up (Justin, 2026-06-07) already
flagged the sibling concern — "swap orders by *framework*, does NOT yet prefer a different MODEL FAMILY
first." For the DEFAULT POLICY this is acceptable (an opinionated default is the whole point and the
operator can override the entire thing), but the order MUST be a single named, documented constant
(`INTERNAL_FRAMEWORK_PREFERENCE`, already in §4.1) with a comment stating it encodes the operator
directive and is the documented override point — so it is auditable as a deliberate policy, not an
accidental privilege. **With that, the default is framework-OPTIMIZING (it protects the primary path),
not framework-privileging. Standards-conformance finding: resolved in the spec's favor.**

---

## Foundation-audit verdict

The `IntelligenceRouter` engine is **sound** and the spec builds on it correctly. The fail-closed
re-throw aligns with "No Silent Degradation to Brittle Fallback" (NOT a Signal-vs-Authority violation —
it refuses a brittle heuristic, the mandated behavior). The two real foundation concerns are
INHERITED-AND-AMPLIFIED, not engine bugs: (1) the spec makes the fail-closed tail a hot path for the
first time and must test the GATING CALLER's fail-closed behavior on re-throw, not just the router's;
(2) the active-provider probe must be candidate (a) `buildProvider !== null` (per L5) and the §4.4
boot-frozen active-set contradicts the §5 self-heal claim — reconcile or drop. The unflagged
cross-feature interaction (Cartographer sweep `job` category flips to author-on-Codex) is the single
most important material finding to resolve before approval.

## Overall verdict: NEEDS-CHANGES

Sound foundation, sound core idea, operator-directed default is justified. Four material items block a
clean approval: (1) Cartographer-sweep `job`-category interaction (resolve Q4 — lean exclude `job`);
(2) active-set boot-freeze vs. self-heal contradiction (§4.2 commit to (a); reconcile §4.4/§5);
(3) gating-caller fail-closed test on the now-hot re-throw path; (4) commit the runtime-computed
migration decision (P3/P10) + correct the stale CLAUDE.md awareness line (P5/B1).
