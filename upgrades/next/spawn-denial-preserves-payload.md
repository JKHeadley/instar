# A refused agent-to-agent message is no longer a deleted one

## What Changed

`SpawnRequestManager.evaluate()` — the admission funnel every inbound agent-to-agent dispatch passes
through before a session is spawned for it — had six exits that do not spawn. Three preserved the
inbound payload by queueing it; three destroyed it. All transient-pressure exits now preserve it:

- **Memory pressure** — now queues the payload (was: dropped it).
- **Session limit** — now queues the payload (was: dropped it).
- **Spawn threw** — deliberately UNCHANGED. This branch also destroys payloads, and an earlier revision
  of this change restored them — but second-pass review proved that unsafe and it was removed.
  `SessionManager.spawnSession` creates the live tmux session *with the prompt* and only afterwards calls
  `state.saveSession()` outside any `try/catch`, so a rejection does NOT prove non-delivery. Restoring
  would risk delivering the same instruction to a second live session — trading a rare lost message for a
  rare duplicated one. The prerequisite is upstream: `spawnSession` must stop reporting failure once the
  session is live and holding the prompt. <!-- tracked: CMT-1114 -->
- **`envelope-too-large`** — still drops, deliberately: it is a permanent size rejection, not transient,
  so queueing it would re-refuse the same oversized payload on every drain tick.

Every denial verdict is byte-for-byte unchanged — same predicate, same `reason`, same `retryAfterMs`. No
threshold, priority rule, or gate was touched. Queued payloads join the drain loop
(`runTick` / `onDrainReady`) that was already running on a 5-second tick, so delivery lands at the next
window instead of never.

One further line: a GLOBAL-cap refusal in `#queueMessage` now sets the existing `#truncated` marker. It
returns `false` before any marker logic and every callsite discards that boolean, so this was the one
queue loss that left no trace at all — the same silent-loss shape being fixed here.

## Evidence

Found live on a two-agent machine, 2026-07-29:

- **40** `Spawn denied: Memory pressure too high for new session` entries in one agent's server log in a
  single day. Each one destroyed its payload.
- Three dispatches confirmed lost at `19:45:23.541Z`, `23:18:33.406Z`, `23:20:35.503Z` — each logged
  `handled: true` alongside the spawn-denied error, while the sending agent's `threadline_send` returned
  `{"delivered":true,"outcome":"accepted"}`. Both ends recorded success.
- Impact: the receiving agent merged 25 PRs up to `15:01Z` then produced nothing for 8 hours. Not idle —
  unreachable, with the transport reporting success.
- Pressure was genuine, not a miscalibrated threshold (checked, because loosening it would have been the
  cheap answer): swap 16361 MB used of 17408 MB (94%), compressor holding ~7.3 GB, total RSS 7.9 GB on
  16 GB of RAM.
- The retry driver was already live and already trying: `[spawn-manager] drain re-attempt for echo not
  approved: …` at `09:32:28.013Z` and `09:32:33.021Z`, 5 seconds apart, `tick=5000ms`.

Tests: 5 added to `tests/unit/spawn-request-manager.test.ts` (3 positive, 2 pure controls) plus one
renamed exactly-once control. **Every new test was run against the unfixed source first** — 5 failed / 78
passed on original code; the two no-context controls passed on both old and new, proving they
discriminate. With the fix: 83/83. Wider run across `spawn-request-manager`, `subscription-quota-gates`,
`threadline/ThreadlineRouter`, `SpawnAdmission` and `threadline-fixes`: 197 passed. `tsc --noEmit` exits
0 and the 33-lint chain passes.

The running copy provably carries the defect: both agents' installed
`dist/messaging/SpawnRequestManager.js` shows the memory-pressure branch returning with no enqueue.

Known limits, tracked rather than papered over: the sender is still told `delivered: true` (CMT-1111),
the queue does not survive a server restart (CMT-1112), no class-level guard exists yet (CMT-1113), and
the spawn-failure branch still loses payloads pending the upstream truthfulness fix (CMT-1114).

## What to Tell Your User

If two of your agents hand each other work, a message could previously be **deleted** when the receiving
machine was briefly short on memory or at its session cap — and both sides reported success, so neither
you nor the agents had any way to know. That is fixed: a refused message now waits and is retried
automatically, usually within a minute.

The symptom this explains: an agent that looks idle for hours despite being handed work, with no error
anywhere. It was not idle — it was unreachable behind a transport that reported delivery.

Two honest limits. If a machine stays under pressure for more than ten minutes, messages can still
expire; and if the agent's server restarts while a message is waiting, that message is lost. Neither is
left as a good intention — both are tracked. <!-- tracked: CMT-1111 --> <!-- tracked: CMT-1112 -->

## Summary of New Capabilities

No new capability, endpoint, config key, or flag — this is a defect fix in existing behavior. Rollback is
a single revert with no state to clean up. The pre-existing kill switch for the retry machinery
(`threadline.spawn.drainEnabled: false`) is unchanged.
