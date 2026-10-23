# Side-Effects Review — Linux E2E race in the test-runner progress test

**Version / slug:** `watchdog-linux-cpu`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent, concurred (see Second-pass review)`

## Summary of the change

Test-only. `tests/e2e/watchdog-test-runner-progress-alive.test.ts` failed on Linux CI because its first poll could land in npm's roughly one-second startup window, when Linux `ps` shows the process title as bare `npm`. npm's `entry.js` sets that title before `npm.js` sets `npm test`. macOS `ps` shows the original argv, never the title. `waitForSuite` now returns only once the npm row classifies through the production `classifyTestRunnerCommand` and the fixture's `vitest` row exists. The incorrect comment from #2298, which claimed a Linux npm row can never read more than `npm`, is replaced with the measured sequence. `tests/unit/session-watchdog-test-runner-floor.test.ts` gains three cases: the macOS argv shape, the Linux title shape `npm run test:unit`, and bare `npm` as a non-match. No file under `src/` changes.

## Decision-point inventory

- `SessionWatchdog` test-runner floor / progress extension (`classifyTestRunnerCommand`, `classifyTestRunnerProtection`) — pass-through. Behaviour is unchanged. The tests now pin the platform shapes it already handles.

---

## 1. Over-block

No block/allow surface changed — over-block not applicable. The product's interrupt decision is unchanged.

---

## 2. Under-block

No block/allow surface changed — under-block not applicable. Product-level observation: during npm's first ~second on Linux, its row reads `npm` and does not classify. The watchdog never judges a command under 3 minutes old (`stuckCommandSec` 180), so production never acts on that window. A test runner that is not vitest (for example jest) under `npm test` is matched by its `npm test` title on both platforms, so there is no Mac/Linux divergence.

---

## 3. Level-of-abstraction fit

The fix sits at the test's synchronisation point. It waits for the same state production sees, using the production classifier rather than a regex copy. Changing the product, for example by treating bare `npm` as a test run, would be wrong: `npm install` has the same startup title.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Test and coverage changes only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. No product logic changes.

---

## 5. Interactions

- **Shadowing:** none. Tests only.
- **Double-fire:** none.
- **Races:** this change removes a race (the poll vs npm's process-title update). `waitForSuite` still has a 15 s deadline. If it expires, the later assertions fail loudly rather than pass vacuously.
- **Feedback loops:** none.

---

## 6. External surfaces

No external surface changes. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The watchdog inspects this machine's own process table. The change is test-only and emits no notices, holds no state and generates no URLs.

---

## 8. Rollback cost

Pure test change. Revert it and ship a patch. No persistent state, no user-visible effect.

---

## Conclusion

The Linux failure was a test-timing race, not a product misjudgment. Evidence: in the failing runs, the judged command was the 3-character `npm`. The next test in the same file read `npm test` from the same process, which shows the title grows. npm 11's own source sets `npm` first and `npm test` after config load. #2298 already made CI pass by adding a vitest descendant. That fixture state also appears only after npm has set its title, but #2298 attributed the pass to a permanent Linux limitation. This change makes the wait explicit and corrects that record, so nobody later "fixes" a non-existent Linux gap in the product. Clear to ship once the second pass concurs and Linux CI is green.

---

## Second-pass review

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), one round, 2026-10-23 — concur

Concur, no blocking issues. The e2e wait is stricter than before (it now also needs an npm row the production classifier accepts, so the old theory would fail loudly); the three unit cases match `classifyTestRunnerCommand`; the ELI16 credits #2298 correctly; fixture processes are cleaned up as before. Unit file 43/43. Nits left: Linux evidence comes from the verifier's run, not this review; the claim that macOS `ps` never shows the title was not checked and does not affect the fix.

## Evidence pointers

- CI 39767066373 / 39753464476 E2E logs: judge prompt `Command: npm`, `commandChars: 3`; same run, later test: `stuck command (3660s): npm test`.
- npm 11.11.0: `lib/cli/entry.js:5` `process.title = 'npm'`; `lib/npm.js:159-165` setTitle after config load.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was a test synchronisation race. The added unit cases pin the platform title shapes.
