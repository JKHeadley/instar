# Side-effects — Mentor agenda coverage (stop re-cycling)

## 1. What files/state does this touch at runtime?
`src/monitoring/MentorStageA.ts` only: `buildConversationSurface` computes a new
`recentlyDrivenAgenda` field on the surface (from the `mentorSent` it already
receives), and `buildStageAContext` reads it to steer task selection. New optional
field on the `ConversationSurface` interface. No new state, config, schema,
endpoint, or runner wiring.

## 2. Does it change any functional behavior?
Only which agenda item Stage A prefers. When some items are recently driven, the
prompt steers the compose LLM to prefer not-yet-driven items and to observe-only
when ALL are covered. When nothing is driven (or no agenda), behavior is unchanged.

## 3. What happens on failure / weird config?
Pure string/array logic; cannot throw. If `mentorSent` is empty/absent,
`recentlyDrivenAgenda` is simply absent and the prompt uses the original steering.
The matching is a substring check on the item stem — a non-match just means the item
is treated as not-yet-driven (fail-toward-driving, never toward silence).

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed
file / config / template change → no `PostUpdateMigrator` pass.

## 5. Could it spam / flood / burn resources?
The opposite — it REDUCES waste: it stops the mentor from re-driving the same
already-verified agenda items every tick (each re-drive spends a mentee cycle + the
mentor's Stage-A/Stage-B LLM work). No new I/O, timers, or LLM calls; the coverage
list is computed from data already read.

## 6. Rollback / off-switch?
Revert the `recentlyDrivenAgenda` computation + the prompt branch + the type field.
No data, no migration, no flag. Behavior returns to window-only coverage.

## 7. Concurrency / ordering?
None — both functions are pure + synchronous. The coverage list is computed before
the prompt is assembled; ordering of the rest of the surface/prompt is unchanged.

## Blast radius
Small + mentor-only. One pure function gains a derived field; one prompt gains a
conditional block + revised steering. `recentlyDrivenAgenda ⊆ onboardingAgenda`, so
`surfaceText` already covers it → the two-hats leak detector + canary are untouched
and enforcement strength is unchanged. Affects only mentor-enabled agents (mentor
ships dark elsewhere), and only the task-selection wording.
