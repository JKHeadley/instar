# Side-effects review — Observable Intelligence / LLM Activity

**Tier:** 1 (large but purely additive, read-only observability; no existing behavior changes; reversible; full 3-tier tests). Risk floor flags "new capability" — declared below floor with this rationale, recorded in the decision audit.

## Surface touched

- `IntelligenceOptions` gains two **optional** callbacks (`onModel`, `classifyVerdict`). Additive: every existing caller is byte-identical (evaluate() still returns `Promise<string>`).
- `CircuitBreakingIntelligenceProvider` (the single funnel) captures model/framework + classifies the verdict and records them. Pure side-channel — wrapped in try/catch; a throw in either callback cannot change what `evaluate()` returns or break the observed path.
- Five providers (Claude/Codex/Gemini/Pi/InteractivePool) each call `onModel` once per call. Each call is try/caught (`@silent-fallback-ok`) so it can never break the LLM path.
- Two sentinels (MessageSentinel, CommitmentSentinel) pass a `classifyVerdict`; the classification reuses their existing parse and defaults to noop on throw.
- `FeatureMetricsLedger`: new `framework` column via idempotent pragma-guarded `ALTER TABLE ADD COLUMN` (existing DBs migrate at open, no data loss); new `pruneOlderThan`; rollup gains `frameworks[]`/`models[]`.
- `AgentServer`: a retention prune timer (boot + every 6h, `unref`'d), cleared at shutdown.

## Risks considered

- **Schema migration**: covered by a unit test that opens an old-schema DB and confirms the column is added without losing the legacy row. The ALTER is pragma-guarded and idempotent.
- **Performance**: recording is one extra SQLite insert per call (already happening) plus two cheap callback invocations. No new network calls.
- **Retention deletion**: `pruneOlderThan` only deletes rows older than the cutoff; fail-open (a failed prune leaves rows for the next tick). Default 30d, configurable, `0` disables.
- **Observability never gates**: same guarantee as TokenLedger. A failed metric write, failed prune, or thrown callback degrades silently; the LLM path is unaffected.
- **No new HTTP route** (reuses `/metrics/features`), so no new auth/route surface. Dashboard tab is read-only.
- **Migration parity**: existing agents get the enhanced CLAUDE.md section via the existing `/metrics/features` migrateClaudeMd block (enhanced in place, idempotent — verified by `PostUpdateMigrator-metricsFeatures.test.ts`); new agents via the template.

## Constitutional fit

Implements the proposed **Observable Intelligence** standard (pending operator ratification); balanced by Responsible-Resource bounded retention. Sharpens the existing **Observability** standard.
