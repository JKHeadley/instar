# Side-Effects Review — machine names always exist; the footer shows the real model

**Version / slug:** `machine-name-and-footer-model`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, session lifecycle or block/allow change; evidence and presentation only)`

## Summary of the change

Tier 1 (small, reversible), 12 source/test files, about 450 changed lines including tests. One spec-review round (none: Tier 1), first commit attempt. Operator report 2026-11-12 (Bob agent footer `bob · Machine m_4851af · Claude Code · unknown`).

1. **Machine names.** `src/core/friendlyMachineName.ts` (new) reads the name the owner gave the computer (macOS `scutil --get ComputerName`, Linux `hostnamectl --pretty` / `PRETTY_HOSTNAME`, else a prettified hostname). `MachineIdentityManager.registerMachine` uses it when a machine registers itself (init, setup, pairing self-registration); a peer registered by another machine is named from its hostname and marked `nicknameSource: 'auto-derived'`. New `MachineIdentityManager.ensureNicknames()` fills any machine without a usable nickname and upgrades this machine's own derived name; it runs at every coordinator boot (`MultiMachineCoordinator.start`) and as a `PostUpdateMigrator.migrateMachineNicknames` migration. `updateNickname` records `nicknameSource: 'user'`; user and legacy names are never replaced, except a legacy nickname that is exactly the automatic derivation of the identity name (for example "Groky" on an agent whose init named the machine after the agent). `isValidNickname` now accepts apostrophes. `MachineRegistryEntry` gains optional `nicknameSource`.
2. **Model evidence.** Root cause: `RuntimeOriginObserver.readJsonl` treated any transcript line longer than one 256 KB read as an error, dropped the buffer, then parsed the rest of that line as a record, which failed and set `parser.invalid = 'malformed-native-record'` permanently for the session. Claude Code writes screenshots and big tool results as single lines, so long sessions lost their model for good and fell back to the launch model, which is null for account-default launches, hence "unknown". The reader now keeps an incomplete record across reads (chunk list, joined once) up to `maxRecordBytes` (16 MB); a record over that bound is skipped to its newline and only resets the current turn. Second cause: the send-time read was one 256 KB step, so a backlog answered `source-backlog-or-partial-record`; `refresh(id, { catchUp: true })` (used by `TelegramOriginService.sessionProducer`, `attributeLegacy`, and `TriageOrigin`) reads up to `maxCatchUpBytes` (16 MB) before answering. The 250 ms background poll keeps its one-step bound.
3. **Footer wording.** `originFooter` (Telegram) and `slackOriginFooter` (Slack) leave out a field whose evidence is unknown instead of printing `unknown` / `unknown machine` / `unknown harness` / `unknown model`, matching the existing automation-footer rule. The signed origin record still carries `status: 'unknown'` and its reason.

PR 3124 (open) changes the Telegram origin boot fallback to nickname, then registry name, then identity name, then the raw id, via a new `publicMachineName` in `OriginPresentation.ts`. This change does not touch that code (`TelegramOriginBoot.ts` and the end of `OriginPresentation.ts` are left as they are); the edit here is inside `originFooter` only, so the two diffs do not overlap. With a nickname always present, either fallback chain resolves to the name.

## Decision-point inventory

- `RuntimeOriginObserver` evidence classification — modify — which records count as malformed/unavailable. Evidence only; it never blocks a send.
- `originFooter` / `slackOriginFooter` — modify — which labels appear in presentation text. Presentation only.
- `MachineIdentityManager.ensureNicknames` / `registerMachine` nickname choice — modify — which nickname a machine gets. Naming metadata only; no lease, ownership or routing authority changes (a nickname is user-editable metadata per Session Pool §L2).

---

## 1. Over-block

No block/allow surface. Nothing here refuses a message, a send, or a registration. The nickname validator now accepts more (apostrophes), never less.

---

## 2. Under-block

No block/allow surface. Remaining gaps where the footer still omits the model: a session whose native session id never bound (`native-session-unbound`), a transcript in a config home the observer cannot find (`source-unreadable`), a turn whose single record exceeds 16 MB, and a backlog larger than 16 MB at send time. Those now show no model rather than the word "unknown". Sessions launched with an explicit model still show it as `(configured)`.

---

## 3. Level-of-abstraction fit

The model fix sits in the one native-transcript reader every origin path already uses (Telegram, Slack, app, triage), so all footers gain it. The name fix sits in the machine identity registry, which is the single source every footer, dashboard and pool view reads (`MachinePoolRegistry`, `localMachineIdentity`, the Telegram origin boot, the attention-text resolver `nameIdsInText`). No parallel resolver was added; attention items already swap machine ids for registry names through `TelegramAdapter.setMachineNameResolver`, so filling the registry fixes those too.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The observer produces evidence (a signal) consumed by presentation; nickname assignment is metadata. Neither holds blocking authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The record-size bound (16 MB) and catch-up bound (16 MB) are resource floors on a reader, and "treat a legacy nickname equal to its automatic derivation as automatic" is an enumerable identity check (string equality with the deterministic derivation), not a judgment between live signals.

---

## 5. Interactions

- **Shadowing:** `SelfNicknameResolver` convergence in `server.ts` adopts a peer's view of our nickname only when the local one is empty. Boot now fills the local one first, so that path no-ops more often. A rename typed on another machine still reaches this machine through the registry merge (later `lastSeen` wins). Accepted: the operator can rename from either machine.
- **Double-fire:** the coordinator boot and the migration both call `ensureNicknames`; it is idempotent (second run writes nothing, tested).
- **Races:** `ensureNicknames` is a read-modify-write of `registry.json` like `recordSelfHardware` and `updateRole` beside it; same single-process boot ordering.
- **Catch-up refresh:** when a poll refresh is already running, a catch-up waits for it and then runs, so it never runs two reads of one session at once (the `busy` guard is kept).
- **Feedback loops:** none.

---

## 6. External surfaces

- Telegram and Slack footers lose the words "unknown …" and gain real model and machine names. Footer text is part of the signed request body for new sends only; stored records are unchanged.
- `registry.json` entries gain `nickname` (where missing) and `nicknameSource`. Older peers ignore the unknown field and keep it through the whole-entry merge.
- macOS `scutil` and Linux `hostnamectl` are run once per registration/boot with a 2 s timeout; failure falls through to the hostname.
- Operator surface: no new operator action. Renaming stays on the existing Machines rename (PATCH `/pool/machines/:id`).

---

## 6b. Operator-surface quality

No operator surface file touched (no dashboard renderer or form) — not applicable. The visible effect is the footer line, which now reads as plain names.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Nicknames live in `.instar/machines/registry.json`, which already replicates through git sync with `mergeRegistry` (later `lastSeen` wins). Each machine names itself (it alone can read its own ComputerName) and bumps its `lastSeen`, so its name wins the merge on peers; peers without a name are filled locally from their hostname without bumping their `lastSeen`, so their own entry still wins. The model reader is machine-local by design: each machine reads the transcripts of the sessions it runs. No notices, no URLs, no new status routes.

---

## 8. Rollback cost

Pure code revert, shipped as the next patch. Filled nicknames stay in registries as ordinary, editable names (harmless, and the old code reads them). The extra `nicknameSource` field is ignored by the old code. No data migration needed to roll back.

---

## Conclusion

The review confirmed both causes against live data: Luna's origin store holds 76 session replies with `malformed-native-record` and no configured model, and replaying one of her real 4 MB transcripts through the old reader returns `unknown` while the new reader returns `claude-fable-5-2`. During the review the PeerVisibilityGuard notice text was considered for a name change and dropped, because attention text already swaps machine ids for registry names. Clear to ship.

---

## Second-pass review (if required)

Not required: no gate, sentinel, watchdog, session lifecycle or messaging block/allow decision is touched.

---

## Evidence pointers

- Live replay (old vs new code on real files): Luna transcript `7107beea…` (4,076,989 bytes): before `unknown (malformed-native-record)`, footer `sagemind · Mac Studio 2 · Claude Code · unknown`; after `observed claude-fable-5-2`, footer `sagemind · Mac Studio 2 · Claude Code · claude-fable-5-2`. Copy of Groky registry with the nickname removed (the Bob shape): before `bob · Machine m_bbd267 · Claude Code · unknown`; after backfill nickname `DaBomb's Mac Studio` (auto-self), second run names nothing.
- Tests: `tests/unit/friendly-machine-name.test.ts`, `tests/unit/machine-nickname-backfill.test.ts`, `tests/unit/telegram-origin/runtime-origin-observer.test.ts`, `tests/unit/messageOrigin.test.ts`, `tests/unit/TelegramOriginCanonical.test.ts`, `tests/unit/telegram-origin/origin-service.test.ts`, `tests/integration/message-origin-all-platforms.test.ts`, `tests/e2e/machine-name-and-model-footer-lifecycle.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a` (negative declaration)
- **reason:** no self-triggered action added. The observer change bounds an existing per-send read (catch-up, at most 16 MB per send) and keeps the background poll at one 256 KB step; the nickname backfill is a one-shot idempotent write at boot and update that writes nothing on a second run (tested).

No agent-authored-artifact defect (prompt, hook, config, skill, standards text).
