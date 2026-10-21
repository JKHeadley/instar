# Side-Effects Review — delayed-notice gate + single-creator system topics

**Version / slug:** `telegram-notice-spam-and-system-topics`
**Date:** `2026-10-20`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Two Telegram fixes from operator topic 127648.

(1) `src/messaging/telegram-origin/OriginForwardToHolder.ts` gains `HeldNoticeGate`; `forwardReplyToHolder` consults it before `notify`, and `src/commands/server.ts` (`onLeaseHoldObserved`, the direct lease-hold path) consults the same instance. The fixed "I have your message; my reply is delayed" notice is sent only for a held message whose sealed envelope says `producerKind: 'session'`, at most once per topic per 6 h. `OriginStoreBackend.listHeldOperations` now extracts `producerKind` from the envelope (`StoreTypes.HeldOperationRow.producerKind`, optional). Suppression is audited (`notice-suppressed`). A held item already noticed in its topic raises no second hub item.

(2) `StateManager` gains `SYSTEM_TOPIC_STATE_KEYS` and `adoptSystemTopicId` (write allowed while read-only, for those three keys and positive topic ids only). `server.ts` boot `ensureAgentUpdatesTopic` / `ensureAgentAttentionTopic` return early on a read-only (standby) StateManager, and Updates now find-or-creates by name. `TelegramAdapter` gains `config.systemTopics` (`canCreate`, `getAgentHealthTopicId`, `recordAgentHealthTopicId`): the attention-hub self-heal and the agent-health lane never create a topic when `canCreate()` is false (or throws); the lane uses the recorded/adopted id first and persists one it creates. New `src/messaging/SystemTopicAdoption.ts` + route `GET /telegram/system-topics`; a standby adopts the holder's ids 20 s after boot and then on a 30-minute cadence. CLAUDE.md template + `PostUpdateMigrator` get the awareness row and an idempotent in-place refresh of the held-notice sentence.

## Decision-point inventory

- Held-reply notice (forward path + direct path) — **modify** — now suppressed for non-session authors and for an already-noticed topic.
- Held-reply hub attention item — **modify** — not raised when the topic was already noticed this episode.
- System topic creation (boot Updates/Attention, hub self-heal, agent-health lane) — **modify** — only when this machine is not a read-only standby.
- StateManager read-only guard — **modify (narrow exception)** — `adoptSystemTopicId` bypasses the guard for exactly three keys.

---

## 1. Over-block

- A session reply genuinely answering the user, held in a topic already told within 6 h, gets no second notice. Intended: one notice per hold episode; the held reply still delivers on recovery.
- A held message with an unreadable envelope (`producerKind` null) gets no notice. It stays held, retried, listed in `/telegram/origins/status`, and raises the hub item; only the in-topic line is skipped.
- A standby with no adopted hub/lane id (first seconds after boot, or holder unreachable) posts attention/lane items nowhere in Telegram; the items are still recorded in the attention store and a degradation is reported. Previously it would have minted a duplicate topic.

## 2. Under-block

- A session posting autonomous progress (not answering anyone) and getting held still produces one notice per topic per 6 h. Acceptable: session-authored messages are the case the notice was designed for.
- The cooldown map is in memory; a restart can allow one more notice per topic. Bounded (one per topic per boot).
- Duplicate topics already created stay in Telegram; deletion is a separate operator decision.
- A machine that wins the lease with no local ids and never adopted will find-or-create by name from its OWN name registry, which may resolve to one of its own old duplicates. It will not mint a new one if a same-named topic is known.

## 3. Level-of-abstraction fit

The notice decision sits at the two places that already send it, behind one shared gate instance — no new parallel path. Author identity comes from the existing sealed origin envelope (`producerKind`), the authoritative record of who wrote a message, not from text heuristics. The create-or-not decision uses the existing standby signal (`StateManager.readOnly`, set by MultiMachineCoordinator from the lease before Telegram boots). Adoption reuses existing peer URL resolution (`resolveMeshPeerUrl`) and the bearer auth already used by `relayOutbound`.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over user content.

The gate only decides whether to ADD a fixed informational line; it never blocks, delays or rewrites a real message. The check (`producerKind === 'session'`, a cooldown) is an invariant on a structured field, not brittle content matching. The standby create-guard prevents a hard-to-undo side effect (creating a Telegram topic) and fails closed (an unreadable lease never creates).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Both checks are invariants: "only a session's reply may claim 'I have your message'" and "only the lease holder may create shared topics".

## 5. Interactions

- `HeldForwardItemCollapser` still collapses hub items; the new `already-noticed` skip only removes items for topics the user was already told about.
- `runtime.refreshHeldForward` still marks direct holds reported (`reportedAt`), so a suppressed row is not re-observed.
- WriteAdmission seam: `adoptSystemTopicId` does not go through `guardWrite`; it is a deliberate, allowlisted exception analogous to the coherence-journal entrypoint. Writes outside the three keys still throw on a standby (tested).
- `/telegram/post-update` and `AutoUpdater` read `agent-updates-topic`; on a standby they now see the holder's id once adopted (previously its own duplicate or none).
- Attention hub `getAttentionHubTopicId` reads `agent-attention-topic`; adopted ids flow through unchanged.
- Self-action convergence: the adoption loop is a self-triggered cadence. Its brake is the per-kind per-boot adopt cap (`withAdoptionBrake`, 3) plus idempotent writes; registered as `system-topic-adoption` in `src/testing/selfActionRegistry.ts` so the convergence ratchet proves it settles (boundK 9, perTarget 3) under a flapping holder.

## 6. External surfaces

- New authenticated read-only route `GET /telegram/system-topics` (Bearer, no secrets in the body).
- Fewer Telegram messages (notices) and no new topics from standbys — the user-visible intent of the fix.
- `logs/telegram-origin-held.jsonl` gains `notice-suppressed` rows and `ts`/`producerKind` on direct rows.
- No operator-facing actions added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**replicated (pull from the holder)** for the system-topic ids: the lease holder's record is authoritative; standbys pull it via `GET /telegram/system-topics` over the existing peer URL resolution on a cadence and persist it. **machine-local BY DESIGN** for the notice cooldown: the notice is emitted by the machine holding the reply; one machine holds a given reply.

## 8. Rollback cost

Pure code revert in a patch release; no data migration. Adopted ids in `state/agent-*-topic.json` are valid topic ids either way. The `agent-health-topic` key becomes unused on revert. The CLAUDE.md row refresh is text-only.

## Conclusion

Ships. Both fixes remove user-visible noise without removing any hold, retry, status or audit path.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only audit of the diff + this artifact, 2026-10-20)
**Independent read of the artifact: concur**

"Concur with the review." Verified: `producerKind` is read from the same envelope path as `executionOwnerMachineId` and a `/telegram/reply` send carries `session`; no temporal dead zone at the two `wireSystemTopicAdoption` call sites; `readOnly` is set synchronously by `MultiMachineCoordinator.start()` before Telegram boots; the `adoptSystemTopicId` exception is limited to three keys and positive ids; every creation path for the three topics is gated; signal-vs-authority compliant.

Three minor gaps raised, two closed in this change: (1) a machine promoted to holder after booting as standby now runs its own `ensureAgent*Topic` on each adoption pass (`ensureOwn`); (2) the holder's lazily created Attention hub now records `agent-attention-topic` so standbys can adopt it. (3) Background holds still raise one collapsed hub item each — intended, kept.

## Evidence pointers

See `upgrades/next/telegram-notice-spam-and-system-topics.md` → Evidence.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` — this change adds a self-triggered controller (the standby's system-topic adoption cadence, `startSystemTopicAdoptionLoop`) and modifies a self-triggered notify (the held-reply notice).
- **`closure`**: `guard`
- **`guardEvidence`**: enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts` (registry entry `system-topic-adoption` in `src/testing/selfActionRegistry.ts`). How it would have caught this defect: the control-loop edge is the holder's record changing; the steady-state bound is idempotence (an unchanged id writes nothing) plus the settling brake `withAdoptionBrake` (at most 3 re-adopts per kind per boot, then hold + one log line), so under a flapping holder the ratchet proves the loop settles at boundK 9 / perTarget 3 and does not scale with the horizon. The notice gate only suppresses an existing notify (once per topic per 6 h cooldown); it adds no new emit.
