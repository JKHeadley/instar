# Side-Effects Review — Native Accounts, Spend and Resource usage screens (read-only)

**Version / slug:** `mobile-native-capacity-screens`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent — concur (see below)`

## Summary of the change

Three read-only routes for the Instar iPhone app, owner phones (device-signed) or the bearer token only: `GET /mobile/accounts` (subscription accounts across the machines that answer: sign-in state per machine, usage windows with reset times), `GET /mobile/spend?window=today|week|month` (recorded pay-per-use cost added across machines with each machine's own state, this machine's paid-route limits, conversation token totals, and what each figure covers), `GET /mobile/resources` (CPU and memory for the agent, its server and sessions on this machine). New module `src/server/mobileCapacityRoutes.ts` (pure summarizers with explicit field allowlists, a 15 s single-flight cache, owner-or-bearer guard, degradation reporting); `routes.ts` extracts `subscriptionPoolScopeView()` and `routingSpendSummaryResult()` from their handlers (moves, plus one hardening: a peer's account rows are attributed to the peer that was asked and named from this machine's registry) and mounts the routes with a peer fan-out for spend; `DEVICE_ALLOWLIST` gains three `ownerOnly` GET entries with their own 20/min bucket; CapabilityIndex gets a `mobileCapacityScreens` entry (no prefix); the Mobile app routes CLAUDE.md block gets one bullet (template + idempotent migration). Tier 2; spec converged at the 6-round cap. App screens ship in the agent-home `apps/instar-ios` repo (separate commit).

Proportion: ~10 files, ~1,100 added lines including tests; 6 review rounds (the Tier-2 cap); the late rounds were multi-machine money semantics, not access.

## Decision-point inventory

- `DEVICE_ALLOWLIST` (mobilePairingRoutes.ts) — add — three exact-path GET rules, `ownerOnly`, own bucket `capacity-reads` (20/min).
- `ownerOrBearer` (mobileCapacityRoutes.ts) — add — route-level re-check: explicit bearer match or owner-role device; everything else 403.
- Field allowlists in the summarizers — add — fixed redaction contract.
- `/subscription-pool?scope=pool` peer attribution — modify — remote account and email-gap rows take the asked peer's id and the local registry nickname instead of a peer-supplied id/nickname.

---

## 1. Over-block

An MSP (non-owner) phone is refused these three screens; that is the people-and-roles owner-only default, not an over-block. The 20-per-minute shared bucket could refuse a very fast manual refresher (the app only reads on open, pull or window change); the app words a 429 as "Too many refreshes in a minute." No other legitimate input is refused.

## 2. Under-block

An owner phone that is lost but not revoked can read account emails, usage and spend until revoked — the same exposure as every other owner-phone read (chat, sessions); revocation is the existing control. A bearer-token holder already reads all raw sources, so the summaries add nothing for it.

## 3. Level-of-abstraction fit

Right layer: authentication stays in the existing device authenticator (`ownerOnly`), the routes are thin read models over the same server functions the console's routes use (extracted, not copied), and display rules live in pure summarizers next to the console's view-model rules they mirror. No new gate.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface beyond deterministic authentication of the principal.

The only refusals are principal checks (path allowlist, resolved owner role, explicit bearer match): invariants in the existing device model, not judgment calls on content. Nothing here blocks agent behaviour or messages.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Display classifications (sign-in state, usage tone, spend basis, staleness lines) copy the console's documented rules and gate nothing.

## 5. Interactions

- **Shadowing:** `ownerOnly` in the device layer refuses non-owner phones before the route; the route's own check is defence in depth and never contradicts it. The ops-screens PR (#2706, open) adds sibling routes and its own allowlist lines, CLAUDE.md bullet (after a different anchor line) and CapabilityIndex text (a different entry); the two can merge in either order, with a rebase keeping all allowlist entries.
- **Double-fire:** the spend fan-out and accounts fan-out reuse `poolPeerFetch` (rope recording). The 15 s single-flight cache keeps phone refreshes from multiplying peer reads.
- **Races:** none with state; reads only. The in-use resolver is one instance for the server's life (its own 60 s cache), never per read.
- **Feedback loops:** none. A failed read records one `MobileCapacityScreens.read` degradation; nothing reads that back into these routes.
- **Peer-attribution hardening:** the console's Accounts page now names a peer's rows by the asked peer and this registry's nickname. For any peer on current code this is identical (the plain route never sets `machineId`); only a peer that wrote another machine's id into its rows changes.

## 6. External surfaces

- New HTTP routes visible to paired owner phones and bearer callers; no change to existing route answers except the peer-attribution hardening above.
- Peer traffic: `/mobile/spend` asks each online peer's plain `/routing-spend/summary` and `/tokens/summary` (bearer, 5 s timeout), at most once per 15 s per window.
- No persistent state, no messages, no notices, no URLs generated.
- **Operator surface:** no operator actions are added (read-only). The phone screens say where actions live ("Signing in is done from the dashboard", "Limits are changed from the dashboard"), and the agent page keeps its Open dashboard link.

## 6b. Operator-surface quality

No dashboard/console file is touched — not applicable to the console. The app screens (separate repo) lead with a plain headline, show no ids, and were checked at phone width in the simulator (screenshots).

## 7. Multi-machine posture

- Accounts: **proxied-on-read** (`subscriptionPoolScopeView`, `?scope=pool` fan-out); registered offline machines listed in `offline`, peers that failed in `unread`, and any of either scopes the headline.
- Spend recorded cost + conversation tokens: **proxied-on-read** (each online peer's plain `/routing-spend/summary` and `/tokens/summary`), each machine listed with its state; offline machines listed, not counted.
- Spend limits: machine-local-justification: physical-credential-locality — the caps store, committed money ledger and money-layer status are kept where the metered credential is used; each paid route names its designated machine, and committed figures booked elsewhere are null, never a local $0.
- Resources: machine-local-justification: hardware-bound-resource — CPU and memory of this machine's processes; the answer names the machine.
- No user-facing notices, no durable state, no generated URLs.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state. The app's screens then get `403 device-not-allowed` and show "update the agent to see this here". The revert also restores the old peer attribution in the console's pool view.

## Conclusion

The review reshaped the design substantially (peer attribution, pool-wide spend with per-machine states, the designated-machine money semantics, honest coverage windows, a cache and bucket against fan-out). Remaining accepted risks are listed in the convergence report's Left behind (a UTC-midnight edge on peer spend windows, snapshot disjointness, retired machines in the registry). Clear to ship after Local Verify.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Opus 5.5)
**Independent read of the artifact: concur**

Concur with the review: the owner check fails closed at the device layer and again in the route, and the field allowlists send no paths, ids, credential references or lease-holder ids. Its one note (a peer's `emailGaps` rows still kept a peer-supplied machine id/nickname in the console's pool view) was fixed in the same change: gap rows are now attributed to the asked peer like its accounts.

---

## Evidence pointers

- Unit: `tests/unit/mobile-native-capacity-screens.test.ts` (26), `tests/unit/mobile-native-capacity-screens-claudemd.test.ts` (4); neighbouring CapabilityIndex, discoverability, subscription-pool scope, routing-spend view, mobile-pairing, scaffold-templates suites green.
- Integration: `tests/integration/mobile-native-capacity-screens.test.ts` (14) through the production auth + device middleware.
- E2E: `tests/e2e/mobile-native-capacity-screens-alive.test.ts` (1) on a production AgentServer boot with a phone paired via redeem/confirm.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added (the 15 s cache is request-driven, not a loop).
