<!-- bump: patch -->
## What Changed

The context budget's practice folds now run (Phase 2, shadow folding). This is on development agents only, behind `contextBudget.fold.shadow` (dev-gated); it is dark on the fleet.

When a conversation's session finishes a turn, the runner checks three things in order:
- the brakes: at most 2 asks per hour per conversation, a 30-minute backoff, and only 1 in 3 stops;
- whether shrinking would save more than it costs;
- whether this is a calm stopping point.

Only then does it ask the session, once, for a short handoff. The conversation's sends and incoming messages wait for that one turn, at most 5 minutes. The session is released straight away. Then, off to the side:
1. a restore bundle is built and checked;
2. quiz questions are written;
3. a throwaway session with no credentials of its own answers them;
4. the answers are graded;
5. one row goes into the record at `GET /context-budget/fold-shadow`.

The live conversation is never shrunk.

Also fixed: on a machine whose session pool is live, folds could never start, because ownership read as unknown for every conversation. Ownership now follows the topic's active ownership record (§9.3). An ownership change fences the fold.

## What to Tell Your User

On the development agent, long conversations now get occasional practice runs of the context budget. Now and then, at a quiet moment, the session writes itself a short handoff note, and a separate test checks whether a shrunken version would still remember what matters. Nothing in the conversation is actually shrunk, and replies are paused for at most a few minutes while the note is written. Progress toward the 40 practice runs needed before anything goes further is recorded.

## Summary of New Capabilities

- Practice folds on development agents (`contextBudget.fold.shadow`), with results at `GET /context-budget/fold-shadow`.
- Fold ownership on pool-live machines, following the topic's active ownership record.

## Evidence

- Unit:
  - `fold-shadow-runner` (5): a full graded fold with the live session released before the answerer and every carrier gone, the record `aborted`/`shadow-graded`; switch off and other engines; an unknown estimate and a not-clean stop skipped with no record; a handoff timeout or unparseable reply declined with backoff; no judge aborted.
  - `fold-shadow-runner-boot` (4): a turn end triggers one fold; the handoff turn's own turn end becomes the reply; one fold per machine, never queued; nothing for off, Codex or topicless sessions; stop releases waiters.
  - `fold-pool-ownership` (8): an active record naming this machine; unknown with no record or identity; not the owner for another machine, transferring, or the session elsewhere; an epoch change fencing transitions; dark placement unchanged.
- E2E: `context-budget-fold-shadow-alive` (2): Stop events through the real boot wiring drive a graded fold end to end, and `server.ts` wiring is checked by text (after the AgentServer, the dev-gated switch, the Stop hook, the ledger getter, the probe token, ownership before the boot sweep).
- 788 neighbouring unit tests and 37 fold/context-budget e2e tests pass. Lint 54/54.
