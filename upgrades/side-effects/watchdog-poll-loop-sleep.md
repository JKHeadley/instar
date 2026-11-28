# Side-effects review: the stuck-command watchdog leaves a sleeping poll loop alone

## What changes
`src/monitoring/SessionWatchdog.ts`:
- `classifyProtectedWait` gains a deterministic rule, reason `poll-loop-sleep`. A candidate is protected when a timed `sleep` (the same parser as the existing `timed-sleep` rule) is running below it, or was seen below it within `POLL_LOOP_SLEEP_RECENT_MS` (5 minutes).
- The watchdog records, on every poll, when it last saw a timed sleep below each child (`timedSleepSeenAt`). It passes that age into the classifier and prunes it when the process exits.

## Why
A poll loop or Monitor watch script is a long-lived shell that runs a quick check, then `sleep N`, over and over, printing only on a change. The stuck candidate is the shell, never its short sleep, so the existing timed-sleep rule never saw it, and the probabilistic judge read a quiet, minutes-old loop as stuck. On 2026-11-27 it stopped four deliberate watches on the M5 (subscription-management, during a live sign-in) and four heavy-turn queue waits on the Studio. Each stop silently ended a watch the session relied on.

## Selection, not an early return (second-pass review)
The first version only protected the loop once it had been chosen as the stuck candidate, and a protected candidate ends that session's poll. An older sleeping loop, chosen first every poll, would then have hidden a younger, genuinely stuck command in the same session for up to the 2 h bound. Before this change, the judge's "legitimate" verdict excluded the loop and later polls moved on. The loop is now recognised in candidate selection and skipped, so the search continues to its siblings. Its own children are not shielded: a check hung inside the loop is a separate child past the threshold and is judged as before. Wiring tests cover a sleeping loop beside an unrelated stuck command, and a hung check inside a recently sleeping loop.

## What does not change (detection is not weakened)
- The protection is bounded. The existing two-hour `MAX_PROTECTED_WAIT_MS` applies before this rule, as for every protected wait.
- It needs live evidence. A loop that stops sleeping, for example one hung inside its check, loses protection once no sleep has been seen for 5 minutes, and the judge and the hard ceiling decide as before.
- `sleep infinity` and other non-timed sleeps are not evidence (same parser as `timed-sleep`).
- The test-runner floor, push waits, the pipeline guard and every other path are unchanged. This only adds a deterministic protected case ahead of the judge.

## Risks considered
- **A genuinely stuck command that happens to have a timed sleep child:** for example a script whose own child is stuck while another branch sleeps. It is protected at most until two hours, the same bound every protected wait has.
- **Cost:** one descendant walk per child per poll, over a snapshot the watchdog already holds.
- **Rollback:** revert this commit.

## Existing test changed
`tests/unit/session-watchdog-test-runner-floor.test.ts` used `/bin/zsh -lc sleep 900` with a `sleep 900` child as its negative control for the test-runner-ancestor floor, expecting no protection. A timed sleep child is now a deliberate wait (`poll-loop-sleep`). So the negative control is now a `tail -f` child, and the same file asserts that the sleeping case is protected under `poll-loop-sleep`, never as a test-runner ancestor.

## Tests
`tests/unit/session-watchdog-timed-sleep-and-notice.test.ts` covers:
- a watch script and a heavy-turn wrapper with a sleeping child;
- a loop sampled mid-check, inside and outside the 5-minute window;
- the two-hour bound;
- `sleep infinity`.
