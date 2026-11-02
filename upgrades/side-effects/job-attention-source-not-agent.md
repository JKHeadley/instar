# Side-Effects Review — scheduled jobs stop posting to the Attention topic as "agent"

**Version / slug:** `job-attention-source-not-agent`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator report 2026-11-02 ("These are pretty useless messages"): the built-in `evolution-overdue-check` job (every 4 h, Haiku) raised its attention row with `source: "agent"`. `admitItemToHub` admits every `agent` item, so a scheduled job bypassed the Attention hub filter, and because Haiku reworded the body each run, `admitAttentionObservation` saw a change and reposted (28 posts in topic 3 between Oct 28 and Nov 2). The post asked for a "bulk triage" only the agent can do.

Changes:
1. `src/scaffold/templates/jobs/instar/evolution-overdue-check.md` + `src/commands/init.ts` (same body): source is now `evolution-overdue-check`; the body is report-only (matches the job's own description — no completing, cancelling, or "escalate to the user via Telegram"); the row body has a fixed shape (`<count> overdue, <stale> pending over 48h`).
2. `src/scaffold/templates/jobs/instar/bench-refresh.md`: source `bench-refresh` instead of `agent`. Its routing-diff item IS an operator decision, so `attentionHubPolicy.NEEDS_USER_SOURCES` gains `{ source: 'bench-refresh', idPrefix: 'bench-refresh:routing-diff' }` and it still reaches the operator — for the right reason.
3. `TelegramAdapter.admitAttentionObservation`: a re-raise of an existing row adopts the new observation's `sourceContext`. Without this, the existing `evolution-overdue` row (persisted with `sourceContext: "agent"`) would keep passing the filter forever after the job changed.
4. CLAUDE.md template + `PostUpdateMigrator.migrateClaudeMd`: one bullet telling agents that a job they write names itself as the source, never `agent` (sniff: ``never claims `source: "agent"` ``).
5. Tests: `tests/unit/job-attention-source-lint.test.ts` (every shipped job's /attention POST names a non-"agent" source; overdue held, bench diff admitted; overdue job is report-only), hub-policy cases, adapter re-raise cases both sides, migration idempotency.

## Decision-point inventory

- `admitItemToHub` (`src/messaging/attentionHubPolicy.ts`) — modify — one new needs-user source entry, narrowed by id prefix.
- `admitAttentionObservation` (`src/messaging/TelegramAdapter.ts`) — modify — the row's `sourceContext` follows the latest raise. The decision logic itself (changed → repost) is unchanged.
- Job prompt bodies — modify — the job no longer claims the agent's own voice.

## 1. Over-block

The overdue row no longer reaches the operator's topic. That is intended: nothing in it is the operator's to act on (the overseer tracks the triage separately). The row is still in the attention store and dashboard (`GET /attention`), and each held refresh is logged to `logs/attention-hub-held.jsonl`. A row raised by the agent itself with `source: "agent"` is unaffected (adapter test: re-raise as "agent" still posts after the throttle window).

Source adoption could, in principle, hold a row that a needs-user producer raised if an automated producer later raises the SAME conditionKey under a status source. No such shared conditionKey exists among shipped producers; conditionKeys are producer-specific by convention.

## 2. Under-block

User-authored jobs can still write `source: "agent"`; the server cannot tell a job session's curl from the agent's own (all callers share one bearer token and the job body's curl sends no session header). Covered by the CLAUDE.md bullet (awareness, new + existing agents) and, for shipped jobs, the lint test. A server-side "this request came from a job session" signal would need every job curl to send a session header — a larger change with its own failure modes; not needed to stop this bug.

The job's gate skips the run when nothing is overdue, so the job's "clear the row" step never runs; the lifecycle pass expires the row after 14 days untouched (automated class). Unchanged by this PR and harmless now the row is held.

## 3. Level-of-abstraction fit

The hub filter is the right authority and already exists; the defect was a producer mislabelling itself. Fixing the label at the producer, plus making the store honour the producer's current label, keeps the single filter authoritative. No parallel filter added.

## 4. Signal vs authority compliance

No new blocking authority. The change corrects an input (source label) to the existing smart-enough gate; held items are never dropped.

## 4b. Judgment-point check

No new static heuristic at a competing-signals point. The NEEDS_USER_SOURCES entry follows the existing pattern (a named producer whose item is an operator ask).

## 5. Interactions

- Lifecycle expiry class is derived from source: the overdue row moves from the 30-day "agent-raised" class to the 14-day automated class. Appropriate.
- Repost throttle (6 h) and `hubHeld` flag: a held row sets `hubHeld: true`; `attentionHubAdmits` (used by follow-up/notification paths) now returns false for it — consistent.
- Mobile push fires only after a hub post, so it stops for this row too.
- The 67 "You asked me to ... setting reverted" posts (commitment notice category) are a different path (`admitNoticeToHub`, category `commitment`) and are not touched.

## 6. External surfaces

The operator's Attention topic gets fewer posts (this row). Job body text changes on every agent at next update (built-in bodies are always overwritten by `installBuiltinJobs`). CLAUDE.md gains one bullet. No API shape change.

## 7. Multi-machine posture

Machine-local by design, same as before: each machine's job raises its own row in its own attention store, and the pool view merges them. No new state.

## 8. Rollback cost

Revert the PR; next update rewrites the job bodies back. Operator-side immediate rollback for the filter remains `messaging[].config.attentionHubFilter: "all"`. No data migration; the row's `sourceContext` simply follows whatever source the next raise uses.

## Conclusion

Small, reversible (Tier 1). Stops the noise at the producer, makes the existing row follow, keeps the dashboard view, and keeps the one real operator ask (bench routing diff) reaching the operator.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact:** see appended note below.

## Evidence pointers

- `tests/unit/job-attention-source-lint.test.ts`
- `tests/unit/attention-single-topic-routing.test.ts` ("a row re-raised under a job source is held from then on" fails without the adapter change — verified by disabling the line)
- `tests/unit/attentionHubPolicy.test.ts`, `tests/unit/PostUpdateMigrator-attentionHubFilter.test.ts`

### Second-pass note

Independent reviewer (subagent) traced POST /attention → `createAttentionItem` → `admitAttentionObservation`. The existing `evolution-overdue` row is found by its id. It takes the new source, and the fixed-shape body counts as a change. `routeToAttentionHub` then holds it. A source switch can only happen through an exact id or a caller-supplied conditionKey: a derived key already contains the source. A raise with no source leaves the row's source unchanged. Caveat noted: the switch happens on the next run that finds overdue items, because the gate skips empty runs. Verdict: **Concur with the review.**
