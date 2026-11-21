# Side-Effects Review — Telegram topic names reach every machine

**Version / slug:** `topic-name-replication`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no block/allow, session-lifecycle, gate, sentinel or watchdog surface; the driving spec had six rounds of independent internal and cross-model review)

## Summary of the change

Tier 2. Telegram topic names and renames now replicate to every machine of the agent on the existing WS2 record path (new kind `telegram-topic-name-record`, store `telegramTopicNames`), are applied to each machine's `TelegramAdapter` map and `topic-session-registry.json`, and are carried once by every machine that accepts them, so they survive the machine that learned them (Studio outage ledger N40, CMT-2095; spec `docs/specs/topic-name-replication.md`). New files: `src/messaging/TelegramTopicNameReplication.ts` (row schema, fold, store, drain) and `src/messaging/TelegramTopicNameReplicationWiring.ts` (boot wiring). Edited: `TelegramAdapter.ts` (publish seam after create/edit/capture; `applyReplicatedTopicName`, `persistTopicNames`, `listTopicNames`; session binds keep the replicated name), `server.ts` (kind registration, switch, peer-commit observer line, wiring before `telegram.start()` and on the send-only branch, rename-label handler on every machine), `TelegramLifeline.ts` + `routes.ts` (forward Telegram's time and message id for rename notices), `CoherenceJournal.ts` (kind tables), `JournalSyncApplier.ts` (feature evidence), `ReplicatedStoreReconcilerWiring.ts`, `BackupManager.ts`, `state-coherence-registry.json`, `feature-ladders.json`, an awareness entry. Size: about 13 source files and 3 new test files, roughly 750 added lines; spec review took 6 rounds (the Tier 2 cap) and this commit is the first gate attempt.

## Decision-point inventory

- Fold: which name row wins per topic — add — total order rename > lead > fill, then time, then Telegram message id, then event id, then name (an invariant on row content, not a judgment).
- Gap-fill rule: a `fill`/`lead` row replaces only a missing name or one a fill put there — add.
- Session bind name — modify — `registerTopicSession` keeps the replicated name instead of the caller's when the store holds a rename or an applied fill.
- Which emitter outcomes count as sent / final — add (enumerable outcome set).
No block/allow decision on messages, sessions, or actions.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The closest analogue: a name with control characters, line breaks, bidi overrides or zero-width marks is not replicated (it stays on the machine that learned it). Telegram topic names essentially never contain these.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Known gaps in what replicates (documented in the spec's residual risks): a name learned by a lead that dies before any peer pulls its stream; an agent rename and an owner rename within about a second; a pre-upgrade name mismatch on a machine that held its own name (heals on the next rename).

---

## 3. Level-of-abstraction fit

Right layer. It rides the existing generic WS2 replicated-record path (journal, emitter, peer reader, commit observer) exactly as `conversation-list-pin` and `conversation-graph-suggestion-record` do, rather than adding a transport. The adapter remains the single owner of the name map; the store only folds rows and calls the adapter's apply method. The parent spec's future `agent-setting` kind can name this kind as the carrier for Telegram topic names.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

It writes a name into a map. It never blocks, filters, routes or gates anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The fold is an invariant over an enumerable domain (the rows held for one topic), computed identically on every machine so they converge; the spec's `## Decision points touched` classifies each row with basis and evidence.

---

## 5. Interactions

- **Shadowing:** `registerTopicSession` now defers to the replicated name; its callers (spawn, dashboard binds, respawns) see the replicated name instead of the one they passed when a rename or applied fill is held. Without a held name, unchanged.
- **Double-fire:** `topicRenamedHandler` now also fires when a replicated rename replaces a real name, and is registered on the send-only branch (standbys, lifeline-owned leads) — previously renames forwarded by the lifeline never relabelled sessions there. It only renames a session's display label.
- **Races:** all writes happen on the server's event loop; the store writes its state file before the registry file, and a boot reconcile repairs a crash between them. The lifeline never writes the registry file.
- **Feedback loops:** carrying re-emits an accepted peer row once; a receiver that already holds that row does not see a new winner and does not carry it again, so carrying terminates. The apply path never calls the publish hook.
- **Self-triggered retry:** the drain retries refused emits on a timer (5 s after progress, 2 min doubling to 1 h when nothing is sent, one report after six empty ticks). Steady state: zero ticks when nothing is unsent (`arm()` returns without a timer); bounded by one batch of 80 rows per tick under the journal's per-kind token bucket.

---

## 6. External surfaces

- Other agents on the same machine: none.
- Install base: every multi-machine agent with the coherence journal starts sharing topic names; a single-machine agent writes rows into its own journal that nobody reads (bounded: one row per name change, under 400 bytes).
- External systems: no new Telegram API calls. The lifeline's forward to `/internal/telegram-forward` gains two optional fields (`topicEventAtMs`, `topicEventSeq`) on rename notices; older servers ignore them.
- Persistent state: new `state/telegram-topic-names.json` (0600, atomic), registered in the state coherence registry and the backup list; new journal stream files of the new kind (2 MiB rotation, never deleted).
- Timing: names reach peers within the journal-sync cadence; a one-time burst at first boot after upgrade (backfill of pre-upgrade names, paced 80 rows per 5 s).
- Operator surface: no operator-facing actions added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** — `telegram-topic-name-record` on the WS2 coherence-journal path; every machine applies winners to its own map and registry, and carries accepted rows into its own stream so names survive the machine that learned them. `state/telegram-topic-names.json` is the outbox and fold cache of replicated rows (its `filled` bookkeeping is safe to lose). No user-facing notices. Durable state does not strand on topic transfer (it is per-topic data present on every machine). No URLs. Status surfaces: none added; a stuck outbox is reported as the `TelegramTopicNames.replication` degradation, and an agent with journal replication off records `held: journal-replication-not-on` feature evidence.

---

## 8. Rollback cost

Off switch `multiMachine.stateSync.telegramTopicNames.enabled: false` (read at boot) or revert the release. Names already applied stay in each registry file and are correct data. Journal lines of the kind stay inert (an unregistered kind is ignored). No migration, no user-visible regression during rollback.

---

## Conclusion

The review loop (six spec rounds) reshaped the design substantially: evidence ranks (rename > lead > fill) so a creation name can never undo a rename, wall-clock and Telegram-time stamps with message-id ordering, an in-process paced drain instead of boot-only retry, wiring before polling starts, chat scoping, crash-safe write order, and once-per-machine lead backfill. Clear to ship; the accepted long-tail items are listed in the convergence report's Left behind section.

---

## Second-pass review (if required)

Not required (see header).

---

## Evidence pointers

- `tests/unit/telegram-topic-name-replication.test.ts` (35 tests), `tests/unit/topic-names-through-lifeline.test.ts`, `tests/unit/CoherenceJournal.test.ts`.
- `tests/integration/telegram-topic-name-replication.test.ts` (3 tests: three machines over real journals; rebuilt machine learns names with the lead gone).
- `tests/e2e/telegram-topic-name-replication-alive.test.ts` (3 tests: production wiring alive, restart idempotent, kill switch, server.ts wiring).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The drain is a bounded retry of the store's own outbox (steady state: no timer while nothing is unsent; one batch per tick; hourly ceiling), recorded here for the self-action reader.
