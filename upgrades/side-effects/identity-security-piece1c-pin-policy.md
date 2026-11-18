# Side-Effects Review — One PIN attempt policy for every place the PIN is checked

**Version / slug:** `identity-security-piece1c-pin-policy`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/identity-security-piece1c-pin-policy.md` (3 rounds; split into two budgets in round 1).

- **Public budget** for `POST /dashboard/unlock`, `POST /dashboard/session/step-up` (reachable without a bearer) and the email-code route. Sign-in and step-up share one set of helpers in `AgentServer.ts`: `publicPinContext`, `publicPinAdmit`, `publicPinFailure` and `publicPinSuccess`.
  - PinThrottle with the marker cookie first, as sign-in had.
  - The overall cap of 20 per 5 minutes is now also durable in `PinAttemptStore`.
  - Unattributable loopback callers are charged to the cap only.
  - The legacy in-memory limiter is gone. `security.pinThrottle.enabled: false` is ignored with a one-time report.
  - PinThrottle settings are clamped to the shipped floors.
- **Per-request budget** for `/mcp/approve/:id` and recommended-services confirm: 5 per live request, keyed on a hash of the request id or token.
  - The strangers' cap never refuses these.
  - Wrong guesses feed an alert-only count, which alerts once per window.
- **Signed-in budget** for every route behind the auth middleware: mandate PIN (3 copies), the work board, skill learning, the money layer, `/passkeys/revert-method`, the two `/class-reviews` routes, the subscription relogin PIN check and subscription-pool repair-email.
  - 5 per credential per 5 minutes.
  - The credential is resolved by `ownerPinSource.ts`: session family, then forwarded machine, then the remembered-browser cookie, then `agent-bearer`.
  - `createOwnerPinVerdict` serves routes that keep their own response shape.
  - The money layer's shared 15-minute lockout is removed; its audit of failed attempts stays.
- **PinAttemptStore:**
  - prunes expired rows and caps at 4096 rows (locked rows are never evicted);
  - quarantines an empty, corrupt or invalid file, pauses unmarked public sign-in for one window, and writes the pause back so a restart stays paused;
  - starts fresh on a missing file;
  - reports a failed write once and keeps enforcing in memory.
- **Ratchet:** a test fails on any dashboard-PIN compare outside the verifiers.

## Decision-point inventory

- PIN admission on every PIN route — modify — one policy, three budgets.
- PinThrottle settings — modify — clamped to floors (stricter only).
- Money-layer PIN lockout — remove — replaced by the per-caller signed-in budget.

---

## 1. Over-block

With the right PIN, nothing that works today is refused, except in the cases below. Each is either a caller's own repeated wrong guesses or a stated pause:

- **A caller's own guesses.** A signed-in credential that made 5 wrong guesses is refused for up to 5 minutes. That includes `agent-bearer`, which local scripts share; the owner's browser is keyed on its cookie. Today mandate routes allow 5 per window on a shared `127.0.0.1` key, and five routes allowed unlimited guesses.
- **Step-up and unlock share the public budget.** A browser with no remembered cookie can be refused when strangers drain the cap, as sign-in already was. The owner's browser has the cookie from its own sign-in.
- **A damaged counter file** pauses unmarked public sign-in for at most 5 minutes. The owner's other routes are untouched.
- **Mandate tests that allowed 5 tries** still allow 5. Step-up now starts its backoff after 3 per real client, which was already sign-in's behaviour.

## 2. Under-block

- **Per-request budget:** a stranger holding a live approval link (the id is unguessable) gets 5 guesses per link, and those guesses feed only the alert-only count. Per link this is the same as today; the difference is that the strangers' cap no longer stops those guesses.
- **A holder of the agent's key** can mint fresh remembered-browser cookies, because the cookie's signing key comes from the agent key. Each new cookie is a fresh `browser:` source on the signed-in routes, so such a holder can step past the 5-per-window `agent-bearer` limit. That holder is inside the Basic boundary: it can already read the PIN from the config, and PIN non-disclosure is piece 1d.
- **Several machines:** each has its own cap, a stated residual of about 19.5 days at 4 machines for a 6-digit PIN.

## 3. Level-of-abstraction fit

There is one public set of helpers in the server, one signed-in verifier (`createMandatePinCheck` / `createOwnerPinVerdict`) and one source resolver. The ratchet keeps new compares from appearing outside them.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a deterministic count of known-invalid attempts (wrong PINs) against shipped floors. The forwarded client address is used only as a signal to pick a bucket; the cap is the authority.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check (Judgment Within Floors standard)

The numbers are inherited floors (SEC-002 design (b)), with their evidence in the spec's decision points. Settings can only make them stricter.

## 4c. Self-action convergence

No self-triggered loop is added. Every action here is a response to a request.

## 5. Interactions

- `skillLearningRoutes` forwarded taps are keyed on the verified machine only. Before, they were charged on both the address and the machine.
- The work board and project-app custom routes build their own checks without a source, so they keep address buckets (unchanged).
- Console callers already treat `attemptsRemaining` as optional; the unlock route no longer sends it.
- `DashboardSessionStore.familyIdForToken` is a new read-only lookup.

## 6. External surfaces

- A new 429 body `code: 'pin-paused'` with plain words.
- Unlock and step-up 429s keep their shape.
- The money layer's `pin-lockout` 429 now comes from the route, per caller.
- A new degradation `DashboardPin.approvalLinkGuessing`, plus `PinAttemptStore.load` / `.persist` and `DashboardPin.throttleSetting`.

## 6b. Operator-surface quality

"PIN sign-in is paused for a few minutes. Use a browser you have signed in with before, your phone, or this computer." It says what happened, how long it lasts, and the routes that still work.

## 7. Multi-machine posture

Counters are per machine, as before. The residual is stated in the spec (section 4). One credential holder per synced PIN comes in piece 4.

## 8. Rollback cost

Revert and ship a patch. `pin-attempts.json` keeps the same shape; extra keys (`req:*`, `agent-bearer`, `session:*`, `browser:*`, `__pin_alert_only__`) are ignored by an older build.

## Conclusion

Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5), 2026-11-18
**Independent read of the artifact: concur**

On re-check, the public-cap check used by the email-code route now passes `clearOnSuccess: false` (`src/server/routes.ts:16635`, honoured at `src/server/mandatePin.ts:106` and `:150`). A right PIN there no longer clears the strangers' cap, and a new unit test covers it; the file passes 10/10. Section 2 now states that a holder of the agent's key can mint remembered-browser cookies, and the misplaced doc comment in `DashboardSessionStore.ts` is fixed. Nothing I found now refuses a right PIN beyond the stated cases, and no route is less protected than on main.

## Evidence pointers

- **Unit:** `tests/unit/owner-pin-verifier.test.ts` (including the ratchet) and `tests/unit/pin-attempt-store-hardening.test.ts`. The existing pin-throttle, money-layer, dashboard-pair-page and console suites pass.
- **Changed integration/e2e** (for Local Verify; not hand-run here): dashboard-pin-throttle, dashboard-scoped-session-token, passkeys-revert-method-routes, skill-learning-routes, skill-learning-alive, dynamic-mcp-routes, recommended-services-confirm-wiring.
- **Guards:** no-silent-fallbacks, feature-ladders, awareness, html-site, the 21 ratchet files, self-action convergence and the state-registry lints all pass.
- **Throwaway:** agent home `.instar/state/identity-build-144636/p1c-throwaway-proof.md`. It covers the off switch ignored, the cap drained by strangers while the owner's routes work, per-credential limits on a real route, the cap surviving a restart, and the damaged-file pause holding across a restart. A real tunnel was not available.
