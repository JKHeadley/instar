<!-- bump: patch -->

## What Changed

The maturation ladder now covers the switched-off features the November 5 review found on no ladder, with thresholds taken from each feature's own spec. Features that are finished and live register as finished rather than carrying an invented bar. A feature at its last rung now shows its numbers, so a "harmed" reading says why, and the autonomous heartbeat's fleet error rate looks back 3 days so a fix shows up quickly. Phone permission actions, memory privacy, the class closure lint and the self-action governor now record what they do for the ladder. Recording never blocks anything.

## What to Tell Your User

Nothing changes in how I behave. If you look at the feature maturation board, more of my switched-off features now show up there with real numbers and a next step, and a feature marked as harmed now shows the number behind that.

## Evidence

The 2026-11-05 review counted 13 switched-off features on no ladder. `GET /maturation/ladder` on the production wiring path now lists each of them (tests/e2e/maturation-ladder-alive.test.ts). On 2026-11-06 `monitoring.autonomousHeartbeat` read `harmed` with `metrics: []` while the evidence log held 189 error rows; the new unit test proves the number shows and clears after a fix.
