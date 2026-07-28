---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "yes lets start with pipeline" + "Yes please!" on the A+C proposal)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Two pipeline backstops from the 2026-05-29 fix-shape post-mortem.**

- **Failure-Learning Loop: unimplemented-source warning + wiring-integrity test.**
  `monitoring.failureLearning.sources.regression` and
  `monitoring.failureLearning.sources.degradation` are config flags that exist
  in defaults but have **no implementation** yet — setting them on did
  absolutely nothing. The loop reported them as "configured" without ever
  capturing a single corresponding event. Per the "specced but not wired"
  bug class named in the post-mortem (PR #530 was the worst recent instance),
  this PR makes the unimplemented sources surface their gap at boot via a
  clear `console.warn` and adds a unit-tier wiring-integrity test that pins
  the gating logic — the existing `ci` and `revert` sources must construct
  their poller/detector when their flag is on, must stay null when it's off,
  and the unimplemented sources must produce a warning when on but stay
  quiet when off. The substrate for `ci` and `revert` was already shipped;
  this PR adds the missing tests around it.

- **Migration parity: a static assertion that fresh-init hook installs match
  auto-update hook installs.** Per the "Migration parity skip" class — the
  telegram-reply.sh 403 (PR-of-record never shipped a migrator), the
  autonomous-stop-hook broken path, the slack-channel-context.sh divergence
  we found mid-build during PR #542. The new test reads
  `installHooks()` (src/commands/init.ts) and `migrateHooks()`
  (src/core/PostUpdateMigrator.ts), extracts the set of hook files each
  writes, and asserts the sets agree — except for a small documented
  allowlist of migrator-only deferred-install hooks. The allowlist's soft
  cap (10) catches the gap widening, and current contents document the
  followups.

This is the first of several pipeline hardenings the post-mortem
recommended. Levers B (real-world-state fixture tests), D (silent-failure
ban lint), and E (pre-merge `gh pr checks` enforcement) come in
follow-up PRs.

## What to Tell Your User

Nothing visible in normal operation. If you previously turned on the
regression or degradation failure-learning sources expecting them to do
something, you'll now see a warning at startup telling you they are
silent no-ops; you can set them back off. Otherwise no behavior change.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unimplemented failure-learning sources warn loudly | Automatic at boot. If `sources.regression` or `sources.degradation` is set the agent logs a one-line warning. |
| Wiring-integrity test for failure-learning sources | Automatic (CI). Any future regression in the source-construction gating fails the unit suite. |
| Migration-parity assertion for hooks | Automatic (CI). Any new install-only or migrator-only hook fails the unit suite unless it is explicitly added to `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a rationale. |

## Evidence

- 14 new unit tests; 5 existing related tests (CiFailurePoller, RevertDetector,
  PostUpdateMigrator-time-injection) remain green.
- `tsc --noEmit` clean.
- Side-effects review:
  `upgrades/side-effects/failure-learning-sources-wiring-and-migration-parity.md`.
- Both new tests verified by destructive-negative test (introduce a fake
  install-only or migrator-only-without-allowlist hook → migration-parity
  test fails as expected; remove the warning block → wiring test fails as
  expected).
