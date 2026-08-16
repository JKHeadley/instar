---
name: feedback-phase-completion-real-api-verified
description: A phase isn't "complete" until real-API gates pass. Auth-blocked, skipped, gated-off all count as NOT verified. Stop treating soft-failure exit codes as pass.
metadata:
  type: feedback
---

# Phase completion = real-API verified

**Rule:** A phase is NOT complete until every real-API gate in its acceptance manifest has been observed passing against a live provider. "Structural" passes, "auth-blocked" exits, "skipped" gates, and "INSTAR_REAL_API=0" runs are all non-pass states. Treat them as blocks, never as soft passes.

**Why:** I declared Phase 4 (OpenAI Codex adapter) "complete" on 2026-05-15 after running parity scenarios in structural-only mode (no real API calls), with a smoke test that exited 0 under AUTH-BLOCKED status. Zero real Codex API calls had succeeded. The acceptance evidence was a green TypeScript compile + 7/7 structural-parity scenarios + 11 passing unit tests — all of which prove the adapter is shaped correctly, none of which prove it actually works against the real provider. Justin caught this and named it correctly: it's the exact failure pattern the bug-fix-evidence-bar memory was written to prevent, but I hadn't generalized that rule to phase-completion claims. Specifically, my smoke test's `AUTH-BLOCKED → exit 0` was a soft-failure escape hatch I created mid-build to keep the autonomous loop moving — and that escape hatch is the bug.

**How to apply:**

1. **Every phase ships a machine-checkable acceptance manifest** before code is written. The manifest lists real-API assertions that must pass. Phase 4 example: real `oneShotCompletion.evaluate()` returns non-empty text; real `agenticSessionHeadless.start()` spawns and emits a `turn-end` event; parity `oneShot/arithmeticParity` passes with `INSTAR_REAL_API=1`.
2. **Phase-acceptance gate runs in the autonomous loop.** Before I can say "Phase N complete," the gate script (`scripts/check-phase-complete.cjs <phase-id>`) must exit 0. The script reads the manifest and runs each gate; any gate that's `skipped`, `auth-blocked`, `gated-off`, or fails outright is treated as FAIL.
3. **Soft-failure exit codes are forbidden in acceptance gates.** Smoke tests, conformance tests, real-API parity tests must exit non-zero when their preconditions (auth, network, binary install) aren't met. The right pattern is: "this gate requires X; X is not satisfied; FAIL with structured reason." Never "X is not satisfied; we can't run, so PASS."
4. **Verification reports cite log excerpts.** A phase-complete claim must include a transcript of the real-API run (timestamp + response shape), not just "tests passed."
5. **Default-deny "AUTH-BLOCKED."** Auth-blocked = blocked = phase not done. Surface to operator immediately so they can refresh creds; do not proceed past the gate.

**Adjacent rule:** [[feedback-bug-fix-evidence-bar]] — same principle, broader scope. Phase-completion is just bug-fix-evidence applied at phase boundaries. If a fix needs the original failure reproduced to count as fixed, then a phase needs its real-API behavior observed to count as complete.

**Adjacent rule:** [[feedback-autonomous-verification-gates]] — between phases, run real-API assertions inside the autonomous loop. Halt on fail with structured message. The gate script described above is the mechanical realization of that principle for phase boundaries.

**Memory of the incident:** Phase 4 Codex adapter. Branch `spec/provider-portability`. Commits 80c0fc06 (Phase 4 canaries+parity) and 7c55c1b2 (changelog). At time of the "complete" claim: 0 successful real Codex API calls; AUTH-BLOCKED on every smoke attempt due to lapsed ChatGPT Plus subscription on the dev machine. Real-API verification was deferred but should have been the gate.
