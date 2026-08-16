# Upgrade Notes (Unreleased)

## What Changed

PromiseBeacon's auto-pause threshold defaults too patient. PR #163 introduced the auto-pause feature with N=12 unchanged cycles before silencing — which at the default ~10-minute cadence works out to two to three hours of "still working" pings before the watcher gives up. A user reported seeing nine hourglass messages before complaining; the design was right but the dial was set too high. This release lowers the default to 4 cycles, so a quiet watcher emits at most about four templated heartbeats before sending a single final "auto-paused — reply 'keep watching' to resume" line and stopping. Agents that genuinely need to watch for longer can still override per commitment via `beaconAutoPauseAfterUnchanged`, or set `defaultAutoPauseAfterUnchanged` in agent config.

### fix(promise-beacon): tune default auto-pause threshold from 12 → 4 cycles

- `PromiseBeacon` constructor default for `defaultAutoPauseAfterUnchanged` changed from `12` to `4`. The accompanying interface docstring was updated to reflect the new math (≈40 minutes of silence at default 10-minute cadence).
- No schema, route, or contract changes. Per-commitment `beaconAutoPauseAfterUnchanged` overrides continue to win against the default. Resume path (`POST /commitments/:id/resume` and the "keep watching" Telegram detector) is unchanged.
- Auto-pause remains non-terminal: `status` stays `pending`; only `beaconPaused=true` is set. Resume restarts the cycle.

## What to Tell Your User

When your agent says "I'll let you know when X happens," it starts a watcher that pings you every ten minutes or so until X resolves. Previously that watcher kept pinging for about two to three hours of silence before giving up — which felt like spam. Now it gives up after about forty minutes of no observable progress, sending one final line: "auto-paused — reply 'keep watching' to resume." If you do reply "keep watching" on that topic, the watcher comes back for another round. That's it — no setup needed; the new default takes effect on the next agent update.

## Summary of New Capabilities

- **Shorter default auto-pause horizon** — beacons now pause after 4 unchanged cycles (≈40 min at default cadence) instead of 12 cycles (≈2–3 h). Same final-message and resume flow as before.

## Evidence

New test: `tests/unit/PromiseBeacon-ux-fixes.test.ts > auto-pauses by default within ~5 fires when no threshold override is configured` exercises the default path end-to-end and asserts the pause lands no later than the 6th outbound message (seed + 4 unchanged + pause). Existing UX-fixes tests (heartbeat suffix, threshold-override auto-pause, resume, re-arm) continue to pass.

Production observation pre-fix: CMT-392 on topic 9597 reached nine unchanged heartbeats over roughly three hours under the old default before the user reported the watcher still felt like spam. Withdrawn manually pre-fix; new default would have paused after ≈40 minutes of silence.
