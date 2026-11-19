# Side-Effects Review — Codex CLI version probe: a test-time budget

**Version / slug:** `codex-version-probe-test-budget`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. Four files, about 50 lines; one commit attempt planned, no spec review rounds. The `codex --version` probe in `src/core/codexCapabilities.ts` had a fixed 2 second deadline. The deadline is now read at call time from `versionProbeTimeoutMs()`: 2 seconds times the whole number in the environment variable `INSTAR_CODEX_VERSION_PROBE_SCALE` (1 to 20; unset or invalid means 1). Nothing in the product, its launchers or its templates sets that variable, so the production deadline stays 2 seconds. `tests/unit/CodexCliIntelligenceProvider.test.ts` sets the variable to 10 for that file and restores the earlier value afterwards, because its fake CLIs are shell scripts and on a loaded machine one took longer than 2 seconds to start. That was read as an unreadable version, the one-shot policy kept the newer model, and the older-CLI expectation failed (Local Verify, 2026-11-18 03:31Z). `tests/unit/codexCapabilities.test.ts` gains two assertions for the scale parsing. The release note fragment `upgrades/next/codex-gpt-6-2-default.md` gains one Evidence sentence.

**Phase 1 answer:** this change involves no decision point. It is a test-time knob on a probe timeout. The rule that decides what an unreadable version means is not touched.

## Decision-point inventory

No decision-point surface. The older-CLI model choice (`pick` in `codexCapabilities.ts`) is passed through unchanged; only how long the probe may take to answer can change, and only when the environment variable is set.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. One limit of the test fix itself: a machine so loaded that a shell script needs more than 20 seconds to start would still fail the provider test. That is far outside what the verify machines have shown.

---

## 3. Level-of-abstraction fit

The deadline lives in the probe, and the knob sits beside it as one small exported function. The test file sets its own environment, the same way it already sets `INSTAR_CODEX_EXEC_JSON`. The shared test setup file was left alone on purpose, because another open pull request edits it. `tests/unit/codexCapabilities.test.ts` has two tests that depend on the 2 second deadline (a wedged CLI that sleeps 30 seconds); that file does not set the variable, so those tests keep their timing.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The probe reports a version or "unreadable". Each caller keeps its own existing policy for "unreadable". Nothing gains authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The scale is an enumerable setting (a whole number from 1 to 20) with a fixed default.

---

## 5. Interactions

- **Shadowing:** none. Both probe forms (the async one and the first-read synchronous one) read the same function, so they cannot disagree.
- **Double-fire:** none.
- **Races:** the value is read once per probe at the moment the deadline is set; a probe already running keeps the deadline it started with.
- **Feedback loops:** none.

A longer deadline would let a wedged CLI hold the first synchronous read for longer. That is only reachable through an environment variable that nobody sets in production, and the cap of 20 bounds it at 40 seconds even then.

---

## 6. External surfaces

No external surface changes. No other agent, user, external system or persistent state is touched. The variable is not documented for operators and is not written into any config, launcher or template. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the probe reads the Codex CLI installed on the machine it runs on, and the variable is read from that process's own environment. It emits no user-facing notices, holds no durable state and generates no URLs. No `/status`, `/health`, `/capabilities` or `/channels` answer is added or changed.

---

## 8. Rollback cost

Pure code change — revert the commit. No persistent state, no agent repair, no user-visible effect either way. A revert would bring back the load-sensitive test.

---

## Conclusion

The review found nothing to change in the design. Production behaviour is the same as before because the variable is unset there; the test file that failed on a loaded machine now gives its fake CLI 20 seconds. Clear to ship. Proportion: Tier 1, four files, no review rounds.

---

## Second-pass review (if required)

Not required: no gate, guard, session lifecycle or messaging decision is touched.

---

## Evidence pointers

- `nice -n 15 npx vitest run tests/unit/CodexCliIntelligenceProvider.test.ts tests/unit/codexCapabilities.test.ts` — 2 files, 54 tests passed.
- `tests/unit/CodexCliIntelligenceProvider.test.ts` alone, three runs in a row — 31 passed each time.
- `nice -n 15 npx tsc --noEmit -p .` — clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The change adds no self-triggered controller.
