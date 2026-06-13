# WS2.1 — preferences become the first replicated store on the HLC foundation

<!-- bump: patch -->

<!--
  NOTE: internal substrate, dark by default (multiMachine.stateSync.preferences,
  enabled:false + dryRun:true). The change touches runtime src/ (a new core module,
  dual-registry wiring, server wiring, route consult, migration + awareness), so the
  tests/docs-only lane does not apply. The user-facing sections honestly state the
  capability only becomes real once an operator flips the flag.
-->

## What Changed

The **auto-learned preference store is now the FIRST concrete consumer of the HLC replicated-store foundation** — `pref-record` rides the foundation primitives (envelope / union-reader / conflict-store / rollback-unmerge / bounds / snapshot) so a preference learned on one machine is honored on the others. Per `docs/specs/multi-machine-replicated-store-foundation.md` §4 + §7 + §13 + §15.1.

- **The `pref-record` replicated kind** (`src/core/PreferencesReplicatedStore.ts`) — the store schema (strict typed validation on top of the envelope; `recordKey` = the preference `dedupeKey`; the operator's local-only `violationPattern` is NEVER replicated), the HIGH impact tier, per-kind bounds, the emit-envelope builder, and the load-bearing union-aware read.
- **DUAL REGISTRY** — `pref-record` is registered in BOTH `JOURNAL_KINDS` (`CoherenceJournal.ts` — the static serve/apply/advert half) AND `ReplicatedKindRegistry` (the dynamic half). A kind in only one silently replicates nothing; a CI ratchet now asserts the coupling.
- **The advisory both-variants read** (resolves spec §15.1) — `GET /preferences/session-context` reads the no-clobber UNION through the bypass-proof `ReplicatedStoreReader` when `multiMachine.stateSync.preferences.enabled`. On an OPEN concurrent conflict the session-start block injects BOTH variants as advisory hints — it NEVER suppresses a usable hint waiting on operator resolution. The conflict flag is observability + optional cleanup (`POST /state/resolve-conflict`), not a blocked preference.
- **Coordination** (CMT-1416) — this foundation path SUPERSEDES the earlier seamlessness `PreferencesSync.ts` (deprecation header added; retained dark until validated, removed in a separate cleanup PR). Both dark → zero runtime duplication.
- **Config + advert + awareness + migration** — `multiMachine.stateSync.preferences { enabled:false, dryRun:true }` added to ConfigDefaults (classified in `DARK_GATE_EXCLUSIONS`; `applyDefaults` backfills existing agents); the `stateSyncReceive` advert self-reports `preferences` from the registry; the "One Memory" CLAUDE.md section gains a WS2.1 line in both `generateClaudeMd` and an idempotent `migrateClaudeMd` splicer.

Pure MECHANISM, dark by default. A single-machine / flag-off agent is a strict no-op (byte-identical to before). A pre-apply agent's union is just its own local store.

## What to Tell Your User

None — internal substrate (dark by default). The user-visible capability — a preference I learned about you on one machine is honored on your others, and when two machines learned divergent preferences during a partition I show you BOTH and let you resolve — becomes real only when an operator turns on cross-machine preference replication.

## Summary of New Capabilities

None user-facing while dark. New internal module `PreferencesReplicatedStore.ts`. The existing `/preferences/session-context` route gains a foundation union path (consulted only when the flag is on; otherwise its legacy own-only behavior is byte-identical). No new routes.

## Evidence

- `tests/unit/PreferencesReplicatedStore.test.ts` — dual-registry coupling (pref-record in BOTH registries), the store schema (reject empty learning, jail a path-shaped provenance, clamp confidence, drop unknown + local-only fields), the emit builder (recordKey=dedupeKey, violationPattern never replicated, credential scrub), and the §12 wiring tests: the union reader CANNOT be bypassed for preferences, append-both-and-flag idempotent on a stable conflictId, the advisory reconciliation injects BOTH variants on an OPEN conflict (never suppressed), post-unmerge zero-dangling-refs. Green.
- `tests/unit/ReplicatedRecordEnvelope.test.ts` — the post-WS2.1 dual-registry ratchet (pref-record coupled in both registries). Green.
- `tests/integration/preferences-routes.test.ts` — the foundation union path over HTTP: 200 + scope:mesh, an OPEN conflict injects BOTH variants, the clean sequential chain resolves to one hint, and the flag-OFF path keeps the legacy own-only behavior. Green.
- `tests/e2e/preferences-session-context-lifecycle.test.ts` (Phase 1c) — the WS2.1 union path is ALIVE on the real AgentServer boot path: 200 + scope:mesh, both variants on an open conflict. Green.
