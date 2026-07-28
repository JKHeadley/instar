# Round 2 — Lessons-Aware + Foundation-Audit Convergence Check

Reviewer angle: lessons-aware + foundation-audit. Scope: verify round-1 lesson/foundation
resolutions are SOUND against the named constitutional standards. Grounded in
`docs/STANDARDS-REGISTRY.md`, `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`, and the
shipped engine `src/core/IntelligenceRouter.ts`.

**Verdict: CONVERGED.** Zero NEW material findings. The four checks below pass.

---

## (1) §6.5 Framework-Agnostic resolution — AIRTIGHT ✅

Standard text (`STANDARDS-REGISTRY.md:205-212`, *"Framework-Agnostic — and Framework-Optimizing"*):
> "generality is the floor, not the ceiling … Instar also opportunistically exploits a
> framework's unique strengths when present" … "No engine is privileged, none is
> second-class."

The standard explicitly NAMES framework-optimizing as a sanctioned posture ("the ceiling —
optimize where a framework is strong"). The privileging line the conformance gate must not
cross is making an engine *second-class* or a code path that *can't fall back*. §6.5 clears
every clause of that line:

- **Operator-DIRECTED, not core-imposed.** The order is Justin's explicit directive
  (spec §1 origin directive; mirrors how the standard's own "Anthropic Path Constraints"
  were "formally locked by Justin"). The constitution treats an operator-locked default as
  legitimate, not a privilege smuggled in by the core.
- **No engine is made second-class.** The no-op guarantee (§4.2: `active === ['claude-code']`
  ⇒ byte-identical to today) means Claude is never *removed* — it stays the `failureSwap`
  tail (the true last resort), so every gating call can still reach it. This is precisely the
  standard's floor: *"Every code path must be able to fall back to the subscription-backed
  interactive session."* Claude-as-tail preserves the floor. **Verified in engine:**
  `IntelligenceRouter.ts:215-217` re-throws to the caller (fail-closed) only after the whole
  active chain — Claude tail included — is exhausted.
- **Single uniform mechanism, no framework-specific code path.** §6.5(c) + §4.2: selection is
  `INTERNAL_FRAMEWORK_PREFERENCE.filter(isActive)`; the router resolves every framework through
  the same `resolveProvider`/`buildProvider`. There is no `if (codex)` branch — exactly the
  standard's "*capability flags + a routing policy … without naming a provider*" shape inverted
  into a preference order. The order is data, not control flow.
- **One named, documented, inspectable constant.** Round-1 M10's *pending* condition was "the
  order being a single NAMED documented constant." §4.1 satisfies it literally:
  `INTERNAL_FRAMEWORK_PREFERENCE = ['codex-cli','pi-cli','gemini-cli','claude-code']`. Changeable
  in one place; a unit test pins the constant against the framework enum (§4.2 last bullet).

**Conclusion: airtight.** The resolution is not a hand-wave fit (the failure mode the
Constitutional-Traceability gate punishes at `STANDARDS-REGISTRY.md:306-307`). It maps clause-
by-clause onto the standard's OWN sanctioned "optimize where a framework is strong" posture,
preserves the fall-back floor by construction (Claude-tail + no-op), and routes through one
uniform mechanism. A chosen, documented, overridable, fall-back-preserving default is framework-
OPTIMIZING, which the standard expressly permits.

---

## (2) §6.4 garbage-output scope-OUT — LEGITIMATE pre-existing-property scope-out, NOT an improper deferral ✅

**Position: §6.4 is a legitimate scope-out, not a "No Deferrals" violation.**

Standard text (`STANDARDS-REGISTRY.md:364-368`, *"No Deferrals"*):
> "Ship complete features and fixes. A deferral requires a same-PR tracked commitment with
> active follow-through — never an orphaned 'later' note." … "*Tactical now + the rest later*
> without owned follow-through is how regressions recur."

The "No Deferrals" standard governs deferring **in-scope work of the feature being shipped**.
Its test is: *does the shipped feature leave its own job half-done, deferring a piece of ITS
work without follow-through?* §6.4 is not that. Two grounded reasons:

- **It is a PRE-EXISTING engine property, not work this spec creates and then defers.** The
  garbage-but-not-erroring gap lives in `IntelligenceRouter.evaluate()` today: the swap loop
  (`IntelligenceRouter.ts:193-217`) traps `throw`n errors and circuit-open trips, but a
  provider that *returns* a malformed-but-non-erroring answer is not catchable by a try/catch
  by construction. This spec adds (a) a default policy, (b) active-provider primary selection,
  and (c) a per-attempt timeout — NONE of which is output validation. Output validation was
  never in this feature's scope; fixing it here would be scope-CREEP, not closing a deferral.
- **The risk is not MATERIALLY broadened in a way that converts it into in-scope work.** §6.4
  is honest that the spec "broadens exposure (more calls go to non-Claude providers)" — but the
  *property* (no output sanity check on any provider, Claude included) is identical before and
  after. Pre-spec, a garbage-returning Claude already poisons a gating decision with no trap.
  Post-spec, a garbage-returning Codex does the same. The spec changes WHICH provider can serve
  the weak answer, not WHETHER weak answers are trapped. Output validation is correctly assigned
  as **the calling gate's responsibility** (§6.4) — which is exactly where the *Signal vs.
  Authority* standard (`STANDARDS-REGISTRY.md:445-448`) puts the final call: the router is the
  body/signal substrate; the gate is the full-context mind that decides. A router-level "is this
  answer good?" check would be the router usurping authority that belongs to the gate.

**Why it is NOT an improper deferral:** an improper deferral under the standard is "tactical now,
the rest later, no owned follow-through" *for work this PR was supposed to do*. §6.4 (i) names a
pre-existing property, (ii) does NOT silently inherit it (it is "Documented, not silently
inherited"), and (iii) flags "a future *swap-target output sanity* follow-up." The one
improvement worth making explicit (already a request, not a blocker): the follow-up should be a
**tracked commitment** (per the standard's "same-PR tracked commitment with active follow-
through"), not just a prose "flagged for a future follow-up." This is a wording nicety — it does
NOT change the scope-out's legitimacy, because the deferred item is out-of-scope engine work, not
this feature's own work. **No NEW material finding.**

---

## (3) §6.2 herd + §4.3 honest-self-heal vs *No Silent Degradation* + *Signal vs. Authority* — ALIGNED ✅

### §6.2 herd vs *No Silent Degradation to Brittle Fallback* (`STANDARDS-REGISTRY.md:118-122`)

Standard text:
> "a provider failure … must never silently drop to a brittle heuristic. The call must SWAP
> PROVIDER … or FAIL CLOSED … and the degradation must be REPORTED — never swallowed."
> **In practice:** "Route every gating LLM call through the one shared provider that
> swaps-then-fails-closed (`IntelligenceRouter.failureSwap` for `gating: true` calls)."

§6.2 is in exact alignment, and is in fact a textbook application of this standard:
- **Swap-then-fail-closed is preserved.** Verified in engine: gating calls swap down the active
  chain (`IntelligenceRouter.ts:197-214`) and re-throw — fail closed — only when all are down
  (`:215-217`). §6.1 + §6.2 restate this faithfully.
- **The herd is BOUNDED, exactly as round-1 M2 demanded.** §6.2's three bounds — swap is
  gating-only (so the falling population is small; engine `:190-191`, non-gating re-throws at
  `:196`), per-framework breaker damps repeated slow attempts, and Claude-as-last-resort-for-a-
  *gating*-call is *correct* (a safety gate must not drop to a dumb heuristic). This honors the
  standard's core teaching that *"silent degradation to a weak check is worse than no check."*
  Falling to Claude (a real LLM) is NOT degradation to a brittle heuristic — it is the
  standard's sanctioned SWAP-PROVIDER branch reaching its last healthy provider.
- **Reported, never swallowed.** §6.6 + engine `onDegrade` callbacks (`:174-180`, `:203-209`)
  route every swap/degrade to `DegradationReporter` + `/metrics/features`. Satisfies the
  "must be REPORTED" clause.

### §4.3 honest-self-heal vs *Signal vs. Authority* + *No Silent Degradation*

Round-1's foundation audit corrected an OVER-PROMISE (M4): the earlier blanket "self-heals on
CLI install/remove" claim was false for the install direction. §4.3 now states the precise truth
— PRIMARY selection is boot-computed (restart to adopt a newly-installed higher-preference CLI;
*documented, not silent*), the failureSwap TAIL self-heals live (`resolveProvider(target)` null →
continue, verified `IntelligenceRouter.ts:200`). This is *No Silent Degradation* applied to the
spec's OWN claims: a precise, honest semantic instead of a comforting over-claim. It is also the
posture *Near-Silent Notifications*/*Documentation IS Being* would demand — the doc tells the
truth about what the body actually does. **Aligned; the round-1 honesty correction is sound.**

---

## (4) NEW lessons/principles the rewrite contradicts — NONE ✅

Checked the rewrite against the standards most at risk for a routing-default change:

- **Maturation Path — Every Feature Ships Enabled** (`STANDARDS-REGISTRY.md:370-375`): §9 ships
  **enabled by default** with a no-op guarantee on Claude-only agents and a `{}` rollback lever.
  This is the OPPOSITE of the "ships dark, rots forever" anti-pattern the standard punishes —
  fully compliant. (A routing *default* that ships dark would defeat its own purpose; §9 names
  this.)
- **Migration Parity** (`STANDARDS-REGISTRY.md` Standards / CLAUDE.md): §5 covers it correctly —
  runtime-computed (no frozen block that would pin a stale active-set), `migrateClaudeMd()` for
  the agent-awareness change with a content-sniff guard, machine-local-by-design active-set.
- **Token-Audit Completeness** (`STANDARDS-REGISTRY.md:383-389`): §4.1's EXCLUSION of the `job`
  category is the load-bearing guard here — it prevents this policy from silently auto-arming
  the cost-bearing CartographerSweep (a `job`) off-Claude as a side-effect. This actively
  HONORS the standard's spirit (a cost-bearing background feature must be operator-armed, never
  auto-armed by an unrelated default). Reinforced by §4.4's boot-snapshot operator-set detection
  (M5) so an in-memory auto-vivify can't defeat the override path.
- **Observable Intelligence / Observability** (`STANDARDS-REGISTRY.md:272`): §6.6 routes swaps
  to `/metrics/features`; the operator can SEE sentinels now run on Codex. Compliant.
- **Testing Integrity** (NON-NEGOTIABLE): §7 covers all three tiers + wiring-integrity (caller
  fail-closed, M11) + regression guards for M1/M3/M5/M7. Compliant.

No contradiction found with any standard or recorded lesson.

---

## Summary

- **NEW material findings: 0.**
- §6.5 Framework-Agnostic resolution: **airtight** — maps clause-by-clause onto the standard's
  own sanctioned "optimize where a framework is strong" posture; preserves the fall-back floor
  (Claude-tail + no-op); single uniform mechanism; one named documented constant (M10 *pending*
  condition satisfied).
- §6.4 garbage-output: **legitimate pre-existing-property scope-out, NOT an improper deferral** —
  it is out-of-scope engine work (output validation belongs to the calling gate per *Signal vs.
  Authority*), the spec does not materially change the *property* (only which provider serves a
  weak answer), and it is documented-not-silently-inherited. *Nicety (not a blocker):* make the
  "future follow-up" a tracked commitment to fully satisfy "No Deferrals" hygiene.
- §6.2 herd + §4.3 self-heal: **aligned** with *No Silent Degradation* (swap-then-fail-closed,
  bounded herd, reported) and *Signal vs. Authority* (router = signal substrate; calling gate =
  authority); §4.3 is the round-1 honesty correction landed correctly.

**Verdict: CONVERGED.**
