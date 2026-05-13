# NEXT — upcoming release notes

Entries here ship in the next release. Move them into the versioned upgrade
note (`upgrades/<version>.md`) at release-cut time.

---

### feat(scheduler): runtime invariant gate for legacy-jobs.json auto-migration

`PostUpdateMigrator.autoMigrateLegacyJobsJson` now re-verifies Seamless Migration Guarantee invariants 1, 2, 4 against the staged state AFTER `jobsMigrate` completes but BEFORE the auto-migration is considered final. Per spec §Gate wiring. Any verification failure triggers a fail-closed rollback via `jobsMigrate({ abandon: true })` (invariant 9). The migrator surfaces the failure to the update report so the operator sees what fired.

New module `src/scheduler/MigrationInvariants.ts` exports `snapshotUserNamespace()`, `verifyMigrationInvariants()`, and `canonicalScheduleHash()`. 14 unit tests cover every invariant pass/fail/skip path. Invariant 6 (in-flight protection) is structurally satisfied at update-apply time (no jobs run mid-update) and is deliberately NOT wired here — that needs `JobScheduler.activeRuns()` on the agentmd path, follow-up work.

### feat(server): Phase 4 — Dashboard migration endpoints for jobs-as-agentmd

Three new HTTP endpoints surface the migration state so the Dashboard frontend can render confirm / abandon buttons:

- `GET /jobs/migration-status` — returns `{ hasLegacyJobsJson, hasMigrationComplete, hasMigrationAbandoned, canConfirm, canAbandon, scheduleEntryCount }`.
- `POST /jobs/migration-confirm` — writes `.instar/jobs/.migration-complete.json`. The release-cut gate consumes this marker to allow `jobs.json` deletion. Refuses when the abandonment marker is present (operator must re-run migrate first).
- `POST /jobs/migration-abandon` — invokes `jobsMigrate({ abandon: true })` to roll back.

This is the backend half of Phase 4. The Dashboard UI rewrite (Jobs tab, Issues card, drift digest, unfork action with backup, interactive three-choice prompt) lands as a follow-up multi-PR effort against these endpoints.

## What Changed

### feat(remediation): F-8 — Remediator orchestrator skeleton (Tier-1 subset)

Ships the Tier-1 subset of F-8 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A2, §A4, §A6, §A21, §A36, §A57). New module `src/remediation/Remediator.ts` exposes the orchestrator class plus public types `ApprovedRunbook`, `RemediationContext`, `ExecutionResult`, `VerifyOutcome`, `BlastRadius`, `Reversibility`, `DispatchOutcome`.

`Remediator.registerRunbook()` enforces two registry-load-time gates:
- §A6: refuses any prefilter that includes `provenance: 'free-text'` (structured sources only).
- §A36: refuses `essential: true` unless `blastRadius === 'machine'`.

`Remediator.dispatch()` composes the F-1..F-4 primitives:
- Match candidate runbooks via `eventPrefilter` (errorCode + provenance) + `match()`; pick highest priority.
- Compute `tupleHash = sha256(runbookId + signatureHash)`, check existing in-flight locks (§A2 covered-by-inline detection).
- Acquire `MachineLock` (HMAC-signed via F-1 leaf key for the `inflight` context).
- Declare intent via `IntentJournal` BEFORE running the surface.
- Build a `RemediationContext` carrying `attemptId, runbookId, lockHandle, auditToken (F-1 audit-context leaf), abortSignal, expiresAt, monotonicDeadline`.
- Race `surfaceCallable + verify` against an `AbortController` timer (§A4 deadline enforcement); on timeout returns `aborted-deadline` and releases the lock.
- §A21 strict verify typing: probe error or verify-THROW maps to `verify-inconclusive`, never `verify-failed`.
- Audit-append via F-4 `AuditWriter` at every state transition.

Tier-2 carve-outs (deferred per A57): trust elevation source, probe authentication (A40/A52), surface-side capability-token HMAC enforcement (A3/A23/A42), supervisor handshake (A15), signed-manifest registry validation (A56/A66), child-process SIGTERM/SIGKILL escalation (W-1's concern).

No production consumer in this PR — the dispatcher is constructible but not yet wired into `DegradationReporter.setRemediator()`. W-1 (NativeModuleHealer wrapper) is the first caller.

12 new unit tests in `tests/unit/Remediator.test.ts` cover: register-valid, register-rejects-free-text (§A6), register-rejects-essential-on-non-machine (§A36), no-matching-runbook + audit entry, full success-path with lock+intent+verify+release, covered-by-inline (§A2) for pre-existing same-tuple lock, aborted-deadline (§A4) on hanging surface, verify-NEVER-called on surfaceCallable failure, verify-inconclusive distinct from verify-failed (§A21), verify-THROW → verify-inconclusive, audit entries land in `audit-projection-<machineId>.jsonl`, forged-token entries route to `audit-rejected.jsonl`.

Side-effects review: `upgrades/side-effects/f8-remediator-skeleton.md`.

### fix(security): API safety guard — subscription-by-default enforcement

`src/commands/server.ts` had one silent-fallback path that could engage billed Anthropic API mode without explicit user consent: if the Claude CLI was unavailable and `ANTHROPIC_API_KEY` happened to be set in the environment, instar would silently use the API "as a last resort." That trade-off ("degrading to heuristics is worse than using whatever LLM is available") encoded a values choice the principal rejects. Removed.

Selection logic moves to a new pure function `src/core/selectIntelligenceProvider.ts`. API mode now requires BOTH `intelligenceProvider: "anthropic-api"` AND `intelligenceProviderConfirmed: true` in config.json. Server startup with API mode active prints a visible yellow boxed billing banner. An `ANTHROPIC_API_KEY` in env without the two-flag opt-in is surfaced as a warning and explicitly ignored.

- New `src/core/selectIntelligenceProvider.ts` — pure selection function; 14 unit tests in `tests/unit/selectIntelligenceProvider.test.ts` exhaustively cover the selection table.
- `src/commands/server.ts` replaces the inline 70-line selection block (formerly lines 2050–2114) with a `selectIntelligenceProvider()` call plus warning/banner rendering.
- Spec: `docs/specs/API-SAFETY-GUARD-SPEC.md` + ELI16 companion at `API-SAFETY-GUARD-SPEC.eli16.md`. Side-effects review: `upgrades/side-effects/api-safety-guard.md`.

Driven by Telegram topic 9003 on 2026-05-13: "By default Instar should only run on subscription."

### F-1 — RemediationKeyVault (Tier-1 foundation for Self-Healing Remediator)

- **Adds** `src/remediation/RemediationKeyVault.ts` — per-context, per-scope HKDF-SHA256 leaf-key derivation with a 4-backend secret store (OS keychain, hardware enclave stub, cloud KMS stub, env-passphrase + AES-256-GCM flatfile).
- Per amendments A20, A23, A39, A42, A51, A54, A58, A62 of `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`.
- **No runtime consumers yet.** F-2+ wires capability tokens, probe authentication, in-flight lockfiles, the cross-process attempt ledger, and the audit-token writer onto the leaf-key surface.

### feat(monitoring): F-3 — DegradationReporter normalization shim (Self-Healing Remediator v2 foundation)

Adds the F-3 milestone of the Self-Healing Remediator v2 foundation (per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A5, §A33, §A50). `DegradationReporter` gains a back-compat shim that converts legacy `DegradationEvent` quintuples into a new `NormalizedDegradationEvent` (`{subsystem, errorCode, provenance, reason: {redacted, full}, timestamp, monotonicTs}`) using the F-2 `Redactor` and `ErrorCodeExtractor`. All ~103 legacy `.report(...)` emit sites continue to work unchanged; they normalize to `provenance: 'free-text'` and (per §A6) cannot match any runbook prefilter — they will route to `no-matching-runbook` once F-8 ships the Remediator dispatcher.

New surface on the reporter:
- `reportStructured(event)` — go-forward emit API for callers that already have a NormalizedDegradationEvent.
- `setRemediator(remediator)` — registration hook for the F-8 dispatcher (no consumer wired in this PR).
- `_normalize(legacy)` — pure transform exposed for testability.
- `_setRestartPending(true|false)` — supervisor-controlled flag that re-routes events to a durable JSONL queue at `<stateDir>/remediation/degradations-queue.jsonl` (1000 entries / 5 MiB cap, drop-and-counter on overflow per §A5).

New `scripts/lint-degradation-emit-sites.js` — warning-only catalogue of legacy vs structured emit sites. Exits 0 always; F-8 may upgrade to blocking once a deprecation timeline is agreed.

9 new unit tests appended to `tests/unit/degradation-reporter.test.ts` covering normalization, structured-emit provenance preservation, Remediator routing, backward compat, RestartPending enqueue/replay, queue-cap drop-counter, secret redaction, and errorCode extraction.

Side-effects review: `upgrades/side-effects/f3-degradation-reporter-shim.md`.

### feat(monitoring): F-2 — Redactor + ErrorCodeExtractor (Self-Healing Remediator v2 foundation)

Adds two foundation modules from the Self-Healing Remediator v2 spec (§A1 manifest, F-2): `src/monitoring/Redactor.ts` and `src/monitoring/ErrorCodeExtractor.ts`. The Redactor centralizes content sanitization (home-directory paths, bearer tokens, Telegram bot tokens, emails, UUIDs, long hex strings, IPv4/IPv6, and ≥6-digit numeric IDs). The ErrorCodeExtractor enforces the §A6 errorCode-provenance contract: returns `{code, provenance}` where provenance is `native-binding | probe-id | subsystem-explicit | free-text`, following a priority ladder. A static `isAllowedForRunbookMatch` predicate gives the runbook registry validator a single call to refuse matchers that would consume free-text-provenance events — the §A6 structural defense against attacker-shaped error-text. Neither module has any consumer in this PR; F-3 (DegradationReporter migration) and the W-* runbook wrappers wire them up in follow-up PRs. 46 new unit tests across `tests/unit/Redactor.test.ts` (25) and `tests/unit/ErrorCodeExtractor.test.ts` (21).

Side-effects review: `upgrades/side-effects/f2-redactor-errorcode-extractor.md`.


### feat(remediation): F-4 — MachineLock + IntentJournal + audit infrastructure

Foundation Tier-1 building blocks for the Self-Healing Remediator v2 (§R1 + A2/A24/A29/A42/A43/A46/A63). Four new modules under `src/remediation/`:

- `MachineLock.ts` — HMAC-protected in-flight lock with heartbeat sequence-number envelope, SIGKILL-grace stale-reclamation, and in-memory cache that re-stats every read (A46).
- `IntentJournal.ts` — Append-only intent-declaration log at `<stateDir>/remediation/intent-journal-<machineId>.jsonl`. Writes are O_APPEND + `fsync`.
- `audit/AuditWriter.ts` — Verified-append audit log. Forged-token entries route to `audit-rejected.jsonl` (A12); timestamp-regression entries also routed to rejected (A42). In-memory tail of last 1,000 entries (A29).
- `audit/AuditProjection.ts` — Read view exposing `Map<runbookId, AuditEntry[]>` for the churn detector and SystemReviewer clustering.

No surface wires into these primitives yet. The Remediator dispatcher (F-8), runbooks (W-*), and the primary-aggregator lease (A47 Tier-3) consume them in subsequent PRs.

Tests: 13 new cases across `tests/unit/MachineLock.test.ts`, `tests/unit/IntentJournal.test.ts`, `tests/unit/AuditWriter.test.ts`. Side-effects review: `upgrades/side-effects/f4-machine-locks-intent-journal-audit.md`.

### feat(instar-dev): ELI16 overview required for every approved spec

`/instar-dev`'s pre-commit gate and `/spec-converge`'s convergence-tag writer now both refuse to advance a spec that ships without a plain-English ELI16 overview. Topic 3079 on 2026-05-13 surfaced this directly: "I can't digest this without an ELI16 overview. That should be required for every spec."

This release adds a deterministic structural gate. The overview lives at `docs/specs/<slug>.eli16.md` by default (or any path declared via the spec's `eli16-overview:` frontmatter field) and must be at least 800 characters of real content. Stubs are refused. Both gates share `scripts/eli16-overview-check.mjs` so the rule is uniform across convergence-time and commit-time enforcement.

- New shared check module `scripts/eli16-overview-check.mjs` exposes `resolveEli16Path()` and `checkEli16Overview()` with `MIN_ELI16_CHARS = 800` floor.
- `scripts/instar-dev-precommit.js` adds Step 7 after spec-tag verification: refuses commit if the referenced spec has no ELI16 companion or the companion is a stub.
- `skills/spec-converge/scripts/write-convergence-tag.mjs` adds a pre-check before stamping `review-convergence`: refuses to mark a spec converged without an ELI16 companion.
- New template at `skills/instar-dev/templates/eli16-overview.md`. Updated `skills/instar-dev/SKILL.md` Phase 0 and `skills/spec-converge/SKILL.md` Phase 5.
- 11 new unit tests in `tests/unit/eli16-overview-check.test.ts` — all passing.

Side-effects review: `upgrades/side-effects/eli16-overview-required-gate.md`.

## What to Tell Your User

**Stronger API-billing safety.** Instar will no longer silently switch from your Claude subscription to the metered Anthropic API just because your CLI broke and you happen to have an API key in your environment. The default has always been subscription-only; this fix removes the one path that could quietly bill you. If you actually want API mode, you now need to set two flags in config (`intelligenceProvider: "anthropic-api"` AND `intelligenceProviderConfirmed: true`), and every server startup in API mode prints a yellow boxed banner so it's impossible to miss. No setup needed for the subscription path — that is the default and it stays the default.

**F-2 — Redaction + errorCode normalization.** The self-healing system is getting a safety layer underneath it. Every error report now gets stamped with where the error name came from — a trusted system field, a verified probe, an explicit subsystem call, or just parsed text. Only the trusted sources can trigger automated repair. The same release adds a single place that scrubs personal paths, tokens, emails, and IDs out of every error report before it leaves the agent.

**F-4 — Coordination + audit primitives.** This release adds plumbing for a self-healing system that is not yet active. Nothing changes about how the agent behaves today.

**F-8 — Self-healing orchestrator skeleton.** The piece that decides which repair runs when, makes sure only one repair runs against the same problem at a time, and forcibly stops a repair that takes too long. Wired into the existing audit log, intent journal, and lock primitives from earlier foundation work. Still no user-facing change yet — there are no actual repair playbooks plugged in. The first real playbook (rebuilding the SQLite native module after a Node upgrade) arrives in the next foundation PR. The skeleton fails fast at startup if a playbook is mis-configured (e.g., declared "essential" but only affecting a single process), so misbehaving playbooks can't sneak past review.

**F-1 — Cryptographic foundation for self-healing.** Nothing user-visible yet. Operators running on headless Linux without libsecret should set `INSTAR_REMEDIATION_KEY_PASSPHRASE` in their environment before any F-2+ feature ships. macOS and Linux+libsecret have nothing to do.

**ELI16-overview gate.** When your agent hands you a spec for approval, you'll now always get a plain-English overview alongside the dense technical document. The instar repo refuses to commit any code change whose driving spec lacks a readable companion file. The technical spec becomes the appendix; the overview is the entry point. No setup required; the new behavior takes effect on the next agent update.

## Summary of New Capabilities

- **`RemediationKeyVault`** (F-1) — HKDF-SHA256 leaf keys scoped to one of five contexts (`capability`, `probe`, `inflight`, `ledger`, `audit`) and an opaque scope id.
- **4-backend secret store** (F-1) — OS keychain preferred; hardware-enclave and cloud-KMS stubbed; env-passphrase + AES-256-GCM flatfile fallback.
- **Install nonce** (F-1) — 256-bit random anchor stored under `ai.instar.remediation.install-nonce`; auto-initialized on first boot, fail-closed if missing.
- **ELI16-overview gate** — Structural enforcement at both convergence-time and commit-time. Specs handed for approval always carry a plain-English companion.
- **Shared check module** at `scripts/eli16-overview-check.mjs` — `resolveEli16Path()` and `checkEli16Overview()` with 800-char minimum-length floor.
- **Template for ELI16 overviews** at `skills/instar-dev/templates/eli16-overview.md`.
- **Forward-only enforcement** — only specs newly committed-against after this ships have to satisfy the gate.
- **`selectIntelligenceProvider()`** — single chokepoint enforcing subscription-by-default for the shared LLM provider; refuses silent API fallback; requires two explicit flags for API opt-in; prints a billing banner when API mode is active.
- **NormalizedDegradationEvent contract** (F-3) — `{subsystem, errorCode, provenance, reason: {redacted, full}, timestamp, monotonicTs}` — the go-forward event shape; F-3 ships the additive type plus the legacy → normalized shim.
- **`DegradationReporter.reportStructured(event)`** (F-3) — go-forward emit API for callers that already produced a NormalizedDegradationEvent.
- **`DegradationReporter.setRemediator(remediator)`** (F-3) — registration hook for the F-8 dispatcher; no consumer wired in this PR.
- **Durable RestartPending queue** (F-3) — `<stateDir>/remediation/degradations-queue.jsonl`, 1000 entries / 5 MiB cap, drop-and-counter on overflow (per spec §A5).
- **`scripts/lint-degradation-emit-sites.js`** (F-3) — warning-only catalogue of legacy vs structured emit sites; exits 0 always.
- **Centralized content redaction** (F-2) — `new Redactor().redact(text)` / `.redactFields(obj, fields)` — wired into DegradationReporter in F-3.
- **Structured errorCode extraction with provenance** (F-2) — `ErrorCodeExtractor.extract({ nativeError, probeEmission, subsystemExplicit, freeText, verifyProbeSignature })`.
- **Runbook-match provenance gate** (F-2) — `ErrorCodeExtractor.isAllowedForRunbookMatch(extracted)` — refuses free-text-provenance matchers.
- **In-flight tuple lock** (F-4) — Prevents two heal paths from racing on the same problem.
- **Intent journal** (F-4) — Durable log of "what an attempt declared it was about to do."
- **Audit-writer + projection** (F-4) — Verified-append audit log + read view consumed by later remediation modules.
- **`Remediator` class** (F-8 Tier-1) — Orchestrator skeleton that matches normalized degradation events to registered runbooks, acquires a per-tuple in-flight lock, declares intent, runs the surface callable with deadline enforcement, races verify, and audit-logs every state transition.
- **`ApprovedRunbook` contract** (F-8) — Public type with `eventPrefilter`, `match`, `preconditions`, `surfaceCallable`, `verify`, `blastRadius`, `reversibility`, `expectedRuntimeMs`, optional `essential`. Registry-load-time validators refuse free-text-provenance prefilters (§A6) and `essential` on non-machine blast radius (§A36).
- **`RemediationContext`** (F-8) — Capability-token-shaped context handed to surfaces: `attemptId`, `runbookId`, `lockHandle`, `auditToken` (from F-1 audit-context leaf), `abortSignal`, `expiresAt`, `monotonicDeadline`. Surface-side HMAC enforcement is Tier-2.
- **§A4 deadline enforcement** (F-8) — `AbortController` race against `expectedRuntimeMs`; surfaces that hang are aborted, lock is released, outcome is `aborted-deadline`.
- **§A21 verify taxonomy** (F-8) — `verified-healthy | verify-failed | verify-inconclusive`. Verify-THROW and surface-throw map to `verify-inconclusive` and `verify-failed` respectively; only a clean structured failure increments churn.
- **§A2 covered-by-inline** (F-8) — Pre-existing in-flight lock with same tuple short-circuits dispatch with the existing attemptId.
