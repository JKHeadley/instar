# Side-Effects Review — a conversation moved mid-step picks the step back up

**Version / slug:** `interrupted-move-resume`
**Date:** `2026-11-14`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1. On 2026-11-14 at 18:04 Pacific Justin asked Echo, in topic 142440, to check in with Luna. The Mama PC served that conversation, replied "I will check in with Luna", and while still working called `POST /pool/transfer` to move the conversation to the Studio. A move waits up to 30 s (`SessionDrainRunner.drainBoundMs`) for the session to reach a turn boundary; the session was busy (it was the caller), so it was force-closed (`drained-interrupted`). The only follow-up was one notice ("ask me to check it"), stamped with the generic `uncategorized` notification envelope, so the router's quiet-by-default gate filed it in the quiet feed. Nothing on the Studio restarted the request. Justin got no answer (Echo Bugs topic 10000002746, feedback fb-3b6d675c-64b).

The change:

- `src/core/SessionDrainRunner.ts`: the forced-close hook (`notifyInterrupted`) now runs AFTER the target's claim CAS and carries the epoch the claim lands at (`transferring epoch + 1`).
- `src/core/InterruptedMoveResume.ts` (new): source half `handOffInterruptedMove` asks the target to take the step and sends the "may be incomplete" notice only when the target does not accept; target half `InterruptedMoveResumeReceiver` waits (≤ 20 s) until its OWN ownership record shows it owns the conversation at or past the claim epoch, answers `accepted`, then in the background injects a short note into the conversation's live session or starts one with the recent history, and sends ONE notice (picking it back up, or "may be incomplete" if the restart failed). Once per (conversation, epoch).
- `src/core/MeshRpc.ts`: new signed verb `interrupted-move-resume`, registered-peer RBAC class.
- `src/commands/server.ts`: wires both halves; the forwarded-message spawn's router-history pull is factored into `pullMovedTopicContext` and shared with the resume; the notice uses a `message-loss-notice` envelope anchored to the person's message id (falls back to the old stamp only when no id is known).
- `src/messaging/userNotices.ts`: `movedMachinesResumingNotice` + catalog entries.

Size: 5 src files (~260 added lines incl. comments), 3 new test files, 3 test files extended. Effort: no spec rounds (Tier 1), one design revision during build (the target answers fast and owns the notice, because `/mesh/rpc` is bounded by the 30 s default request timeout).

## Decision-point inventory

- `SessionDrainRunner` forced-close hand-off — modify — moved after the claim, now carries the claim epoch. No new block/allow.
- Target resume admission (`InterruptedMoveResumeReceiver`) — add — acts only when its own ownership record shows self as active owner at ≥ claim epoch, no emergency stop; otherwise refuses. This is an ownership-fence invariant, not a judgment.
- Notification selectivity for this one notice — pass-through — the existing gate decides; the notice now offers a conversation-category envelope instead of the quiet default.

---

## 1. Over-block

No block/allow surface on user input. The only refusals are on the resume request itself: `not-owner` (claim not seen within 20 s, or the conversation moved on), `emergency-stop`, `unsupported` (not a Telegram topic). In each refusal the source still sends the plain "may be incomplete, ask me to check it" notice, so the person is never left with nothing. A slow replication (> 20 s) refuses a resume that would have been fine; the person then gets the old notice. Placement nudges after a claim normally replicate in about a second.

---

## 2. Under-block

- App (native) conversations: unchanged — they keep their existing in-conversation `disclose` notice and are not restarted. The receiver answers `unsupported` for non-numeric keys. The bug and the incident are Telegram topics; app parity is reported to the feedback queue.
- The notice reaches the conversation only when the deciding (router) machine can match the person's message id within its 15-minute conversation window. A step cut off more than 15 minutes after the person's message, or a move where neither machine knows the id, still records the notice quietly. The resumed session's own reply is a session reply and is never filed quiet, so in the resume path the person still hears back.
- If the source machine dies between the claim and the request, nothing asks the target to resume (the old behaviour). Out of scope: a dead source cannot hand anything off; the stale-owner engine and the person's next message remain the backstop.

---

## 3. Level-of-abstraction fit

The hand-off lives where the knowledge is: only the drain runner knows a step was cut off, and only the target can restart a session it owns. It reuses the existing signed mesh (same pattern as `ownership-nudge`), the existing ownership registry as the fence, and the exact spawn path a forwarded message uses (`spawnSessionForTopic` + `registerTopicSession`, with the shared router-history pull). It does not re-implement the inbound-delivery ledger (Stage B), which replays unanswered messages but not a step that already got an "I will" acknowledgement.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The receiver's refusals are an ownership fence (the same "act only on what you own" invariant every ownership consumer applies), not a brittle content check. What the resumed session does about the cut-off request is decided by the session itself, with full conversation context.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Do I own this conversation at this epoch?" is an enumerable invariant read from the ownership registry. Whether the step still needs doing is left to the resumed session's judgment (the note asks it to check what was already done).

---

## 5. Interactions

- **Shadowing:** the old notice send is replaced, not shadowed: exactly one machine sends the notice (target when it accepted, source otherwise).
- **Double-fire:** a new user message arriving right after the move may spawn a session on the target at the same time. The resume waits (≤ 60 s) for any in-flight start for that topic to bind, then injects into it. When it starts a session itself, it holds the topic's start-in-progress token (`SpawningTopicsRegistry`, taken with no await after the check) until the session is bound, so a message arriving meanwhile sees a start in progress instead of starting a second session under the topic-name-derived tmux name (second-pass finding 1). Repeated requests for the same (conversation, epoch) are answered `duplicate`.
- **Two notices (rare):** the source sends the "may be incomplete" notice whenever it does not receive `accepted`. If the target accepted but its answer was lost in transit (or cut off by a request timeout configured below about 21 s), both machines send a notice and the step is still resumed. The person then sees one extra, accurate-but-cautious line; nothing is dropped (second-pass finding 2).
- **Races:** the hand-off now runs after the claim CAS; the target polls its replicated record. A lost claim CAS still hands off; the target waits for the reconciler's backstop claim and refuses after 20 s.
- **Feedback loops:** a resumed session could itself call `/pool/transfer` again. Each move goes through the transfer planner, which allows at most one placement change per topic per 10 s (`src/core/TransferByNickname.ts`, `DEFAULT_MIN_UPDATE_INTERVAL_MS`, applied by the `/pool/transfer` route via `lastPlacementUpdateAt`), and each forced close itself costs the 30 s drain bound, so a ping-pong is at most one move per ~30 s and needs the model to keep asking for it. Each resume is once per epoch, and a refused or failed resume is never re-sent.
- **Backstop claim:** if the reconciler's backstop claim already made the target the owner before the drain's own claim, the hand-off names that claim's epoch rather than one past it (second-pass finding 3).

---

## 6. External surfaces

- Telegram: the person now sees "I moved this conversation to the Mac Studio before I'd finished my last step. I'm picking that step back up there now, and I'll tell you when it's done." followed by the resumed session's own reply; or, when the target cannot take it, the existing "may be incomplete" notice — now in the conversation rather than the quiet feed (when the message id is known).
- Mesh: one new verb. Older peers answer "no handler"; the source then sends the old notice. No change to existing verbs.
- No persistent state: the dedupe memory is in-process (≤ 500 keys).
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Inherently cross-machine: the source (old owner) and target (new owner) each act on their side through the signed mesh. One-voice: exactly one machine sends the notice (`handOffInterruptedMove` sends only when the target did not accept; the receiver sends only after accepting). Durable state: none added; it fixes durable work stranding on topic transfer (the cut-off request). No URLs. No status surfaces changed.

---

## 8. Rollback cost

Pure code revert, ship a patch. No persisted state, no migration. During a mixed-version window, a target without the verb answers "no handler" and the source falls back to the notice.

---

## Conclusion

The review moved the hand-off after the claim (the target can only resume what it owns) and moved notice ownership to the target (the mesh route's 30 s limit cannot cover a session start). The second-pass review found a double-session race and a backstop-claim epoch error, both fixed with tests. App-conversation parity is filed to feedback (fb-13f2c942-c1f) rather than built here. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read the code before the artifact)
**Independent read of the artifact: concern → resolved**

Concerns raised and how each was resolved:
- Two live sessions possible: the resume's own start did not hold the start-in-progress token, so a message arriving during the history pull could start a second, differently named session. Fixed: the start now holds the `SpawningTopicsRegistry` token until bound (pinned in `tests/e2e/interrupted-move-resume-alive.test.ts`).
- "Exactly one notice" is not absolute when the target's answer is lost. Accepted and stated in §5 (Two notices); the failure direction is one extra cautious line, never silence.
- A backstop claim landing before the drain's claim made the hand-off name an epoch one too high, so the target would refuse. Fixed in `SessionDrainRunner` (unit test "a backstop claim that already landed…").
- The rate-limit claim needed a code reference. Added (`TransferByNickname.ts`, 10 s per topic).

The reviewer confirmed the epoch arithmetic against `SessionOwnership`, the mesh timeout budget (28 s single attempt vs. ~20.5 s target answer under the 30 s route limit), and the cross-machine delivery of the `message-loss-notice` envelope.

---

## Evidence pointers

- Incident: Studio `logs/server.log` 2026-11-15T02:07:10Z `/pool/transfer` from the Mama PC (100.101.95.10); 02:07:42.536Z ownership epoch 7 → Studio; quiet row `99031846-…` 02:07:42.605Z with the old notice text, category `uncategorized`.
- Tests: `tests/unit/InterruptedMoveResume.test.ts`, `tests/unit/SessionDrainRunner.test.ts` (hand-off after claim, claim epoch, lost claim), `tests/unit/userNotices.test.ts`, `tests/unit/MeshRpc.test.ts`, `tests/integration/interrupted-move-resume-roundtrip.test.ts` (real drain runner → real signed mesh → real receiver; refusal and old-peer fallbacks), `tests/e2e/interrupted-move-resume-alive.test.ts` (boot wiring).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a`: a one-shot, event-triggered action. One resume per (conversation, ownership epoch), fired only by a drain's forced close of a user- or session-initiated move; a refused or failed resume is never retried, and moves themselves pass the transfer planner's per-topic rate limit (`src/core/TransferByNickname.ts`, 10 s).
