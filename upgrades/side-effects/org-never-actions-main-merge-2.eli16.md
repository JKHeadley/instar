# Catching the "never rules" change up with main, again (ELI16)

## What happened

This pull request adds the check that compares a joined agent's actions against its organization's "never" rules. While it waited in line, two other changes landed on main, and both touched what this one relies on.

First, a security fix made the agent accept an organization's published policy only in one strict, standard layout. This pull request's tests wrote their sample policy with a stray blank line at the end, which the strict layout refuses. So the sample organization never got set up in the tests, and four tests failed.

Second, the place where a setting can be changed over the agent's local web connection gained a general list of which settings may be changed. That list now runs before this pull request's own rule that the organization check can only be set from the Instar app. The change was still refused, but with a vaguer error.

## What changed

The sample policies drop the stray blank line, so they're in the standard layout. The organization rule now runs before the general list, so a refused change keeps its plain explanation: set this from the Instar app. Nothing about how the check behaves changed.

## Evidence

The org unit tests pass (117 of 117) and the integration test passes (3 of 3). An independent review agreed.
