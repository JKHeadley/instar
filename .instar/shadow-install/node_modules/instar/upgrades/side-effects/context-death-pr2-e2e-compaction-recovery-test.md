# Side-Effects Review — Context-Death PR2 (E2E compaction-recovery test)

**Version / slug:** `context-death-pr2-e2e-compaction-recovery-test`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § (c)
**Phase / PR sequence position:** PR2 of 8
**Second-pass reviewer:** `not-required` (test code, no runtime decision logic — see Phase 5 criteria below)

## Summary of the change

Ships the actual end-to-end compaction-recovery assertion suite on top of the PR0d harness. Spec § (c) calls out four assertions the test must make; PR2 lands all four plus a latency ceiling and an autonomous-session scenario guard.

Files touched:

- **`tests/e2e/compaction-recovery.test.ts`** (NEW) — 6 tests:
  1. **Hook exits 0.** A non-zero exit is the exact failure mode that causes agents to rationalize context-death self-stops. The test pins this invariant.
  2. **Structural "Continue your work" marker.** Downstream sessions look for this banner as the signal that re-grounding completed. If the hook template ever drops it, the agent won't know to continue.
  3. **Drift-inducing phrasing regression guard.** Asserts the output does NOT contain `fresh session`, `start over`, `restart the session`, `open a new conversation`, `continue in a new session`. A future template edit that adds any of these fails this test and the PR is blocked.
  4. **Durable-artifact evidence.** Commits a plan file, runs the hook, asserts file content + git sha are unchanged afterward. This is the spec's foundational premise — with durable artifacts, context death is not a real risk — made into CI evidence.
  5. **Latency ceiling <5s.** A slow recovery hook undermines the "just re-read the plan, it's fine" premise. 5s is a soft ceiling; tightens if the canonical hook legitimately runs faster.
  6. **Autonomous mid-plan scenario.** The exact failure mode this spec exists to prevent — autonomous agent, plan in flight, compaction happens. Asserts the hook handles it without crashing and produces the correct completion signal.

## Decision-point inventory

Zero. Tests assert properties; they don't make runtime decisions. The "regression guard" (test #3) blocks CI if forbidden phrasings appear, but that's ordinary CI signal flow, not an agent-behavior gate.

---

## 1. Over-block

The regression guard could over-block if a future edit legitimately needs one of the forbidden phrases in a different context (e.g., a security warning that mentions "fresh session" without suggesting the agent use one). That's a low-probability false positive: the surrounding prose in recovery output is narrow enough that these specific phrases are effectively reserved words.

If we hit a legitimate false positive later, the fix is to tighten the regex to word-boundary matches that exclude the legitimate context, not to drop the guard.

## 2. Under-block

**What failure modes does this still miss?**

- **Doesn't drive actual Anthropic API traffic.** Per spec § P0.1 and PR0d's artifact, the harness uses the canonical hook directly — not a real Claude Code subprocess. Acceptable because (a) the spec's flake budget anticipates CI environment limitations; (b) the hook itself is the thing under test, not the Anthropic API.
- **Doesn't assert specific plan-file reference in stdout.** The canonical recovery hook does NOT echo plan file contents — it re-injects a fixed template. A test that asserted specific plan content in stdout would be testing a behavior the hook does not have. The durability test (#4) gets at the same property via on-disk evidence.
- **Doesn't assert cross-machine behavior.** Out of scope for PR2; lives alongside PR4's multi-machine rollout tests.

## 3. Level-of-abstraction fit

`tests/e2e/` with `.test.ts` suffix to match the vitest discovery pattern. Precedent: `tests/e2e/compaction-telegram-context.test.ts` uses the same shape. The spec's written path was `.spec.ts`; adjusted to `.test.ts` so the test is actually discovered by the pre-push gate (otherwise it would silently not run).

## 4. Signal vs authority compliance

Test code. Neither a signal nor an authority. The regression guard acts as a CI gate, not a runtime agent-behavior gate.

## 5. Interactions

- **Depends on PR0d's harness.** Imports `createCompactionHarness` from `./compaction-harness.js`. If the harness is removed or renamed, PR2 breaks at test-collection time (immediate, clear failure). No silent drift.
- **Runs canonical `compaction-recovery.sh`.** Reads the file from `src/templates/hooks/` (source-of-truth) or `.instar/hooks/instar/` (deployed). One-way dependency: the test validates what the hook does, never writes back.
- **Temp-dir per test via harness `teardown()`.** No shared mutable state between tests; parallel execution safe.
- **No network, no Anthropic API.** Deterministic.

## 6. External surfaces

Test-only. Nothing ships to the production runtime. Invisible to agents, users, other systems.

## 7. Rollback cost

Trivial. Delete one file (`tests/e2e/compaction-recovery.test.ts`). No runtime surface to undo. If rolled back, the PR0d harness remains intact and ready for any replacement assertion suite.

---

## Tests

- `tests/e2e/compaction-recovery.test.ts` — 6 tests, all passing.
- `npm run lint` clean.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no**.
- Session lifecycle: spawn, restart, kill, recovery — **test-adjacent to recovery**; no runtime path changed.
- Context exhaustion, compaction, respawn — **this is the assertion surface for compaction recovery**; still test-only, no runtime decision.
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **no** (the "regression guard" is a test assertion, not a runtime gate).

PR3 will require Phase 5 second-pass review.
