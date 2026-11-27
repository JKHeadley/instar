# Side-Effects Review — Instar Documents: linking a member's computer

**Version / slug:** `instar-documents-browser-link`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see end)`

## Summary of the change

Spec `docs/specs/instar-document-viewer.md` §3.6a (approved 2026-11-10), dev-gated behind `documents.enabled` and the existing browser switch:

- `src/server/documentLinkRoutes.ts` (new). The page asks for a single-use 10-minute nonce bound to the browser's own key (`POST /docs/_link/nonce`, public, rate-limited) and polls `POST /docs/_link/status` (nonce in the body, never the URL). Each code records the caller's address (`cf-connecting-ip` trusted only through the agent's own tunnel), a fixed-word browser description and the time; a caller holds at most 3 waiting codes, and a page asking again for the same key replaces its own code. The phone first calls the device-signed `POST /mobile/browsers/link/lookup { nonce, browserPublicKey }`, which returns the fingerprint and that `requester` so the app can show who asked before Face ID. The member's phone, after a local Face ID, sends the device-signed `POST /mobile/browsers/link { browserPublicKey, nonce, machineId, host, expiresAt }`. The server checks the phone's person (members and guests; the owner keeps the console's own flow), the nonce, this machine and host, and an expiry of at most 30 days. It creates a browser record for that person (`role: 'team'`, `scope: 'documents'`, or `documents-read` for a guest, `approvedVia: 'person-phone'`, `linkedByDeviceId`), writes the key-ledger activation, and writes a team-log `browser-bind` event that carries the phone's whole signed request. `GET /mobile/browsers` lists the person's linked computers; `POST /mobile/browsers/:id/forget` revokes one (ledger revocation, registry, `browser-unbind`). A one-minute sweep revokes expired links, links whose phone went, and links of people removed. Allowance: 3 per person, 4 links an hour, counted from the replicated bindings.
- Peer side (`verifyBrowserLink`, `AgentServer.documentBrowserLinkValid`): a linked computer is trusted on another machine only when the linking phone's replicated key signed the request, the phone is bound to the same person and not revoked, the request names this key and expiry, and it has not expired. So the browser binding is never weaker than the phone's.
- Device auth (`mobilePairingRoutes.ts`): a scoped computer is refused on every device-signed route except the chat send, and there only for the exact Send template naming a document this person may Send on, into that document's own conversation (`scopedSendTarget`, `documentScopedSendOk`). A guest's computer can't send or write (403 `read-only-computer` on page writes).
- `MobileDeviceKeys.ts`: the new record fields and `createLinkedBrowser`; the owner's browser pool no longer counts members' computers. `TeamAccessEvents.ts`/`TeamAccessLog.ts`: `browser-bind` (never to `owner`/`owner-browser`) and `browser-unbind`; a link never overrides an existing phone binding. Older peers ignore the new events.
- Page (`dashboard/docs/`): makes a non-extractable key, keeps linked-computer records in their own IndexedDB database (`instar-docs`, apart from the console's), shows the QR (`qr-code.js`, a small encoder checked against a reference implementation) and the fingerprint to compare, polls, and continues into the normal page.
- Test-only switch `documents.loopbackOrigin` (off unless `true`, never written by the migrator): with no stable origin, `POST /mobile/docs/:id/open` sent to this server's own `127.0.0.1:<port>`/`localhost:<port>` from a loopback peer with no forwarding header returns that `http://` origin, and the page cookie drops `Secure` on it only. For the iOS simulator against a development agent.
- Fixes found by real-server tests: the scoped Send read the document as the agent (which can't read shared documents) and used only the pairing origin; it now reads as the computer's own person and uses the link origin.
- Wording: `person-phone` in the approval words and the CLAUDE.md approval line (with a stale-line migration).

Tier 2. About 900 lines across 17 files. Tests: 7 real-server e2e boundary tests (scoped computer refused elsewhere, guest computer can't write, peer refusal after removal/revocation/expiry/switch off, member lowered to guest, owner phone refused, 503 when off), a jsQR decode round trip over all masks and error levels, 3 loopback-origin tests, 8 integration (link flow, single-use nonce, allowance, guest read-only, forget, sweep, peer verification, the Send template), team-log event validation, 31 page/QR unit tests, the e2e alive test.

## Decision-point inventory

- Link admission — **add** — invariant: a member's own phone's device signature, a single-use nonce bound to the key, this machine, a bounded expiry, a counted allowance.
- Peer trust of a linked computer — **add** — invariant: the phone's own signature, replicated key and binding, revocation and expiry.
- Scoped computer's routes — **add** — invariant: a closed set (page writes outside device auth; one exact template send).

## 1. Over-block

- A member with three linked computers must forget one first; a fourth link in an hour waits.
- A linked computer works on any machine only after its binding and the phone's binding have replicated (up to a minute); until then it can't open there.
- An owner's computer keeps using the console's approved-browser flow, not this one.

## 2. Under-block

- Stated limit (spec §3.6a.5): the QR is shown by a page the machine serves, so something running as the agent's user could show its own key; a member who links without comparing the fingerprint would link it. That key could comment as the member on documents they can see and send the Send template, for up to 30 days, labelled as the member's computer. The fingerprint comparison on the phone is the check; the People screen lists each linked computer with Forget.
- Remote code relay (spec §3.6a.6): anyone reaching the tunnel can get a code for their own key and send the QR to a member; the fingerprint can't catch it. Mitigated by showing who asked (browser, address, age) with a warning before Face ID, and the 3-per-caller cap; a member who approves anyway gives that computer the same bounded reach.
- The phone's Face ID before linking is a local app check; the server sees the device signature.

## 3. Level-of-abstraction fit

The link lives in a documents module; it reuses the device registry, key ledger, team log and device auth rather than adding a parallel identity system.

## 4. Signal vs authority compliance

Every new authority is deterministic and cryptographic, fail closed. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

None.

## 5. Interactions

- Device auth: the scoped gate sits right after the existing browser gate, before the person and tier checks, and fails closed if the documents check isn't wired.
- `revokePersonPhones` already covers every `role: 'team'` device, so removing or lowering a person also revokes their computers.
- The owner's browser count now excludes members' computers (members' computers have their own allowance).
- Registry tests updated deliberately (guest-open device routes 35 → 38).

## 6. External surfaces

Two public page routes (nonce, status; no credential, rate-limited, single-use, 10 minutes), three phone routes, a new team-log event type (ignored by older versions). All 503 unless documents are on.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: on a computer that isn't linked, the page leads with the QR code and the one instruction ("Open the Instar app on your phone, go to People → Link a computer, scan this code, and check the app shows the same code:").
2. **Zero raw internals as primary content?** The nonce is never shown. The one identifier shown is the four-group check code, deliberately: comparing it is the security step (§3.6a.5).
3. **Destructive actions de-emphasized?** Forget is on the phone's People screen, not on the page.
4. **Plain language + phone width?** Plain wording; "This code expired." with **Show a new code**; a clear note on what the computer can do. The real-screen check is part of the live proof.

## 7. Multi-machine posture

Unified: the ledger activation, the `browser-bind` with the phone's signed request, and revocations all replicate; every machine verifies the link itself. Machine-local by design: the nonce (`machine-local-justification: physical-credential-locality` — a ten-minute single-use code bound to the machine the computer is talking to; the phone sends the link to that machine).

## 8. Rollback cost

Turn documents off: the routes answer 503 and no computer can link; linked computers' page access stops with the page routes. Reverting removes the routes; `browser-bind` rows stay in the log and are ignored by older code; records keep their extra fields, harmless.

## Release note

`upgrades/next/instar-documents-browser-link.md`.

## Second-pass review

Independent reviewer subagent, 2026-11-10 17:30 PST, read the spec, the app contract and the full diff. No blockers. Six should-fixes, all fixed above: remote phishing of a link code (who-asked display + spec §3.6a.6), a global code-pool lockout (per-caller cap, tunnel-only trust of `cf-connecting-ip`), no tests of the privilege boundaries (7 e2e tests), the QR never decoded (jsQR round trip), a failed save turning into a 500 without the unbind row (undo runs every step, reported via degradation), and phone key rotation breaking links on peers (`linkedByKeyHash`). Nits fixed: expiry sweep also from `reconcileTeamPhones`, nonce out of the URL, a stale comment, one parse of `bodyB64`.

**Reviewer:** independent reviewer subagent (general-purpose), 2026-11-10
