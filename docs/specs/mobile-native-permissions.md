---
title: "Native Permission slips and What I'm allowed to do screens, with Face ID-confirmed writes, for the Instar iPhone app"
slug: "mobile-native-permissions"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-permissions.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively; his instruction for this lane makes the existing owner-presence proof the PIN's equivalent and nothing weaker). Applied because the phone path is no weaker and no broader than the PIN-confirmed console for the same decisions (§3.5): the same console code runs; the phone gets only approve/decline of requests held here and on/off of switchable features; it needs an active owner phone, a configured PIN, local TLS or loopback, and a fresh presence-key signature over a single-use 60 s challenge that names the device, Host, action, target, the approved proposal's hash, the shown consent disclosure's hash and the decline reason's hash; the bearer is refused; every write and refusal is audited beside the console's own records"
review-convergence: "2026-11-04T16:04:41.910Z"
review-iterations: 5
review-completed-at: "2026-11-04T16:04:41.910Z"
review-report: "docs/specs/reports/mobile-native-permissions-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 15
cheap-to-change-tags: 0
contested-then-cleared: 6
---

## 1. Problem

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the Instar iPhone app should do every feature natively instead of opening dashboard pages. The plan of record (`.instar/lanes/app-native-coverage-plan.md`) lists two rows this change covers, the first native **write** actions:

- **Permission slips** (mandates): list them, then approve or decline a waiting request from the phone.
- **What I'm allowed to do** (feature switches): list them, then turn a switch on or off from the phone.

Both are writes that the console gates on a fresh operator action (the dashboard PIN). The phone must carry an equivalent fresh operator action, and must not gain any authority the PIN-confirmed console does not have.

## 2. What exists (instar main 837349296)

- **Approvals (console).** `dashboard/console/mandates.js` reads `GET /mandate`, `GET /mandate/audit`, `GET /authorization-requests?status=pending`. Each waiting request is a card with the server-rendered `headline` (`renderAuthorizationCard`: "Let <person> <action> for <duration>.") and the agent's reason as a secondary note. Approve and Decline put the **dashboard PIN in that one request's body** (`checkMandatePin`: 503 when no `dashboardPin` is configured, 403 missing/incorrect PIN, 429 after 5 failures per IP in 5 minutes, durable via `PinAttemptStore`). Decline needs a reason (`denyReason`, `AuthorizationRequestStore.deny` refuses an empty one). A request asked on another machine (`heldOnThisMachine: false`) shows "open that machine's console" and no buttons. Approve runs `store.approve(id, { execute })`, which re-checks the allowlist (`PROPOSABLE_FLOOR_ACTIONS`) and the grantee registry, issues a carrier mandate with the grant (`author: 'system'`, `authorizedBy: ar.ownerDisplay`), records a `coordination.audit` row (`grant-floor:<action>`, allow, "approved via authorization-request, authorizedBy …"), and sets `resolvedBy: 'operator'`. Both routes record `featureEvidence('monitoring.authorizationRequests', …)`. The bearer alone can never approve (an agent holds the bearer).
- **Slips (console).** Active slips as cards (scope, the two agents, grants, expiry, authorship check), ended slips collapsed, the decision history, revoke/grant/hand-issue (each PIN-in-body). Out of this change's scope: revoke, grant and issue stay console-only.
- **Feature switches (console).** `dashboard/console/allowed.js` reads `GET /features` and posts `POST /features/:id/transition { to: 'enabled'|'disabled', trigger: 'explicit-ask', context }`. When the page holds a dashboard **operator session** (minted by the PIN unlock, `DashboardOperatorSessionStore`, 15-minute TTL, reusable, cleared when the PIN changes) it sends `X-Instar-Operator-Session`; the route then calls `featureRegistry.operatorSet(id, userId, to, { context })` (the operator's switch: consent recorded as `explicit-written` for consent tiers, discovery event `trigger: 'operator-switch'`), then `applyFeatureSetting` sends the feature's own enable/disable action to this server over loopback, serialized per feature. Without the session the agent path runs (state machine + consent checks). Non-switchable features answer `409 FEATURE_NOT_SWITCHABLE`. The PIN unlock that mints the session is refused when direct desktop access is on and the request did not arrive over local TLS (`dashboardUnlockRefused`, exposed to routes as `ctx.pinEntryRefusedHere`).
- **Owner presence proof (PR #2702, `src/server/mobileConsoleTicket.ts`).** A second Secure Enclave P-256 key on the phone (`PresenceKey.swift`, access control `.privateKeyUsage + .userPresence`, so every signature needs Face ID, Touch ID or the passcode unless the app hands in a still-authenticated `LAContext`). Enrolled once per device with proof of possession (`POST /mobile/device/presence-key`; replacing it needs re-pairing). A challenge is a 32-byte single-use secret bound to the device and the Host, 60 s TTL, at most 4 live per device and 64 in total, only its SHA-256 kept (`BoundSecretStore`). Signatures are strict low-S DER ECDSA-P256-SHA256 (`verifyPresenceSignature`). `activeOwnerPhone(svc, id)` checks registry status `active`, the device-key ledger, and the resolved person's role `owner`. Audit rows go to `state/mobile-console-tickets.jsonl` (metadata only).
- **Device requests.** Every phone request is signed by the device key over method, path with query, body, time and Host; `deviceAuthenticator` admits only `DEVICE_ALLOWLIST` paths, with replay protection, per-rule buckets and `ownerOnly`. The merged native read pattern (#2706, #2712, #2725, #2728): purpose-built trimmed routes, `ownerOrBearer`, `cleanText`, `rowKey`, `DegradationReporter` on read failure, owner-only allowlist entries in a named bucket, and the owner-only named set in `tests/unit/mobile-session-terminal.test.ts`.

## 3. Design

### 3.1 Two read routes

New module `src/server/mobilePermissionsRoutes.ts`, mounted inside `createRoutes` beside the phones-messages routes. Both are `ownerOrBearer` (bearer, or an owner-role device; else `403 owner-phone-required`), `Cache-Control: no-store`.

| Route | Reads | Answers |
|---|---|---|
| `GET /mobile/permissions/slips` | this machine's `authorizationRequests.store.list('pending')` (decorated with the server-rendered card) and `coordination.store.list()`, plus each online peer's `GET /mobile/permissions/slips?scope=local` (proxied-on-read, read-only rows) | `{ schemaVersion: 1, generatedAt, actions, approvals: { state, rows, total, truncated }, slips: { state, active, total, endedCount, truncated }, unread, offline, cantTell }` |
| `GET /mobile/permissions/features` | this machine's `featureRegistry.getAllFeatures('default')` with `getEffectiveState`, plus each online peer's `GET /mobile/permissions/features?scope=local` (proxied-on-read, read-only) | `{ schemaVersion: 1, generatedAt, actions, state, features, otherMachines, unread, offline }` |

- `approvals.state`: `ok | off` (`off` = the authorization-request feature is not enabled here, or the mandate engine is unavailable) `| unavailable` (the read threw). Rows: `{ id, key, proposalHash, headline, reason, agent, askedAt, expiresAt, here, machine }`, soonest-expiring first. `headline` is the server-rendered card rendered for the phone with `renderAuthorizationCard(r, <registry name> ?? 'a person')`, so a raw Slack user id never reaches the phone (the console's `decorateAuthReq` falls back to the id; the phone's does not); it is never agent free text and is not shortened for this machine's rows (a peer's headline is cleaned and capped at 400). `proposalHash` is `hashProposal(r.proposal)` computed fresh at read time, present only on rows held here whose grantee resolves to a registered person with a real name: it is what an approve signs (§3.3). A row without it (grantee not registered or unnamed: the headline would say "a person", and approve would refuse it as `unknown-user` anyway) shows no Approve button; Decline stays. `reason` is the agent's note (the store already refuses one over 280 characters, so it passes whole), cleaned. `here` is true only for a row held on this machine (`heldOnThisMachine`, read from this machine's own store); a peer's rows are always `here: false` with `machine` its verified nickname ("another machine" otherwise) and no `proposalHash`. A row in this machine's store that is not held here is dropped when its holder returned the same id (the holder's row wins), else shown read-only. `key` is `rowKey` of (machine, id), so equal ids on two machines are two rows. `?scope=local` answers this machine's held rows only, with their full `total`, and never reads peers (how one machine reads another's).
- **Caps and what they cut.** The approvals list is capped at 100 rows and the slip list at 100 (both far above what occurs: the store holds at most `pendingCapPerAgent` (default 10) pending requests per agent, and carrier slips live at most 24 h). `total` is always the full count, including rows a peer counted but did not return; when a cap is hit, `truncated` is set, the rows dropped are the ones expiring **last** (the soonest decisions are always shown), and the app says "Showing N of M; the rest are in the console." No decision input is cut: the headline and the request's own fields are never shortened, and an approval's id, action, person and duration are all in the headline the server renders. Peers: at most 16 online peers are read (5 s timeout, 500,000-byte body cap, the phones-messages pattern); any not read are named in `unread`, offline ones in `offline`, a peer that answered but could not read its own store (`unavailable`) in `cantTell`, and the app names them ("Mac Mini didn't answer, so its waiting requests aren't shown"). **No cache**: every read is fresh (a 15 s cache would keep showing a request the owner just decided); the shared 20-per-minute device bucket bounds the fan-out to at most 20 × 16 peer reads a minute per phone.
- `slips.state`: `ok | off | unavailable`. `active`: unrevoked, unexpired mandates, `{ key, title, summary, expiresAt, grants, invalid, machine }` (cap 100, `key` = `rowKey` of (machine, mandate id); a peer's slips carry its `machine` and their `grants` folded into `summary`): `title` is the scope in words (`user-authority-grant` → "A person may act"; other scopes cleaned and capped at 80); `summary` lists each live grant as "<person name> may <action words>" (the time is the slip's `expiresAt`, which a grant never outlives, worded on the phone) (person name from the principal registry, else "a person"; action words from `FLOOR_ACTION_LABELS`) or, with no grants, "N things these two agents may do together"; `invalid` is `!verifyAuthorship`. `endedCount`: revoked or expired. Never returned: agent fingerprints, Slack user ids, authority bounds, auth proofs, the audit chain.
- `features` (this machine's switches, the only ones the phone can switch from this answer): `{ id, name, oneLiner, on, stateWords, switchable, readOnlyReason, notice, offWarning, consent }` in registry order, uncapped (the registry is a fixed list of under 100 built-in definitions). `on` is the switch position (`discoveryState === 'enabled'` when switchable; `effective.status === 'on'` when read-only), as the console computes it. `stateWords` is the server's own `effective.summary` (cleaned, capped 200), else the discovery-state word. `readOnlyReason` is the honesty note for a read-only switch. `notice` is true when the setting does not match the switch (`on-after-restart`, `off-after-restart`, `recorded-only`, `not-recorded`); the sentence that explains it is `stateWords` (the server's `effective.summary`, which names the mismatch), and the app shows it under the row in the attention colour. `consent` is set for a switchable feature in a consent tier (`network`, `self-governing`): `{ tier, description, data: [{ text, goesTo }], howToUndo, disclosureHash }`, the same disclosure the console's sheet shows before a switch-on (full description, "Your data" with where each item goes, how to undo), because turning such a switch on through the operator path stores an `explicit-written` consent record with those data implications. `disclosureHash` is SHA-256 over exactly that disclosure (JSON of `[id, tier, description, data, howToUndo]`); null for other tiers. `offWarning` is a fixed sentence for switches whose turning off has a consequence the owner should read in the confirmation (Frontloaded Decision 12), else null. `id` is the registry id (needed for the action). Never returned: config paths, enable/disable action routes, stored consent records, and the raw definition fields (data types, the full data-implication objects); the disclosure is returned only as the `consent` words above. `otherMachines: [{ key, name, state, features }]`: each answering peer's switches (rebuilt through the same field allow-list, `offWarning` null), shown read-only under the machine's name with "Change these on that machine's console."; `unread` and `offline` name the machines not read. `?scope=local` answers `{ state, features }` for this machine only.
- `actions`: what this caller can do on this machine, so the app decides once whether to show buttons: `{ state: 'available' | 'console-only', reason }` where `reason` is one of `bearer` (the token cannot carry an owner presence proof), `off` (the feature switch below is off), `no-pin` (no dashboard PIN is set: the console cannot do these either), `transport` (the request did not arrive over this machine's own TLS front or loopback, the console-ticket rule), `not-owner` (the device is no longer an active owner phone), `enrol-off` (this phone has no presence key yet and `mobilePairing.consoleTicket.enabled` is false, so the enrolment route is off), plus `presenceKey: boolean` (this phone's presence key is enrolled; the app enrols it on first use when false). `actions` is computed by the same predicates as the write gate, in the same order.

A read that throws answers that part `unavailable` and records one `MobilePermissions.read` degradation through `DegradationReporter`.

### 3.2 Who may read them

Two `DEVICE_ALLOWLIST` entries: `GET /mobile/permissions/slips` and `GET /mobile/permissions/features`, `statuses: active`, `body: 'none'`, `ownerOnly: true`, one shared bucket `permissions-reads` of 20 per minute. Everything earlier is unchanged (MSP device `403 owner-phone-required`, removed person `403 person-unknown`, revoked/unsigned/replayed/tampered `401`). The raw routes (`/mandate*`, `/authorization-requests*`, `/features*`) stay off the allowlist.

### 3.3 The Face ID-confirmed writes

Four device-only POST routes in the same module:

| Route | Body | Does |
|---|---|---|
| `POST /mobile/permissions/challenge` | `{ action, target, value?, reason?, proposalHash?, disclosureHash? }` (the same fields the action post will carry; the challenge is bound to the line they build) | issues a single-use challenge bound to this device, this Host and the exact action line |
| `POST /mobile/permissions/requests/:id/approve` | `{ proposalHash, challenge, presenceSig }` | approves the waiting request `:id`, only if its proposal still hashes to `proposalHash` |
| `POST /mobile/permissions/requests/:id/decline` | `{ challenge, presenceSig, reason }` | declines it with the reason |
| `POST /mobile/permissions/features/:id` | `{ to, disclosureHash, challenge, presenceSig }` | sets the switch `:id` to `to` (`enabled` or `disabled`) |

**The action line** names exactly one action and its target:

- `approve-request <id> <proposalHash>`
- `decline-request <id> <sha256hex(reason)>`
- `set-feature <id> <enabled|disabled> <disclosureHash | none>`

`<id>` matches `^[a-z0-9._:-]{1,128}$` (anything else is `400 bad-target`). `proposalHash` is 64 lowercase hex characters (`400 bad-proposal-hash`). The reason hash is SHA-256 over the reason's exact UTF-8 bytes as sent, with no trimming or normalisation (Swift and JavaScript trim different whitespace sets, so neither side trims before hashing); the reason must be at most 500 characters and not blank after trimming (`400 reason-required` / `400 reason-too-long`), and the store trims it when it records it.

**Binding a switch-on to the consent shown.** Turning on a consent-tier feature carries the `disclosureHash` the phone was sent and showed; every other switch carries `none`. The app sends that hash (or omits it, meaning `none`) in both the challenge and the action post, so both build the same line. The action route recomputes the expected value from the registry definition (`consentDisclosure`) and answers `409 disclosure-changed` on a mismatch, before anything changes (the app then re-reads the list and shows the new disclosure), so the consent record `operatorSet` stores is always for the disclosure the owner saw. Ids match `^[a-z0-9._:-]{1,128}$` (request ids `authreq-…` and feature ids are lower-case; the allowlist pattern is the same).

**Binding the approval to what was shown.** The approve line carries the proposal's hash as the phone read it. `approveAuthorizationRequest` checks, inside the store's own `execute` callback (on the very proposal being approved, synchronously, no await between the store's read and its write), that `hashProposal(proposal)` equals the signed hash; otherwise the request stays pending and the answer is `409 request-changed`. So an agent that rewrites a waiting request's details between the phone's read and the Face ID tap cannot get the new details approved. (The console's PIN approve binds only the id; the phone is stricter here. The stored `proposalSha256` is an unkeyed hash next to the proposal in an agent-writable file, so it is not relied on.)

**The signed bytes** (presence key, strict low-S DER ECDSA-P256-SHA256, the existing `verifyPresenceSignature`):

```
instar-permission-action-v1\n<deviceId>\n<host>\n<challenge>\n<action line>
```

`<host>` is the Host the device signature was verified against, normalised as the console ticket does (`normalHost` of `instarDeviceHost`, else the paired host), lowercase. The version prefix differs from the console ticket's (`instar-console-ticket-v1`) and the enrolment proof's (`instar-presence-enroll-v1`), so a signature made for one can never verify for another.

**Order of checks on every write route** (the challenge route runs steps 1–6, then validates the action shape):

1. Feature on: the pairing service is on (`mobilePairing.enabled`, itself dev-gated) and `resolveDevAgentGate(mobilePairing.permissionActions.enabled, config)` is true (read live) → else `503 permission-actions-off`.
2. A device principal → else `403 device-signature-required` (the bearer is refused: an agent holds the bearer).
3. Transport: the request arrived over this machine's own TLS front or loopback (`arrivedOverLocalTls`, the console-ticket routes' rule; the Cloudflare connector reaches the server over loopback) → else `403 secure-transport-required`. This is stricter than the console's PIN unlock, which needs it only while direct desktop access is on, and it is the rule the presence-key enrolment route already applies.
4. `activeOwnerPhone(svc, deviceId)` (active, not revoked in the key ledger, person role `owner`, read at request time) → else `403 owner-phone-required`.
5. A dashboard PIN is configured (`config.dashboardPin`) → else `503 console-pin-not-set`. Where the console cannot do these writes at all, the phone cannot either.
6. The device's presence key is enrolled → else `409 presence-key-missing`.
7. The body's action line is built from the route and body (`:id`, the decision, `to`, the reason hash).
8. The challenge is consumed (deleted before it is judged): it must exist, be unexpired, and be bound to this device, this Host and this exact action line → else `401 challenge-invalid`.
9. The presence signature verifies over the signed bytes with the device's stored presence key → else `401 presence-invalid`.
10. The action runs (§3.4) and its answer is returned.

Challenges live in their own `ActionChallengeStore` (not the console ticket's store), 60 s TTL, at most 4 live per device and 64 in total, SHA-256 of the secret kept only, in memory (lost on restart: the app asks again). A challenge carries its action line, so a challenge for approving request A cannot approve B, decline A, or set a switch, even with a valid signature over another line. The challenge route validates the action shape (`400 bad-action` / `bad-target` / `bad-value` / `reason-*`) but not whether the target exists; the action route answers that.

Each write consumes its challenge whatever the outcome after step 8, so a replay of a captured `{ challenge, presenceSig }` gets `401 challenge-invalid`. Device-level replay of the whole signed HTTP request is already refused by `deviceAuthenticator`.

### 3.4 What each action does (the console's own code path)

The approve, deny and operator-switch bodies in `routes.ts` are extracted into three functions shared by the console route and the phone route, so both run the same code:

- `approveAuthorizationRequest(id, by)`: everything the console route does after `checkMandatePin` (the `execute` callback with the allowlist and registry re-checks, carrier mandate with the grant's `authorizedBy: ar.ownerDisplay` unchanged, `coordination.audit` row, `featureEvidence`, status codes and body). The phone route additionally refuses a request that is not `heldOnThisMachine` (`409 asked-elsewhere`, as the console shows no buttons for it) and one whose proposal changed (`409 request-changed`, above). `by` is `{ kind: 'pin' }` for the console or `{ kind: 'owner-phone', deviceId, proposalHash }` for the phone; the console's audit text is unchanged, the phone's `coordination.audit` reason is the console's text ("approved via authorization-request, authorizedBy <ownerDisplay> until <time>") followed by ", from the owner's phone (device <id>) with a Face ID / passcode proof", and the phone's `featureEvidence` context adds `via: 'owner-phone', deviceId`.
- `denyAuthorizationRequest(id, reason, by)`: the console's deny path, same additions.
- `operatorSwitchFeature(req, id, userId, to, context)` and `featureTransitionAnswer(outcome, …)`: the console's operator-session branch and its answer (`FEATURE_NOT_SWITCHABLE` 409, `operatorSet` inside the same per-feature `serializeFeatureSwitch` chain the console uses, so a console switch and a phone switch on one feature run one at a time, then `applyFeatureSetting`, the same response with `viaOperatorSwitch: true`, `apply`, `effective`). Both are defined in `createRoutes` and passed to the new module; the module never builds its own chain. A phone switch that waits behind another switch on the same feature re-checks, inside the chain right before `operatorSet`, every gate condition that can change while it waits: pairing and the feature switch still on, a dashboard PIN still configured, the device still an active owner phone (`503 permission-actions-off` / `503 console-pin-not-set` / `403 owner-phone-required` otherwise; transport and the proof cannot change), so a revocation or an off switch takes effect even for a queued switch. Approve and decline are synchronous after the gate (no wait in which authority could change). Only `to: enabled|disabled` and `userId: 'default'`. The phone's context is "Turned on from the Instar app (owner phone, device <id>, Face ID / passcode proof)" (or "Turned off …"), so the discovery event and any consent record name the device; the console's is unchanged.

**Audit.** Besides those existing sinks, each phone write and every refusal the route itself makes (from step 1 on; refusals made earlier by the device authenticator, such as an MSP phone's 403, a 401 or a 429, are that layer's and are not in this file), the bearer's with `deviceId: null`, and each `400` shape refusal) appends one metadata-only row to `state/mobile-permission-actions.jsonl` (`{ at, event: 'challenge' | 'approved' | 'declined' | 'feature-set' | 'refused', deviceId, personId, action, target, value?, reason?, status }`, `personId` the registry user id the device resolves to (null for the owner's own profile), rotated at 1 MB, `0o600`; `reason` there is the refusal code, never the decline text; a failed write is reported through `DegradationReporter`, which is the trace of that refusal when the file cannot take it, and never fails the request).

**Rate.** The four POSTs share one owner-only allowlist bucket `permission-actions`, 12 per minute per device.

### 3.5 Authority comparison (the approval condition)

| | Console (today) | Phone (this change) |
|---|---|---|
| Who | holder of the bearer token **and** the dashboard PIN | the owner's active, unrevoked paired phone (device key in the Secure Enclave) **and** a fresh Face ID / Touch ID / passcode check on that phone (presence key) |
| Freshness | approve/decline: PIN in that one request; switch: operator session, reusable for 15 min | one single-use, 60 s challenge per action |
| Binding | the PIN is bound to the request id only | the signature names the device, Host, action, target, the approved proposal's hash and the decline reason's hash |
| Scope | approve/decline any pending request (button only for requests held here); any switchable feature; plus revoke/grant/issue | approve/decline requests held here; switch any switchable feature, `enabled`/`disabled` only, user `default`; nothing else |
| No PIN set | refused | refused |
| Not over local TLS / loopback | switch refused only while desktop is on (unlock refused); approve allowed | all refused |
| Brute force | 5 PIN tries per 5 min per IP | no guessable secret: an ECDSA signature by a non-exportable key; device bucket 12/min |
| Audit | `coordination.audit`, `featureEvidence`, `resolvedBy: operator`, discovery event `operator-switch` | the same sinks, plus the device id and a phone audit row |
| Consent on switch-on | the sheet shows the data implications, then the PIN session switches | the confirmation shows the same disclosure, and its hash is signed and re-checked |
| Ending the authority | change the PIN (clears operator sessions) | remove the phone (`activeOwnerPhone` reads the ledger at once) or switch the feature off |

Nothing the phone can do here is outside what the PIN-confirmed console can do. In the genuine app's prescribed flow (a new `LAContext` per action, so the enclave prompts each time), every phone write carries a proof at least as fresh and more tightly bound than the console's. The server verifies the signature's freshness (single-use challenge) and the key's identity; it cannot itself observe the Face ID prompt (see "Verify the state" and §4 on the enrolment trust root).

### 3.6 The app

New SwiftUI files in `apps/instar-ios` (its own git repository): `PermissionsData.swift` (parsing, action lines, signed bytes, outcome words; unit-tested) and `PermissionsViews.swift` (screens and the confirm-then-Face ID flow). A new "Permissions" section on the agent's detail screen opens **Permission slips** and **What I'm allowed to do**.

- **Permission slips**: "Waiting for you" (each card: headline, the agent's reason in smaller text, asked and expires times; Approve and Decline when `here` and `actions.state == available`; else a plain note), "Active slips" (title, summary, expiry, a "signature doesn't check out" line when `invalid`), and the ended count. Revoke, grants and writing a slip by hand are named as console-only in one line.
- **What I'm allowed to do**: each feature with its state words and a switch; a read-only feature shows its reason and no switch; a `notice` shows the server's sentence.
- **Confirm, then Face ID.** Approve, Decline and every switch first show a confirmation dialog naming the exact action ("Approve: Let Sam deploy to production for 1 hour."; "Turn on <name>?"). Decline asks for the reason first. On confirm the app asks for a challenge, then signs with the presence key using a **new** `LAContext` (never the app lock's recent context), whose `localizedReason` names the action, so iOS shows its own Face ID / passcode prompt for every action. It then posts the action. If the key is not enrolled yet (`presenceKey: false` or `409 presence-key-missing`), the app enrols it once (the console-ticket enrolment call and the same `presenceEnrolled.<deviceId>` flag), then continues. A `401 challenge-invalid` gets one fresh challenge (a slow prompt can outlive 60 s).
- **Lost answers.** A write whose answer never arrives (timeout, dropped connection, or a switch that cut the phone's own route) is shown as "The agent may have made this change; the answer didn't arrive." The app never repeats the write on its own; it re-reads the list when it can reach the agent, and when it cannot it says to check from another connection or the console. A repeat by the owner needs a new challenge and a new Face ID check, and the server's own idempotency covers it (approving an approved request answers `alreadyApproved`; declining a declined one is a no-op; setting a switch to its current value records it again).
- **Read-only fallbacks.** `actions.state == console-only`, a token (non-device) agent in the app, or a phone without a passcode: lists only, with "To change this, open the console." and the specific reason (no PIN set; this connection can't be used for changes; turned off on this agent; this phone needs pairing again). An MSP phone gets neither list (`403 owner-phone-required`): "Only the owner's phone can see this."
- **Confirmation text** comes only from rows held here (`here: true`): Approve and Decline both use the row's headline; only Approve needs `proposalHash` (a row without it, whose person is unnamed or unregistered, can still be declined); a switch's confirmation shows its `offWarning` when turning it off, and, when turning on a feature with `consent`, the description (the feature's name when it has none), each "Your data" item with where it goes, how to undo, and, when there is at least one data item, the console's sentence "Turning this on records that you agreed to what is listed under Your data." A disclosure that changed is found when the action is posted, after its challenge is used, so the owner looks again and confirms with a second Face ID prompt.
- **One route per action.** The challenge and the action post go to the same route (the challenge is bound to the Host it was issued on); a route change between them answers `challenge-invalid` and the app asks for one fresh challenge (a second Face ID prompt). An older server (`403 device-not-allowed`, `404`): "This agent's server is too old to show this here. Update the agent to see this here." `409 presence-key-set` at enrolment: "Changing this from the phone needs this phone paired again (remove it, then pair)."

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the two GETs and four POSTs for active owner devices | invariant | Route-level authentication by exact path; the existing deterministic device model. |
| `ownerOrBearer` on the reads | invariant | Authorization from the authenticated principal's resolved role; fails closed. |
| Write gate: device principal, transport rule, active owner phone, PIN configured, presence key enrolled | invariant | Each is a deterministic authorization fact (principal kind, registry and ledger state, config presence, the same transport predicate the console unlock uses); a write that fails any of them is refused. No competing signals: this is authentication, not judgment. |
| Challenge bound to device, Host and action line; signature verification | invariant | Cryptographic verification and exact-string binding; there is nothing to weigh. |
| `heldOnThisMachine` required for a phone approve/decline | invariant | Mirrors the console (no buttons for requests asked elsewhere); deterministic field. |
| Approve/deny/switch semantics | invariant (unchanged) | The console's own code, extracted unchanged into shared functions. |
| Field allow-list in each read summarizer | invariant | Fixed redaction contract. |
| Which switches the phone may set | invariant | Every registry feature with `switchable !== false`, to `enabled`/`disabled`, user `default`: exactly the console's operator switch. |
| Proposal-hash match on approve | invariant | Exact equality of a hash over the structured proposal; refuse on mismatch. |
| Which rows a cap cuts; how unread/can't-tell peers are shown | invariant | Fixed ordering (soonest expiry kept) and fixed naming; display only. |
| `actions.state` | invariant | The write gate's own predicates, in order; display only (the write route re-checks). |

## Verify the state, not its symbol

No detector, monitor or LLM judgment is added.

- "The owner was present": symbol = a valid presence-key signature. State claimed = a person passed Face ID, Touch ID or the passcode on that phone for this action. Corroboration = the key's Secure Enclave access control (`.userPresence`), set at creation and enforced by the enclave, plus enrolment's proof of possession. The app always signs with a fresh `LAContext`, so the enclave prompts for each action. Honest limit: the server cannot see the prompt; a modified app on the owner's unlocked phone could reuse a context for a few seconds. That is the same trust the console ticket already rests on. Unmeasurable: no presence key → `409 presence-key-missing`, never a write.
- "This approval is for this request": symbol = the action line inside the signature and the challenge binding. Corroboration = the route builds the line from its own `:id` and body, and the stored challenge carries the line it was issued for. Mismatch → refused.
- Feature state words: symbol = `effective` (the registry's comparison of switch, config and boot value). A read-only switch shows its honesty note. When `effective` is missing the discovery-state word is shown (the console's rule).
- Slips: symbol = mandate records; `invalid` = `!verifyAuthorship`, shown, never hidden.

## Maturation plan

The writes ride `mobilePairing.permissionActions.enabled`, resolved through `resolveDevAgentGate` and registered in `DEV_GATED_FEATURES` (omitted ⇒ live on a development agent, dark on the fleet; read live, so setting it takes effect without a restart). The approve and decline writes also need `monitoring.authorizationRequests` (itself dev-gated), and every route needs `mobilePairing.enabled` (dev-gated). The reads have no flag of their own (they ride `mobilePairing.enabled`).

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot: a phone paired through redeem/confirm with an enrolled presence key reads both lists, approves one request, declines another, and switches a feature; every refusal case answers as specified.
- **dev-agent-live:** after release, Echo pairs a simulator app to Echo's own server (Echo's device, not the operator's phone), approves and declines throwaway authorization requests Echo created, and switches a harmless feature off and back on, recording PASS/FAIL per action. Tracked as an Echo commitment opened with the PR.
- **fleet:** dark on the fleet until the dev-agent-live record passes and the graduation criterion holds; graduation is a later change that flips the default (its own reviewed PR). An agent operator can opt in with `mobilePairing.permissionActions.enabled: true`; `false` turns the writes off live (the reads stay).
- **physical-device check:** the simulator uses a software key, so the hardware claim (a Face ID or passcode prompt for every action) is proven only on a real phone: before graduation, one owner-phone run on physical hardware records two consecutive actions each prompting, a cancelled prompt sending nothing, and an expired challenge recovering with one fresh challenge. Until that record exists, the per-action prompt is recorded as unverified on hardware.
- **graduation criterion:** one week after release, every `mobile-permission-actions.jsonl` `approved`/`declined`/`feature-set` row has a matching `coordination.audit` / discovery-event record, `refused` rows are only the expected codes, the dev-agent-live record shows every action passing, and the physical-device check is recorded.
- **dark-window:** the fleet stays dark from release until graduation; the development agent is live from release.
- **ladder:** mobilePairing

## Open questions

*(none)*

## Frontloaded Decisions

1. The presence proof stands in for the PIN for these writes and nothing broader (operator's instruction). The phone gets approve/decline and on/off only; revoke, grant and hand-issue stay console-only.
2. No dashboard PIN configured → the phone refuses too (`503 console-pin-not-set`), because the console cannot do these writes without one.
3. The transport rule is the console-ticket routes' rule (local TLS or loopback), applied to all four writes unconditionally: stricter than the console's PIN unlock, which applies it only while direct desktop access is on.
4. One proof per action (single-use 60 s challenge), never a reusable phone session.
5. Requests asked on another machine are read-only on the phone, as on the console.
6. Feature switches use the operator path (`operatorSet`), the same path the PIN-unlocked console uses; the agent consent path is never reachable from the phone.
7. The bearer may read the two lists (it already reads the raw routes) but can never write through these routes.
8. The writes are dev-gated (live on the development agent, dark on the fleet), with a live switch either way.
9. Decline reason: required, 1–500 characters, its hash bound into the signature.
10. Row caps: 100 approvals and 100 active slips with `total` (including rows peers counted but did not return) and `truncated` (the latest-expiring rows are the ones cut, and the app says "Showing N of M; the rest are in the console."); features uncapped.
11. Approvals, slips and feature switches are proxied-on-read across online peers (read-only rows naming their machine); only this machine's rows carry actions.
12. Switching off `cloudflare-tunnel` (which can cut the phone's own route) and the safety checks `external-operation-gate`, `input-guard` and `response-review` stays allowed (the console allows it), with a fixed `offWarning` sentence shown in the confirmation. The rule for the list: a switch whose turning off can cut the phone's own route, or removes a safety check on what the agent does. Other consequences are in each feature's own "how to undo" note.
13. The reads are not cached (fresh after every decision); the device bucket bounds fan-out.
14. A phone without a presence key enrols it through the existing console-ticket enrolment route; when that route is off (`consoleTicket.enabled: false`) the phone is read-only (`enrol-off`).
15. Turning a consent-tier feature on from the phone shows the console's full disclosure and signs its hash (see §3.3); approving an already-approved request answers `alreadyApproved` without a new grant or a hash check (no authority is added).

## 4. Security

- New capability: an owner's phone may approve or decline an agent's authorization request held on this machine, and switch features, with a fresh Face ID / passcode check per action. A stolen, locked phone cannot (the presence key needs the passcode or biometrics). A stolen phone with its passcode can do what the console with the PIN can do for these two actions; the owner removes that phone from any other phone or the console, which ends it at once (`activeOwnerPhone` reads the ledger).
- No agent path: the bearer is refused on every write route, and the presence key never leaves the enclave.
- Replay and substitution: single-use challenges bound to device, Host and action line; signatures under a version prefix unique to this protocol; device-level replay refusal; tests for replayed, expired, wrong-action, wrong-target, wrong-reason, wrong-device, wrong-Host and console-ticket-signature cases.
- The lists carry no fingerprints, Slack ids, config paths, consent records or proofs. Agent reasons are cleaned and capped, shown as secondary text, never as the headline.
- Denial of service: challenge store caps (4 per device, 64 total) evict the oldest; device bucket 12/min for writes.
- **Why the presence proof counts as the PIN here (lesson L15, "a non-dashboard surface may authorise only S-class acts").** These are P-class acts (granting authority, switching off guards). L15 keeps such acts on the dashboard gate because a chat tap proves nothing about who tapped. This proof is different in kind: a device key and a presence key in the owner's phone's Secure Enclave, both non-exportable, the second usable only after Face ID, Touch ID or the passcode, bound to one action. It is the dashboard gate's equivalent, not a chat tap.
- **The enrolment trust root, stated.** The presence key is enrolled by whoever first signs an enrolment with the device key; the server cannot see that the key requires presence. The device key and the presence key are keychain items bound to the Instar app's code-signing identity, so only the genuine app (or code with control of the whole phone, e.g. jailbroken) can create or use them; code with that control can equally read the PIN as the owner types it into the console. Enrolment is one-time (replacing the key needs re-pairing), is audited (`presence-key-set`), and an already-enrolled key cannot be swapped.
- **Local state write access** (an agent able to edit the device registry or the authorization-request file) could forge an owner device; the same agent can read the PIN from config. This change does not move that trust boundary.
- **A stolen phone with its passcode** can remove the owner's other phones (existing rule, no Face ID) before the owner removes it; the console (PIN) is the dependable place to recover, and every removal is audited.

## 5. Multi-machine posture

- Writes: machine-local. machine-local-justification: physical-credential-locality — the device record and the presence key that authenticate a write live only on the machine the phone paired with (the native device-key ledger replicates device keys for message provenance, but not the presence key or the device record this gate reads), so the proof verifies only there; the app talks to that machine. An approval held on another machine is shown read-only ("asked on <machine>"), as the console shows it.
- Approvals and slips: **proxied-on-read**: this machine's rows plus each online peer's `GET /mobile/permissions/slips?scope=local` (bearer over `poolPeerFetch`, the phones-messages transport), each peer row read-only and naming its machine; machines not read are named.
- Feature switches: **proxied-on-read** for the list (this machine's switches plus each answering peer's, read-only, by machine); the switching itself is part of the machine-local writes above (the proof verifies only where the phone paired).
- Challenges: in memory on this machine, by design (bound to its Host and keys).
- No user-facing notices, no generated URLs. The audit file is this machine's, beside `mobile-console-tickets.jsonl`.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-permissions.test.ts`): the `DEV_GATED_FEATURES` entry resolves live on a dev agent and dark on the fleet; peer rows are always `here: false` and a peer `unreached` is named; caps keep the soonest-expiring rows; `actionLine` and `permissionPresenceMessage` exact bytes; `ActionChallengeStore` (single use, expiry, per-device and total caps, binding to device, Host and line); the slips and features summarizers (field allow-list, caps, `invalid`, ended count, grants in words, read-only reason, `notice`, never fingerprints/ids/config paths); `actions` state for bearer, off, no PIN, transport, presence key; the allowlist has exactly these six rules, owner-only, in their buckets, and none of the raw routes; the owner-only named set in `tests/unit/mobile-session-terminal.test.ts` gains the six.
- **Integration** (`tests/integration/mobile-native-permissions.test.ts`, production `authMiddleware` + `deviceAuthenticator` + the real routes): owner phone reads both lists; bearer reads, bearer write refused; MSP phone 403 on reads and writes; approve with a valid proof → 201, request approved, a proposal rewritten after the read → 409 request-changed and still pending, carrier mandate and `coordination.audit` row with the device id, phone audit row; decline → 200 with reason; switch on and off → `operatorSet` event `operator-switch`; replayed challenge → 401; expired challenge → 401; challenge for another action (approve vs decline, other id, other feature, other value, other reason) → 401; signature by another device's presence key → 401; signature over the console-ticket message → 401; not over local TLS → 403; console ticket off and no key → `actions.reason: enrol-off`; omitted flag on a fleet config → 503 and on a dev config → served; a peer's rows read-only and named; a console switch and a phone switch on one feature serialized; no presence key → 409; no PIN configured → 503; feature off → 503; request held elsewhere → 409; non-switchable feature → 409; console approve/deny/transition with the PIN still behave exactly as before.
- **E2E** (`tests/e2e/mobile-native-permissions-alive.test.ts`): AgentServer production boot, a phone paired via redeem/confirm, presence key enrolled through the real route, both lists 200, one approve, one decline and one switch round-trip with real P-256 keys, and the raw routes still 403 for the phone.
- **App** (`Tests/InstarAppTests/PermissionsDataTests.swift`, listed in `project.yml`): parsing, action lines and signed bytes equal the server's, outcome words for every refusal code.

## 7. Agent awareness and migration parity

- One shared `MOBILE_PERMISSIONS_LINE(port)` (exported from `PostUpdateMigrator.ts`, the `MOBILE_PHONES_MESSAGES_LINE` pattern) is used by both. `generateClaudeMd()` gains one bullet in the Mobile app routes block (after the phones-messages bullet) naming the two lists, the four writes, and that only the owner's phone with a fresh Face ID check can use the writes.
- `migrateClaudeMd()` inserts the same bullet after the phones-messages bullet under a content-sniff guard on `GET /mobile/permissions/slips` (idempotent); a block without that bullet gets the line appended.
- `CapabilityIndex` gets a `mobilePermissionsScreens` entry listing the six endpoints (no new prefix).
- Config default: none written; `permissionActions.enabled` is omitted and resolved by the dev gate. A `DEV_GATED_FEATURES` entry `mobilePairingPermissionActions` (name, configPath, description, justification) is added; the existing wiring and lint tests then cover it.

## 8. Rollback

Set `mobilePairing.permissionActions.enabled: false` to stop the writes at once without a release, or revert the commit. A revert removes the routes; the app then shows the lists as "update the agent". Approvals, declines and switch changes already made stay made, exactly as if done in the console: an approval is ended by revoking its slip, a switch by switching it back, and a decline stays recorded (the agent asks again with a new request under the existing re-proposal rules).
