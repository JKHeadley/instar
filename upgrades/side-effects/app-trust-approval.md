# Side effects: approving trust raises from the Instar app

Spec: `docs/specs/app-trust-approval.md` (converged at the 6-round cap, then narrowed during the build; see its Convergence section). Constitution: the paired-device text Justin approved on 2026-11-16 at 22:13 PST (instar #3296, instar-2 #205). Built on #3236 (trust journey stage 0, parts B and C).

## What changes

- **Store:** `TrustJourneyStore` gains four immutable record types:
  - `device-acceptance`;
  - `device-acceptance-withdrawn`;
  - `device-approval` (an accepted device approves a new one);
  - `outcome` (applied or not-applied, keyed by requestId).
- **Proof:** `TrustRaiseGuard` gains proof kind `accepted-device`. It is issued by the same single issuer, and only after a durable consumption. `proofCovers` accepts it alongside `accepted-account`.
- **`AccountPathService`:**
  - `propose` records a device request when no chat reaches the owner but a device acceptance is current.
  - `onPresenceApproval` makes the spec's checks, then uses the shared `consume`: one consumption key per request, `tj:consumption:<requestId>`. The outcome is recorded after the apply returns; with no outcome, the status reads `unknown` and nothing is retried.
  - Acceptance, approval of a new device, withdrawal, the 7-day listing, and `noteDevicePaired`.
- **Routes**, new in `mobilePermissionsRoutes.ts` and `mobileTrustApproval.ts`:
  - `GET /mobile/trust/requests`;
  - `POST /mobile/trust/requests/:id/approve`;
  - `POST /mobile/trust/device-acceptance`;
  - `POST /mobile/trust/device-acceptance/withdraw`;
  - challenge kinds `approve-widening` and `accept-device`.
- **Switch:** a new `mobilePairing.trustApproval.enabled`, separate from phone permission changes.
  - The installer writes it on for new agents.
  - The fleet stays dark until it is set; development agents have it live.
  - Withdrawal works with the switch off, because it only narrows.
- **Device registry:** an `onActivated` listener fires after any pairing path makes a device active. Every new pairing then reaches the approving devices as a notice.
- **Who can take the first acceptance** (one at a time):
  - the device the Mac app paired locally (`local-install`, with a `localBinding`);
  - or a phone that device approved: the iPhone paired during setup when the Mac has no Touch ID.
- **Write domains and awareness:** a write-domain entry for `/mobile/trust/` (cluster-shared), a CapabilityIndex entry, and an awareness note.

## What can approve, and what can't

- **Can approve:** only a device signature plus a presence signature over a single-use challenge bound to the device, the host and the exact action line, under a current acceptance for that device's key.
- **Can't approve:** the bearer token, the dashboard PIN, any request body. A routes test asserts the bearer is refused at every trust route.
- **A Mac:** approves only with a `biometryCurrentSet` key, enforced on the server too (`key-policy-not-allowed`).
- **Not the deciding machine:** refuses before issuing a challenge.
- **Changed keys:** a re-keyed or revoked device loses its acceptance automatically.

## Smaller behaviour notes

- **Withdrawal by the agent:** the agent can also withdraw device acceptances at the person's request: `POST /trust/acceptance/withdraw` with `adapter: "device"`. It only narrows.
- **Switch off:** while `mobilePairing.trustApproval` is off, no device counts as an approver. A proposal with no chat answers `no-approver` instead of recording a request nobody could approve.
- **Notices:** the person's other approving devices hear of every new pairing, whatever path made the device active.
- **The listing:** it returns the calling device's own key fingerprint (`thisDeviceKey`), so the app signs an acceptance over exactly what the server checks.
- **The approval code:** the feature-toggle path keeps #3236's rule; the agent never sees the code.

## Blocking authority

None is added. The change adds a way for the person to say yes; it never blocks the agent's actions. Every refusal is deterministic: signatures, hashes, record state. No language model judges anything.

## Limits (stated in the spec and in every disclosure)

- **Device list:** kept on the agent's own computer, so a device approval is a duty, not an independently verified guarantee. Attestation would make device keys verifiable later. It would not protect saved records; running the server under a separate account would.
- **Local override and first pairing:** the server can't tell the app from the agent on the same computer. Both are recorded and shown on the other approving devices.

## Rollback

- **Turn it off:** set `mobilePairing.trustApproval.enabled` to false. Existing acceptances stay recorded but can't be used while it's off, and withdrawal still works.
- **Records:** the new record types are ignored by older readers (the reader rule), and the chat path is unchanged.

## Second-pass review

- **Round 1** (independent reviewer): **concern raised.** The service-level design held up on all five questions, with one concern and three smaller points:
  - **Concern:** after main was merged in, the route tests failed 8 of 8. The fixture bound local devices to a non-loopback host, which #3259's `localBindingOk` refuses, so none of the route-level security checks were being verified. Fixed: locally-bound devices use `127.0.0.1:4040`, and each request carries its device's own host.
  - **Race on the first acceptance:** two eligible devices accepting at the same moment could both pass. Fixed: a first acceptance takes a fixed key per generation (`tj:device-acceptance:first:<n>`), so the store's key reservation lets exactly one win. A unit test covers it.
  - **Requests nobody could approve:** with the switch off, a proposal could record a device request no one could approve. Fixed, as above.
  - **The approval code:** the toggle path had lost #3236's rule (this branch was cut before that fix). Restored by merging #3236's head.
  - **Missing from this review:** the agent-side withdrawal. Now added above.

## Live proof (server)

Run on the throwaway agent Maple (`home3`, port 4043), on this branch's build, 2026-11-17 01:28–01:31 PST. A locally-paired Mac was stood in by software keys over loopback at its stored host; the Touch ID tap itself needs a real device.
- **Switch unset (an existing fleet agent):**
  - The device's acceptance challenge was refused: 503 `trust-approval-off`.
  - The agent's raise answered `no-approver`.
- **Switch on (as a new install writes it):**
  - **Acceptance:** recorded as the first, local device (`via: local-install`).
  - **The agent's raise** (`gmail write: log → autonomous`): sent to the device (202, `via: device`) and listed as open.
  - **The bearer token** trying to approve: 403 `device-signature-required`.
  - **The presence-signed approval:** `applied`, with the disclosure in its message. `GET /trust` then showed `gmail.write: autonomous`, source `user-explicit`, "approved by the person on a paired device".
  - **The same request approved again:** 409 `already-approved`.
  - **Withdrawal from the device:** `withdrawn: 1`. The next raise (`calendar write`) answered `no-approver`.
- **Wording found live:** the no-approver message named an "Agent screen → Set up approvals" that the app doesn't have. It now names "Changes to approve", which is what the iPhone (under Permissions) and the Mac app call it.

- **Round 3** (after the live run): the reviewer checked the wording fix and raised a concern. Three refusal messages still named "Set up approvals", and the awareness line was garbled. Both were fixed, and the reviewer concurred.

- **Round 4** (merge-line rule test, browser-device-readers): two direct `.publicKey` reads, in `mobileTrustApproval.ts` (the snapshot fingerprint) and `MobileDeviceKeys.replacePresenceKey`, now go through `deviceKeyOf`. The result is unchanged for app devices, and a browser is never an approving device. The reviewer concurred with both; 46/46.

- **Round 5** (merge-line rule test, owner-only pin): the four /mobile/trust routes (list, approve, device-acceptance and its withdraw) join the pinned owner-only set in tests/unit/mobile-session-terminal.test.ts. TEAM_ROUTE_TIERS has no trust route, so a team phone never reaches them. The reviewer concurred, and suggested the withdraw line; 21/21.

## Local-verify fix (merge line, 2026-11-17 14:22Z)

The e2e alive test got 401 device-unauthorized: tests/helpers/trustAppServer.ts marked a local device (localBinding, approvedVia local-install) but kept its stored and request host at the tunnel name, and localBindingOk requires the loopback host (mac-app-creates-agent §A, #3259). The helper now stores and signs with 127.0.0.1:4040 for local devices. Test-only; no product change.

## Local-verify fix 2 (merge line, 2026-11-17 17:44Z)

team-access-status-table: the approve route (`tr-<12 hex>-<6>`) had no generated sample path; the test NAMED table gains `/mobile/trust/requests/tr-0123456789ab-abc123/approve`. Test-only; 6/6.
