# Maturation ladder: wrong decisions now block promotion, and on-in-code features read as on

## What this is

The maturation ladder is a scoreboard. It tracks each switchable feature on its way from "off" through "dry run" (deciding but not acting) to "live on the development agent" and then to "on for everyone". At each step it compares the feature's numbers against a bar. When the numbers have held for a few days, it tells the review job that the feature is ready to move up. The review then makes the call.

## What was wrong

The 2026-11-05 review found two features about to read "ready" because their bars only asked two things: did it run, and did it crash. The crash-loop pauser ran a lot, 173 times. But what it wanted to do was wrong: it would have paused the bug-intake job, which succeeds on almost every run. The unknown-agent trust check also ran often. Each time, it wanted to refuse messages from Luna, a peer agent we already trust. Promoting it would have cut Echo off from Luna. The review graded five of each feature's recent decisions as wrong. Nothing on the scoreboard looked at those grades.

A third feature had the opposite problem. The autonomous heartbeat was switched on for every machine in code last week, and the code no longer reads its setting. The scoreboard still read the setting, so it reported the feature as "off, not started".

## What changes

- Both the pauser and the trust check now have a third bar: of the decisions a reviewer has graded, at most 5% may be wrong, and at least 5 must be graded before the bar counts. Five wrong out of five fails the bar. The feature then reads "hold" instead of "ready", so activity alone can no longer carry it up.
- The registry gains a marker for "the code turns this on everywhere, whatever the setting says". A feature with that marker reads as fully on (its final step), and the scoreboard stops asking anyone to start it. Only the heartbeat uses the marker.

## What does not change

The scoreboard still decides nothing. It reports, and the review decides. No feature is switched on or off by this change. The pauser's own counting, which ignores successes, is a separate problem and is filed separately.

## Safeguards

The new marker is only accepted on a feature whose end state is "on for everyone", and never together with "how to start it" settings, so it cannot be used to hide a feature that is really off. Tests cover a feature that runs a lot but is graded wrong and confirm it never reads ready. Other tests check the three real registry entries directly.

## What to decide

Nothing. This only corrects data, so no operator decision is needed.
