# The design-review helper loaded an old copy of itself — plain-English overview

## What happened

When Echo reviews a design, part of the review is done by a model from a different company (a GPT model through the Codex command-line tool), because a second family of models catches mistakes the first one shares. A small helper script runs that outside review. The helper does not contain the review logic itself: it loads the built reviewer code from wherever instar is installed, trying a few places in a fixed order and taking the first one it finds.

On the Studio, the first place it looked held an old, forgotten build of that code sitting in the agent's home folder. Nothing marked it as a real instar install, and it was built before the GPT model names were updated, so it asked for a model the account no longer accepts. The account refused, and the helper reported only a generic "degraded" result. The outside review quietly stopped working, and the message did not say why.

## What changes

First, the helper now checks each copy before trusting it. A copy with no instar package file next to it is an orphan, and nothing says what version it is, so the helper skips it. A copy in a source checkout whose source files are newer than the build is out of date, so the helper skips that too. It moves on to the next place, which is normally the agent's real, current install. If nothing better exists, it still uses what it found, so a review is never blocked, but it marks the result as possibly stale.

Second, the helper now always reports which copy it used and which copies it skipped, and why. That makes the next problem of this kind visible immediately.

Third, when the account refuses the model, the result now says "model-unsupported" with the model's name, instead of the generic "error".

## Safeguards

Nothing is deleted. Skipped copies are left exactly where they are. The review still never blocks a design from converging: every failure is still a degraded result that the review process records. The change touches only the helper script and the one function that names review failures.

## What you need to decide

Nothing. This is a small, reversible repair of a helper: reverting the change restores the old behaviour exactly.
