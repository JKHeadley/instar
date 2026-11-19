# A Local Verify helper machine keeps working while the coordinator restarts

<!-- bump: patch -->

## What Changed

On a two-machine Local Verify line (a coordinator and a peer verifier), each planned coordinator restart used to cost the peer work in two ways: no new work was handed to the peer while the coordinator waited to restart, and a peer run that spanned the restart was thrown away because the coordinator came back at a new lease epoch. Measured over two days that was up to about 105 peer-minutes a day.

Behind one live setting, `monitoring.localVerify.peerWorksThroughRestart.enabled` (absent or anything but `true` = off = today's behaviour exactly; no config default is written):

- **Dispatch during a restart pause.** The coordinator may hand a PR verify to an idle peer while a restart is pending, unless the verifier on disk already changed or the restart is forced (`bypassHolds`). A `main` verify is never handed out then, and the coordinator's own slot still starts nothing.
- **Restart episodes.** The coordinator tracks each pending update or planned restart as an in-memory restart episode. An attempt sent during its pause carries the episode id (`sentDuringPause`) and does not hold that episode's restart; after the episode ends without a restart it holds later restarts like any other. Each episode ends with a `restart-episode-ended` audit row (`restarted`, `qualifying`, `peerIdleMs`, `attemptsInFlightAtRestart`, `pauseDispatches`).
- **Adoption across the coordinator's own restart.** PR 3451's holding record (`peer-trust.json`) gains `holding.since`, the first epoch of this machine's unbroken holding. After a restart the coordinator keeps a peer attempt dispatched at an earlier epoch when that holding is unbroken since the dispatch, the entry, verifier and policy are unchanged, and it is not a `main` verify (`adoptedEpoch`, audit `peer-attempt-adopted`). While the lease read is unreadable, unheld or not yet caught up it waits without cancelling (`peer-attempt-adoption-waiting`). Anything else abandons with a `lease-changed:holding-broken|entry-moved|verifier|main|disabled` reason. A `lease-changed:verifier` abandon gives the attempt back once per entry. The peer's signed record must still name the dispatch-time epoch.
- **Progress, not the clock alone, ends a peer attempt.** At 60 minutes an attempt is judged on progress read from the run's `*.progress.json` files: it keeps running while files keep finishing within twice their recorded duration (times this run's measured slowdown; a file with no history uses its lane's hang deadline), and ends when it stalls, when progress cannot be read, when the run child is gone, or at a 150-minute backstop. Both sides judge (`peer-attempt-judged`); a running peer answer carries `progress`.
- **The progress files are exact at the end of a test process (also with the setting off).** The test reporter now writes one last progress snapshot when its process's tests are over: nothing running, every started file counted as finished. Before, a completion inside its 5-second write throttle could leave a finished process's files listed as still running. A lane's first part ("likely-failing files first") reads as its lane in the progress check. A process that is killed leaves its snapshot as it was, so the lane-deadline forensics are unchanged.
- **Kill switch.** Turning the setting off makes every lease change abandon and cancel as before, including attempts already adopted.

`GET /local-verify` shows `peers.worksThroughRestart`, `peers.restartEpisode`, and per reserved attempt `sentDuringPause` and `adoptedEpoch`. Existing agents' CLAUDE.md peer line is rewritten (idempotent, content-sniffed) to name the setting, and a feature note is added.

## What to Tell Your User

- **Helper machine keeps testing through restarts**: "If you turn it on, the second machine that runs tests for me keeps getting work while this machine waits to restart, and a test it was already running is kept across my restart instead of thrown away, as long as no other machine took over in between. A slow but healthy test run is no longer cut off at one hour; it gets up to two and a half hours if it keeps making progress."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Peer keeps working through a coordinator restart | Set `monitoring.localVerify.peerWorksThroughRestart.enabled: true` on the coordinator (and the peer, for its side of the progress check); read live |
| See restart episodes and kept attempts | `GET /local-verify` → `peers.restartEpisode`, `peers.reserved[].sentDuringPause` / `adoptedEpoch` |
| Hung-versus-slow judgments for peer runs | Audit rows `peer-attempt-judged` in `.instar/logs/local-verify.jsonl` |

## Evidence

- Unit: `tests/unit/localVerify/peerWorksThroughRestart.test.ts` 40 passed: the dispatch gate truth table; the restart-episode lifecycle (minted, kept across pause flips, cleared, coordinator only, `restart-episode-ended`); which attempts hold a restart; `holding.since` on creation, reset, backfill and keep, with PR 3451's `holdingDecision` contract pinned; every C.3 adoption case; no re-adoption; refund only on `lease-changed:verifier`, once per entry; malformed marker fields dropped alone; the raw marker-epoch guard (with a negative control); setting-off abandons adopted and waiting markers with `lease-changed:disabled`; E's verdicts on both peer and coordinator.
- Related unit suites: `peerVerifier.test.ts`, `LocalVerifyService.test.ts`, `local-verify-peer-trust.test.ts`, `PostUpdateMigrator-localVerifyMainRedHold.test.ts`, `awareness-entry-registry.test.ts`, `claude-md-reference-layout.test.ts` pass.
- Integration (`tests/integration/local-verify-peer-works-through-restart.test.ts`: GET fields, the live setter, progress over the real client, idempotent CLAUDE.md step) and e2e lifecycle (`tests/e2e/local-verify-peer-works-through-restart-lifecycle.test.ts`: restart mid-attempt ends in import, the first tick after boot does not cancel, wiring integrity): run by Local Verify (no local integration/e2e lane on the verify machines).
