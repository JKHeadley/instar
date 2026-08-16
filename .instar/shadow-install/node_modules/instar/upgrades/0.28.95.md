# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

PromiseBeacon's heartbeat messages used to give the user no idea what was being tracked ("still working — snapshot unchanged since last beat") and ran forever even when nothing was changing, producing extended runs of context-free hourglass spam on Telegram. This release fixes three things:

- Every heartbeat now appends a `re: <promise excerpt>` suffix so the user can see which watched promise it's about.
- Beacons auto-pause after a run of consecutive unchanged-snapshot heartbeats (default 12 cycles, ≈2h at 10-min cadence). When the threshold is hit, the beacon emits one final "auto-paused after long quiet — reply 'keep watching' on this topic to resume" message and stops firing. Status stays `pending` — this is non-terminal suppression, not delivery or violation. New optional Commitment fields: `beaconPaused`, `beaconPausedReason`, `beaconPausedAt`, `beaconAutoPauseAfterUnchanged`, `consecutiveUnchanged`.
- New endpoint `POST /commitments/:id/resume` clears the paused flags and resets the counter; PromiseBeacon re-arms on the `resumed` event. A literal "keep watching" detector in the Telegram inbound path calls this endpoint for any paused beacons on the originating topic and now reports per-call success ("⏳ resumed N watchers", "⏳ resumed X of Y watchers", or "⚠️ couldn't resume — try again").

Honors PROMISE-BEACON-SPEC.md line 161 ("suggest, don't auto-close"): this is auto-pause, not auto-delivery — `status` stays `pending` and the beacon can be resumed at any time.

## What to Tell Your User

- "I'll now tell you what I'm tracking in every progress update, instead of just saying 'still working'."
- "If a watcher goes silent for too long with no change, I'll send one last note and stop pestering you. Reply 'keep watching' on that topic and I'll pick it back up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Heartbeat shows which promise is being tracked | automatic |
| Beacon auto-pauses after extended silence | automatic (default 12 unchanged cycles) |
| Resume a paused beacon | `POST /commitments/:id/resume` or reply "keep watching" on the topic |

## Evidence

<!-- REQUIRED if this release claims to fix a bug. -->
<!-- Unit tests passing is NOT evidence. Provide ONE of: -->
<!--   (a) Reproduction steps + observed before/after on a live system. -->
<!--       Include log excerpts, observed command output, or behavior -->
<!--       description. Make it specific enough that a future reader can -->
<!--       re-run it and see the same thing. -->
<!--   (b) "Not reproducible in dev — [concrete reason]" if the failure -->
<!--       mode truly can't be exercised locally (race conditions, -->
<!--       event-driven paths requiring external signals, etc). -->
<!--                                                                 -->
<!-- If this release doesn't claim a bug fix (pure feature / refactor), -->
<!-- leave this section blank or delete it — it's only enforced when -->
<!-- "What Changed" describes a fix. -->

**Reproduction (live):** Telegram topic 9210 ("threadline dev") on the echo agent. Three commitments (CMT-381, CMT-382, CMT-383) were detected by CommitmentSentinel after three separate threadline-send actions over ~28 minutes; each one became a beacon-enabled commitment with `agentResponse` "Sent threadline message to <recipient>, awaiting reply." All three fired heartbeats independently on the default 10-min cadence. tmux output was idle, so every heartbeat hit the unchanged-snapshot branch and rotated through `TEMPLATED_VARIANTS` then `AT_RISK_VARIANTS`, producing ~30+ context-free hourglass messages between 18:35 and 19:55. None of the messages identified which commitment they were about. Withdrawn via `POST /commitments/:id/withdraw` to stop the spam.

**Fix verification (unit):** New test file `tests/unit/PromiseBeacon-ux-fixes.test.ts` covers the three failure modes the live reproduction exposed:
- `appends a "re: <promise excerpt>" suffix to every templated heartbeat` — passes; the heartbeat text contains the truncated `agentResponse`.
- `auto-pauses after N consecutive unchanged-snapshot heartbeats and emits a final resume hint` — passes; with threshold=3, the 4th unchanged-snapshot heartbeat emits the auto-pause message and subsequent fires emit nothing.
- `a resumed beacon re-arms via the resumed event handler` — passes; calling `tracker.resume(id)` re-arms PromiseBeacon's timer via the new `resumed` event.

**Fix verification (live, post-merge):** will be performed by enabling beaconEnabled on a fresh test commitment on a quiet topic and confirming (a) the heartbeat text contains the promise excerpt, (b) the beacon auto-pauses after the configured threshold, (c) replying "keep watching" on the topic resumes it. Reported in the release notes for the next version after merge.
