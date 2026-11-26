# Side-Effects Review — Native Phones, Messages to you, and Insights screens

**Version / slug:** `mobile-native-phones-messages`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Two read-only routes for the Instar iPhone app, owner phones (device-signed) or the bearer token only: `GET /mobile/messages` (held sends grouped by conversation with fixed reason words, expired and unconfirmed counts, recording readiness, and each online peer's held count and groups through that peer's `?scope=local` answer) and `GET /mobile/insights` (each insight page's headline, lines and numbers here and on each online peer, read cached-only so no model call starts). New module `src/server/mobilePhonesMessagesRoutes.ts` (pure summarizers with explicit field allowlists, owner-or-bearer guard, 15 s single-flight cache, degradation reporting). `TelegramOriginRuntime.deliverySummaryInputs()` returns the five `status()` parts the phone needs without the notice-socket, browser, detector and retention reads. `DashboardInsightEngine.getAll/getInsight` gain `{ cachedOnly }` (serve a fresh cached AI summary or the deterministic floor; never call the model). `routes.ts` mounts the routes with a peer fan-out (at most 16 peers, 5 s, bodies read incrementally and cancelled past 500,000 bytes). `DEVICE_ALLOWLIST` gains two `ownerOnly` GET entries sharing bucket `phones-messages-reads` (20/min). `POST /mobile/devices/:id/revoke` lets an active owner-role phone remove another phone held on this machine (everyone else: `403 owner-phone-required` for another id; no forwarding from a device). CapabilityIndex entry `mobilePhonesMessagesScreens`; one CLAUDE.md bullet in the Mobile app routes block (template + idempotent migration). App screens are in the agent-home `apps/instar-ios` repository.

Tier 2 (widens device-key read access and a device-key write). Proportion: 9 source/test files changed or added in the server (~900 added lines including tests); 6 spec review rounds (the Tier-2 cap; rounds 3-6 each narrowed a counting or wording contract).

## Decision-point inventory

- `DEVICE_ALLOWLIST` — add — two exact-path GET rules, `ownerOnly`, shared own bucket.
- `ownerOrBearer` — reuse — explicit bearer match or owner-role device.
- Revoke route — modify — another device's id is accepted only from a device whose registry record is `active` and whose resolved person is the owner; read at request time.
- Bearer reading the messages summary while the raw origin routes keep their operator-session gate — add — fixed field allow-list.
- Field allowlists in the summarizers — add — fixed redaction contract.

---

## 1. Over-block

An MSP phone is refused the reads and cannot remove other phones (people-and-roles owner-only default). A pending owner phone cannot remove another phone until it is confirmed. The shared 20-per-minute bucket could refuse a very fast manual refresher; the app reads only on open and pull.

## 2. Under-block

A lost but unrevoked owner phone can now remove the owner's other phones: a new credential-removal capability for a device, granted deliberately because the owner has it in the console without a PIN; its harm is bounded (re-pair restores), and each removal records the requesting device in `featureEvidence` and the key ledger, and re-pairing restores a removed phone. The durable held read is bounded at 200 rows (the same bound the console's status uses), so a machine with more than 200 held sends undercounts there. `scrubSecrets` does not recognise every key shape; it is the shared scrubber every phone screen uses (already filed as a scrubber gap with the plans-people change).

## 3. Level-of-abstraction fit

Authentication stays in the device authenticator; the revoke owner check sits beside the existing self-only check in the route that owns revocation. The summaries are thin read models over the runtime and engine; the two engine/runtime additions are read-only narrowings of existing calls. No new gate.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface beyond deterministic authentication of the principal.

The refusals are principal checks (path allowlist, resolved owner role, registry status, explicit bearer match). Insight text is display data, never instructions.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Grouping, reason words and source words copy the console's documented rules and gate nothing.

## 5. Interactions

- **Shadowing:** `ownerOnly` refuses non-owner phones before the read routes; the route check is defence in depth. The revoke allowlist rule is unchanged (it admits non-active statuses for self-revoke), so the owner check in the route is the only gate for another id, and it reads status from the registry.
- **Siblings:** this anchors after the plans-people allowlist entries, CLAUDE.md bullet and CapabilityIndex entry; the owner-only named set in `tests/unit/mobile-session-terminal.test.ts` gains two lines.
- **Double-fire / loops:** a peer's `?scope=local` answer never reads peers, so fan-out is one level. The 15 s single-flight cache is keyed by route and scope.
- **Spend:** `cachedOnly` never calls the model; the console's own reads are unchanged.
- **Existing tests:** the pairing-routes revoke test that expected an active owner phone to be refused for another phone now expects success, and new cases cover pending and MSP phones and the no-forwarding 404.

## 6. External surfaces

- New HTTP routes for owner phones and bearer callers; `?scope=local` is how machines read each other's summaries.
- New to the bearer: grouping and fixed reason words of all held sends (not only lease holds), the expired and confirmed/unconfirmed counts, and readiness items. No audit record field (origin, chat, message, account ids, content) crosses.
- Changed: an owner phone may remove another phone on its machine.
- Peer traffic: at most 16 peers per route per 15 s, agent token, 5 s, 500,000-byte bodies.
- No persistent state of its own, no messages, no notices, no generated URLs.

## 6b. Operator-surface quality

No console file touched. The app screens lead with a plain headline, show no ids, name machines by nickname, explain "update the agent" and "only the owner's phone" cases, and warn clearly before removing the phone in hand. Checked at phone width in the simulator with seeded answers (screenshots).

## 7. Multi-machine posture

- Messages: proxied-on-read (each online peer's `/mobile/messages?scope=local`); per-machine state listed, unanswering and offline machines named.
- Insights: proxied-on-read (each online peer's `/mobile/insights?scope=local`), cached-only on every machine.
- Phones: machine-local-justification: physical-credential-locality — a device key verifies only on the machine it paired with; the bearer path keeps its peer forwarding.

## 8. Rollback cost

Revert and ship a patch. No state written by the reads. Phones removed while live stay removed (re-pair). The app then shows "update the agent" for the reads and explains the old self-only refusal for removal.

## Conclusion

Review moved the messages read off the full status call, made the phone never spend on a model, replaced the lease-hold-only peer count with each peer's own summary, gave the revoke refusal its own code, bounded peer bodies while reading, carried peer truncation, lower-bound counts and machine-scoped keys through the merge, and kept both the local and peer facts in every headline. Clear to ship after Local Verify.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Opus 5.5)
**Independent read of the artifact: concur**

Concur with the review: only an active owner-role phone (status read from the registry, person resolved) can remove another phone, and a device request for a phone held elsewhere still answers 404 before any forwarding; both new allowlist entries are GET-only, owner-only, bodyless and share their own bucket, with `ownerOrBearer` in the route as well; the messages summary carries counts, fixed reason words, times and verified conversation names, no message text or audit records; `cachedOnly` returns the floor before any model call; peer reads are bounded (16 peers, 5 s, 500 KB, bad JSON counted as not answering). It noted that owner phones now see conversation names and hold reasons that the raw route keeps behind a PIN session, accepted because the reads are owner-only. (After this pass, review round 6 further reduced the readiness rows to fixed vocabulary.)

---

## Evidence pointers

- Unit: `tests/unit/mobile-native-phones-messages.test.ts`, `tests/unit/mobile-native-phones-messages-claudemd.test.ts`, `tests/unit/mobile-session-terminal.test.ts`.
- Integration: `tests/integration/mobile-native-phones-messages.test.ts`, `tests/integration/mobile-pairing-routes.test.ts` (revoke).
- E2E: `tests/e2e/mobile-native-phones-messages-alive.test.ts`.
- App: `apps/instar-ios/Tests/InstarAppTests/PhonesMessagesDataTests.swift` (6 tests, simulator), screenshots of each screen.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added (the 15 s cache is request-driven).
