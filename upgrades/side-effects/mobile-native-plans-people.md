# Side-Effects Review — Native Plans, What I've learned about you and Other agents screens (read-only)

**Version / slug:** `mobile-native-plans-people`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent — concur (see below)`

## Summary of the change

Three read-only routes for the Instar iPhone app, owner phones (device-signed) or the bearer token only: `GET /mobile/plans` (projects and initiatives across the machines that answer, grouped as the console groups them), `GET /mobile/learned` (learned preferences from the session-start block and the scrubbed corrections being watched, across machines), `GET /mobile/agents` (other agents' claimed names, pairing state and delivery health across machines, plus this machine's channel registry verdicts). New module `src/server/mobilePlansPeopleRoutes.ts` (pure summarizers with explicit field allowlists, one text cleaner for all shown text, per-machine plan identity and a correction merge that ignores future-dated copies, owner-or-bearer guard, 15 s single-flight cache, degradation reporting). `routes.ts` extracts `preferencesSessionContext()`, `channelRegistryReport()` and `peersHealthPoolView()` from their handlers (moves only; the HTTP answers are unchanged) and mounts the routes with a peer fan-out for initiatives and corrections (bodies over 2,000,000 characters are not parsed, 5 s timeout). `DEVICE_ALLOWLIST` gains three `ownerOnly` GET entries with their own 20/min bucket; CapabilityIndex gets a `mobilePlansPeopleScreens` entry (no prefix); the Mobile app routes CLAUDE.md block gets one bullet after the capacity bullet (template + idempotent migration). App screens are in the agent-home `apps/instar-ios` folder.

Tier 2 (widens device-key read access). Proportion: ~11 files, ~1,300 added lines including tests; 6 spec review rounds (the Tier-2 cap).

## Decision-point inventory

- `DEVICE_ALLOWLIST` (mobilePairingRoutes.ts) — add — three exact-path GET rules, `ownerOnly`, own bucket `plans-people-reads` (20/min).
- `ownerOrBearer` (imported from mobileCapacityRoutes.ts) — reuse — explicit bearer match or owner-role device; everything else 403.
- Field allowlists in the summarizers — add — fixed redaction contract.
- Cross-machine merge — add — corrections de-duplicated by their machine-qualified id (this machine's copy wins ties, a future-dated copy is no evidence); plans keep (machine, id) identity and are never merged.

---

## 1. Over-block

An MSP (non-owner) phone is refused these screens: the people-and-roles owner-only default, not an over-block. The 20-per-minute shared bucket could refuse a very fast manual refresher; the app reads only on open and pull. A peer body over 2,000,000 characters is treated as not answering and named as such; a real agent's initiative list is far below that.

## 2. Under-block

An owner phone that is lost but not revoked can read plan titles, learned preferences and agent names until revoked: the same exposure as every other owner-phone read; revocation is the existing control. `scrubSecrets` does not recognise every key shape (an `sk-ant-…` key with its dash-separated prefix passes it); this is the shared scrubber every phone screen uses, and the text it guards (plan titles, correction summaries already scrubbed when recorded, preference sentences) is the owner's own and already shown in the console. Filed to the feedback queue as a scrubber gap (fb-3fd2df1e-059) rather than patched here.

## 3. Level-of-abstraction fit

Right layer: authentication stays in the device authenticator (`ownerOnly`); the routes are thin read models over the same server functions the console's routes use (extracted, not copied); the display rules sit in pure summarizers that mirror the console's view-model rules. No new gate.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface beyond deterministic authentication of the principal.

The only refusals are principal checks (path allowlist, resolved owner role, explicit bearer match), invariants of the existing device model. Nothing blocks agent behaviour or messages.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Grouping, health words and channel words copy the console's and the registry's documented rules and gate nothing.

## 5. Interactions

- **Shadowing:** `ownerOnly` refuses non-owner phones before the route; the route's own check is defence in depth.
- **Sibling PR #2706 (open):** adds its own allowlist lines, CLAUDE.md bullet (after the route-list bullet) and CapabilityIndex text inside `mobilePairing`. This change anchors after the capacity bullet and has its own CapabilityIndex entry, so the two merge in either order; the owner-only named set in `tests/unit/mobile-session-terminal.test.ts` must keep all entries on rebase.
- **Double-fire:** peer reads reuse `poolPeerFetch` (rope recording) and the existing `pairingPoolMerge` (3 s cache) and `readReaperPoolPeers`; the 15 s single-flight cache keeps phone refreshes from multiplying peer reads.
- **Races:** none with state; reads only.
- **Feedback loops:** none. A failed read records one `MobilePlansPeople.read` degradation; nothing reads it back.
- **Extraction:** `/preferences/session-context`, `/channels` and `/threadline/peers/health?scope=pool` now call shared functions; their answers are byte-for-byte the same (their existing tests stay green).

## 6. External surfaces

- New HTTP routes visible to paired owner phones and bearer callers; no change to existing route answers.
- Peer traffic: `/mobile/plans` asks each online peer's plain `/initiatives`, `/mobile/learned` each peer's `/corrections?limit=40` (agent token, 5 s timeout), at most once per 15 s per route; `/mobile/agents` reuses the existing pairing and delivery pool merges.
- No persistent state, no messages, no notices, no URLs generated.
- **Operator surface:** no operator actions added. The screens say where actions live ("To change one, tell me in chat", "Conversations and pairing are in the console's Other agents page", blockers and autonomous runs in the console's Plans page).

## 6b. Operator-surface quality

No console file touched. The app screens lead with a plain headline, show no ids, and were checked at phone width in the simulator with seeded answers (screenshots), including the "update the agent" message for an older server.

## 7. Multi-machine posture

- Plans: **proxied-on-read** (this tracker + each online peer's `/initiatives`); offline machines counted in `offline`, failed peers in `unread`, either one scopes the headline.
- Preferences: **replicated** through the existing preference paths `/preferences/session-context` already reads (state-sync union reader or the ws21 replica merge); own store when both are off.
- Corrections: **proxied-on-read** (each online peer's `/corrections?limit=40`), rows from peers name their machine.
- Pairings and delivery health: **proxied-on-read** through the existing `?scope=pool` merges.
- Channel registry: machine-local-justification: physical-credential-locality — each verdict is about this machine's own live connections (the relay socket held with this machine's identity, messaging adapters bound to credentials on this disk); the app labels the section "Channels on this machine".
- No user-facing notices, no durable state, no generated URLs.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state. The app's screens then get `403 device-not-allowed` and show "update the agent to see this here".

## Conclusion

The review tightened identity and the merge (plans per machine, corrections by machine-qualified id, future-dated copies and ties, documented switched-off 503s only), made coverage visible (offline and unanswering machines, this machine's own read state), bounded what is parsed from peer bodies, applied one text cleaner to every shown string, and turned the row caps into decided limits. Clear to ship after Local Verify.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Opus 5.5)
**Independent read of the artifact: concur**

Concur with the review: all three routes run `ownerOrBearer` first (403 + no-store otherwise) and the allowlist entries are GET-only, `ownerOnly`, own bucket; every output field is fixed words, numbers, `rowKey` hashes or `cleanText` output, with no raw ids, paths, invite material, message bodies or channel evidence text; no blocking authority is added; the extracted `/preferences/session-context`, `/channels` and `/threadline/peers/health?scope=pool` keep their statuses and bodies. Its one note (an agent row key is an unsalted hash of a public fingerprint) is accepted and listed in the convergence report's Left behind.

---

## Evidence pointers

- Unit: `tests/unit/mobile-native-plans-people.test.ts`, `tests/unit/mobile-native-plans-people-claudemd.test.ts`, `tests/unit/mobile-session-terminal.test.ts` (owner-only named set).
- Integration: `tests/integration/mobile-native-plans-people.test.ts` through the production auth + device middleware.
- E2E: `tests/e2e/mobile-native-plans-people-alive.test.ts` on a production AgentServer boot with a phone paired via redeem/confirm.
- App: `apps/instar-ios/Tests/InstarAppTests/PlansPeopleDataTests.swift` (5 tests, simulator).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added (the 15 s cache is request-driven, not a loop).
