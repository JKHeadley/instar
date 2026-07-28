# Convergence Report — Robust Session Time Awareness

## ELI10 Overview

An AI agent can't feel time passing — it only knows what the moment it's told, each turn. Right now the system tells it the time on your messages, but during long autonomous work (where the agent keeps going on its own) it often gets no clock at all, and even when it does, it's just "it's 5:42" — never "you're 4 hours in, 8 to go." So the agent loses the thread of how long it's been working and can make bad calls — like the real incident that triggered this: in a 12-hour run it announced it was basically done after only ~4 hours.

This spec gives the agent a real, always-on clock. It computes "elapsed / remaining / % done" from a durable record of when the work started, injects that on every kind of turn (your messages AND the agent's own autonomous continuations), and adds a `GET /session/clock` endpoint so the agent (or you, from the dashboard) can just ask "how long left?". It's purely informational — it never blocks or changes what the agent does, it just makes sure the agent always knows what time it is and how far along it is.

## Original vs Converged

The review process changed several load-bearing things:

- **Originally** the spec claimed autonomous turns were completely time-blind. **After review** that was corrected: the autonomous stop-hook *already* injects "N minutes remaining" — the real hole is that this morning's run used `/loop` mode, which creates **no durable record at all**, so nothing could track time. The fix shifted from "inject time into `/loop`" (impossible — `/loop` is a Claude Code harness skill instar can't touch) to "any timed run must create the durable autonomous-state record, and tracking reads that."
- **Originally** the design echoed a `label` into every turn and over HTTP. **After review** security caught that (a) there is no `label` field in the record — only the free-text `goal` — and (b) injecting raw `goal` every turn is a prompt-injection vector. So `label` is now explicitly *derived* from `goal` by stripping control characters and capping at 80 characters, and that bounded label is the *only* task text ever injected or served; the full goal is never echoed.
- **Originally** the per-turn routine would re-resolve "which session" itself. **After review** adversarial caught that the stop-hook already resolved the session and computed the numbers, so re-resolving could produce a *different* clock than the one driving the expiry decision — "two truths." The stop-hook path is now **render-only** (it passes its own numbers in); only the message-turn path resolves independently (via the new endpoint).
- Clock-skew clamping (no negative times), multi-session topic binding, leak-bounding on the endpoint, the reporting-nudge being strictly signal-only (to stderr, never echoing the agent's own "done" phrase), and concrete migration hooks for every changed file were all added.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~12 (deduped) | Coherent rewrite: corrected the autonomous-coverage premise; dropped `/loop`/`loop-clock.json` (harness-owned) for the autonomous-state record; `started_at`+`duration_seconds` canonical (not `end_at`); label sanitization; multi-session binding; clock-skew clamp; signal-only Component 4; concrete migrations; leak-bounded route; `lessons-engaged` + `supervision: tier0`; ELI16 companion. |
| 2 | security, adversarial (integration + lessons-aware: converged) | 2 (label provenance; double-resolution) + 3 low notes | Defined `label` as derived-from-`goal`; split Component 2 into render mode (stop-hook, no re-resolve) vs query mode (`/session/clock`); corrected the date-fallback description (single portable `date` for formatting; parsing only in `SessionClock.compute`); Component 4 signal-sink to stderr-only. |
| 3 | security, adversarial (confirmation) | 0 | none — both confirmed their round-2 findings resolved |

## Full Findings Catalog

### Round 1 (material, deduped)
- **[high] Autonomous "time-blind" premise overstated** (adversarial) — stop-hook already injects `${REMAINING_MIN}m remaining`. → Reframed: real gap is `/loop` (no record) + minutes-only content.
- **[high] `/loop` + `loop-clock.json` infeasible** (scalability, adversarial) — `/loop` is a harness skill; the named writer didn't exist. → Dropped; use the agent-created autonomous-state record (Component 0).
- **[high] `end_at` not canonical** (integration) — the stop-hook reads `started_at` + `duration_seconds`. → `end_at` is derived.
- **[high] Multi-session "which clock?" ambiguity** (adversarial) — per-topic records. → Topic-bound resolution.
- **[high] Component 4 blocking-adjacent authority on a regex host** (lessons-aware, security) — violates Signal vs Authority. → Scoped to signal-only, v1.1.
- **[medium] Unsanitized `label`/`goal` injected verbatim** (security) — per-turn injection vector. → Sanitize + cap; never inject raw goal.
- **[medium] Migration mechanics underspecified** (integration) — no generic ship-scripts mechanism. → Concrete `migrateSessionClockScript()` + content-sniff stop-hook migration.
- **[medium/low] Clock-skew/negative values; BSD/GNU date; route leak; fail-open silence; loop-clock schema** (security, scalability) → clamping, operator signal, leak-bounded route.
- **[high] No `lessons-engaged`/ELI16** (lessons-aware) → added frontmatter + ELI16 companion.

### Round 2 (material)
- **[medium] `label` provenance undefined** (security) — record has no `label` field; implementer would wire `label := goal`, re-opening the vector. → Component 0 now defines `label := strip+truncate-80(goal)`, the only task-text ever injected/served.
- **[medium] Double-resolution divergence** (adversarial) — routine re-resolving could bind a different record than the hook's expiry math. → Component 2 render mode (stop-hook passes its own computed values) vs query mode (UserPromptSubmit → `/session/clock`).
- **[low] Date-fallback mis-description** (adversarial) — formatting `now` needs one portable `date`; parsing belongs in `SessionClock.compute`. → Corrected.
- **[low] Component 4 signal recursion** (adversarial) — a "done" signal echoed into context is self-confirming. → Sink to stderr-only, carry the remaining-time fact, never the agent's phrase.

## Convergence verdict

**Converged at iteration 3.** Both reviewers who raised round-2 material findings — security (`label` provenance) and adversarial (double-resolution "two truths") — independently confirmed resolution with **zero new material findings**, each verified against the actual code (the canonical record schema in `setup-autonomous.sh` ~145-161; the existing `goal_snippet()` `tr | cut -c1-80` precedent; the stop-hook's own resolution + `started_at` parse at `autonomous-stop-hook.sh` 203/369-381/567-569; `routes.ts:4478` Bearer-gating; the `CURRENT TIME` template source in `PostUpdateMigrator` ~6092-6123). Integration and lessons-aware had already converged at round 2 (0 new material). No material finding remains. **The spec is ready for user review and approval.**

A non-blocking observation (not a finding): the deployed worktree copy of `telegram-topic-context.sh` lacks the `CURRENT TIME` block, but the canonical source template emits it before the `[telegram:N]` early-exit and migration always-overwrites the built-in hook — so the spec's "verified premise" is correct against the right reference.

## Cross-model review note

The external cross-model pass (GPT/Gemini/Grok/codex) was run in ABBREVIATED form this round: codex is installed + authed on this host but its binary is not reachable from the running shell environment, so the external-model leg was deferred. Per the spec-converge skill's abbreviated-convergence allowance, the mandatory lessons-aware pass WAS included (and converged). A full codex cross-model pass can be run through the live Codey agent on request before implementation.
