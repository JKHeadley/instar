# Side-Effects Review — The one-time local dashboard link

**Version / slug:** `identity-security-piece1a-local-link`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (authentication surface). Adds `instar dashboard open` and a one-time local link (spec `docs/specs/identity-security-piece1a-local-link.md`, converged in 4 rounds after the larger piece-1 spec's 5). Files: `src/core/LocalAccessStore.ts` (ticket/credential store), `src/server/localAccessRoutes.ts` (mint, open page, challenge, exchange, use-challenge; launcher; sweeps), `src/commands/dashboardOpen.ts` + `src/cli.ts` (the command), `src/server/AgentServer.ts` (construction, start-up sweep after bind, the unlock route's verified-local branch, lockout text, stop), `src/core/PinThrottle.ts` (read-only `isMarkerHonored`), `src/core/keyMaterialPaths.ts`, `src/core/devGatedFeatures.ts`, `src/core/types.ts`, `src/data/state-coherence-registry.json`, `src/data/awareness/local-dashboard-link.md`, `dashboard/local-access.js`, `dashboard/local-access-open.js`, and the seven dashboard PIN forms now posting through one helper. Dev-gated (`security.localAccessLink.enabled`): live on development agents, dark on the fleet. ~2,300 lines including tests; 4 spec review rounds; first commit attempt.

## Decision-point inventory

- `POST /local-access/v1/mint` — add — admits a mint only with an HMAC over the private listener key, from the 127.0.0.1 socket, loopback peer, no forwarding header, exact Host, fresh nonce, stamped after this server began listening.
- Exchange binding — add — one key per ticket, one credential per ticket, inside one SQLite transaction.
- `POST /dashboard/unlock` budget selection — modify — a verified local credential (no honoured marker, verified-local budget not full) is judged on `local-verified:<machine>:<generation>` (10 failures / 5 min) instead of the loopback/stranger budgets. Every other request: unchanged.
- Start-up revocation — add — unredeemed tickets and open challenges revoked once the process holds its socket.

---

## 1. Over-block

The link adds a new admission path; it removes none. A browser whose local credential is missing, expired, malformed, from another origin, or whose challenge fails is handled exactly as before. A full verified-local budget falls back to today's rules. A browser with an honoured prior-unlock marker keeps today's marker rules. Legitimate cases the link itself refuses: a link minted before a restart (re-run the command), a link evicted by ten newer ones (re-run), print mode without a terminal, and agents whose listening socket does not cover 127.0.0.1 (link off, plain message). None of these block unlock.

---

## 2. Under-block

- A program running as the agent's own OS account can mint and use up the verified-local budget (inside the Basic boundary, umbrella §3.3); unlock then falls back to today's rules.
- After redemption the dashboard page and the PIN typed into it are served by whatever holds `127.0.0.1:<port>`, exactly as today; this change does not authenticate the dashboard listener to the browser (pieces 4/6).
- On a wildcard bind on macOS a same-account program could take `127.0.0.1` after a mint; same boundary as above.
- Any script served from the same origin (dashboard pages, preview mount) can use the stored key; the credential's only power is budget selection for at most 15 minutes.

---

## 3. Level-of-abstraction fit

The locality proof lives in its own service and store, and the unlock route consumes one boolean (`verifyUnlockLocalAccess`) before its existing budget logic. It reuses the existing P-256 low-S verifier (`verifyP256`), the browser key helpers (`browser-device.js`), `PinAttemptStore` for the durable budget, `KEY_MATERIAL_PATHS` for exclusion and `resolveDevAgentGate` for the switch. Later pieces add consumers to the same service rather than re-implementing locality.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — deterministic authentication checks (signature, digest, single use, expiry, exact socket/Host/Origin).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The decisions are cryptographic and enumerable-domain checks on a security floor, which the standard allows to be deterministic; no meaning is judged by pattern. `startedBy` is telemetry and no gate reads it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The fixed numbers (10/10/8 capacity, 15-minute lifetime, 60-second challenge and replay window, 10 failures per 5 minutes, 250 ms busy timeout, 8 KB body, 30-minute notice) are declared in the spec's `## Decision points touched` with floor and arbiter; the authentication decisions themselves are invariants.

---

## 5. Interactions

- Unlock: the verified branch is checked first and, when taken, skips the loopback budget, the local marked consult, PinThrottle's unmarked limits and the legacy limiter; success still sets the prior-unlock marker and issues the same session. The failure path raises its own `DashboardPin.localLinkGuessing` degradation with the shipped 30-minute cooldown, separate from `DashboardPin.localGuessing`.
- A body-size parser for `/local-access/v1` is mounted before the server-wide 12 MB parser.
- Start-up sweep runs inside the listen callback, so a second instance that fails to bind never revokes the running server's tickets.
- The seven dashboard unlock forms post through `postUnlock`; with no credential the body is `{ pin }` exactly as before.
- Global install cleanup is untouched; the launcher lives in the agent's own `.instar/bin/`.

---

## 6. External surfaces

New public-before-auth routes under `/local-access/v1/*`, each answering 404 unless the switch is on and the request arrived on the 127.0.0.1 socket from loopback with no forwarding header; tunnel traffic never reaches them. New CLI command. New file `<stateDir>/bin/dashboard-open`. New awareness entry (worded so an agent without the launcher does nothing). No change for remote or tunnel users.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the exchange page shows one line ("Opening your dashboard…") and redirects to the dashboard; the PIN forms are unchanged.
2. **Zero raw internals as primary content?** Yes: messages are plain ("This link has expired or was replaced. Run … for a new one."); no ids shown.
3. **Destructive actions de-emphasized?** No destructive action on these surfaces.
4. **Plain language + phone width?** The exchange page is a heading and a sentence; it is a computer-local page, and the existing dashboard forms keep their layout.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (physical-credential-locality): the key, ticket store, credentials, launch documents, launcher and the verified-local budget belong to the machine whose loopback they prove. Each machine's CLI mints against its own listener; a credential means nothing on another machine. No notices go to other machines; the degradation is raised by the machine that saw it. No new `/status`, `/health`, `/capabilities` or `/channels` answer.

---

## 8. Rollback cost

Set `security.localAccessLink.enabled: false` (or leave the fleet default): routes 404, unlock ignores `localAccess`, the launch-document sweep still runs. Code revert is a plain patch. Persistent state is the `local-access/` folder (key, small SQLite store) and `bin/dashboard-open`; both are inert when off and can be removed by hand; nothing else reads them. No user-visible regression during rollback: unlock returns to today's rules.

---

## Conclusion

The review shaped the design across four rounds (numeric origin, key-authenticated mint and response, eviction instead of refusal, restart revocation after bind, replay anchor at listen time, marker-state rules, helper single submission). Clear to ship to the throwaway proof and Local Verify. Residuals are stated in the spec §6 and above; WSL gateway acceptance (1g), the Mac button (piece 3) and the rest of piece 1 are their own specs.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5), 2026-11-18
**Independent read of the artifact: concur**

Concur with the review: the code does what the artifact and spec claim, and no path unlocks without the correct PIN. Non-blocking notes, two applied: the seven PIN forms now fall back to a plain `{pin}` post if the helper module fails to load; the launch-document sweep refuses a symlinked launch folder. Third, recorded: with `security.pinThrottle.enabled: false` (the legacy limiter, a rollback path), a verified success does not reset `GLOBAL_PIN_KEY` the way a local success does today.

---

## Evidence pointers

- Unit: `tests/unit/local-access-store.test.ts` (16), `tests/unit/local-access-routes.test.ts` (12), plus `file-routes-never-served-key-material` and `awareness-entry-registry` (92 in the four files, all passing locally).
- Integration: `tests/integration/local-access-link.test.ts` and E2E `tests/e2e/local-access-link-alive.test.ts` run in Local Verify (not hand-run on the verify machines).
- Throwaway live proof (Studio, real browser + default browser via the launcher): before-lockout reproduced, unlock through the link while the loopback budget was exhausted, counters, squatter refusal, print mode through a forward, launcher from a fresh shell, restart revocation. Record: `.instar/state/identity-build-144636/p1a-throwaway-proof.md` (agent home), summarised in the PR.
- Review packets: `.instar/state/identity-build-144636/reviews/p1a-r1` … `p1a-r4`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed here. Self-action class, mirrored from the trace:

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a`
- **reason** — one-shot user-driven action, not a self-triggered loop: the CLI opens the browser once per person request; the 60-second sweep only deletes expired rows and files (bounded by the 10/10/8 caps, never creates work); the store-unavailable degradation is raised once per distinct cause.
