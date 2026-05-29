# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Coherence Gate now represents unbound topic-project alignment as an
indeterminate check and summarizes the result honestly. A warning-level
indeterminate check is no longer counted as passed in the top-level pass flag or
the human-readable summary. Recommendation behavior is unchanged: clean checks
proceed, warning-level checks warn, and error-level checks block.

## What to Tell Your User

- **Coherence checks are clearer**: "When I verify a risky action, I'll now tell you when a check needs human verification instead of incorrectly saying every check passed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Honest indeterminate Coherence Gate summaries | Automatic for pre-action coherence checks |

## Evidence

Before the change, a live Coherence Gate request for an unbound topic returned a
warning recommendation while the summary still said all four coherence checks
passed. After the change, focused unit, HTTP route, and e2e lifecycle tests
verify that the unbound topic check returns an indeterminate value, the overall
pass flag is false, the recommendation remains warn, and the summary includes
the indeterminate count instead of the all-passed sentence.
