# Side-Effects Review — WS5.2 one-tap card: live wiring (the missing integration)

**Version / slug:** `ws52-operator-card-wiring`
**Date:** `2026-06-18`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (completion of an already-approved + second-pass-concurred design; no new decision surface)`

## Summary of the change

Completes the live wiring of the WS5.2 one-tap Approve card (approved spec `docs/specs/ws52-operator-tap-not-text.md`). The prior PR (#1223) shipped the card render functions, the payload builder, the connector, and the enforcement — but the render functions were never invoked by the live dashboard controller, and the scan offer lacked the fields/agents the card needs, so the card never appeared on the real Subscriptions tab (a Live-User-Channel-Proof failure caught while driving the actual proof). This change connects the pieces: (1) `src/server/routes.ts` — the `/subscription-pool/follow-me/scan` handler now enriches each consent offer with the card fields (`machineNickname`, `accountLabel`, `expiryText`) and the FD2 `agents` pair, resolved SERVER-SIDE (`resolveAgentFingerprint`) so the operator never types a fingerprint; (2) `dashboard/subscriptions.js` — the controller now POSTs the scan, renders the offers via `renderFollowMeOffers` into `els.followMe`, and wires the Approve tap (delegated, once) → `buildFollowMeIssuePayload` → POST `/mandate/issue-for-machine`; (3) `dashboard/index.html` — adds the `#subFollowMe` container as the panel's lead section + passes `els.followMe` + widens the subscriptions `fetchImpl` to pass method/body (for the POST scan + issue). A new integration test (`tests/unit/follow-me-controller-wiring.test.ts`) drives the real controller end-to-end.

## Decision-point inventory

- `/subscription-pool/follow-me/scan` offer shape — **modify** — adds card fields + FD2 agents (server-resolved); no gating change.
- Approve → `/mandate/issue-for-machine` — **pass-through** — unchanged PIN-gated route; the client now calls it with a server-resolved agents pair instead of nothing.
- No new block/allow gate is introduced.

## 1. Over-block
No block/allow surface — over-block not applicable. (The card renders only when the scan offers a candidate; the Approve POST is the existing PIN-gated route, unchanged.)

## 2. Under-block
No block/allow surface — under-block not applicable. The PIN gate, deny-by-default mandate gate, and R4a delivered-mandate re-verify are all unchanged and still authoritative at enroll time.

## 3. Level-of-abstraction fit
Correct layer — pure presentation/wiring. The card is a dashboard view that reads a server-built offer and calls an existing authority (the PIN-gated issue route). No decision logic moved into the client; the agents pair is resolved server-side (the client never composes authority data).

## 4. Signal vs authority compliance
**Required reference:** docs/signal-vs-authority.md
- [x] No — this change has no block/allow surface. It renders an offer and calls the existing PIN-gated mandate route; all authority (PIN, deny-by-default gate, R4a bounds+signature) is unchanged and server-side. The client holds zero authority — a forged client payload still hits the PIN gate + the mandate gate + the enroll-time bounds/signature re-verify.

## 5. Interactions
- **Shadowing:** the scan POST is added to the existing best-effort `Promise.all` in the controller tick, caught independently (a scan failure degrades to "no card", never blanks the accounts list). No shadowing of accounts/pending.
- **Double-fire:** the Approve listener is delegated and wired ONCE (`state.approveWired`), so re-renders never stack listeners or double-POST; the button disables on submit.
- **Races:** the scan rides the same aborted-controller guard as the other fetches.
- **Feedback loops:** none.

## 6. External surfaces
- **Operator (phone):** the one-tap card now actually appears on the Subscriptions tab and is the panel's lead section. Mobile-complete: tap Approve + PIN; the device-code login link surfaces in the existing Pending Logins panel.
- **Server:** the scan response gains fields (additive; existing consumers unaffected). No token/fingerprint leaves the server in operator-facing text (agents stay out of the DOM by the card's construction).
- **No** change to other agents/users or persistent state shapes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
This change touches an operator surface (`dashboard/index.html`, `dashboard/subscriptions.js`), so this section is required.
1. **Leads with the primary action?** Yes — `#subFollowMe` is inserted as the FIRST section of the Subscriptions panel (above Accounts), so the Approve card is the first thing seen when a follow-me offer exists.
2. **Zero raw internals as primary content?** Yes — the card shows plain language ("Let Mac Mini use your … subscription") + a PIN box + Approve; the FD2 agent fingerprints are resolved server-side and never enter the DOM (verified by the card test); only non-sensitive account/target ids ride as `data-*`.
3. **Destructive actions de-emphasized?** N/A — the card is constructive (Approve) only.
4. **Plain language + phone width?** Yes — single-column card, plain labels, password PIN field, one button; status messages are plain English ("Approved — the machine is logging in now…").

## 7. Multi-machine posture (Cross-Machine Coherence)
**Proxied/served from the fronting machine, by construction.** The scan runs on the machine serving the dashboard (the operator's single dashboard) and offers to enroll OTHER machines that lack the account (peer-views). The Approve issues a cross-machine mandate (`issue-for-machine`) delivered to the target; the FD2 agents are this Echo identity's fingerprint (issuer === target identity). The login link surfaces on the fronting machine's existing Pending Logins panel. No machine-local stranding (the mandate + delivery are the existing durable cross-machine path); the dashboard is the single operator surface (honors one-dashboard).

## 8. Rollback cost
Pure dashboard/route-shape change behind the existing dev-agent gate (dark on fleet). Back-out = revert; no persistent state, no migration. Reverting removes the card wiring (back to the render functions being unused) and the scan's extra fields (additive — harmless if a stale client reads them).

## Conclusion
This change closes the Live-User-Channel-Proof gap that the previous PR left: the card now renders on the real dashboard and the Approve tap drives the real PIN-gated issue route, verified by a new controller integration test (`follow-me-controller-wiring`) plus the existing card/payload unit tests (47 tests green, tsc clean). No new authority or block surface. Clear to ship; the operator-tap → deliver → enroll → answer chain is exercised live in the proof itself.

## Evidence pointers
- `npx tsc --noEmit` — clean.
- `npx vitest run` (6 files) — 47/47 pass, incl. the new `follow-me-controller-wiring` (drives fetch-scan → render → Approve → POST issue).
