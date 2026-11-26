# Side-Effects Review — PresenceProxy on a Slack-only agent

**Slug:** `presence-proxy-slack-only-agent`
**Date:** `2026-10-20`
**Author:** Echo (autonomous, 24h run on topic 61449)
**Tier:** 1

## Summary of the change

`PresenceProxy` (the unanswered-operator-message watcher), its Slack arming, the
Slack standby commands, the Slack triage surface and `PromiseBeacon` were all
constructed inside `if (sharedIntelligence && telegram)`. On a Slack-only agent
none of it existed — indra's full server log contains no "Presence Proxy wired to
Slack" line, which is why an operator message went 28 minutes unanswered on
2026-10-20 with nothing raised.

The gate becomes `sharedIntelligence && (telegram || _slackAdapter)`. Every dep
the proxy receives already resolves the Slack synthetic-id map before falling
back to Telegram, so no dep logic changed.

## Decision-point inventory

No LLM decision points added or changed. The proxy's existing tier logic and its
LLM usage are untouched; this changes only whether it is constructed.

## Blast radius

- `server.ts`, one block. The gate, 7 Telegram message-capture chains (now
  skipped when there is no adapter), and 3 Telegram fallbacks that used non-null
  assertions (now `?? null`).
- A Telegram agent is unaffected: the gate still admits it, every chain still
  binds, and the fallbacks behave identically because `telegram` is defined.
- A Slack-only agent newly gains: the unanswered-message watcher, its standby
  commands, the triage surface, and PromiseBeacon.

## Reversibility

Reversible by revert — one conditional and a set of optional-chaining edits. No
state, no schema, no config key, no migration.

## Failure modes considered

- **A crash at startup on a Slack-only agent.** This is the real risk of widening
  the gate, and it is why the sweep went past the compiler: a non-null assertion
  type-checks and then throws. The block now contains none, enforced by a test
  that greps for the pattern rather than trusting `tsc`.
- **A Telegram agent regressing.** The gate is a strict widening (`A` →
  `A || B`), every capture chain is guarded by the adapter it needs, and the 122
  existing presence-proxy tests stay green.
- **New noise for Slack users.** The proxy's own tier thresholds, speaker
  election, stand-down suppression and brief-ack filtering are unchanged — a
  Slack-only agent now gets exactly the behaviour a Telegram agent already had,
  including its silences.
- **PromiseBeacon newly live on Slack.** Its user output is off unless a
  deployment sets `promiseBeacon.userOutputEnabled`, so what this actually
  restores there is internal follow-through, not new messages.
- **A Slack system channel being spoken to.** The existing arming already skips
  system channels before reaching the proxy; untouched.

## Verification

6 new unit tests (`tests/unit/presence-proxy-slack-only-agent.test.ts`): the gate
accepts Slack-only, the old Telegram-only gate string is gone, the Slack arming
is inside the admitted block, the block contains no non-null Telegram assertion,
every capture chain is guarded, and the deps resolve Slack before Telegram. The
full presence-proxy suite (13 files, 122 tests) is green, as is the reap-notifier
pair in this branch (33 tests). `tsc --noEmit` clean. Full lint clean.

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`
**Closure:** `n/a`
**Reason:** no new self-triggered loop. An existing watcher with its own tier
timers, speaker election and budgets is constructed on a platform where it
previously was not; its cadence and brakes are unchanged.
