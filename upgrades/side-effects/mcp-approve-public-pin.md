# Side-Effects Review — tool-change approval link uses the public PIN-route check

**Version / slug:** `mcp-approve-public-pin`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 1 source + 2 test files + 3 docs. `src/server/routes.ts`: (1) a new `checkPublicPin(req, res)` helper next to `checkMandatePin` holds the PIN rules for routes reachable without the bearer token (insecure-connection refusal via `ctx.pinEntryRefusedHere`, the global attempt cap via `ctx.pinAttemptStore` + `GLOBAL_PIN_KEY`, then `checkMandatePin`, charging a wrong non-empty PIN to the global bucket); (2) `POST /mcp/approve/:requestId` (bearer-exempt tap submit) now returns 404 for an unknown or consumed request id BEFORE any PIN is checked, then uses `checkPublicPin`; (3) the two identical inline `checkConfirmPin` closures in the recommended-services routes are replaced by calls to the helper. Class of problem: a no-bearer PIN route held weaker PIN-attempt rules than its siblings. Found by the standing security review; the feature is off by default (`sessions.dynamicMcp.enabled`). User-visible effect: none for the operator approving from the link.

## Decision-point inventory

- Tap-submit request existence — modify — checked before the PIN (deterministic).
- Tap-submit PIN gate — modify — the shared public-route PIN rules.
- Recommended-services confirm PIN gate — refactor — same rules via the helper.

---

## 1. Over-block

Wrong PINs on the approval link now count toward the global PIN cap shared with the unlock page, so many wrong guesses there can lock PIN entry everywhere for the cap window, as wrong guesses on the other public PIN pages already do. Opening the approval link over an insecure connection now refuses PIN entry with `insecure-connection`, as the other public PIN pages do. An empty PIN is never charged.

## 2. Under-block

The bearer-gated `POST /mcp/approve` (agent route, no request id) keeps `checkMandatePin`; it is not reachable without the bearer. The GET approval page still returns 404 vs 200 for unknown vs live request ids, as before (ids are server-minted and opaque).

## 3. Level-of-abstraction fit

One helper beside `checkMandatePin`, used by every no-bearer PIN route in this file, instead of three copies.

## 4. Signal vs authority compliance

- [x] Deterministic credential check; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **PinAttemptStore:** the global bucket is shared with `/dashboard/unlock` and the recommended-services confirm routes (intended).
- **Refactor:** the recommended-services `checkConfirmPin` behaviour is identical (same checks, same order, same responses).
- **Races:** the request may be consumed between the existence check and the approve; `approveByRequestId` still returns `unknown-request` → 404, as before.

## 6. External surfaces

No route shape change; responses: 404 now precedes PIN errors for unknown ids on the tap submit.

## 6b. Operator-surface quality

The operator flow is the same. The approval page's script now shows a refused PIN (wrong PIN, too many attempts, insecure connection) as a plain sentence and lets the operator retry, instead of writing the server's raw JSON into the page (the wrong-PIN and too-many cases already showed raw JSON before this change).

## 7. Multi-machine posture

Machine-local BY DESIGN: PIN attempts are counted by each machine's own store, as today.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration.

---

## Conclusion

Closes the PIN oracle and uncapped guessing on the tap submit by giving it the same rules as the other no-bearer PIN routes, through one shared helper. Tests on both sides; second pass concurs. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff before this artifact)
**Independent read of the artifact: concur.** No way past the global cap; no PIN oracle without a live 144-bit, single-use, 10-minute request id; the existence check, PIN check and consume run in one synchronous step (no race); the refactor is statement-for-statement identical. Applied from its notes: the page now shows refused PINs in plain words (the insecure-connection case was new), and tests now check that a wrong PIN or a lockout leaves the request pending and applies nothing. Noted, unchanged here: the email-code confirm route tests a PIN whenever a grant exists (capped by the global key); 20 wrong PINs on any public PIN route lock all of them for the window (existing shared-cap design).

---

## Evidence pointers

`tests/integration/dynamic-mcp-routes.test.ts`: 5 new tests (made-up id + wrong PIN → 404 and nothing charged; real id + wrong PIN → 403, global bucket charged, request still pending; insecure connection refused with the right PIN; global cap → 429, nothing applied, request still pending; the page script handles refused PINs in plain words). Run as a temporary unit-config copy on 2026-11-16 (the integration config is not run by hand on the Studio): 26/26 on the new code; the PIN tests fail on the previous code. `tests/unit/html-site-ratchet.test.ts` listing updated (the tap submit gained one static HTML 404 site): 4/4. Local Verify runs the file under its own config. `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in a route's PIN gate, closed by the tests above).


## Follow-up (Local Verify, 2026-11-17)

The page script's JSON-parse `catch` now has a body (`j = {}`), satisfying the no-empty-catch ratchet; behaviour unchanged (an unreadable answer still shows the plain default message).
