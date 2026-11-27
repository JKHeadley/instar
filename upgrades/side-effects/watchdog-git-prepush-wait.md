# Watchdog intervention during pre-push

## Decision points

Candidate selection skips the push, its HTTPS helper and launcher, and the hook subtree when a pre-push hook under the
same push has a CPU baseline or measured progress. The watchdog takes a fresh
snapshot after judging and before continuing escalation for this helper.

## Over-block

A stalled hook receives one sampling interval to establish its CPU baseline.
A busy hook child can mask a stalled sibling within that hook until the absolute ceiling.

## Under-block

A missing hook, an unrecognized command shape or an unreadable CPU sample
returns the helper to ordinary watchdog evaluation. Another push's workload
cannot protect this helper. Sampling covers the existing bounded process tree.

## Interactions and rollback

The decision uses the existing CPU tracker. It affects signal delivery inside
the watchdog. Revert the commit and restart the server to restore prior behavior.

## Second-pass review

**Reviewer:** Independent watchdog source reviewer.
**Result:** Concur after fixing candidate selection for a push running a custom
hook worker. The review traced the parent, both forms of the HTTPS helper,
the hook subtree, unrelated siblings and the fresh signal checks.
