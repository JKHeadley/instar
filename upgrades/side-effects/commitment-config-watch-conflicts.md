# Side-Effects Review — commitment config-watch conflicts

**Version / slug:** `commitment-config-watch-conflicts`
**Date:** 2026-10-28
**Author:** Echo
**Second-pass reviewer:** independent subagent (concurred after the fixes noted at the end)

## Summary

Echo Bugs topic 10000001049. Two promises about two different topics were both
recorded by the commitment sentinel as `config-change` on the invented key
`topic.model` (CMT-570 expects `Opus 5.5`, CMT-1068 expects `gpt-6-sol`). Each
verify sweep auto-corrected one value and so "reverted" the other, and each
reached 1001 violations and about 1000 IMMEDIATE alerts in the Attention topic.
Escalation fired once per promise but did not stop the per-flap alerts.

Three changes in `CommitmentTracker`, plus one prompt line in `CommitmentSentinel`:

1. `record()` downgrades a `config-change` whose configPath root names a topic or
   session (`topic`, `topics`, `thisTopic`, `topicProfile(s)`, `session`,
   `conversation`, case/`-`/`_` insensitive) to an unverifiable
   `one-time-action` (`verificationMethod: 'manual'`, no configPath). No
   config-watch, no auto-correct writes.
2. `record()` withdraws any open `config-change` on the same configPath whose
   expected value differs, with `supersededBy` set to the new id.
3. `verifyOne()` skips `onViolation` once the commitment has `escalated: true`.
4. The sentinel detection prompt says per-topic requests are not config-change.

## Decision-point inventory

- Creation-time classification of a config-change (new, structural prefix check).
- Creation-time supersession of a conflicting open watch (new).
- Whether a regression notifies the user (existing; now also gated on `escalated`).

## 1. Over-block

- A real global config key whose root is literally `session` or `conversation`
  would no longer get a config-watch. There is no such root in the agent config
  today (`sessions` plural is the real one and is not in the list); a request of
  that shape is still recorded as a promise, just without the automatic check.
- Supersession assumes the newest request wins. If two users on one agent
  genuinely disagree on one global key, the older promise is withdrawn. That is
  the only coherent outcome for one key; the old behaviour was an endless flap.
- After escalation, a later unrelated revert of the same key posts no new
  violation alert. The value is still auto-corrected and the escalation alert
  already told the user something keeps overwriting it. The `escalated` flag is never
  cleared, so this silence lasts for the life of that promise; withdrawing and
  re-recording the promise restores per-revert alerts.

## 2. Under-block

- An LLM-invented global-looking key (for example `models.default` for a per-topic
  request) still becomes a config-watch. The prompt line reduces this; the
  structural check only covers topic/session-named roots. Two such watches with
  different values are now caught by change 2.
- Conflicting watches that already exist in a store (created before this release)
  are not retro-superseded at boot. Their alerts are bounded by change 3 once they
  escalate (threshold 3 corrections per hour), and the live pair was withdrawn by hand.

## 3. Level-of-abstraction fit

All three live in `CommitmentTracker.record()` / `verifyOne()`, the single entry
point every creator (sentinel, POST /commitments, in-process) goes through, so the
rules hold regardless of who records the promise. Per-topic model pins remain owned
by topic profiles; this change does not make the tracker verify profiles.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`: no new blocking authority over agent actions or
messages. The prefix check changes how a promise is classified, not whether it is
recorded. Supersession is a deterministic invariant (one key, one value). The alert
suppression removes duplicate notices of a condition already escalated.

## 5. Interactions

- Graveyard reconciler acts only on non-terminal rows with `supersededBy`; the
  superseded row is already `withdrawn`, so it is not double-closed.
- Downgraded promises are unverifiable one-time-actions: the verify sweep is a
  no-op for them, auto-expiry and PromiseBeacon/overdue surfacing apply as for any
  other such promise.
- Sentinel de-duplication is unchanged.

## 6. External surfaces

Fewer IMMEDIATE `commitment` notices in the Attention topic. `withdrawn` events
fire for superseded rows (existing event). No route, config, or template change.

## 7. Multi-machine posture

Commitments are recorded and verified by the machine that owns the store; changes
operate on that same local store and replicate through the existing commitment
sync like any other status change. No new durable state, no URLs, no new notices.

## 8. Rollback cost

Revert the commit in a patch release. No data migration: downgraded rows are valid
one-time-actions and superseded rows are valid withdrawn rows.

## Class-Closure Declaration

No new spawn, retry, restart, or self-triggering action. Change 3 removes a
repeating notification; auto-correction behaviour is unchanged.

## Second-pass review

Concern raised, then resolved: the older watch was withdrawn before the new row
was saved, so a failed save could lose the earlier promise. Fixed by superseding
after `insertNew()` in one `mutateSync` (status + `supersededBy` together, one
`withdrawn` event). Also noted, and documented above: the post-escalation
silence is permanent for that promise. A misplaced doc comment was moved back.
The reviewer confirmed the graveyard-reconciler, verify-sweep, behavioural-rules
and multi-machine claims against the code.
