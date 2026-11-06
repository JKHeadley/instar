# Maturation ladder quality bars

## What Changed

The maturation ladder's crash-loop pauser and unknown-agent trust entries now carry a graded-wrong quality bar: at most 5% of reviewer-graded decisions may be wrong, with at least 5 graded. A feature that runs often but does the wrong thing can no longer read ready-to-advance. A new registry marker, `shippedOn`, records that the code switches a feature on for every machine regardless of its setting. Such a feature reads as fleet. The autonomous heartbeat uses it, so the ladder stops reporting it as dark.

## What to Tell Your User

My feature-promotion scoreboard got stricter. A feature now has to make good decisions to move up, not just run often. The progress-heartbeat feature, which is already on everywhere, now shows as on.

## Summary of New Capabilities

- Maturation ladder bars can now hold a feature back when reviewers have graded its decisions as wrong.
- The ladder recognizes features that are on in code for every machine.

## Evidence

Unit tests in tests/unit/MaturationLadder.test.ts: a feature with passing activity metrics and 5 of 5 decisions graded wrong reads `hold`, and the three real registry entries are checked directly.
