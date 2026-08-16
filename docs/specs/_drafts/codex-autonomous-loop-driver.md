# DRAFT — Codex Autonomous-Loop Driver (multi-turn task sustainment)

> Status: **build-ready design brief** (not yet a converged spec). Initiative #28.
> Author: Echo. Date: 2026-05-30. Awaiting Justin's prioritization before the spec→converge→approve cycle.
> Tenet: "FULL parity between Claude Code and Codex is a fundamental tenet" (Justin, directive #1).

## Problem

A `codex exec` (or interactive codex) session runs **one turn and exits**. There is no
mechanism that, at end-of-turn, checks "is the autonomous task list still incomplete?" and
re-prompts the session to keep going. So codex agents **cannot sustain multi-turn autonomous
work** — the headline symptom behind "Codey can't carry a long task" (the ship-gate stalls,
the dogfooding loop dies after one turn). This is the deepest codex-parity gap.

For Claude this is solved by the `/autonomous` skill's **Stop hook**
(`.instar/hooks/instar/autonomous-stop-hook.sh`): it reads `.instar/autonomous-state.local.md`,
and while tasks remain it returns exit-code-2 `{decision:"block", reason:<task feedback>}` —
which Claude Code honors by **continuing the session with `reason` as the next prompt**. That
is the entire loop driver.

## What already exists (every prerequisite is present — verified 2026-05-30)

1. **Codex fires Stop hooks.** `~/.codex/config.toml` `[hooks.state]` records real executions
   of `…/.codex/hooks.json:stop:0:0` and `:stop:0:1` — empirical proof, not a claim.
2. **Codex honors `{decision:"block", reason}` on Stop** as a grounding-pause/continue (NOT a
   hard termination) — **verified in the codex 0.133 binary's `StopCommandOutputWire`**
   (documented in `src/core/installCodexHooks.ts:98`). This is the exact re-prompt contract the
   Claude loop relies on. The Claude-compatible exit-code-2/JSON shape is intentional.
3. **instar already registers codex Stop hooks** at `<projectDir>/.codex/hooks.json`
   (`src/core/installCodexHooks.ts` → `installCodexHooks()`; current Stop chain:
   `stop-gate-router.js`, `response-review.js`, `claim-intercept-response.js`,
   `scope-coherence-checkpoint.js` — the framework-neutral grounding trio + the unjustified-stop
   router). They read stdin and POST to the local server; they already run on codex turn-end.
4. **Codex exposes a `session_id` to its hooks** (`stop-gate-router.js` reads `session_id` /
   `SESSION_ID`), so the same per-session isolation the Claude hook uses is portable.
5. **The StopGateInterceptor + inputInjection primitives exist** for codex
   (`src/providers/adapters/openai-codex/control/`). Note the in-process `hookEventReceiver` is
   an EventEmitter that only flows `stop` events if something calls `dispatchHookEvent` — which
   **nothing in `src/` currently does** — so the interceptor path is not the mechanism in play
   for real sessions. The real mechanism is the **external `.codex/hooks.json` Stop hook**
   (#1–#3 above), exactly mirroring how Claude's loop works via `.claude/settings.json`.

## The gap (precise, single-sentence)

The `/autonomous` skill's hook-registration step (SKILL.md Step 2a) **patches only
`.claude/settings.json`** to add `autonomous-stop-hook.sh`. There is **no codex equivalent**
that adds an autonomous-driver hook to `<projectDir>/.codex/hooks.json`. So a codex agent
entering autonomous mode gets the standing Stop trio but **never the task-feedback loop driver**
— and the session dies after one turn. The mechanism is fully present; only the autonomous-mode
*wiring* is claude-only.

## Proposed design

1. **`autonomous-stop-hook.sh` is framework-neutral or gains a codex sibling.** It already reads
   `.instar/autonomous-state.local.md` and emits the block/approve decision. Audit it for any
   `$CLAUDE_CODE_SESSION_ID`-only assumptions; resolve the session id from the codex-provided
   `session_id` when running under codex (env-first, claude var as fallback). The decision JSON
   shape is already Claude-compatible → codex honors it unchanged (prerequisite #2).
2. **`/autonomous` skill: framework-aware registration (Step 2a).** Detect the agent framework
   (config) and register the loop hook into the correct file:
   - claude → `.claude/settings.json` Stop array (today's behavior, unchanged)
   - codex → `<projectDir>/.codex/hooks.json` Stop array (append the autonomous driver to the
     existing chain; remove on completion, mirroring Step 2c). Reuse `installCodexHooks.ts`'s
     merge/write helper (`writeFileSync(hooksPath, …)`) rather than hand-rolling JSON.
3. **Migration parity.** Existing codex agents must get the codex autonomous path on update
   (the skill is shipped content; the registration is runtime, so the migration surface is the
   skill body + any helper the skill calls — confirm whether `PostUpdateMigrator` must touch it).

## Residual empirical check before merge (small, not blocking the design)

All three core unknowns are resolved. The one remaining live check is a **belt-and-suspenders
end-to-end run**: register the codex autonomous driver, give a trivial 2-task autonomous goal,
and confirm codex re-prompts itself across turn boundaries until both tasks complete. Gate it on
codex quota (secondary/weekly window — was 99% earlier today; primary/5h was 93% free at
22:55Z). Do NOT run it while Codey is mid-task on the shared OpenAI account.

## Test plan (3-tier, per Testing Integrity Standard)

- **Unit:** the registration helper writes the codex Stop array correctly (append, not clobber;
  idempotent re-run; remove-on-complete restores the prior chain). The hook's decision JSON is
  byte-identical to the Claude path for the same state file.
- **Integration:** an autonomous-state file with incomplete tasks → hook returns
  `{decision:block, reason}`; with all tasks complete → `approve` (both sides of the boundary).
- **E2E:** the belt-and-suspenders live codex run above (quota-gated), asserting multi-turn
  sustainment.

## Why this needs Justin's go-ahead (not a self-approved autonomous build)

It modifies the **autonomous-mode lifecycle machinery** (the `/autonomous` skill + hook
registration) — high blast radius (a bug here could wedge or fail to terminate autonomous runs
on BOTH frameworks). It is his #1 stated tenet and an initiative-sized, multi-file change with a
spec→converge→approve gate. On a load-starved box, with Justin actively engaged, the responsible
move is to surface this build-ready brief and let him prioritize it among the queue — not to
self-approve a from-scratch lifecycle change.
