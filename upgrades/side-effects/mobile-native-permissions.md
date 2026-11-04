# Side-Effects Review — Native Permission slips and What I'm allowed to do, with Face ID-confirmed writes

**Version / slug:** `mobile-native-permissions`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. New module `src/server/mobilePermissionsRoutes.ts`: two read routes (`GET /mobile/permissions/slips`, `GET /mobile/permissions/features`; owner phone or bearer; approvals, slips and switches proxied-on-read across online peers) and four owner-phone-only writes (`POST /mobile/permissions/challenge`, `/requests/:id/approve|decline`, `/features/:id`) that need a configured dashboard PIN, local TLS or loopback, an active owner phone, its enrolled presence key, a single-use 60 s challenge bound to device, Host and the exact action line, and a valid presence-key signature. `src/server/routes.ts`: the console's approve/deny bodies and the operator-switch branch are extracted into shared functions (`approveAuthorizationRequest`, `denyAuthorizationRequest`, `operatorSwitchFeature`, `featureTransitionAnswer`) called by both the console routes (behaviour unchanged) and the phone routes; the module is mounted with deps. Also: six `DEVICE_ALLOWLIST` rules (`mobilePairingRoutes.ts`), a `DEV_GATED_FEATURES` entry and config type for `mobilePairing.permissionActions.enabled`, a `CapabilityIndex` entry, the CLAUDE.md awareness line and its migration (`PostUpdateMigrator.ts`), `RouteContext.mobilePairingService` wired in `AgentServer.ts`. Change size ≈ 700 new + 150 changed server LOC, tests ≈ 650 LOC; spec converged in 5 rounds (cap 6); three commit/build gate passes expected. App (separate repo, `apps/instar-ios` commit 66a1f9e): `PermissionsData.swift`, `PermissionsViews.swift`, tests, section on the agent page.

## Decision-point inventory

- `DEVICE_ALLOWLIST` — add — six exact paths, owner-only, own buckets.
- Phone write gate (`writeGate`) — add — deterministic authorization: feature on (dev gate), device principal, local TLS/loopback, active owner phone, PIN configured, presence key.
- Challenge binding + presence signature — add — exact-string and cryptographic checks.
- Proposal-hash check inside `execute` — add (phone path only) — refuse a request changed since it was read.
- Consent-disclosure hash check — add (phone path only) — refuse a turn-on whose disclosure changed.
- In-chain re-check before `operatorSet` — add (phone path only).
- Console approve/deny/operator-switch — pass-through (extracted, unchanged behaviour).

---

## 1. Over-block

- A phone reaching the agent only over plain LAN HTTP (not the machine's TLS front, not loopback) is read-only for changes (`transport`), even where the console's PIN approve would accept that route. Deliberate: the console-ticket rule; the owner can use the tunnel/TLS route or the console.
- An agent with no dashboard PIN set cannot change these from the phone (the console cannot either).
- A request whose grantee is not a registered named person can be declined but not approved from the phone (approve would fail as `unknown-user` anyway).
- A route switch between challenge and post costs a second Face ID prompt (`challenge-invalid`, one retry).

---

## 2. Under-block

- The server cannot observe the Face ID prompt; it verifies a signature by an enclave key whose access control the app set at creation. A modified app on a compromised (e.g. jailbroken) phone could sign without prompting; such a device could equally capture a PIN typed into the console view. Stated in the spec (§4).
- First presence-key enrolment wins (the console ticket's existing trust root); unchanged here.
- An agent with write access to local state could forge a device record; it can equally read the PIN from config. Trust boundary unchanged.

---

## 3. Level-of-abstraction fit

Right layer: the authentication checks sit in the route (as the console ticket's do), and the action itself is the console's own code, extracted rather than duplicated, so there is one approve path, one deny path and one per-feature switch chain. The device allowlist remains the outer gate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is authentication/authorization, not judgment: deterministic identity, key and binding checks (the documented hard-invariant exception for auth gates).
- [ ] ⚠️ Yes, with brittle logic

The blocks are principal checks (who signed, is it the owner's active phone, is the proof fresh and bound to this action), not content heuristics. Nothing here classifies messages or behaviour.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every check is an invariant (identity, cryptography, exact equality, config presence); the spec's `## Decision points touched` classifies each.

---

## 5. Interactions

- Shares `serializeFeatureSwitch` with the console, so console and phone switches on one feature run one at a time; the phone's re-checks its authority inside the chain.
- Shares `approveAuthorizationRequest` with the console: same `coordination.audit`, `featureEvidence`, `resolvedBy: 'operator'`; phone adds the device id and the proposal-hash check inside `execute` (no await between store read and write).
- Uses the console ticket's presence key and enrolment route; a separate challenge store and message version (`instar-permission-action-v1`), so console-ticket signatures and challenges never cross over (tested).
- Device buckets: `permissions-reads` (20/min) and `permission-actions` (12/min), separate from the chat read allowance.

---

## 6. External surfaces

- New routes visible to owner phones and the bearer (reads). New audit file `state/mobile-permission-actions.jsonl` (metadata only, 1 MB rotation, 0600).
- CLAUDE.md gains one line (new agents and, via migration, existing ones).
- The iPhone app (separate release) shows the screens; an older server answers 404/`device-not-allowed`, which the app words as "update the agent".
- Dark on the fleet (dev gate); live on the development agent.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard file is touched; the operator surface is the app:
1. Leads with the primary action: waiting requests are the first section with Approve/Decline on each card; switches are on each row.
2. No raw internals: headlines are server-rendered sentences; no ids, hashes, fingerprints or Slack ids are shown.
3. Destructive de-emphasized: Decline is the bordered secondary button beside the prominent Approve; turning off shows a destructive-styled confirm only after a dialog.
4. Plain language, phone width: verified in the simulator screenshots (slips, features, read-only).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Lists: **proxied-on-read** — this machine's rows plus each online peer's `?scope=local` answer (≤16 peers, 5 s, 500 KB), peers' rows read-only and named; unread, offline and can't-tell machines named.
- Writes: **machine-local by design** (physical-credential-locality) — the device record and presence key that authenticate a write live only on the machine the phone paired with.
- No user-facing notices, no generated URLs. Challenges are in memory (lost on restart; the app asks again).

---

## 8. Rollback cost

Live switch: `mobilePairing.permissionActions.enabled: false` stops the writes at once (read live, also re-checked inside a queued switch). Code revert: the routes disappear; the app shows "update the agent". No migration; the audit file can stay. Changes already made stand as if made in the console (revoke the slip, switch back; a decline stays recorded).

---

## Conclusion

The review changed the design five times (proposal-hash binding, consent-disclosure binding, dev gate consistency, stricter transport, in-chain re-check) before code was final. The phone path is no weaker and no broader than the PIN-confirmed console for these two decisions. Clear to ship behind the dev gate, pending the physical-device prompt check before fleet graduation.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5)
**Independent read of the artifact: concur**

Concur with the review: the console's approve, deny and transition routes behave as before (the operator branch calls the extracted function with no re-check), and the phone path only adds checks (proposal hash inside `execute`, asked-elsewhere, disclosure hash, in-chain re-check, user pinned to `default`). Non-blocking notes: the in-chain re-check does not re-check the consent disclosure (definitions are fixed in code, so negligible); rebase onto current main before the PR.

---

## Evidence pointers

- `tests/unit/mobile-native-permissions.test.ts`, `tests/unit/mobile-native-permissions-claudemd.test.ts`, `tests/unit/mobile-session-terminal.test.ts` (owner-only set)
- `tests/integration/mobile-native-permissions.test.ts`
- `tests/e2e/mobile-native-permissions-alive.test.ts`
- App: `Tests/InstarAppTests/PermissionsDataTests.swift` (6 tests pass); screenshots of slips, features and read-only states taken in the simulator.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
