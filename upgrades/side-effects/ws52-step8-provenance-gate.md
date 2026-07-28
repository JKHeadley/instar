# Side-effects review — WS5.2 Step 8 (credential provenance flag + env-token gate)

**Spec:** `docs/specs/live-credential-repointing-rebalancer.md` (approved:true, converged) §2.10/§0.b/§2.4, build-plan §8.
**Tier:** 2 (src code + a read-time gate + a session-record metadata field; ships DARK behind the EXISTING `subscriptionPool.credentialRepointing` flag — NO new gate flag).
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
**Second-pass reviewer:** independent reviewer subagent (this change touches a "gate" → Phase 5 required).

## What changed

- **NEW `src/core/CredentialEnvTokenGate.ts`** — the §2.10 env-token gate (the §0.b applicability precondition, enforced). Pure evaluator (no IO): `evaluate()` REFUSES the feature, with a NAMED CATEGORY reason, when (a) `config.anthropicApiKey` is ANY non-empty value (OAuth OR API key — round-3) OR (b) any RUNNING claude-code session's durable `credentialSource` flag is `'env'` (the live-fleet path that closes the mid-life flip). The static helper `shouldAttributeSlotTenant(session)` is `false` for an env session (its usage is never mis-attributed to a slot tenant — §2.10 requirement 3).
- **`src/core/types.ts`** — adds `Session.credentialSource?: 'store' | 'env'` (additive optional metadata field; no `enabled:` literal → dark-gate UNCHANGED).
- **`src/core/SessionManager.ts`** — sets `credentialSource` on the session record at all four claude-code spawn record-writes. At the three env-block lanes (headless `~:1846`, rerouted-interactive `~:2127`, interactive `~:3248`) it is derived from the **IDENTICAL** expression that selects the Anthropic env block — `(this.config.anthropicApiKey ?? '') !== '' ? 'env' : 'store'`, computed at the spawn site, NEVER a recomputation. The triage lane hardcodes `'store'` (it always empties `ANTHROPIC_API_KEY=`, so it deterministically reads the store).
- **`src/commands/server.ts`** — constructs the `CredentialEnvTokenGate` (reading `config.sessions.anthropicApiKey` — the SAME source `sessionManagerConfig` spreads into SessionManager — and `state.listSessions()`); AND-s its refusal into the `CredentialLocationGate.isEnabled` (so a §2.10 refusal suppresses ALL re-pointing attribution: requirement 3 enforced structurally through the one gate the QuotaPoller already consults); adds the gate to the `credentialRepointing` bundle.
- **`src/server/routes.ts`** — adds `envTokenGate` to the `credentialRepointing` RouteContext type; `GET /credentials/rebalancer` now surfaces the gate verdict (refused + named reason + envSessionCount) when the flag is ON, scrubbed via `audit.response`. DARK → strict 503 no-op (unchanged).
- **Tests:** NEW `tests/unit/credential-env-token-gate.test.ts` (18); extended `tests/integration/credential-routes.test.ts` (+3 rebalancer cases) and `tests/e2e/credential-repointing-routes-alive.test.ts` (+3 cases, incl. live env-token fleet); widened the look-back window in `tests/unit/codex-model-swap-wiring.test.ts` (the §2.10 derivation sits between `effectiveAccountId` and `buildInteractiveLaunch` — the WS5.3 source-string-ratchet lesson).

## Decision-point inventory

- `CredentialEnvTokenGate.evaluate()` — **add** — the §2.10 refusal decision (config field OR live fleet). It is a SIGNAL feeding the rebalancer status surface + the location-gate enablement; it never blocks a session spawn, a message, or a swap directly.
- `CredentialLocationGate.isEnabled` AND-in — **modify** — a §2.10 refusal makes the location gate behave as dark (attribution off) so the QuotaPoller stops re-routing reads/attribution through moved slots for an env fleet.
- `Session.credentialSource` derivation — **add** — additive provenance metadata, not a decision (it is the durable INPUT the gate's fleet scan reads).

## State files / migrations

- **No new state file.** `credentialSource` rides the existing session record (`state/sessions/*.json`); additive optional field, absent on legacy records (treated as `'store'` — the safe, non-refusing direction).
- **No migration in Step 8.** The CLAUDE.md awareness template + `migrateConfig`/`migrateClaudeMd` + CapabilityIndex are explicitly scoped to **build-plan §9 (Step 9 — Migration parity)** — tracked there, not deferred silently. No new config flag means nothing to migrate for the gate itself.

## Blast radius / reversibility

- **Ships DARK.** The gate is only consulted behind `subscriptionPool.credentialRepointing.enabled` (the location-gate AND-in short-circuits on the flag BEFORE evaluating the gate, and the rebalancer route 503s while dark). With the flag off (always, fleet-wide) the only runtime delta is the additive `credentialSource` field on new session records — free metadata, never read. E2E proves the dark surface is a byte-for-byte 503 no-op.
- Reversibility: revert the commit. The `credentialSource` field is inert metadata; no credential write, no schema migration, no durable state to repair. A swap is still the reversible oracle-verified permutation from Step 5.

## Per-Phase-C (multi-machine posture)

- **Machine-local BY DESIGN.** The gate is per-machine: each machine evaluates ITS OWN `config.sessions.anthropicApiKey` + ITS OWN `state.listSessions()`. An N-machine pool is N independent gates; a machine running an env-token fleet refuses LOCALLY without reading or affecting a peer's store-reading fleet. No cross-machine credential read, no LAN/broadcast assumption. The `credentialSource` flag is per-session-per-machine durable metadata and never crosses machines (it would be meaningless on another machine, whose config/fleet differ). This is the correct posture: env-vs-store is a function of the LOCAL config field + the LOCAL fleet, so a remote read would be both unnecessary and a coherence hazard.

## Adversarial review (4 lenses, folded as named tests)

1. **Single-source-of-truth provenance (THE blocker)** — the flag is the IDENTICAL `(this.config.anthropicApiKey ?? '')` expression as the env-block selection at each of the three lanes, computed at the spawn site. Proven by a static grep-assert against the real SessionManager source (exactly 3 env-block predicates + 3 identical provenance derivations + 4 record writes) — an independent recomputation would fail it. A divergence test guards the staleness class this whole spec exists to kill.
2. **Mid-life-flip / live-fleet** — the gate refuses on a running `env` session even when the config field is empty (named unit + integration + e2e tests). A config-only gate would miss it; the fleet scan reads the durable flag.
3. **Attribution-suppression** — `shouldAttributeSlotTenant` is false for an env session (named test); structurally, the location-gate AND-in suppresses re-pointing attribution wholesale on refusal so the QuotaPoller never mis-attributes an env session's usage to a slot tenant.
4. **Dark-ship inertness** — flag OFF → rebalancer 503 strict no-op; record-write shape unchanged except the additive field (e2e "feature is alive" — the single most important test).

## Silent-fallback tags

`CredentialEnvTokenGate` is pure logic with NO catch blocks. The route/server edits add no new catch. no-silent-fallbacks (5/5) + no-empty-catch-blocks (4/4) pass with NO baseline bump.

## Second-pass review (Phase 5 — independent reviewer subagent)

**Concur with the review.** All seven load-bearing invariants verified against the actual code:
1. Single-source-of-truth — the `credentialSource` derivation is the IDENTICAL `(this.config.anthropicApiKey ?? '') !== ''` expression adjacent to each lane's `.startsWith('sk-ant-oat')` env-block predicate over the SAME `this.config.anthropicApiKey` field (SessionManager lanes 1/2/3); triage hardcodes `'store'` and demonstrably empties `ANTHROPIC_API_KEY=`. Not a recomputation.
2. Config predicate is "any non-empty value" (`key !== ''`), correctly broader than the launch's sk-ant-oat branch (both branches set a store-bypassing env var).
3. Gate ANDs the live-fleet scan (running + claude-code + `credentialSource === 'env'`, undefined→store safe default) onto the config check, closing the mid-life-flip hole.
4. The location-gate `isEnabled` AND-in is sound: `&&` short-circuits on the dark flag BEFORE `evaluate()` is ever called (true no-op while dark); on refusal it suppresses re-pointing attribution wholesale (the conservatively-correct direction); `shouldAttributeSlotTenant` false for env.
5. Gate-level single-source-of-truth holds — `config.sessions?.anthropicApiKey` is the same value `sessionManagerConfig = { ...config.sessions }` feeds SessionManager (anthropicApiKey not overridden).
6. Dark surface is a strict 503 no-op through the scrub chokepoint; the only record-shape delta is the additive optional field.
7. Signal-vs-authority: advisory except the attribution-suppression AND-in, which is appropriate and non-brittle (a boolean over a durable flag with a safe default).

No concern raised.

## Gate-ratchet results (run locally before push)

- `tsc --noEmit` clean; full `npm run lint` clean (includes dark-gate 16/16 — **UNCHANGED**, no ConfigDefaults touch).
- no-silent-fallbacks 5/5, no-empty-catch-blocks 4/4, feature-delivery-completeness 97/97, docs-coverage --check pass (floor-based; internal-plumbing symbol, no floor breach).
- credential-env-token-gate 18/18; credential-routes (integration) all pass incl. 3 new rebalancer cases; credential-repointing-routes-alive (e2e) 6/6 incl. live env-token fleet; codex-model-swap-wiring 7/7 (window widened); all SessionManager wiring/activation tests green.

## Second-pass review verdict (Phase 5 — required: change touches a "gate")

Independent reviewer subagent audited the gate + the 4 spawn-site provenance derivations + the dark-ship short-circuit against the real code (not the artifact's claims), and against `docs/signal-vs-authority.md`. All six verification points held:

1. **Single-source-of-truth** — all 3 env-block lanes (`SessionManager.ts:1844/2126/3246`) derive `credentialSource` from the identical `(this.config.anthropicApiKey ?? '') !== ''` predicate adjacent to their own env-block write; the triage lane hardcodes `'store'` and provably empties `ANTHROPIC_API_KEY=`. The gate reads `config.sessions?.anthropicApiKey` (`server.ts:9213`), which is the SAME value `sessionManagerConfig = {...config.sessions}` feeds SessionManager (not overridden). Not a recompute.
2. **Fail-safe direction** — `credentialSource==='env'` is the only fleet-path refusal; `undefined`→`'store'` (non-refusing). A refusal disables the FEATURE (re-pointing attribution), never messaging/sessions/swaps.
3. **Dark-ship inertness** — `enabled === true && !gate.evaluate().refused` short-circuits on the flag BEFORE `evaluate()`; the route 503s before evaluating. Byte-for-byte prior behavior when dark.
4. **Config predicate** — refuses on ANY non-empty `anthropicApiKey` (OAuth `sk-ant-oat` OR api key), matching both SessionManager launch branches.
5. **Signal-vs-authority** — a deterministic policy evaluator over a structured durable flag, not a brittle detector; the only authority it holds is suppressing the feature itself (the conservatively-correct fail-safe), which the principle doc explicitly permits for a domain this constrained.
6. **Over/under-refuse** — the mixed-fleet whole-feature refusal is conservatively-correct (refuse rather than mis-steer); machine-local posture is correct. No hole found.

**Verdict: CONCUR.** The side-effects artifact's claims all hold against the actual code.
