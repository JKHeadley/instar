# Side-Effects Review — mentor consumer: receiver wiring + outstanding-prompt tracker (PR 3c-2)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2b "Implementation surface"
item 4 + the receiver-handler wiring + Justin's anti-ping-pong concern (which Fix 1's
removal made THE real cadence gate). PR 3 of the staged build, part c-2.
**Change:** Three coupled additions that close the mentor round-trip:
1. `OutstandingPromptTracker` — anti-ping-pong gate (refuse to send a new prompt while a
   prior is in flight within `replyTimeoutMs`); persistent across server restart.
2. Mentor-reply role-handler installed on the mentor-bot adapter — clears outstanding by
   `corr` + persists the reply to `mentor-replies.jsonl` for Stage-B forensics.
3. `deliverToMentee` integrates the tracker (sweep + check + mark on send) + emits a
   `DegradationReporter` event for each orphan (deduped per `corr`).

**Ships dark** at the same gate as PR 3c-1 — until `mentor.botToken` + the three mentee
fields are set, the mentor-bot isn't constructed and none of this runs.
**Files:** `src/scheduler/OutstandingPromptTracker.ts` (new), `src/server/AgentServer.ts`
(receiver-hook installation + tracker wiring), `tests/unit/scheduler/OutstandingPromptTracker.test.ts` (new, 10).

## What changed

1. **`OutstandingPromptTracker`** (new): pure in-memory + small JSON persistence via
   `SafeFsExecutor.atomicWriteJsonSync`. Per-mentee. Key methods: `canSendTo(mentee)`
   returns `{ok:true}` or `{ok:false, reason:'prior-prompt-in-flight'}`; `markSent(corr,
   mentee)`; `clearByCorr(corr)`; `sweepExpired()` returns orphans; `recordOrphanNotified(corr)`
   dedups the orphan notification per `corr`. Corrupt-file recovery starts fresh (don't
   crash the mentor on a bad state file).
2. **Mentor-reply receiver hook** — installed on the mentor-bot adapter via
   `setAgentMessageHook` + `buildAgentMessageHook` (PR 3b composer) inside the existing
   `getOrCreateMentorBot` lazy construction. The recipient config (built per-mentee from
   `mentor.menteeFramework` + `mentor.menteeBotId`) accepts ONLY `mentor-reply` from
   `instar-<framework>`. The role-handler:
   - Calls `outstanding.clearByCorr(msg.corr)`. Logs a warning if no outstanding match
     (spurious / late reply after orphan-sweep).
   - Appends the reply to `mentor-replies.jsonl` (append-only; Stage-B forensics reads
     this in a future PR).
   - **Capability-handle invariant** (spec): the handler's closure has access to
     `outstanding`, the reply jsonl path, and nothing else. No `spawnStageA`, no
     `deliverToMentee`, no scheduler, no Threadline — structurally unreachable.
3. **`deliverToMentee`** integrates the tracker:
   - `sweepExpired()` on every call → for each orphan, emit ONE `DegradationReporter`
     event (deduped per `corr` via `recordOrphanNotified`).
   - `canSendTo(menteeAgent)` — if `{ok:false}`, log + return (defer this tick).
   - On successful send, `markSent(corr, mentee)`.

## The seven questions

1. **Over-block.** The tracker correctly defers only when a prior prompt to the SAME
   mentee is in flight. Different mentees are not blocked. Aged-out outstanding is
   swept first → caller proceeds.
2. **Under-block.** `markSent` only fires on successful send (a failed send doesn't owe
   a reply). The reply-handler clears by `corr` (exact match). Orphan sweep prevents
   indefinite blockage if a reply is silently lost; the degradation event makes that
   silent-loss observable.
3. **Level-of-abstraction fit.** Tracker is pure logic + tiny persistence; the handler
   closure has minimal-capability access (clear + append); the wiring in `deliverToMentee`
   is the integration point. No new policy layers.
4. **Signal vs authority.** Tracker is the cadence authority; the degradation event is
   the signal (with dedup so the same orphan-episode doesn't re-fire).
5. **Interactions.** Receiver-hook is installed only on the mentor-bot adapter (not the
   primary) — primary's behavior is unaffected. Capability-handle invariant means the
   reply path can't accidentally close the loop. The tracker file is a new path under
   stateDir; corrupt-file recovery is tested.
6. **External surfaces.** None new. `mentor-replies.jsonl` + `mentor-outstanding-prompts.json`
   + `a2a-processed-ids.json` are new state files (per-agent, dark by default).
7. **Rollback cost.** Trivial — revert removes the tracker module + the additive wiring.
   The reply-jsonl + tracker JSON are forward-only; old state is harmless if left on disk.

## Testing

10 new unit tests for `OutstandingPromptTracker`, all green:
- empty / canSendTo→ok; markSent → canSendTo prior-prompt-in-flight (the ANTI-PING-PONG
  assertion); clearByCorr lets next send proceed; clearByCorr on non-existent corr →
  false (spurious); different mentee not blocked; persistence across re-open (server
  restart preserves in-flight state); reply-timeout sweeps + caller can proceed;
  sweepExpired returns orphans; recordOrphanNotified idempotent (no re-spam); corrupt-file
  recovery starts fresh.

Coverage strategy: the integration in `AgentServer.deliverToMentee` (tracker + receiver
hook installation) is the dark-default wiring layer. The primitive sides
(`sendAgentMessage`, `buildAgentMessageHook`, `AgentTelegramLedger`, `ProcessedIdStore`)
are fully covered by prior PRs (PR 1: 20; PR 2b: 5; PR 3a: 8; PR 3b: 7 = 40 a2a tests
+ this PR's 10 tracker tests = **50 mentor-stack tests, all green**). The end-to-end
mentor round-trip is the live-test deliverable in PR 3c-3 (bot-setup + supervised cycle).
`tsc --noEmit` clean.

## Migration parity

None in this PR (separate PR 3c-3 ships the migration: `migrateRetireDeadMentorConfig`
for `dailySpendCapUsd` + `migrateRetireMentorOutbox` for the legacy file-outbox).
