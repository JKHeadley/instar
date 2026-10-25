# Side-Effects Review — Telegram invite approval uses the verified operator when no owner id is set

**Version / slug:** `invite-approval-owner-from-verified-operator`
**Date:** `2026-10-19`
**Author:** `Dawn`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Pairing by invite in Telegram (spec `docs/specs/a2a-pairing-invite-link.md` §6.1) only lets the agent's owner forward an invite and tap Approve. The owner was read from `TelegramAdapter.getOwnerUserId()`, which returns the Telegram block's `ownerUserId ?? promptGate.ownerId` and nothing else. Agents set up without either (Scout on 1.3.1357; on one machine two of three agents confirmed) refused their real owner with "Only the agent's owner can do this." even though the owner's id was already recorded by the agent's own Know-Your-Principal operator binding.

`src/threadline/PairingInviteTelegram.ts` gains `resolveApprovalOwner(configuredOwner, operatorBindings, everVerifiedUids)`: a configured owner wins; with none, the owner is the one Telegram user who is the ONLY id ever verified on this machine AND is named by the current verified bindings (each re-checked with `isVerifiedTopicOperatorBinding`). Anything else is no owner. `src/users/TopicOperatorStore.ts` gains that history: an append-only, distinct, capped (64) list of every Telegram uid bound through `setAuthenticatedOperator`, persisted in the same `topic-operators.json` under the reserved key `_everVerifiedOperators` and read by `everVerifiedOperatorUids()`. Assertions (`setOperator`) never add to it and overwriting a binding never removes from it. State written before this change has no such key, so it is seeded at load from the current verified bindings. An ABSENT file seeds (empty) exactly as a fresh install always did. A file that is PRESENT but unreadable (unparseable JSON, or a null/array/scalar top level), or a malformed list, is lost history: it is kept as an explicit `{ "telegram": [...], "unreadable": true }` marker, `everVerifiedOperatorUids()` returns null, and approval refuses. Only numeric ids are ever recorded, so the list can always be read back. `operatorTap()` now separates "no owner" (new wording, `NO_OWNER_REFUSAL`) from "not the owner" (`NOT_OWNER_REFUSAL`, unchanged text). `src/server/routes.ts` wires the pairing dep through it, passing `ctx.telegram.getOwnerUserId() ?? ctx.config.monitoring?.promptGate?.ownerId` and the raw bindings of the local `TopicOperatorStore`. `getOwnerUserId()` itself is untouched.

## Decision-point inventory

- `PairingInviteTelegram.operatorTap` owner check — modify — the owner may now come from a single verified operator binding when none is configured; refusal wording split.
- `resolveApprovalOwner` — add — deterministic resolution of the approving principal.
- `TelegramAdapter.getOwnerUserId()` (owner DMs, tunnel consent prompts, prompt relay) — pass-through, deliberately unchanged.
- `TopicOperatorStore` — modify — `setAuthenticatedOperator` also records the uid in the ever-verified list (and persists it even when the binding itself is unchanged and would otherwise skip the write); bindings, verified readers and `all()`/`allBindings()` are unchanged (the reserved key is stripped at load and never appears as a binding).

---

## 1. Over-block

The no-owner fallback refuses once two different people have EVER been verified operators on this machine, even if one of them is clearly the owner and the other spoke once months ago (for example a family member on an agent with no `authorizedUserIds` allowlist). The record is append-only, so this does not heal by itself. That is intended: the rule never picks between principals, and history it cannot see is not evidence of a single one. Such an owner can set `ownerUserId`, or use the dashboard (PIN), which is unchanged. The refusal text now says the agent hasn't been told who its owner is, which points at the fix.

## 2. Under-block

- **Closed in this change: the last speaker on a shared topic can no longer become the approver.** A topic's binding is replaced by whoever spoke there last, so current bindings alone would have let a second group member who spoke last in the owner's topic be the single verified operator (raised by the second-pass review and by the coordinator for Echo's group-chat concern). The ever-verified list now remembers the owner, so the agent refuses both of them (unit and route tests).
- **History before the upgrade cannot be recovered.** The list is seeded from the bindings present at upgrade time. If a second member had already overwritten the owner's binding (or vice versa) before the upgrade, only the survivor is seeded, and that survivor can approve. This cannot be detected retroactively; `ownerUserId` remains the recommended explicit setting, and the PR says so.
- **Corrupt file (Echo review #1, fixed).** First version: an unparseable or non-object `topic-operators.json` left the list undefined, so it was treated as pre-upgrade and seeded from an empty map. The next authorized member to speak then became the sole approver. Now "file absent" (seed) and "file present but unreadable" (unreadable marker, refuse) are told apart. There are tests for each shape (unparseable, null, array, scalar), where a non-owner member binds next and is refused, plus one through the real route.
- **Unreadable is sticky, by design, and here is the repair.** Once the marker is set it survives every save and reload (tested), so approval in Telegram keeps refusing. To repair it, either (a) set `ownerUserId` in the Telegram block, which is recommended because the configured owner wins and the history is not consulted; or (b) after confirming who has really spoken to the agent, delete only the `_everVerifiedOperators` key from `.instar/state/topic-operators.json`. On the next load the store re-seeds from the current verified bindings (tested). Deleting the whole file also works but loses the bindings.
- **Backups shrink or re-seed the history.** `topic-operators.json` is in the backup manifest (`PostUpdateMigrator.migrateBackupManifest`, `TOPIC_PROFILE_BACKUP_ENTRIES`). Restoring an older snapshot brings back that snapshot's list, which may be missing people verified since then. A snapshot from before this PR has no list at all and re-seeds from its own bindings. Either way a restore can turn "two people ever" back into one, the same limit as the overwritten-before-upgrade case above, and the same advice applies: set `ownerUserId`.
- **An assertion can still remove a CURRENT binding, but no longer changes the answer.** `POST /topic-operator` (`setOperator`) overwrites a verified binding with an asserted one. The ever-verified list is untouched, so "two people ever" stays two (test). Wiping the only person's binding gives "no owner", the safe direction. Needs the agent's Bearer token, inside §6.1's cooperative "Honest boundary".
- **Distinct-id cap.** After 64 distinct ids no more are recorded; any count of two or more already refuses, so the cap cannot turn a refusal into an approval.
- In an agent with no `authorizedUserIds` allowlist, every authenticated sender in the group is "authorized", so a binding proves an authenticated Telegram sender, not an owner. If only one person has ever messaged the agent (since the upgrade) and that person is not the owner, that person is the single verified operator. This is the same principal the agent already treats as its operator for every other operator-role decision (session-start `<topic-operator>` block), and the forward and tap must still come through the lifeline with the lifeline-only secret in enforce mode.
- Before the lifeline ingress guard arms (bounded pre-arm allowance in `LifelineIngressGuard`), an unproven forward still carries sender trust and can write a verified binding. A local process with the agent's Bearer token could therefore plant a binding in that window. This is inside the spec's §6.1 "Honest boundary" (the same process could read the lifeline secret file), and approval itself still needs a verified tap from the bound person.

## 3. Level-of-abstraction fit

The fallback lives in the pairing dep, not in `getOwnerUserId()`. `getOwnerUserId()` also chooses the DM target for `sendToOwnerDM` (tunnel URL + PIN + signed view links), the tunnel consent prompt, and prompt-gate relays; widening it would change who receives secrets across the product. The verified-binding primitive (`TopicOperatorStore` + `isVerifiedTopicOperatorBinding`) already exists and is reused rather than re-implemented.

## 4. Signal vs authority compliance

- [x] No — this change has no new brittle block surface; it adjusts which principal an existing deterministic authority check compares against.

The owner check is a safety guard on an irreversible-ish action (pairing grants trust) and is deterministic by design, as spec §6.1 requires. The new input is the store's own verified-binding oracle, not a heuristic.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Exactly one verified principal, else refuse" is an invariant (Know Your Principal: an unverified or ambiguous identity is a guess), not a weighing of live signals.

## 5. Interactions

- **Shadowing:** the configured owner still short-circuits, so agents with `ownerUserId`/`promptGate.ownerId` behave exactly as before (test: "a configured owner still wins over a verified operator binding").
- **Double-fire:** none; the resolver is a pure read per forward/tap.
- **Races:** the store caches one JSON file in memory; the same instance the auto-bind writes is the one read (`ctx.topicOperatorStore`), so a bind is visible on the next tap.
- **Feedback loops:** the invite-carrying forward returns before the operator auto-bind, so forwarding an invite never binds anyone.
- **Replication / assertions:** `TopicOperatorReplicatedStore` records are a separate store and are never passed in, and it never writes `topic-operators.json`, so it cannot add to the ever-verified list. Asserted `POST /topic-operator` records are never counted and never add to or remove from the list; an assertion can still replace a current verified binding (see §2).
- **Store consumers:** the reserved key is stripped at load, so `getBinding`, `getOperator`, `all()`, `allBindings()`, `GET /topic-operators` and the profile surface's `boundOperator` see exactly what they saw before. An older Instar reading the new file sees one extra non-binding entry, which every verified reader already rejects. The BackupManager entry for the file now carries the list too. The idempotent re-bind still skips the disk write when nothing changed (existing test passes).
- **Malformed configured owner:** config is raw JSON. A configured owner id written as a numeric string is accepted; any other non-empty configured value means "no owner" and never falls through to the bindings, so a typo cannot hand approval to a binding. (Before, a string owner id silently never matched anyone.)

## 6. External surfaces

- Telegram text: a new refusal "I can't approve this here because this agent hasn't been told who its owner is." followed by the existing dashboard hint. "Only the agent's owner can do this." is kept for a genuine non-owner.
- Agents with no configured owner but one verified operator now get the Approve/Decline prompt instead of a refusal (the fix).
- `monitoring.promptGate.ownerId` now counts as a configured owner for pairing. It never reached `getOwnerUserId()`: the adapter is built from the messaging block's `config` only (`src/commands/server.ts`, both `new TelegramAdapter({...telegramConfig.config, ...})` sites), and `getOwnerUserId()` reads `this.config.promptGate`, i.e. the messaging block's.
- Operator surface: the dashboard PIN route is unchanged and remains the phone-completable fallback named in every refusal.
- No persistent state written.

## 6b. Operator-surface quality

No dashboard or approval-page file touched — not applicable. The Telegram text is plain words.

## 7. Multi-machine posture

Machine-local BY DESIGN. The verified operator binding and the ever-verified list are per-machine (`state/topic-operators.json`) and the Know Your Principal invariant forbids a replicated record from establishing an operator. The Telegram pairing prompt is served by the machine whose lifeline received the forward, which is the machine whose binding was written from that person's authenticated messages. On a machine that never saw the owner's messages the result is "no owner", the safe direction. No new notices or URLs. New durable state: the ever-verified list, in the existing file; it does not strand on topic transfer because it is per-machine and keyed by person, not topic.

## 8. Rollback cost

Revert and ship a patch. The only data written is the `_everVerifiedOperators` key in `topic-operators.json`; the reverted code would read it as one extra raw record that no verified reader accepts, so no cleanup is required (it can be deleted by hand). During rollback the affected agents return to refusing (dashboard still works).

## Conclusion

The fix is the narrowest that closes Scout's case: only the pairing dep changes, a configured owner keeps precedence, and the fallback accepts only the store's verified-binding oracle with an exactly-one rule. The review surfaced the latest-only-binding gap, which is now closed with an append-only ever-verified list in the store, so "exactly one" means exactly one person ever verified here. Remaining honest limits: history before the upgrade cannot be recovered, and the pre-arm window can bind from an unproven forward (inside the spec's cooperative boundary). The spec's §6.1 says "the agent's configured operator user id"; this change reads "configured" to include the verified Know-Your-Principal operator when no id is configured. A one-sentence clarification of §6.1 is suggested in the PR rather than edited into the approved spec.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only)
**Independent read of the artifact: concern raised; on re-read, concur** (concerns 1 and 3 fixed in code; concern 2 neutralised by the same fix. The reviewer concurred on the version before the ever-verified list; that list was added afterwards on the coordinator's direction)

- Concern 1: the artifact described binding replacement only in the harmless direction; the last speaker on a shared topic can become the approver on an open-allowlist agent. Resolution, first pass: documented. Resolution, final: FIXED in code with the append-only ever-verified list (coordinator direction before Echo's review); tests and mutations below.
- Concern 2: "asserted records never count" was true only of counting in; an assertion can delete a verified binding. Resolution: deleting a current binding no longer changes the answer, because the ever-verified list is untouched by assertions (test).
- Concern 3: a configured owner of the wrong JSON type (string) was skipped and fell back to bindings. Resolution: code changed: numeric strings accepted, any other configured value means no owner; test added and mutation-checked.
- Confirmed by the reviewer: only `setAuthenticatedOperator` writes records that pass the oracle; both writers require `isAuthorizedSender` and exclude untrusted senders; exactly-one rule and configured-owner precedence hold; the replicated store never writes `topic-operators.json`; an invite forward returns before auto-bind; the pre-arm statement is accurate; leaving `getOwnerUserId()` unchanged is right.

---

## Evidence pointers

- `tests/unit/threadline/PairingInviteTelegram.test.ts` (42 pass: adds corrupt-file x4, marker survives save and reload plus the repair step, absent-file fresh install, numeric-only ids): configured owner wins (string id too; malformed means no owner); one verified operator resolves; two different operators, none, asserted-only, legacy/evidence-mismatched records and a non-Telegram binding give no owner; owner then a second member in the SAME topic gives no owner, and the owner speaking again does not undo it; current bindings must name the one ever-verified id, and two current bindings refuse even with a one-id history; an assertion overwrite neither erases nor adds to the list, which survives reload; upgrade seeding from existing state (one id, two ids, assertion not seeded); an unreadable list fails closed; operatorTap wording for no owner vs a non-owner.
- `tests/integration/pairing-invite-telegram-routes.test.ts` (14 pass, adds a corrupt file through the real route): through the real `/internal/telegram-forward` and `/internal/telegram-callback` routes with a real `TopicOperatorStore`: the owner's own authenticated message binds him, his invite opens Approve and his tap approves; owner then a second member speaking last in his topic refuses both with the no-owner text; another sender gets the non-owner refusal; two operators and no binding get the no-owner refusal; an unproven message binds nobody (observe and enforce); a `POST /topic-operator` assertion never counts; a configured owner wins; `monitoring.promptGate.ownerId` counts.
- `tests/integration/topic-operator-polling-bind.test.ts`: its raw-file key assertion now excludes the reserved key and checks the list. All 28 test files that touch the operator store pass (299 tests).
- Mutation, new guards: 9 tried, 9 caught (resolver ever-verified check removed; ever size-only without matching current; verified bind not recorded; assertion recorded; no upgrade seeding; seeding ignores verification; unreadable list read as empty; list not persisted; route not passing the list).
- Mutation, Echo-review guards: 7 tried, 7 caught (catch branch not unreadable; non-object top level not unreadable; marker not persisted; marker ignored on reload; accessor hides unreadable; non-numeric ids recorded; malformed list not unreadable).
- Mutation, first-round guards re-run after the change: 9 of 9 caught. The "exactly one current binding" guard first SURVIVED (the ever-verified check subsumes it on a consistent store); a test with two current bindings and a one-id history was added and now kills it.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a runtime source bug: the owner source ignored the agent's verified operator).
