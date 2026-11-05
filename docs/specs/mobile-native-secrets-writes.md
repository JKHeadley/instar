---
title: "Ask for a key and cancel a request from the Instar iPhone app"
slug: "mobile-native-secrets-writes"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-secrets-writes.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively; told at 2026-11-04 17:08 PST that these writes are the next build)"
review-convergence: "2026-11-05T05:08:53.048Z"
review-iterations: 4
review-completed-at: "2026-11-05T05:08:53.048Z"
review-report: "docs/specs/reports/mobile-native-secrets-writes-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## 1. Problem

Justin asked for every feature to work natively in the iPhone app. `docs/specs/mobile-native-secrets.md` delivered Passwords & keys read-only and left two writes in the console: asking someone for a password or key, and cancelling a request. On the phone they need proof the owner is present: a phone can be picked up, so the device key alone isn't enough to make a capability link or cancel one. The app now has that proof, the Face ID presence key used by Permission slips (`docs/specs/mobile-native-permissions.md`). The agent's own bearer route stays as it is: the agent asking for a key is a normal part of its work, and this change requires presence only for phone writes.

## 2. What exists

- `POST /secrets/request` and `DELETE /secrets/pending/:token` (bearer) run `SecretDrop.create` and `SecretDrop.cancel`. The console calls them after its PIN unlock. Create answers with the token and the drop link; the token is the capability to fill the request.
- `mobilePermissionsRoutes.ts` has the write gate: feature switch `mobilePairing.permissionActions`, device signature, local TLS or loopback, active owner phone, a configured dashboard PIN, the enrolled presence key, a single-use challenge bound to device, Host and exact action line, the presence signature, and an audit row.
- `GET /mobile/secrets` shows each waiting request by a one-way `key`, `rowKey('secret-request', token)`.

## 3. Design

Two new actions on the existing permission action path, so there is one write gate, one challenge store, one audit file and one switch. This widens `docs/specs/mobile-native-permissions.md`, whose scope named only approvals and switches: `mobilePairing.permissionActions` now also covers these two writes.

- `request-secret`: line `request-secret new <sha256(label)> <sha256(note)> <topicId|none>`. `POST /mobile/secrets/requests` with `{label, note, topicId, challenge, presenceSig}`.
- `cancel-secret`: line `cancel-secret <key>`. `POST /mobile/secrets/requests/<key>/cancel` with `{challenge, presenceSig}`.

The challenge comes from `POST /mobile/permissions/challenge`, as for the other actions, which gains three optional fields. Its body is `{action: 'request-secret', target: 'new', label, note, topicId}` or `{action: 'cancel-secret', target: <key>}`, and the action post carries the same `label`, `note` and `topicId`. Both build the line through one function. The hashes are SHA-256 of the exact UTF-8 bytes sent, with no trimming or normalisation on the server. The server refuses a label with outer spaces (`bad-label`), so the app trims before it asks and the same bytes are hashed at both steps. An absent note is the empty string; an absent `topicId` is `none`; a topic is its decimal digits. A shared test vector with a non-ASCII label and an empty note runs in both the server and the Swift tests. Each write needs its own Face ID or passcode prompt and a fresh challenge, as the app flow does for the other actions.

Input rules: `label` is required, at most 120 UTF-16 code units (JavaScript `length`; the app counts the same way) non-empty, equal to its own JavaScript `trim()` (the server's whitespace rule; the app trims with Swift's whitespace set, and any character the two sets differ on is refused with `bad-label`, which the app words plainly rather than altering what was signed), with no character in U+0000-U+001F or U+007F-U+009F (`bad-characters`), and is refused if it has a recognisable credential shape (the `TOKEN_RUN` rule the read uses). That catches a pasted key of those shapes, not every password, so the sheet also says not to put the key there. `note` is optional and may be empty; at most 500 UTF-16 code units; the same credential-shape refusal, and the same control-character refusal except that newlines and tabs are allowed; outer spaces are kept as sent, since the bytes are signed (the app trims before it asks). `topicId` is absent, a positive safe integer, or that integer as decimal digits with no leading zero (the app's action fields are strings): the conversation told when the key arrives. The expiry is fixed at one hour, the longest the console offers, because the link is collected separately.

The duplicate check and the create run in one synchronous call, so no other request can run between them on this server. A console create does not take part: the console's own form can still make a request with the same name, as it can today.

Answers. Ask: 201 `{ok, key, expiresAt}`. Cancel: 200 `{ok}`. Refusals carry a fixed code and no raw error. Input: `label-required`, `bad-label`, `label-too-long`, `note-too-long`, `bad-characters`, `looks-like-a-secret`, `bad-topic`. From the action: `already-waiting` (a live request on this machine has the same trimmed label under JavaScript `toLowerCase`: a repeat tap or a lost answer must not stack up links), `too-many-requests` (only SecretDrop's pending cap; any other failure is reported and answers the fixed `permission-action-failed`), `request-gone` (a 404, which the app reads by its code so a repeat cancel doesn't read as an old server), and the gate's existing codes. Neither answer ever has a token, a drop URL or a value. Cancel resolves the key against this machine's pending list only.

The link. This is native creation and cancellation; handing the link over stays in the console, and that stays recorded as outstanding in the coverage plan. A request is useless until someone has its link, and no native route returns it, so the app never stores it. The console page, opened on the phone or anywhere, shows it as it does today. After asking, the app says so and offers the console, where the request's card already has Copy and Share. The app opens the console the way it always does: by Face ID where console tickets are on, otherwise with the console PIN. Either way the request's card is there, so an ask made with tickets off can still be handed over.

`GET /mobile/secrets` gains `actions` (the same `actionsState` the permission reads give), so the app shows the buttons only when they can work and otherwise says why. An older agent sends no `actions`: the app stays read-only. A request on another machine has no Cancel button: writes run where the request is held.

App: an "Ask for a password or key" row opens a sheet with label, note, and an optional conversation picker from the phone's existing topic list. Each waiting row on this machine gets a swipe and context Cancel with a confirmation. Both run `PermissionActionFlow.perform`.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the two POST routes for active owner devices | invariant | Route-level authentication by exact pattern (the cancel route's key is 16 hex characters), the existing deterministic device model; no competing signals. |
| Write gate and presence proof | invariant | Reuses the merged gate unchanged. Cryptographic proof of possession; there is nothing to weigh. |
| Label or note refused when token-shaped | invariant | A fixed redaction contract. A false refusal only asks the person to reword; the console stays available. |
| `already-waiting` duplicate refusal | invariant | Exact string comparison on this machine's live list. It only prevents a second link; the person can cancel the first. |

## Verify the state, not its symbol

No detector is added. `already-waiting`: symbol = a live row with the same label; state claimed = a request for this thing already exists. After a lost answer the first request is the good one, so the words point to its link in the console first, then to cancelling. A different thing with the same label costs one cancel. Unmeasurable: if the pending list can't be read the write answers 500 with a fixed code and creates nothing.

## Maturation plan

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot, and the seeded simulator screens.
- **dev-agent-live:** after release, Echo drives both writes from the simulator app paired to Echo's own server and records PASS/FAIL, then asks Justin to try one on the phone.
- **fleet:** rides `mobilePairing.permissionActions`, dev-gated: live on a development agent, dark on the fleet until that switch's rung moves.
- **graduation criterion:** the same switch's, plus one real ask and one real cancel from a phone with audit rows.
- **dark-window:** the switch's.
- **ladder:** mobilePairing.permissionActions

## Open questions

*(none)*

## Frontloaded Decisions

1. Reuse the permission action path and its switch, not a new gate. Durable external side effect: a drop link can be created, so the action is the same class as approving a slip.
2. No native route returns the link or token; the console hands it over. Rejected: returning the link once in the 201 answer with `no-store`. That would save a step, but it puts a capability into the app's own code path and response handling for the first time. Copy in the console can still put it on the clipboard, by the person's choice.
3. Fixed one-hour expiry on the phone.
4. Owner phones only. MSP phones, bearer and console-ticket signatures are refused by the existing gate.
5. Writes act on this machine only.
6. Peer requests stay read-only on the phone.

## 4. Security

Widened device-key access: two POST routes for owner phones, each needing Face ID on that phone at that moment. The presence key signs only after Face ID or the phone's passcode, so someone holding the phone needs one of those. The inherited limits of `docs/specs/mobile-native-permissions.md` apply: the passcode counts, and the prompt on every action is what the genuine app does, not something the server can see; the server sees only a fresh signature. The worst an attacker holding a passing phone can do is make a request or cancel one: no value is readable through these routes. Cancelling can lose a request someone is about to fill; it asks for confirmation and the owner can ask again. Replay, wrong action, wrong target, wrong label, wrong note, wrong topic, wrong device and wrong Host fail the challenge binding. Audit rows use the existing file with two new success events, `secret-requested` and `secret-cancelled`, plus the existing `refused`. A request's row carries `requestKey`, the one-way key of what it made, because its signed target is only `new`. Rows hold the action, target and key only, never the label, note, token or link, and a refused secrets write records a fixed route name, not the path it was sent, so a token pasted into a path can't reach the file.

## 5. Multi-machine posture

- Writes: machine-local. machine-local-justification: physical-credential-locality. A Secret Drop request is an in-memory capability on the machine that will receive the value, and the link names that machine, so it cannot be created or cancelled elsewhere.
- Challenges: machine-local, as in the permissions spec (in-memory, bound to the Host).
- `actions`: this machine's answer, as for the permission reads. No new durable state beyond the existing audit file, no notices, no new URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-secrets-writes.test.ts`): the action lines, every input refusal, `askForSecret` and `cancelSecretByKey` on both sides, no token in any answer. Parity: `tests/unit/mobile-session-terminal.test.ts` lists both paths as owner-only. Awareness: the migrator test.
- **Integration** (added to `tests/integration/mobile-native-permissions.test.ts`, production `authMiddleware` + `deviceAuthenticator`): the happy paths, replay, wrong label, wrong target, bearer, MSP, revoked, feature off, presence missing, no token in responses.
- **E2E** (`tests/e2e/mobile-native-secrets-writes-alive.test.ts`): production boot, real pairing and presence key, a real ask appears in `GET /mobile/secrets` and in the raw pending list, a real cancel removes it, not 403, 404 or 503.
- App: action line and outcome unit tests, seeded simulator screens.

## 7. Agent awareness and migration parity

`generateClaudeMd()` gains one bullet after the secrets bullet; `migrateClaudeMd()` inserts it under a content-sniff guard on `POST /mobile/secrets/requests/<key>/cancel`; `CapabilityIndex` gets `mobileSecretsWrites`. No config, hook or skill change.

## 8. Rollback

Turn off `mobilePairing.permissionActions`, or revert the commit. The app then shows the read-only screen with its words. Requests already made expire by themselves within the hour.
