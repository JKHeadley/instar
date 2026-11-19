# Merge hand-off: ask again when GitHub has not answered

<!-- bump: patch -->

## What Changed

An optional live switch, `monitoring.greenPrAutoMerge.handoffRecheck`, lets a
verified hand-off reuse its existing direct read and then ask GitHub again after
5, 10 and 15 seconds when mergeability is still `UNKNOWN`. Each read is bounded
at 10 seconds. The same pass holds the watcher marker until its final state save;
only an open change at the verified head with `MERGEABLE` proceeds through every
existing eligibility and merge gate. Conflicts, failed reads, moved heads and
closed changes stop the re-check. No other change or list is re-read.

The switch is off when absent, read live, and needs no config migration. With
it on or off, refusal answers distinguish UNKNOWN from CONFLICTING. Delayed
reads write `handoff-recheck` rows. Hand-off results carry the first GitHub value,
whether a re-check began, delayed-read count and seconds spent. The verifier's
start time (`handoffStartedAt`) joins watcher, result and late-answer rows.

Under `mergeLine`, GET /local-verify reports `unknownHandoffs`,
`recoveredHandoffs` and `holdActiveSkips` since start. Only re-checks entered count
as UNKNOWN; only merges confirmed before the hold releases count as recovered.
Late merges do not count as recoveries.

This changes LocalVerifyService and therefore rotates the verifier version.
Existing records follow the normal verifier-version invalidation rules.

## What to Tell Your User

Nothing changes for you yet. This matters only if your changes are tested and merged by your own test line. Sometimes a change passes its tests and still is not merged straight away, because GitHub has not yet worked out whether it can be merged. A new option lets me ask GitHub again for up to half a minute in that one case, where until now I gave up and the change was merged later. It is switched off. For the first days I only record what GitHub answers, to check that this really is the cause; then whoever runs the test line decides whether to switch it on.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Bounded UNKNOWN re-check | Set `monitoring.greenPrAutoMerge.handoffRecheck: true` live after the baseline decision |
| Diagnose misses and waiting time | Read watcher `handoff-recheck` and verifier `merge-handoff-result` rows |
| See recovery and contention counts | GET /local-verify under `mergeLine` |

## Migration

No config migration: absent remains off. The awareness registry distributes the
new feature note to new and existing agents on update.
