---
title: "Build plan — Increment A (live credential re-pointing)"
spec: "docs/specs/live-credential-repointing-rebalancer.md"
status: building (approved 2026-06-12 by Justin, CMT-1372)
increment: "A (swap-primitive + ledger + identity-oracle + manual levers); ships dark"
grounding-base: "v1.3.488 (7526bb5ea), worktree echo/live-cred-repoint"
---

# Build plan — Increment A

Execution checklist for the post-approval `/instar-dev` build. Increment A delivers the
zero-touch default-flip (CMT-1337) + operator-triggered rescue with the smallest authority
surface. The autonomous drain balancer is **Increment B** (separate, later). Ships DARK.
Anchors below are grounded against this worktree; re-verify line numbers at build (they drift).

## 0. Order of work (each its own commit through /instar-dev)

1. Config + dark-gate registration (no behavior yet) → proves the gate resolves dark.
2. `CredentialLocationLedger` (+ unit tests) → the bookkeeping core, no writes to keychain.
3. Identity-oracle client (reuse existing `oauth/profile` caller) (+ wiring test).
4. `CredentialWriteFunnel` + lint (+ lint test) → structural funnel BEFORE any swap writer.
5. `CredentialSwapExecutor` (staged exchange, verify, repair) (+ unit + crash-boundary tests).
6. Census consumer re-routing (the §2.2 table) — ledger-resolve every `configHome` live read.
7. Routes (`/credentials/*`) + `CredentialAuditEmit.scrub` chokepoint (+ integration + e2e).
8. `credentialSource` provenance flag at spawn + env-token gate (§2.10).
9. CLAUDE.md template (both sites) + CapabilityIndex + migrateConfig/migrateClaudeMd.
10. Livetest battery (dev-agent, gates dry-run→live promotion — NOT part of the merge gate).

## 1. Config + dark-gate (spec §2.8, §4)

- `src/config/ConfigDefaults.ts` — add `subscriptionPool.credentialRepointing: { enabled: false,
  dryRun: true, balancer: {...clamped knobs}, manualLeversEnabled: true }`, mirroring the
  **`agentWorktreeReaper` precedent at ConfigDefaults.ts:176-181** (explicit `enabled:false` +
  `dryRun:true`).
- `src/core/devGatedFeatures.ts` — add a `DARK_GATE_EXCLUSIONS` entry (the array at **:137**,
  `DarkGateCategory` at **:121**) with `category: 'destructive'`, `configPath:
  'subscriptionPool.credentialRepointing.enabled'`, and a ≥12-char reason (writes credentials).
  Do NOT use `DEV_GATED_FEATURES` (would resolve LIVE on Echo via `resolveDevAgentGate =
  explicitEnabled ?? !!developmentAgent`, devAgentGate.ts:44 — the rev-2 blocking bug).
- Verify `scripts/lint-dev-agent-dark-gate.js` assertion C passes (literal `enabled:false`
  requires the registry entry).
- Going live needs a deliberate two-flag flip (`enabled:true` AND `dryRun:false`).

## 2. CredentialLocationLedger (spec §2.2)

- New `src/core/CredentialLocationLedger.ts`. State `state/credential-locations.json`
  (atomic tmp+rename — mirror `SubscriptionPool.save`, **SubscriptionPool.ts:390-402**).
- Schema: `{ version, assignments:[{slot,accountId,since,lastVerifiedAt,quarantined}], journal }`.
- Corrupt-while-enabled → **unknown mode** (swaps refuse, reads fall back to enrollment
  `configHome` WITH one HIGH attention item — NOT silent fresh-start).
- `slotOf(accountId)` / `tenantOf(slot)` sync in-memory reads (never disk/parse per spawn).
- Seeding/recovery: derive each slot's tenant via the identity oracle (§3), map email→accountId
  via the pool; ambiguous/unknown email → refuse auto-assign + attention item.
- Tests: journal recovery at every §2.3 phase boundary; unknown-mode; ambiguity refusal.

## 3. Identity-oracle client (spec §2.3 verify, E4b)

- `GET https://api.anthropic.com/api/oauth/profile` (Bearer = blob access token) → owning email.
- **REUSE the existing caller pattern** — `QuotaCollector.oauthGet` (QuotaCollector.ts:847-874,
  profile endpoint at ~:827) already calls this endpoint and builds errors from `response.status`
  ONLY (no token in errors). Extract/share that helper; do NOT hand-roll a fetch wrapper.
- Result classification (§2.11): identity-confirmed IFF `isNonEmptyString(email) && poolHas(email)
  && email===expected`; EVERY other outcome (timeout/401/403/429/5xx/missing-empty-nonstring
  email/unparseable) → **unavailable** (quarantine-never-repair), NEVER mismatch.
- Wiring test: the real oracle is wired non-null/non-stub (a no-op oracle greens every check).

## 4. CredentialWriteFunnel + lint (spec §2.2)

- `src/core/CredentialWriteFunnel.ts` — `withSlotLock(slot, fn)` per-slot lock + machine-local
  single-mover mutex. Bounded: refresh fetch carries `AbortSignal.timeout`; lock acquire is
  try-lock-with-timeout (skip-named-reason, never block forever). Lock-timeout skip on the
  QuotaPoller refresh path returns NO-SNAPSHOT, never `markNeedsReauth`.
- Route ALL in-process keychain writers through it: (1) the new executor, (2) QuotaPoller
  401-refresh closure (**QuotaPoller.ts:218**), (3) OAuthRefresher/EnrollmentWizard writes,
  (4) `KeychainCredentialProvider.writeCredentials` (**CredentialProvider.ts:137**).
- Lint (mirror SafeGitExecutor/SafeFsExecutor): forbid outside the funnel
  `defaultCredentialStore.write`, `KeychainCredentialProvider.writeCredentials`, AND a
  string-literal `add-generic-password` SCOPED to the `Claude Code-credentials` service
  (so it does NOT false-positive on WorktreeKeyVault/SecretStore/GlobalSecretStore/
  RemediationKeyVault — distinct services). Lint test asserts both primitives + the `-i` stdin
  form are caught.

## 5. CredentialSwapExecutor (spec §2.3)

- `src/core/CredentialSwapExecutor.ts`. Steps: preconditions (exact ledger membership BEFORE any
  path expansion; reject `../`/`~`/abs → 400) → **§2.3.1a source-slot CAS re-read** before each
  destructive write (adopt newer same-tenant blob) → staging escrow (COPY not move, namespace
  `instar-credential-swap-staging-*` disjoint from `Claude Code-credentials[-hash]`, journal
  `begin`) → exchange (keychain first, config second; DEFAULT slot config = `~/.claude.json`
  home-root per **QuotaPoller.ts:124-140**) → verify on ACCOUNT IDENTITY (oracle); unavailable →
  quarantine-never-repair → commit (staging RETAINED) → delayed re-verify ~90s → delete staging,
  journal `done`.
- All `security` calls async `execFile` + 10s timeout (the existing sync funnel can wedge the
  loop). Boot recovery acquires the mutex for WRITES; balancer first pass gated on a
  recovery-complete barrier WITH a hang-timeout (quarantine wedged slot + lift).
- Keychain store API surface: **OAuthRefresher.ts:115-121** (service naming),
  **:150-169** (`defaultCredentialStore.write`), **:205-285** (`refreshClaudeToken`).
- Tests: crash at every boundary; clobber-race interleavings; permutation property (no sequence
  duplicates a lineage); identity-verify/adopt-on-newer/repair-from-staging/quarantine.

## 6. Census consumer re-routing (spec §2.2 table — the 12 rows)

Each live `configHome`-as-location read → `ledger.slotOf/tenantOf` when enabled; ledger-unknown
→ today's behavior. Key sites: QuotaPoller token read (**:108-115**), 401-refresh (**:218**),
email auto-patch SUPPRESSED (**:349-356**), needs-reauth attribution (**:262-269**); spawn
placement (**SessionManager.ts:1712-1716/:1989**); InUseAccountResolver badge → `tenantOf
('~/.claude')` NOT `auth status` (E4a liar); `AccountSwitcher`/`/switch-account`/`autoMigrate`
REFUSE at the MANAGER (**CredentialProvider.writeCredentials**, not only routes); pool
`configHome` PATCH → 409.

## 7. Routes + audit chokepoint (spec §2.4, §2.9)

- `src/commands/server.ts` — register near the existing subscription-pool routes (pattern around
  **:7400+**, `/switch-account` at **:945**). `POST /credentials/swap|set-default|
  restore-enrollment` (Bearer); `GET /credentials/locations|rebalancer` (rebalancer 503 in
  Increment A). All levers: detective controls (operator notification + audit + param-validate +
  per-pair cooldown + `force:true` with its own `maxForcedManualSwapsPerWindow` budget §0.g).
- `CredentialAuditEmit.scrub(record)` — SINGLE chokepoint every jsonl write / `/credentials/*`
  response / attention-item passes through; reuses `redactToken` (**CredentialProvider.ts:56**).
- restore-enrollment: quarantine-bypass scoped to the flag ONLY; retains parse + refresh-token +
  **identity-coherence** check (access-tenant == refresh-lineage); incoherent → one-directional
  park, never exchanged into a healthy slot.

## 8. Provenance flag + env-token gate (spec §2.10)

- Add `credentialSource: 'store'|'env'` to the session record at spawn, derived from the IDENTICAL
  expression that selects the env block: `(config.anthropicApiKey ?? '') !== '' ? 'env' : 'store'`
  (all three lanes **SessionManager.ts:1724/1998/3155**). Default `store`; an env-token launch
  that forgets to set it is a lint-caught bug.
- Gate refuses when: any non-empty `anthropicApiKey` (OAuth OR API key) OR any running session's
  flag is `env`. (This deployment: `anthropicApiKey` empty → alive.)

## 9. Migration parity (spec §4)

- `migrateConfig` (PostUpdateMigrator, called **:237**) — add-missing the explicit
  `enabled:false`+`dryRun:true` block. `migrateClaudeMd` (**:3148**) content-sniffed section +
  `generateClaudeMd` (templates.ts) — proactive triggers ("flip my default account" → set-default;
  "which account is this slot on?" → GET /credentials/locations). Routes in CapabilityIndex.

## 10. Tests (spec §5) + livetest

- Unit + integration (routes dark=503/live; QuotaPoller poisoning regressions; burst-aggregation)
  + e2e (server-startup wiring alive/503; boot recovery mid-swap). Livetest battery (dev agent):
  E3/E4 re-proven against the SHIPPED executor; default-slot swap+swap-back; the §0.c residual via
  a disposable second grant. Livetest GATES dry-run→live promotion; it is NOT part of the merge CI.

## Definition of done (Increment A)

PR through CI green (all tiers) + merged to JKHeadley/main; ships dark (gate resolves OFF on
Echo until the two-flag flip); CMT-1337 (default-flip) deliverable via `POST /credentials/
set-default` once enabled; CMT-1335 partially addressed (manual rescue lever); the autonomous
drain (CMT-1335 full) is Increment B.

---

## BUILD PROGRESS LOG

### 2026-06-12 — Step 1 (config + dark-gate foundation) — BUILT + VERIFIED GREEN, uncommitted
- `src/core/types.ts`: added `subscriptionPool.credentialRepointing` type (enabled, dryRun, manualLeversEnabled, balancer knobs).
- `src/core/devGatedFeatures.ts`: added `DARK_GATE_EXCLUSIONS` entry (category `destructive`, configPath `subscriptionPool.credentialRepointing.enabled`).
- `src/config/ConfigDefaults.ts`: added `subscriptionPool.credentialRepointing { enabled:false, dryRun:true, manualLeversEnabled:true }` under a gate-marker comment.
- `tests/unit/credential-repointing-dark-gate.test.ts`: 4 tests — registry entry/category, dark-on-dev, dark-on-fleet, lint-pairing invariant. ALL GREEN.
- Verified: `scripts/lint-dev-agent-dark-gate.js` clean; `tsc --noEmit` clean; vitest 4/4 pass.
- NOT yet committed (no runtime behavior; will land in the first PR with the ledger).
- Worktree fast-forwarded to v1.3.489 (current JKHeadley/main); no anchor files changed in the delta.

### 2026-06-13 — Step 1 COMMITTED + pushed — PR #1114 (CI green path)
- Foundation re-applied onto current main (v1.3.521; worktree was 65 commits behind), dark-gate
  golden line-map recomputed (new `enabled:false` appended at end — shifts no prior entry).
- Committed af5b7e3d2 through /instar-dev (approved spec, side-effects artifact, deferral markers,
  trace, Tier 2). Pushed → PR #1114. tsc + dark-gate lint clean; 52/52 unit tests.

### 2026-06-13 — Step 2 (CredentialLocationLedger) — BUILT + GREEN
- `src/core/CredentialLocationLedger.ts`: durable machine-local ledger (state/credential-locations.json,
  atomic tmp+rename), unknown-mode (corrupt→fail-closed mutations + fail-open-loud reads + 1 HIGH
  attention), sync slotOf/tenantOf in-memory reads, journal (in-flight + last 50, never prunes in-flight),
  one-home-per-credential invariant on recordAssignment, quarantine/unquarantine/markVerified, and
  seedFromOracle (oracle unavailable→quarantine; ambiguous/unknown email→refuse+attention; non-claude
  accounts excluded). Identity oracle is an INJECTED interface (Step 3 implements it).
- `tests/unit/credential-location-ledger.test.ts`: 17 tests — never-seeded, all 4 seed outcomes,
  unknown-mode (corrupt + wrong-shape, reads-null, mutations-refuse, seed-recovers), one-home invariant,
  journal pruning, persistence round-trip. ALL GREEN. tsc clean; no-empty-catch + repo-invariants pass.

### 2026-06-13 — Steps 1-2 SHIPPED as one gated commit — PR #1114 (a6d7c1fac)
- Re-committed through the FULL gate stack after wiring a missing husky shim (the first two
  commits had bypassed all hooks — caught by the CI decision-audit gate). One clean commit now
  carries the decision-audit entry, release fragment, and both side-effects artifacts. CI gates
  green (decision-audit, eli16, docs-coverage, repo-invariants, verify); unit shards running.

### 2026-06-13 — Step 3 (CredentialIdentityOracle) — BUILT + GREEN
- `src/core/CredentialIdentityOracle.ts`: implements `IdentityOracle`. Reads a slot's blob via
  `readClaudeOauth` (OAuthRefresher — no hand-rolled keychain), probes read-only `/api/oauth/profile`
  with the slot's token (bounded 10s timeout, injectable fetch), returns the raw email or
  `unavailable`. §2.11 fail-closed: no-token / non-2xx (401/403/429/5xx) / fetch-throw / unparseable
  / missing-empty-nonstring email → unavailable, NEVER mismatch. Pool-mapping stays in the ledger.
  Expired-token refresh-before-profile is tracked to Step 4/5 (needs the write funnel); until then
  an expired token → unavailable (safe direction).
- Added the file to `scripts/lint-no-direct-llm-http.js` ALLOWLIST (read-only OAuth identity, not
  an LLM call — same class as QuotaPoller `/usage`).
- `tests/unit/credential-identity-oracle.test.ts`: 9 tests — every §2.11 branch + Bearer-header
  wiring + a real-non-stub wiring test. tsc clean, llm-http lint clean, all green.

### NEXT (resume here)
- Step 4: `CredentialWriteFunnel` (withSlotLock per-slot lock + single-mover mutex; bounded
  try-lock-with-timeout; refresh fetch carries AbortSignal.timeout) + lint forbidding the TWO
  keychain-write primitives (`defaultCredentialStore.write` AND
  `KeychainCredentialProvider.writeCredentials`, plus the scoped `add-generic-password` string)
  outside the funnel. Route the 4 in-process writers through it.
- Step 5: `CredentialSwapExecutor` (staged exchange, §2.3.1a source-slot CAS, identity-verify,
  quarantine-never-repair, crash-boundary journal). THIS step gets the Phase-5 second-pass review.
- Then steps 6–9 per the plan. Commit-gate notes: when committing, pass `--spec docs/specs/live-credential-repointing-rebalancer.md` (now `approved:true`); the no-deferrals pre-commit scan will flag the spec's legit Increment-B scoping language ("deferred", "follow-up") — add `<!-- tracked: 20905 -->` (or a CMT id) markers within 200 chars of each, or move the deferral into Increment B's own section, before the first commit.
