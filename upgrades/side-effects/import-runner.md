# Side-effects review — feedback import runner + dry-run rehearsal route

The cutover-readiness checker (G2.4) composes two conditions; one of them —
`integrity-gate-pass` — reads a persisted import IntegrityReport that NOTHING in
the codebase could produce: the integrity-gate core shipped as pure functions
(#778) with no end-to-end runner wired to live data. This builds the runner and a
zero-durable-writes REHEARSAL route, so the import pipeline is provable on real
production data today and the real import is one adapter away when the
creds-gated cloud DB (G1.4) lands.

## 1. The change

- `migration/importRunner.ts` (new): `runImport(source, target)` — pre-import
  fingerprint-uniqueness scan (aborts BEFORE any write on a collision),
  parent-before-child AS-IS import through the new `ImportTarget` seam, then the
  full integrity gate over what the target READS BACK (intent is never trusted
  over observation). `InMemoryImportTarget` (deep-copy isolation, duplicate-PK
  refusal) is the dry-run/test implementation; the real Prisma adapter is a thin
  future shim over the same seam. Status-equivalence checks CLUSTER statuses only
  (feedback rows carry their own processing-state domain).
- `HttpParitySource`: opt-in `captureRaw` keeps cluster + feedback rows VERBATIM
  for the import read (parity mode unchanged); plus a live-found classification
  gap closed — an abort during the page BODY read now maps to the same classified
  504 naming the page/budgets (was: raw "operation was aborted", observed live
  2026-06-05 11:01Z).
- `CutoverReadiness`: `runImportDryRunPass()` persists the rehearsal envelope to
  a SEPARATE `feedback-import-dryrun.json` path; `importDryRunStatus()` surfaces
  it as `importDryRun` in `status()`. **Readiness honesty is structural**: the
  constructor REFUSES wiring the dry-run path onto the canonical integrity path,
  and `ready` composes integrity + parity only — a green rehearsal can never
  green the gate.
- Routes: `POST /cutover-readiness/import-dryrun` (server computes, agent only
  triggers — T7; same always-logged-outcome contract and same 360s per-path
  timeout as parity-pass) + `GET /cutover-readiness/import-dryrun` (read-only).
- Awareness: CapabilityIndex, site reference/api.md, CLAUDE.md template + an
  idempotent PostUpdateMigrator splice for agents already carrying the Cutover
  Readiness section (Migration Parity Standard).

## 2. Blast radius

Additive. No existing route's behavior changes; `GET /cutover-readiness` gains
the informational `importDryRun` field. The rehearsal writes ONE new state file
(`state/feedback-import-dryrun.json`) and nothing else durable. The mandate
conditions (`integrity-gate-pass`, `parity-zero-divergence`) are untouched — the
rehearsal cannot reach either. No config migration needed (no new config keys;
the runner reuses `feedbackMigration.paritySource`). The real import stays
creds-gated and unbuilt at the adapter layer by design.

## 3. Test coverage

- Unit (18 new, import-runner.test.ts): AS-IS preservation incl. unknown fields,
  collision abort writes NOTHING, mangling/dropping/inventing targets each caught
  by the readback gate, dangling-FK, unknown-status divergence, full v1 legacy
  vocabulary accepted, adapter-supplied schema honored, sequence planning,
  duplicate-PK refusal, deep-copy isolation, snake_case ids.
- Unit (6 new, http-parity-source.test.ts): raw capture verbatim, cross-page
  accumulation + dedup, raw reads refuse without captureRaw/prepare, body-read
  abort → classified 504, non-abort body parse failure propagates.
- Unit (6 new, cutover-readiness.test.ts): dry-run records to the separate path
  and `ready` stays false; failed check records nothing; no-source refusal;
  pre-import abort surfaced; the same-path wiring REFUSED; torn envelope reads
  never-ran.
- Integration (4 new): POST rehearsal over the full HTTP pipeline with a hostile
  body contributing nothing; GET verdict; 409-records-nothing; 503 when absent.
- E2E (1 new): import-dryrun routes ALIVE on the production init path
  (Bearer-gated, 409-not-404 without a source, composed status carries the leg).
