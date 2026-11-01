# Side-Effects Review — Native app conversations, increment 2 (signed records)

**Version / slug:** `mobile-native-conversations-inc2`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer subagent (read-only)`

## Summary of the change

Increment 2 of docs/specs/mobile-native-conversations.md (§4.6 signed records, §4.8 ledger replication, §4.9 Telegram history join), stacked on increment 1 (PR #2530), behind the same boot-read `mobilePairing.native.enabled` gate.

New files: `src/core/AppRecordSignatures.ts` (machine signer over the existing MachineIdentity Ed25519 `sign`/`verify`; signing-key history lookup over `IdentityStore.signingKeyHistory`, the store behind GET /identity-changes; receipt/redaction/ledger-row payloads, domain separated; `verifyRecordedOrigin` with the five verdicts), `src/core/MobileDeviceKeyLedger.ts` (append-only fsynced JSONL, machine-signed rows, merged view, replicated-row ingest that verifies the signature under the named machine's pinned key, boot reconciliation in both directions), `src/core/MobileDeviceKeyLedgerReplicatedStore.ts` (the `mobileDeviceKeyLedger` kind, journal kind `mobile-device-key-ledger-row`).

Modified: the native send route stores `bodyB64` / redaction attestation / machine receipt and dispatches with the real verdict; history and sync return `originVerified` from `AppConversationService.verify`; the device confirm and revoke routes write the ledger row first; with native on, the Telegram chat route persists the signed copy under `telegram:<topicId>` before dispatch and hands the inbound core that eventId; `GET /telegram/topics/:id/messages` joins rows for device readers; `DeviceRegistry` records `approvedVia` and accepts the ledger's `revokedAt`; the store keeps `receipt`, lists only native conversations; server.ts and AgentServer wire signer, key lookup, ledger, its replication hooks and boot reconciliation; CoherenceJournal kind lists; state registry; reconciler allowlist; CLAUDE.md wording with an in-place migration; capability/dev-gate descriptions.

## Decision-point inventory

- `verifyRecordedOrigin` — add — invariant cryptographic checks; never authorizes anything, only labels a stored record.
- Session tag "📱 signed" — modify — now only for `verified` (was never shown).
- Ledger replicated-row acceptance — add — signature under the pinned key of the named machine (invariant).
- Device confirm route — modify — a failed ledger write refuses the confirmation (500, code not consumed; retry works).
- Device revoke route — modify — ledger write first, but a failed ledger write never blocks the revocation.
- Telegram chat route (native on only) — modify — a failed persist refuses the send (503, request released) before dispatch.

---

## 1. Over-block

The only new refusals: a confirmation whose ledger row cannot be written (disk error) answers 500 and can be retried; a Telegram send from the app whose store copy cannot be written answers 503 before dispatch (same rule the native send already had). No content is judged. A redaction with no machine attestation (a machine with no identity) reads `unknown`, not `failed`.

---

## 2. Under-block

`unknown` is shown for: records written by increment 1 (no receipt), machines with no identity key, a peer whose identity is not yet pinned here, unreadable key history, and Telegram history rows whose eventId predates native (`mobile:` ids). That is the conservative side: `unknown` never shows "signed". A revocation reaches another machine only at the replication cadence; until then that machine still verifies the key's messages, limited by the receipt to messages a machine actually accepted (spec §4.8, accepted). Key validity uses only the end of a key's history window, never `validFrom` (a peer's `validFrom` is local pinning time and can postdate honest records); a key used after its recorded end reads `unknown`, not `failed`. The verifier trims the signed `text` before comparing, because the send routes store the trimmed text (whitespace only).

The Telegram route still refuses invites, desktop codes and credential-shaped text as before (the §4.2 "remove instead of refuse" conversion of that route is not part of this increment); the "📱 signed" tag is not added to Telegram-injected messages (the Telegram inbound core is unchanged). Pool-scope Telegram history joins peer rows against this machine's store copy.

---

## 3. Level-of-abstraction fit

No new crypto primitive: machine signatures use `MachineIdentity.sign`/`verify` (Ed25519, the mesh's identity key) and the key history comes from `IdentityStore.signingKeyHistory` (the same lookup `resolveIdentityOriginKey` uses for Telegram origin records). Device signature checks reuse `isStrictLowSDer`, `parseDevicePublicKey` and the canonical string format of `MobileDeviceKeys`. Ledger replication rides the replicated-store foundation exactly as the `appConversations` kind does.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The verdict is a label on stored records; nothing gates on it (it only chooses whether the session tag says "📱 signed"). The ledger grants nothing; device authentication is unchanged. The ledger-ingest signature check and the persist-before-dispatch refusal are structural invariants, not judgments.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. Every check in `verifyRecordedOrigin` is a cryptographic or exact comparison listed in spec §4.6; the spec's decision table classifies the verdict as an invariant.

---

## 5. Interactions

- **Write order:** confirm/revoke write the ledger row first; a crash between the two writes is repaired at boot in either direction (tested); a live registry-write failure after a revocation row is retried once, and otherwise left to boot reconciliation (see the review section). Reconciliation runs once per boot in AgentServer after the ledger is attached to the pairing service.
- **Telegram eventId:** with native on, the Telegram history row's `eventId` becomes the store's event id (`op-…`) instead of `mobile:<device>:<request>`; the pool-merge de-duplication keys on eventId and is unaffected. With native off nothing changes.
- **Boot recovery:** Telegram sends with native on are reserved with `{op:'send', conversationKey:'telegram:N', messageId}`, so the existing `recoverStranded` treats them like native sends (row missing ⇒ not-delivered; row without delivery ⇒ unknown).
- **Feedback loops:** replicated ledger rows are appended without calling the emit hook, so they are not re-emitted.
- **Circular import:** `mobilePairingRoutes` ↔ `mobileConversationRoutes` (functions only, used inside handlers); tsc and the route tests load both.

---

## 6. External surfaces

New durable file `.instar/mobile-device-key-ledger.jsonl` (0600, never pruned; registered in the state registry, class C). New journal kind `mobile-device-key-ledger-row`. History responses gain `originVerified` values other than `unknown`; sync responses still strip the raw origin and receipt. Device Telegram history reads gain `originVerified` and may include `fromStore` rows. No new route, no operator action.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard file is touched; the app shows the verdict in increment 5).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** — the ledger rides the `mobileDeviceKeyLedger` replicated-store kind, injected into the resolved stateSync flags whenever native is on; peers' rows land at boot from the peer streams and on every commit, each accepted only when it verifies under the pinned key of the machine it names. Verification on any machine uses that machine's copy of the ledger and its pinned key history. Device records stay machine-local (unchanged).

---

## 8. Rollback cost

Switch `mobilePairing.native.enabled` off: the ledger stops being written and nothing reads it; the Telegram route returns to its previous behaviour; files stay on disk. Reverting to increment 1 leaves the ledger file and `mobile-device-key-ledger-row` journal lines unread, and stored `receipt` fields are ignored by increment 1's validator (it drops unknown fields). No fleet impact (dark).

---

## Conclusion

Clear to ship as a dark increment on top of #2530. Not in this increment, stated plainly: the Telegram chat route's switch from refusing invites/desktop codes/credential text to removing them (spec §4.2 applied to §4.9), the "📱 signed" tag on Telegram-injected messages, dashboard pairing (`dashboard-pin`, increment 3), Slack (increment 4), and the app's display (increment 5).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, fresh context)
**Independent read of the artifact: concur** (round 3; rounds 1 and 2 were "concern", resolved below — round 2: replication still keyed a phone key as one pairing, and a missing pairing row read `failed`).

The reviewer found no way to get `verified` for a forged, tampered or cross-conversation record and no path that stores a removed token. Its findings and their resolution, each in this change:
- **Must-fix — a retry after an early refusal could show other text as verified.** The Telegram route released the request id after a refusal while the signed copy (ids derived from device and request id only) stayed in the store; a retry with the same id and different text reused the stored event id. The seed now includes the payload hash, so a retry with different text is its own record; and the history join gives no verdict (`unknown`) to a Telegram row whose text differs from the stored copy. Integration-tested.
- **Must-fix — the join showed messages that never reached the agent.** Store-only rows are now added only for operator messages whose delivery is `delivered`, `intercepted` or `unknown` (never `refused` or `pending`), and carry `deliveryState`. Integration-tested.
- **One key paired under two device ids** (another machine, or re-paired after the revoked record was pruned). The ledger view, the duplicate checks, reconciliation AND the replicated record key (`ledgerRowId` now includes `deviceId`) are keyed per pairing, so the old pairing's revocation never revokes the new one, the two pairings' rows never overwrite or de-duplicate each other on a peer, and each keeps its own lifetime on every machine. Unit-tested locally and through a peer ledger ingesting both pairings (second review round).
- **Spec wording, deliberate deviation:** §4.6 lists "`deviceId` … differs from the ledger row" under `failed`. With the ledger keyed per pairing, a record whose (key, device id) has no row on this machine reads `unknown` ("this machine does not know this pairing yet", which replication lag makes normal), and `failed` is kept for a row that exists for that pairing and disagrees (public key, device id field, host). This never yields `verified` for a mismatch; it only avoids marking honest records `failed` during lag (second review round).
- **Registry write failing after the revocation row:** the route now retries the registry write once; if both fail it answers 500 and boot reconciliation completes the revocation. Residual, accepted: in that window the device can still send, and those messages read `failed` (accepted after the recorded `revokedAt`).
- **receivedAt** is now the moment the device authenticator accepted the signature, not later in the handler.
- **Path form:** with the signed copy kept, the Telegram route refuses a non-canonical topic id (`/mobile/chat/077`) with 400, so a stored path always names its conversation exactly. Integration-tested.
- **PostUpdateMigrator** doc comment re-attached to its function.
- Accepted as designed, stated here: a receipt does not cover `eventId`, so a machine of this agent could copy a verified (signature, receipt) pair into a second event of the same conversation; machines of one agent are trusted (spec §4.6 "relative to the ledger this machine holds"). A replicated ledger row that cannot be checked yet (peer identity not pinned here) is dropped on the live path and retried from the peer streams at the next boot. Boot order: server.ts lands peers' ledger rows before AgentServer runs reconciliation. Boot recovery (`recoverStranded`) derives its `unknown` delivery-event id from (device, request) while the Telegram route's own events use (device, request, payload hash); the ids differ but each is written once per message, so the delivery reduction is unaffected.
- **Round 3: concur** — `ledgerRowId` includes `deviceId` (replication per pairing, peer-ingest test); a missing pairing row reads `unknown`. The record-key change is safe because the feature is dark and new in this increment (no peer stream holds rows under the old keys). No remaining must-fix.

---

## Suite ratchets settled in this change (Zero-Failure)

The full unit run surfaced four red ratchets on this branch; each is fixed here, not labelled pre-existing:
- `no-silent-fallbacks` (496 > 494): the new ledger read catch, and increment 1's lease-binding catch in AppConversationService, both report through the `reportDegradation` callback; each now carries an in-brace `@silent-fallback-ok` naming that, so the count is back to 494.
- `SqliteRegistry-wiring`: increment 1's `AppConversationStore` (which registers its handle) is added to the long-lived store allowlist.
- `tone-advisory-channel-parity`: increment 1's `POST /app/session-reply` callsite is named as an exemption — its body permits only `{conversationId, text}` from a bind-token-scoped session, so there is no metadata surface to carry an ack.
- `console-mandates` whenWords: a wall-clock test that failed on the 25-hour daylight-saving day (2026-11-01 00:27, "now + 24 h" stayed on the same date) now uses a fixed local noon in June.

## Evidence pointers

tests/unit/app-record-signatures.test.ts, tests/unit/mobile-device-key-ledger.test.ts, tests/unit/PostUpdateMigrator-appConversationsSignedRecords.test.ts, tests/unit/no-silent-fallbacks.test.ts, tests/unit/SqliteRegistry-wiring.test.ts, tests/unit/tone-advisory-channel-parity.test.ts, tests/unit/console-mandates.test.ts, tests/integration/mobile-native-signed-records.test.ts, tests/e2e/mobile-native-conversations-alive.test.ts.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Boot reconciliation is not a repeating actuator: it runs once per boot and each repair leaves the condition it repaired (a row now exists, or the device is now revoked), so a second run is a no-op (tested).
