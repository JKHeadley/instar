# Side-Effects Review — Threadline Session Completion Retirement

**Version / slug:** `threadline-session-complete-retirement`
**Date:** `2026-05-30`
**Author:** `instar-codey`
**Second-pass reviewer:** `Feynman`

## Summary of the change

This change wires `SessionManager`'s `sessionComplete` event into Threadline thread lifecycle handling. `ThreadResumeMap` gains a reverse lookup from bound tmux session name to live thread records, `ThreadlineRouter` gains `onSessionComplete()` to demote completed non-awaiting thread workers through the existing `onSessionEnd()` path, and `src/commands/server.ts` attaches the listener after the router is constructed. The touched decision point is session lifecycle state transition: whether a live Threadline conversation should leave the active set promptly when its worker session completes.

## Decision-point inventory

- `ThreadlineRouter.onSessionComplete()` — add — decides which bound threads are demoted on a completed worker session.
- `ThreadResumeMap.getBySessionName()` — add — lookup primitive only; it returns live conversation state and does not decide.
- `server.ts sessionComplete listener` — add — forwards a completed tmux session name and optional resume UUID into the router.

---

## 1. Over-block

No block/allow surface. The change does not reject inbound or outbound messages. The main over-demotion risk is a thread that is still waiting for the peer being moved to `idle`; this is guarded by checking the underlying ConversationStore state and skipping `awaiting-reply`.

---

## 2. Under-block

No block/allow surface. The remaining miss is any completed worker whose thread record lacks `boundSessionName`; there is no safe reverse mapping for that case, so it will still rely on the 24h stale-retirement backstop. A session with no captured `claudeSessionId` is still demoted using the existing stored UUID.

---

## 3. Level-of-abstraction fit

This is at the Threadline router/session lifecycle layer, which already owns `onSessionEnd(threadId, uuid, sessionName)`. The new method does not reimplement demotion; it reverse-maps session name to thread ids and delegates each eligible thread to the existing router primitive. The raw `awaiting-reply` guard stays near `ConversationStore` state because the legacy `ThreadResumeEntry` view maps `awaiting-reply` to `active`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

The logic is a lifecycle transition, not a message judgment. It does not block, filter, or score content. The only deterministic guard is whether the stored lifecycle state is `awaiting-reply`, which is a hard state-machine invariant rather than a brittle semantic detector.

---

## 5. Interactions

- **Shadowing:** The listener runs after `SessionManager` emits completion and before the existing 24h stale-retirement backstop would archive stale active entries. It does not shadow inbound routing; future peer replies can still reactivate an idle thread through the normal resume path.
- **Double-fire:** Multiple completion events for the same tmux session are idempotent enough: already-idle entries may be saved as idle again, and `awaiting-reply` entries remain untouched. The log only emits when at least one matching thread is found.
- **Races:** The reverse lookup reads active conversation records without running stale-retirement as a lookup side effect, then each demotion uses `ThreadResumeMap.save()`, which writes through the ConversationStore mutation path. A concurrent state change to `awaiting-reply` after lookup remains the main race; the window is small and the next inbound/outbound action can restore state.
- **Feedback loops:** Demoting a thread reduces active-list noise and prevents the stale backstop from being the first lifecycle update. It does not spawn sessions or send messages.

---

## 6. External surfaces

Other agents see more accurate Threadline active-thread state sooner after a worker finishes. Persistent state changes in `{stateDir}/threadline/conversations.json` move eligible records from `active`/`open` to `idle` and refresh the stored session UUID when available. There are no Telegram, Slack, GitHub, Cloudflare, or wire-format changes. Timing depends on `SessionManager` completion detection, but that event already drives other lifecycle systems.

---

## 7. Rollback cost

Hot-fix release: revert the listener and helper methods, then ship the next patch. No migration is required. Existing records demoted to `idle` remain valid and can still be resumed/reactivated on the next peer reply; no agent state repair is expected.

---

## Conclusion

The change is clear to ship after second-pass review. It narrows the stale-active Threadline window from the 24h backstop to the worker's actual completion event while preserving the important `awaiting-reply` state. Focused regressions cover completed-session demotion and awaiting-reply preservation.

---

## Second-pass review (if required)

**Reviewer:** `Feynman`
**Independent read of the artifact:** `concern resolved`

Initial concern: `getBySessionName()` called `retireInactive()` before filtering by session, so a `sessionComplete` event could archive unrelated stale live conversations, including stale `awaiting-reply` records. Resolution: remove stale-retirement from the reverse lookup and add regression coverage that an unrelated stale `awaiting-reply` thread remains untouched during completion handling.

---

## Evidence pointers

- `npx vitest run tests/unit/threadline/ThreadlineRouter.test.ts` — 36/36 passed.
- `npx vitest run tests/unit/threadline/ThreadResumeMap.test.ts` — 41/41 passed.
- `npm test -- tests/unit/threadline/ThreadlineRouter.test.ts tests/unit/threadline/ThreadResumeMap.test.ts` — 77/77 passed after merging `v1.3.118` main into the PR branch and preparing `v1.3.119` release metadata.
- `npm test -- tests/unit/threadline/ThreadlineRouter.test.ts tests/unit/threadline/ThreadResumeMap.test.ts` — 78/78 passed after adding SessionManager UUID fallback coverage for the real inbound Threadline binding shape.
- `npm run build` — passed; local signing key absent, lockfile signing skipped as documented transitional state.
