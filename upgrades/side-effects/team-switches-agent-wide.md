# Side-Effects Review — team settings turn on for the whole agent

**Version / slug:** `team-switches-agent-wide`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (general-purpose), see below`

## Summary of the change

Tier 2 (multi-machine config). The owner's People page showed one row per machine for memory privacy and app conversations, and the memory-privacy button only changed the serving machine. Now `GET /mobile/team/context` returns `teamSwitches` (one line per setting with `offOn` machines and one action), and `POST /mobile/team/switches/turn-on` (owner phone, Face ID, signed line `team-switch-on <setting>`) runs `TeamSwitchApplier.turnOn`, which sends a machine-signed `POST /api/team-access/switch-on` to every dialable peer, lists registered machines with no address as unreachable, applies the setting on this machine last, persists unanswered requests in `state/team-access/switch-requests.json` and retries them on the team exchange tick. The legacy `POST /mobile/team/memory-privacy` uses the same path. The `machine-below-floor` refusal text no longer suggests marking a live machine gone. Files: `src/core/TeamSwitches.ts` (new), `src/core/TeamAccessSync.ts`, `src/server/teamRoutes.ts`, `src/server/mobilePermissionsRoutes.ts`, `src/server/machineRoutes.ts`, `src/server/AgentServer.ts`, `src/server/mobilePairingRoutes.ts`, `src/server/routes.ts`, `src/server/CapabilityIndex.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, tests. Size: about 12 source files, roughly 450 added lines; one spec review round; effort in line with size.

## Decision-point inventory

- Owner team action gate (`writeGate` with `teamControl`, Face ID presence signature) — pass-through — the new route reuses it unchanged; the action line adds the setting.
- Peer route `POST /api/team-access/switch-on` — add — machine-authenticated; accepts only two named settings, only to turn them on.
- `machine-below-floor` refusal in `floorOk` — modify (text and an added `teamSwitches` field only; the block condition is unchanged).

---

## 1. Over-block

No new block/allow surface. The new route refuses a non-owner, an unsigned request, an unknown setting and a signature for a different setting, all of which should be refused. The `floorOk` condition is unchanged.

---

## 2. Under-block

The `floorOk` condition is unchanged, so nothing new slips through it. A machine whose sandbox is broken still reports privacy off after the setting is on; it stays listed and stays blocking, as it should.

---

## 3. Level-of-abstraction fit

The fan-out uses the same signed machine call (`poolPeerFetch` + `signRequest`) and peer list (`resolvePeerUrls`) as the team access exchange, and the retry rides the exchange's minute timer. team-roles-and-access §3.6 had planned an owner-signed `privacy-required` log event; it was never built, and the log alone could not reach a machine with app conversations off before a team exists. A direct, retried, signed request reaches both cases with no new state model.

---

## 4. Signal vs authority compliance

No brittle check gains blocking authority. The new route is an owner-authorized action behind the existing owner gate. The summary is a read. The peer route grants a paired machine only the ability to turn two settings on, which can only make the peer more private or able to serve the app.

## 4b. Judgment-point check

No competing-signals decision point is added.

---

## 5. Interactions

- `requestSupervisedRestart` writes the planned-restart flag; repeated taps rewrite the same flag (idempotent). A peer already on answers `already-on` and does not restart.
- `TeamAccessPuller` is only read (`standings()`); its floor logic is unchanged.
- The legacy memory-privacy action now fans out, so an older app's button reaches every machine. When `turnOnEverywhere` is absent (an embedder without it) the old single-machine path remains.

---

## 6. External surfaces

- New phone route `POST /mobile/team/switches/turn-on`, allowlisted owner-only in `DEVICE_ALLOWLIST` (permission-actions bucket) and listed in CapabilityIndex.
- New machine route `POST /api/team-access/switch-on` (machine auth). An older peer answers 404 and is reported `needs-update`.
- New context field `teamSwitches`; `machinesBelowFloor` kept.
- Restarts: each machine that changes restarts itself in a planned way, which ends live sessions there; the app's turn-on sheet already warns about the restart for memory privacy.
- Agent awareness: a Registry First line in the CLAUDE.md template plus a content-sniffed migration line. The same line is listed in `migrateFrameworkShadowCapabilities` markers so Codex and Gemini agents get it, and in the section-parity test list.

## 6b. Operator-surface quality

No dashboard file touched. The phone surface is the iOS app (branch `echo/notice-buttons`), which renders one line per setting from `teamSwitches` and reports "Turned on for the whole agent."

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated by direct signed fan-out with durable retry; the summary is a merged read of this machine's standing plus each peer's last reported standing. No machine is skipped silently: dialable peers get the request, registered machines with no address are listed unreachable and kept, older builds are listed `needs-update` and retried. **Status surfaces:** `GET /mobile/team/context` → `teamSwitches` (merged), and the turn-on answer's `machines` list.

---

## 8. Rollback cost

Revert the PR. Settings already turned on stay on (they are ordinary config values the owner chose); the pending file is ignored by an older build. No data migration.

## Conclusion

Ships the owner's request: one line and one tap per setting for the whole agent, with honest per-machine results and retry.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent

**Independent read of the artifact: concern, then resolved**

The reviewer found the security sound (owner-only on two layers; the signed line binds the setting; the peer route only turns two fixed keys on) and raised: (a) a machine with no address could vanish from the summary while still off; (b) machines that applied and are restarting were not in `requested`, so the tap would be offered again; (c) a peer answering 500 was reported `unreachable`; (d) machines the owner marked gone were still fanned out to; (e) the owner device was never passed to peers for their log; (f) the spec overstated how harmless the peer route is for app conversations. Resolution: (a) `teamSwitchSummary` adds owed machines with no standing to `offOn`; (b) `TeamSwitchApplier.requested()` keeps applied-and-restarting machines for up to an hour until their standing says on; (c) `PeerSwitchFailed` maps 500 to `failed`, retried; (d) `knownMachines` filters `isGone`; (e) `requestedBy` carries the owner device and the peer logs it; (f) spec 2.3 now states the deliberate sibling-machine trust and the limits (a failed config write or a missing supervisor can leave a machine answering `applied` while still off; it stays listed). New unit tests cover (a), (b), (c), (e). Concur after these changes.

## Evidence pointers

- `tests/unit/team-switches.test.ts`
- `tests/integration/team-access-routes.test.ts` (block "team settings for the whole agent")
- `tests/e2e/team-switches-two-machines.test.ts`

## Addendum: one tap for everything team access needs
Operator 2026-11-09 ("it should be one single thing for the whole agent"): `POST /mobile/team/switches/turn-on` also takes `setting: "team-access"`. It turns on, in turn, every setting `teamSwitches` reports off somewhere, and answers `{ok, setting: "team-access", settings, results}` (503 when this machine fails any). The Face ID signed line names `team-access`, so a team-access challenge cannot be spent on one setting, nor the reverse (integration test). Nothing new reaches peers: each setting still goes through the same per-setting fan-out.
