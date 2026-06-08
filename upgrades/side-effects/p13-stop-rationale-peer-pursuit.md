# Side-Effects Review — P13 guard blocks "blocked-on-peer" + "resource-burn" stop rationales

**Version / slug:** `p13-stop-rationale-peer-pursuit`
**Date:** `2026-06-08`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Extends `CompletionEvaluator.evaluateStopRationale` — the P13 "Stop Reason Is the Work" guard already wired into the autonomous stop path at `/autonomous/evaluate-stop` — so the independent judge also BLOCKS two additional stop rationales: (a) "I'm blocked / waiting on another agent (or the operator)" and (b) "an idle/polling/waiting loop burns the box / wastes resources." Both are added to `buildStopRationalePrompt`'s BLOCK list with steering toward active pursuit + periodic re-check; the ALLOW list's operator-only exception is tightened to "already actively pursued AND no other work to advance." Also fixes a latent parse bug in `parseStopRationale`: a bare `STOP_BLOCKED` verdict (no reason line) echoed the verdict token as guidance instead of falling through to the rich default. Files: `src/core/CompletionEvaluator.ts`, `tests/unit/CompletionEvaluator.test.ts`, `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P13 section).

## Decision-point inventory

- `CompletionEvaluator.evaluateStopRationale` (P13 stop guard, `/autonomous/evaluate-stop`) — **modify** — adds two BLOCK rationales + tightens the operator-only ALLOW; the verdict mechanism (STOP_OK/STOP_BLOCKED, fail-open) is unchanged.
- `CompletionEvaluator.parseStopRationale` — **modify (bugfix)** — reason now reads the second line only, so a bare verdict reaches the default guidance.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The guard governs whether an autonomous *stop attempt* is allowed; "over-block" here = blocking a legitimate stop. Risk: a genuinely operator-only residual (a credential/approval only the user can give) where the agent truly has no other work could now be nudged to "keep pursuing." Mitigated three ways: (1) the ALLOW list still explicitly permits an operator-only residual the agent has already pursued with no other work; (2) duration/emergency stops remain allowed; (3) the guard is SECONDARY and fails OPEN — the primary completion authority still governs, and any ambiguity returns `stopAllowed:true`. Net: it can only *delay* a genuine operator-only stop by re-injecting "did you pursue it + is there other work?" guidance, never trap it.

## 2. Under-block

**What failure modes does this still miss?**

It relies on an LLM judge reading the transcript, so a stop whose blocked-on-peer/resource-burn reasoning is implicit (never stated) can still pass as `STOP_OK`. It does not detect a *silent* stop that emits no rationale text (that surface is the completion evaluator + the stop-hook re-injection, not this guard). It cannot force the agent to actually pursue — it only refuses the stop and re-injects guidance; pursuit is the agent's next-turn behavior.

## 3. Level-of-abstraction fit

This is an **authority** (a context-rich LLM judgment), correctly so — it extends the existing P13 authority rather than adding a parallel brittle detector. It feeds the existing `/autonomous/evaluate-stop` surface (no new route, no new component). It re-uses the established STOP_OK/STOP_BLOCKED contract and fail-open posture. No lower-level primitive is re-implemented.

## 4. Signal vs authority compliance

**Does this change hold blocking authority with brittle logic?** No. The blocking authority is the LLM judge (full transcript context), not a keyword filter — consistent with `docs/signal-vs-authority.md`. The only string logic is the verdict parse (STOP_OK/STOP_BLOCKED), unchanged in posture, and it fails OPEN. The new content is *prompt guidance* the judge reasons over, not a regex that blocks.

## 5. Interactions

- **Shadowing:** runs as the SECONDARY guard after the PRIMARY completion evaluator; it does not shadow it — completion authority governs first. No change to ordering.
- **Double-fire:** none — single call site (`routes.ts` `/autonomous/evaluate-stop`); no new caller.
- **Races:** none — pure function over an injected transcript string; no shared mutable state.
- **Feedback loops:** when it blocks, it re-injects guidance as the next-turn prompt — intended P13 behavior; bounded by the loop's existing duration/emergency stops.

## 6. External surfaces

No new routes, config, or user-visible output. Behavior change is internal to autonomous-loop stopping. The deployed behavior reaches existing agents on package update (CompletionEvaluator ships in `dist` — no migration needed; it is code, not an installed agent file). The P13 standard doc is updated for the `/spec-converge` reviewer.

## 7. Rollback cost

- **Hot-fix release:** revert the code change; ship as next patch. Fully reversible.
- **Data migration:** none — no persistent state.
- **Agent state repair:** none — no agent files touched; behavior updates with the package.
- **User visibility:** none — internal autonomous-loop behavior; worst case is the guard allows a stop it previously blocked (or vice-versa), both within the existing fail-open envelope.

## Conclusion

Tier-1, safety-improving extension of an existing ratified standard (P13) via its existing guard. Adds BLOCK cases only (more conservative — the safe direction), fails open, no new surface, no migration. Tests 15/15 green, `tsc` clean.

## Second-pass review (if required)

Not required (Tier 1).

## Evidence pointers

- `tests/unit/CompletionEvaluator.test.ts` — 15/15 pass (2 new cases: judge prompt names the new BLOCK rationales; default guidance steers to pursuit).
- `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` — P13 "Extension (2026-06-08)" + "Extended from" note.
- Earned from topic 12476, 2026-06-08 (operator correction: a peer dependency is not a blocker; waiting is not a resource burn).
