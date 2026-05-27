# Side-Effects Review — Cross-Machine Seamlessness: observability + agent awareness + migration parity

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §11 (converged, approved)

## What changed
- `src/core/MultiMachineCoordinator.ts` — `getSyncStatus()`: the
  /health.multiMachine.syncStatus surface (leaseHolder, leaseEpoch, holdsLease,
  splitBrainState, awakeMachineCount, protocolVersion). Always returns valid
  fields (never null/throws) — the Phase-1 "feature is alive" surface.
- `src/server/routes.ts` — RouteContext gains `coordinator`; authed `/health`
  now includes `multiMachine: { enabled, syncStatus }`.
- `src/server/AgentServer.ts` — threads `options.coordinator` into the route
  context.
- `src/scaffold/templates.ts` (`generateClaudeMd`) + `src/core/PostUpdateMigrator.ts`
  (`migrateClaudeMd`) — a concise Cross-Machine Seamlessness awareness section
  (one-agent-many-machines, no double-reply, compaction-pause handoff bar, honest
  machine-provenance, where to read sync status, how to read a split-brain
  escalation). New agents get it via generate; existing agents via the
  content-sniffed migration.

## Migration parity decision (explicit)
- The `multiMachine` seamlessness KNOBS default safely in code
  (`resolveSeamlessnessConfig` applies defaults for any absent key), so every
  existing agent's server resolves valid values without a config write. I
  DELIBERATELY did not write ~13 knobs into every agent's config.json — that is
  noise, and functional migration parity is already achieved by the code
  defaults + the server code shipping + the SQLite stores self-initializing +
  the CLAUDE.md awareness migration. The dials remain user-settable under
  `multiMachine` (documented in the awareness section). A literal config-knob
  migration is a trivial follow-on if a reviewer wants it.

## Over-block / under-block
- `getSyncStatus` is read-only and defensive (try/catch around the registry
  read → awakeMachineCount 0 on failure). It cannot block anything.
- `/health.multiMachine` is only in the AUTHED branch (unchanged auth posture);
  the unauthenticated basic health is untouched.

## Signal vs authority / interactions
- Pure observability — no authority, no mutation. RouteContext.coordinator is
  `| null`; single-machine installs report `{ enabled:false, syncStatus:null }`
  or the trivially-held lease. Existing route tests still pass (tolerant
  context builders).
- protocolVersion is reported (for partial-migration visibility); its
  enforcement point (refusing to hand the awake lease to an old-version machine)
  lands with the live two-machine handoff transport.

## Rollback cost
- Low. Removing the /health block + getSyncStatus + the template sections
  reverts cleanly; the RouteContext field is additive (`| null`).

## Tests
- `tests/unit/multimachine-syncstatus.test.ts` — the feature-alive surface
  returns valid non-null fields on a single-machine install and never throws.
  119 unit tests green overall.
