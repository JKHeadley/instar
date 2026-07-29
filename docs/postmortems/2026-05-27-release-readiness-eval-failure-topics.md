# Post-mortem — Release-readiness eval-failure Telegram topics (2026-05-27)

## Summary

A new monitoring sentinel (`ReleaseReadinessSentinel`, shipped over PRs #433 / #442 / #443) emitted a per-stage Attention item — and therefore a new Telegram topic — every time the watchdog's own fetch / analyzer / tick stage broke. Across the v1.3.38 → v1.3.43 dogfood window on Echo, two such topics surfaced ("Release-readiness check could not evaluate"), with bodies that were inscrutable to a user ("analyze-release returned no report"). This pattern was banned six days earlier by the silently-stopped-trio fix (2026-05-22, post-topic-spam flood): internal-plumbing failures belong in the audit log + server log, not on the user's Telegram surface.

The user caught it. The spec passed conformance. The conformance gate did not see this class of violation.

## Timeline

- **2026-05-22** — Silently-stopped-trio fix lands (#334, then wired in #340). Establishes the canonical "Sentinel Notifications" pattern: housekeeping by default → `logs/sentinel-events.jsonl` + `server.log`, Telegram escalation off by default, coalesced into ONE consolidated message in the existing system topic when opted in. Codified in agent `CLAUDE.md` and `docs/specs/silently-stopped-trio.md`.
- **2026-05-26..27** — `RELEASE-READINESS-VISIBILITY-SPEC.md` converges and lands as #433/#442/#443. §4.2.4 says the spec is "near-silent" (✓), and §4.2 explicitly says **any evaluation failure raises a low-priority Attention item — a silent catch is forbidden**. The two-option framing (loud-attention vs silent-catch) skipped over the housekeeping path the trio standard establishes. No cross-reference to `silently-stopped-trio.md`.
- **2026-05-27 (Echo dogfood window)** — Echo enabled the sentinel. Several ticks ran. The 23:54Z tick fetched canonical and failed (`canonical ref unreachable`); the 01:25Z tick reached the analyzer and got back no report. Each emitted a new Telegram topic via the Attention queue's "create-a-topic-per-item" design.
- **2026-05-27 18:30 PT** — User: "These topics keep popping up in Instar agents which goes directly against instar standards: they produce topic clutter; the messages are completely unhelpful."
- **2026-05-27 18:30..18:46 PT** — Diagnosis → branch `echo/release-readiness-housekeeping` → fix + tests + migrator + side-effects artifact + this post-mortem.
- **2026-05-27 18:35 PT** — Two stale items live-cleaned on Echo via `DELETE /attention/release-readiness-eval-failure-{fetch,analyzer}` (soft-delete; topics closed).

## Root cause

A spec-time framing error. The spec author treated the choice as binary:
1. **Loud signal** → post to Attention queue (creates Telegram topic).
2. **Silent catch** → eat the error → recreate the very bug §3 fixes.

The trio standard establishes a third path:
3. **Housekeeping** → write to `logs/sentinel-events.jsonl` + `server.log` + emit an in-process event. Fully observable for diagnostics, never a user-facing topic. Optional, coalesced, single-hub-topic escalation behind a config flag.

For evaluator-self-failures (the watchdog's own fetch / analyzer / tick stages), path 3 is the correct fit — they are internal plumbing the user can't act on. Path 1 was the wrong choice but was actively defended by the spec text. Path 2 was never on the table.

## Contributing factors

1. **No conformance check for sentinel emit-sites.** The Self-Hosting conformance gate exercises many checks (near-silent, 3-tier testing, migration parity, structure-over-willpower, no-manual-work). It does NOT, today, flag "this new `*Sentinel.ts` calls `postAttention` directly without classifying the emit-site against the silently-stopped-trio housekeeping/escalation taxonomy."
2. **No cross-spec consistency requirement.** A spec referencing the trio standard's pattern was not required. The spec mentioned "near-silent" but didn't cite the trio doc as a peer authority.
3. **No structural primitive.** SocketDisconnectSentinel / ActiveWorkSilenceSentinel implement the housekeeping pattern by hand. There is no shared `SentinelEmitter` primitive that bakes in the housekeeping default + escalation gate. Each new sentinel re-derives (or fails to re-derive) the pattern from prose.
4. **Dogfood-to-ship caught it — at the topic-clutter cost.** The "Echo dogfoods first" gate worked: the issue was caught by a real user before the sentinel shipped on default. But the catch came AFTER the user saw two topics, not before. Dogfood-as-only-safety-net is a smell — design-time review should have caught this.
5. **Spec language reinforced the bug.** "A silent catch is forbidden" framed loud-Attention as the only acceptable alternative. Housekeeping is not silent — it's persistent, structured, queryable observability — but the spec used "silent" pejoratively without distinguishing from "audited but not chat-surfacing."

## What we're changing

### Immediate (this PR)

- `ReleaseReadinessSentinel.failLoud()` demoted to audit-only by default; opt-in via `monitoring.releaseReadiness.escalateEvalFailures`.
- `migrateRetireStaleReleaseReadinessEvalFailureAttention()` cleans up stale rows on existing agents.
- Spec text (next slice) — see "Follow-ups" below.

### Follow-ups (tracked as separate work)

1. **Sentinel-emit-site lint.** A pre-commit / CI lint that scans `src/monitoring/**/*Sentinel*.ts` for direct `postAttention(` calls and flags any that aren't either:
   - Behind a config flag of the shape `*TelegramEscalation` / `escalate*Failures` / `*ChatEscalation`, OR
   - Annotated `// @user-actionable-attention-ok — <one-line justification>` in the same expression.
   This is the structural equivalent of the trio standard. Implements "structure > willpower" for the housekeeping taxonomy.

2. **Sentinel emitter primitive.** Extract a small `SentinelEmitter` class with two methods:
   - `recordHousekeeping(event, payload)` → audit + event (no user-facing emit by default)
   - `escalate(item)` → routes to Attention iff the per-sentinel escalation flag is on, with built-in coalescing per the trio standard.
   New sentinels use the primitive. Existing housekeeping-pattern sentinels (`SocketDisconnectSentinel`, `ActiveWorkSilenceSentinel`) migrate at leisure. Spec-time discussion becomes "which emit-sites are housekeeping vs user-actionable," not "do we postAttention."

3. **Spec template update.** Any spec introducing a sentinel must include a "Failure-mode emit-site table" classifying each error path as (a) user-actionable Attention, (b) housekeeping audit-only, (c) opt-in escalation. The /spec-converge conformance pass requires this section.

4. **Cross-reference rule.** `/spec-converge` flags any spec touching `src/monitoring/` that does NOT cite `docs/specs/silently-stopped-trio.md`. Mechanical, easy.

5. **Spec text fix on `RELEASE-READINESS-VISIBILITY-SPEC.md`.** Replace the §4.2 "fail-loud Attention" language with the housekeeping default + escalation flag pattern; cite the trio standard. A follow-up PR (the spec is converged, the runtime behaviour now contradicts it — the doc must match the code).

## Lessons

- **Two coexisting standards is one standard not yet generalized.** When a class of failure (silently-stopped trio) gets a careful design and a separate class (release-readiness eval) reinvents a worse version of it, that's not two design problems — that's the trio standard wanting to be extracted into a primitive. Do the primitive.
- **"Fail-loud" is not a synonym for "Telegram topic."** Loud means observable and surfaced where the next operator looks. For internal-plumbing failures, that's `logs/sentinel-events.jsonl` and `server.log`. For user-actionable failures, it's the Attention queue. The spec should classify each emit-site explicitly.
- **Dogfood-to-ship works but is the last line of defense.** Catches at design time are cheaper than catches at dogfood time. Conformance checks are how we move catches earlier without slowing review.
- **A bad analogy in a spec writes itself into every implementation.** "A silent catch is forbidden" was true but framed the choice wrongly. Better: "Every failure must be audited; user-facing emission is a separate decision." Words matter; choose them so they don't preclude the right answer.
