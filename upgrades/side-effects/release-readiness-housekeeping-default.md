# Side-Effects Review — Release-readiness eval-failure → housekeeping default

**Driver:** dogfood feedback on Echo (2026-05-27). The user observed two consecutive "Release-readiness check could not evaluate" Telegram topics within 90 minutes (one from a fetch-stage failure, one from an analyzer-stage failure) and called it out as anti-Instar topic clutter with an unhelpful body. This is the exact pattern the silently-stopped-trio fix banned after the 2026-05-22 topic-spam flood; the release-readiness sentinel was emitting against it.

## What changed

- **`src/monitoring/ReleaseReadinessSentinel.ts`** — `failLoud()` now writes the audit entry unconditionally (the canonical observability surface for housekeeping is the audit log), but only calls `deps.postAttention()` when the new config opt `escalateEvalFailures` is true. Default false. The dedupe path (`state.lastFailureKey === key` → early return) is unchanged. The `eval-failed` event is still emitted on the un-suppressed pass so external consumers can wire their own alerting if they want.
- **`src/monitoring/ReleaseReadinessSentinel.ts`** — `ReleaseReadinessSentinelConfig` gains an `escalateEvalFailures?: boolean` field; `DEFAULTS` sets it to `false`. The doc comment at the top of the file is updated to describe the new behaviour and cite the sentinel-trio standard.
- **`src/core/types.ts`** — `monitoring.releaseReadiness.escalateEvalFailures?: boolean` added with a JSDoc explaining the gate.
- **`src/config/ConfigDefaults.ts`** — `releaseReadiness.escalateEvalFailures: false` added to default config so the field is present in every freshly-init'd agent.
- **`src/commands/server.ts`** — the construction call site passes `rrCfg.escalateEvalFailures` through to the sentinel.
- **`src/core/PostUpdateMigrator.ts`** — new `migrateRetireStaleReleaseReadinessEvalFailureAttention()`. Strips items whose id begins with `release-readiness-eval-failure-` from `.instar/state/attention-items.json` so existing agents don't keep tracking the closed-but-haunting topics. Atomic write (tmp + rename), fully idempotent, leaves legitimate `release-readiness-<sha>` user-actionable items + every non-matching item alone.
- **`tests/unit/ReleaseReadinessSentinel.test.ts`** — replaced two pre-existing fail-loud tests with FIVE that pin both halves of the new contract: the housekeeping default (no postAttention; audit-always; event-emits-once-per-dedup-episode), the opt-in path (postAttention on, dedup still works), and the regression guard that the user-actionable "Release blocked — unreleased work is piling up" signal still posts under default config.
- **`tests/unit/PostUpdateMigrator-retireStaleReleaseReadinessEvalFailureAttention.test.ts`** — 7 tests: missing attention-items.json, empty items, no eval-failure rows (idempotent), selective drop preserving siblings, full idempotency on a second run, malformed-entry tolerance (no id / wrong-type id), and unparseable-JSON error reporting.

## Side-effects analysis

**Default-change impact.** The visible behavioural change on an existing agent that updates with default config is: when the watchdog's fetch / analyzer / tick stage breaks, the user no longer gets a Telegram topic. They get an audit line in `logs/sentinel-events.jsonl` + a `console.warn` in `server.log` and the `eval-failed` event for any consumer that's wired one. This is exactly the visibility level the sentinel-trio standard establishes for housekeeping signals. The user-actionable "Release blocked" Attention path is untouched.

**Opt-in restores the old behaviour.** A maintainer who explicitly wants catastrophic watchdog-self-failures in chat sets `monitoring.releaseReadiness.escalateEvalFailures: true` and gets the prior wiring back, including the per-stage Attention id (`release-readiness-eval-failure-fetch` / `…-analyzer` / `…-tick`).

**Migration scope.** The PostUpdateMigrator step mutates ONLY rows whose id begins with the exact prefix `release-readiness-eval-failure-`. Non-matching rows (`release-readiness-<sha>` user-actionable, any unrelated attention id) are preserved byte-for-byte. The migration touches only `attention-items.json`; the Telegram topic itself is left as-is (Echo's two stale topics were already `/done`'d to closed state, and we soft-deleted them via `DELETE /attention/:id` during the live cleanup so the bot won't re-route messages to them). A second run finds nothing to drop and reports `skipped: 'none on disk'`.

**Rollback.** Reverting this PR re-enables the per-event Telegram topic for evaluator-self-failures. The audit log + state files are forward-compatible (no schema change). A revert would not regenerate dropped attention rows (idempotent migration — that data was already noise).

## Testing

`tests/unit/ReleaseReadinessSentinel.test.ts` — 16 tests pass:
- housekeeping default: fetch failure audits + emits `eval-failed`, no postAttention; deduped second tick suppresses the event too
- housekeeping default: analyzer null audits, no postAttention
- housekeeping default: "Release blocked" user-actionable signal STILL posts (regression guard)
- opt-in `escalateEvalFailures: true`: fetch failure posts a deduped Attention item
- opt-in `escalateEvalFailures: true`: analyzer null posts an Attention item with the canonical id
- plus all pre-existing tests for blocked-detection, silent-threshold, priority escalation, hysteresis, resolveEpisodesInRange, TTL reaping, and disabled-state behaviour

`tests/unit/PostUpdateMigrator-retireStaleReleaseReadinessEvalFailureAttention.test.ts` — 7 tests pass

`tests/unit/releaseReadinessWiring.test.ts` — 8 tests pass (unaffected, still green)
`tests/integration/release-readiness-routes.test.ts` — 5 tests pass (unaffected, still green)

Type-check clean (`tsc --noEmit` zero output).

## Live cleanup performed

Echo's two stale items were soft-deleted via `DELETE /attention/release-readiness-eval-failure-fetch` and `DELETE /attention/release-readiness-eval-failure-analyzer` against the running server (status → DONE, topics closed). The PostUpdateMigrator step will pick up the on-disk rows on the next startup after this PR ships, completing the cleanup.
