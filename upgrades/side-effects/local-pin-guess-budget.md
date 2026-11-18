# Side-Effects Review — dashboard PIN: local guesses are bounded too

**Version / slug:** `local-pin-guess-budget`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 1 source file, 1 test file and 3 docs, all in `src/server/AgentServer.ts` `POST /dashboard/unlock`.

The SEC-002 throttle deliberately exempted a "local direct" caller (loopback peer, own Host, no forwarding headers), so a remote stranger could never lock the owner out at the machine. But every process on the machine is local direct, including confined sessions that share the loopback. Now:

1. **An unknown local caller** (no signed prior-unlock marker) has its own budget:
   - 10 failures per 5 minutes, durable in `PinAttemptStore` under its own key (in-memory fallback);
   - a plain 429 with `retryAfterSeconds` once it is used up;
   - an owner alert at the cap, with a 30-minute cooldown;
   - not reset by a success.
2. **A local browser with a marker** is judged by its marker, exactly like a known remote browser: gentle backoff, then the marked abuse cap. A copied cookie is not an unlimited pass.
3. **The remote budget is unchanged** and separate, so neither drains the other.
4. **The remote alert's wording** no longer claims "the machine itself still works", which is no longer true for unknown local callers.

Class of problem: an exemption meant for the owner at the machine also covered every other local process. Found by the standing security review.

## Decision-point inventory

- Unlock attempt admission for local callers — modify — deterministic budget and marker backoff.

---

## 1. Over-block

- **The owner at the machine with a new browser** (or a private window, or an expired marker) who types 10 wrong PINs in 5 minutes waits up to 5 minutes. A browser that unlocked before, and the paired phone app (device-signed, no PIN path), are unaffected.
- **A local nuisance program** can keep unknown local browsers at 429 by re-spending the budget. This is unavoidable without telling the owner's typing apart from a program's on the same machine. The owner's known browser and the phone app still work, and the owner is alerted.

## 2. Under-block

- **Not tight against a local program that is willing to wait:** 10 guesses per 5 minutes is about 2,900 a day, roughly half the PIN space in about half a year. The alert is the backstop.
- **Tunnel-Host spoofing.** A local program can send the tunnel's own Host name with made-up client addresses. Real tunnel traffic also arrives over loopback, so the server cannot tell them apart. That path is still bounded by the shared remote cap (20 per window), so a local program gets about 30 guesses per 5 minutes in total, and draining the remote cap refuses new remote browsers, which is pre-existing.
- **Other PIN routes** (step-up when scoped tokens are on, `checkMandatePin` routes, the MCP approval link) keep their own bounded budgets. None has a local exemption.

## 3. Level-of-abstraction fit

The one unlock route that held the exemption. The marker path reuses `PinThrottle`'s existing marked-browser rules.

## 4. Signal vs authority compliance

- [x] Deterministic budgets; no content judgment.

## 4b. Judgment-point check

The 10-per-5-minutes floor matches the order of the existing remote budgets; there is no new heuristic.

## 5. Interactions

- `PinAttemptStore` gains one key, `local-direct-unmarked`.
- `PinThrottle` sees local marked callers. Before, it never saw local callers at all.

## 6. External surfaces

The unlock route can answer 429 to a local caller. There is no route shape change.

## 6b. Operator-surface quality

- The 429 names the ways in: a known browser, the phone app, or waiting.
- The alert says plainly what may be happening and that the PIN was not accepted.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine's unlock route guards its own loopback.

## 8. Rollback cost

Revert and ship a patch. The extra store key expires on its own.

---

## Conclusion

Closes unlimited local guessing while keeping the owner's known browser and phone app whole. The second pass's concerns are addressed or named above. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff, PinThrottle, the marker code and the other PIN routes)

**Independent read: concerns, now addressed.** Its findings, most severe first:

- **Fixed:** a copied marker cookie gave unlimited local guesses. Local marked callers now go through the marker backoff and the abuse cap.
- **Named in §2:** tunnel-Host spoofing from loopback, bounded by the remote cap.
- **Named in §1:** a local nuisance can keep unknown local browsers refused; known browsers and the phone app still work.
- **Fixed:** the alert had no cooldown. It now has 30 minutes.
- **Fixed:** an owner's success refilled the attacker's budget. It no longer resets.
- **Fixed:** the 429 text. It now names the ways in and carries `retryAfterSeconds`.
- **Fixed:** the remote alert text claimed the machine still works.

Tests now cover the marker backoff, no refill on success, and a known browser still unlocking after the local budget is used up.

---

## Evidence pointers

- `tests/integration/dashboard-pin-throttle.test.ts`: 6 new local-budget tests. The local cap and the alert test fail on the previous code. 11/11 for the file, run as a temporary unit-config copy on 2026-11-17.
- `pin-throttle.test.ts`, the ratchets and the e2e alive test pass.
- Other unlock users pass: scoped-session token and revocation, the graph member-loss integration tests, and 4 e2e files.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the unlock throttle, closed by the tests above).
