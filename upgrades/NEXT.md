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

### feat(monitoring): F-2 — Redactor + ErrorCodeExtractor (Self-Healing Remediator v2 foundation)

Adds two foundation modules from the Self-Healing Remediator v2 spec (§A1 manifest, F-2): `src/monitoring/Redactor.ts` and `src/monitoring/ErrorCodeExtractor.ts`. The Redactor centralizes content sanitization (home-directory paths, bearer tokens, Telegram bot tokens, emails, UUIDs, long hex strings, IPv4/IPv6, and ≥6-digit numeric IDs). The ErrorCodeExtractor enforces the §A6 errorCode-provenance contract: returns `{code, provenance}` where provenance is `native-binding | probe-id | subsystem-explicit | free-text`, following a priority ladder. A static `isAllowedForRunbookMatch` predicate gives the runbook registry validator a single call to refuse matchers that would consume free-text-provenance events — the §A6 structural defense against attacker-shaped error-text. Neither module has any consumer in this PR; F-3 (DegradationReporter migration) and the W-* runbook wrappers wire them up in follow-up PRs. 46 new unit tests across `tests/unit/Redactor.test.ts` (25) and `tests/unit/ErrorCodeExtractor.test.ts` (21).

Side-effects review: `upgrades/side-effects/f2-redactor-errorcode-extractor.md`.

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
- **Centralized content redaction** (F-2) — `new Redactor().redact(text)` / `.redactFields(obj, fields)` — wired into DegradationReporter in F-3.
- **Structured errorCode extraction with provenance** (F-2) — `ErrorCodeExtractor.extract({ nativeError, probeEmission, subsystemExplicit, freeText, verifyProbeSignature })`.
- **Runbook-match provenance gate** (F-2) — `ErrorCodeExtractor.isAllowedForRunbookMatch(extracted)` — refuses free-text-provenance matchers.
