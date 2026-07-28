# Side-Effects Review — Hermetic env for telegram-reply script tests

**Version / slug:** `test-env-hermetic-reply-scripts`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (test-only change, no runtime surface)`

## Summary of the change

Three tests that spawn `telegram-reply.sh` (`tests/integration/telegram-reply-end-to-end.test.ts`, `tests/unit/telegram-reply-recoverable-classification.test.ts`, `tests/unit/reply-scripts.test.ts`) inherited the full process env via `{ ...process.env }`. Inside a live agent session, `INSTAR_AUTH_TOKEN` is exported (SessionManager injects it), the script's documented env-first auth resolution picks it up, and the test server's auth middleware rejects the mismatched Bearer before the route handler records the hit — failing the test only when run inside an agent session. Each spawn site now sets `INSTAR_AUTH_TOKEN: ''` so the script exercises the config-file fallback the tests intend. No runtime files changed.

## Decision-point inventory

No decision-point surface — test-only. The script's env-first auth precedence is intentionally UNCHANGED (it is documented, load-bearing behavior); only the tests' spawn environments changed.

---

## 1. Over-block

No block/allow surface — not applicable.

## 2. Under-block

No block/allow surface — not applicable.

## 3. Level-of-abstraction fit

Right layer: the fix is at the test spawn sites, not the script. Weakening the script's env-first precedence to make tests pass would invert the actual contract. The sibling `telegram-reply-port-resolution.test.ts` already constructs a minimal env (`{ PATH }`) — the targeted blank keeps each test's existing env needs intact while removing the one leaking variable.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

## 5. Interactions

- Shadowing/double-fire/races/feedback loops: none — test-only env construction.
- Verified the three tests + the already-hermetic sibling all pass together under a live agent env AND under a stripped env (both run locally).

## 6. External surfaces

None. No runtime change; CI behavior identical (CI never had the variable set — that's why CI was green while local was red).

## 7. Rollback cost

Trivial revert of three test lines. No persistent state.

---

## Conclusion

Closes a hermeticity gap in the reply-script test family (the same class PR #862 closed for the unit suite's config leakage): tests must not change verdict based on the runner's live agent environment. Found via Zero-Failure triage of a local full-suite run. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required — test-only.

---

## Evidence pointers

- Repro: `npx vitest run tests/integration/telegram-reply-end-to-end.test.ts` fails with `INSTAR_AUTH_TOKEN` exported, passes with it unset (bisected: that single var).
- Post-fix: all 4 reply-script test files green under the live agent env (32 tests).
