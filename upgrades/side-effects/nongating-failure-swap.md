# Side-Effects Review — Non-Gating Failure-Swap (bounded provider swap for non-gating internal calls)

**Spec:** docs/specs/nongating-failure-swap.md (Tier-1 bug fix — bounded extension of the CONVERGED + approved `docs/specs/provider-fallback-default-policy.md`). **Parent principle:** No Silent Degradation to Brittle Fallback.
**Ships ON by default** (`intelligence.nonGatingFailureSwap.enabled`, inline-defaulted `?? true` at the router construction site — no persisted config block). No-op on a Claude-only agent (no off-Claude tail) and on any router constructed without the field (e.g. unit tests).
**Files:** src/core/IntelligenceRouter.ts, src/core/types.ts, src/commands/server.ts, src/scaffold/templates.ts, src/core/PostUpdateMigrator.ts, docs/specs/nongating-failure-swap.md (new), docs/specs/nongating-failure-swap.eli16.md (new), upgrades/next/nongating-failure-swap.md (new), upgrades/side-effects/nongating-failure-swap.md (new), tests/unit/nongating-failure-swap.test.ts (new), tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts (new), tests/integration/nongating-failure-swap-routing.test.ts (new), tests/e2e/nongating-failure-swap-lifecycle.test.ts (new)

## What changed

1. **IntelligenceRouter.ts — `IntelligenceRouterOptions`:** new optional `nonGatingFailureSwap?: { enabled: boolean; maxAttempts?: number }`. Absent ⇒ feature OFF (byte-identical legacy — a non-gating primary failure re-throws straight to the caller's heuristic).
2. **IntelligenceRouter.ts — `evaluate()`:** after the existing `swapPositions`/`gatingDeadlineAt` computation, compute `nonGatingSwapEligible = !gating && !deferrable && !enforced && nonGatingFailureSwap.enabled === true && cfg.failureSwap.length > 0`. On the eligible path ONLY, compose an `onUsage` capture onto the primary attempt (`primaryEvalOptions`) so `primaryProducedTokens` records whether the primary produced any tokens; gating/deferrable/enforced calls use `evalOptions` verbatim (byte-identical). Inside the existing `if (swapPositions.length === 0)` branch, BEFORE the deferrable-queue + heuristic-fallthrough, if `nonGatingSwapEligible && !primaryProducedTokens` call the new `tryNonGatingSwap(...)`; on success return its result (before any heuristic-fallthrough tracking).
3. **IntelligenceRouter.ts — new `tryNonGatingSwap()`:** attempts at most `maxAttempts` (default 1) steps down `cfg.failureSwap`, FILTERING OUT `claude-code`, the default framework, and the just-failed primary. Each target is `resolveProvider`-checked (binary-missing/circuit-open → skipped/caught) and bounded by the SAME `resolveSwapCap` + `withSwapTimeout` machinery the gating loop uses (the cap also flows through as the provider's `timeoutMs`). Emits `onDegrade` (`nongating-failure-swap:` on success, `nongating-swap-attempt-timeout:` on a cap fire) + `onResolved` on success. Returns `{ ok }`; on `{ ok:false }` the caller falls through to its existing heuristic (`onHeuristicFallthrough` + `throw err`).
4. **types.ts:** new `intelligence.nonGatingFailureSwap?: { enabled?: boolean; maxAttempts?: number }` config field, documented as inline-defaulted (codexExecJson/swapAttemptTimeoutMs precedent — deliberately NOT in ConfigDefaults/migrateConfig).
5. **server.ts (router construction):** wire `nonGatingFailureSwap: { enabled: config.intelligence?.nonGatingFailureSwap?.enabled ?? true, maxAttempts: config.intelligence?.nonGatingFailureSwap?.maxAttempts }` — the default-ON expression.
6. **templates.ts + PostUpdateMigrator.ts:** a bullet under Per-Component Framework Routing (new agents) + an idempotent content-sniffed `migrateClaudeMd` corrective subsection (existing agents), marker `non-gating internal calls also get a bounded`.

## Blast radius

- **Gating / deferrable / nature-enforced paths are untouched.** `nonGatingSwapEligible` is false for all of them, so `primaryEvalOptions === evalOptions` (no capture) and the new branch is never entered. The gating swap loop, the deferrable backoff/queue rungs, and the enforced-nature selection are byte-identical.
- **No new HTTP route, no new provider, no new spawn.** The non-gating swap reuses the existing per-framework providers (already built at boot via `buildProvider`) and the existing per-attempt cap machinery. `tryNonGatingSwap` never builds a new provider or spawns beyond what a normal swap attempt does.
- **Bounded blast on the swap itself:** at most `maxAttempts` (default 1) steps, each circuit-checked, each capped by `swapAttemptTimeoutMs` (default 5s). Worst-case added latency on a non-gating failure = `maxAttempts × cap`.
- **Off-Claude only.** `claude-code` and the default framework are FILTERED OUT of non-gating targets, so this can never push non-gating background traffic onto the last-resort Claude tail (the §6.2 herd invariant). On a Claude-only agent `cfg` is undefined / the tail is empty → strict no-op.

## Risk + mitigation

- **Risk:** reintroduces the §6.2 herd (non-gating traffic floods a fallback under a broad rate-limit). **Mitigation:** the non-gating swap is STRICTLY more conservative than the gating swap — one step (default), circuit-checked (a target whose breaker is open throws fast → skipped), and NEVER onto Claude. Under a genuine rate-limit the target's own breaker damps repeat attempts. Proven by the herd-safety lens test (`never onto claude-code … but a GATING call does`) and the maxAttempts-bound test.
- **Risk:** swapping on a content/parse error double-spends tokens on a request that already burned some. **Mitigation:** the swap fires ONLY when the primary produced ZERO tokens (`primaryProducedTokens` false). A token-carrying failure is NOT swapped — the caller fail-opens it (§6.4). Proven by the `content/parse error that CARRIED tokens → NO swap` test.
- **Risk:** a slow fallback adds latency to a high-volume noop path. **Mitigation:** the per-attempt cap (`swapAttemptTimeoutMs`, default 5s) abandons a slow target via `withSwapTimeout` (the shipped crash-safe Promise.race form; timer cleared on settle). Proven by the `SLOW target abandoned at the cap` test.
- **Risk:** the `onUsage` capture interferes with the primary's own metrics/usage recording. **Mitigation:** the capture COMPOSES with the caller's onUsage (`callerOnUsage?.(u)`) and is downstream of the CircuitBreaking wrapper's own capture — additive, no clobber. Metrics honesty is automatic (each provider's wrapper records its own row keyed by serving framework/model); `usageCoverage` is unaffected.
- **Risk:** an error in the swap helper breaks the LLM call path. **Mitigation:** every path in `tryNonGatingSwap` ends at either a returned result or `{ ok:false }` → the caller's existing `throw err` (heuristic). It never introduces a new fail-closed and never swallows silently — the catch emits `onDegrade` on a cap fire and `continue`s (the same non-silent resilience pattern as the gating loop; not counted by the no-silent-fallbacks ratchet).

## Migration parity

- **Config:** no `migrateConfig` needed — the knob is inline-defaulted at the construction site (`?? true`), so existing agents pick up the default-ON behavior purely from the new code shipping (the codexExecJson/swapAttemptTimeoutMs precedent). Absence ⇒ enabled default.
- **CLAUDE.md:** `generateClaudeMd` gains the bullet (new agents); `migrateClaudeMd` appends an idempotent content-sniffed corrective subsection (existing agents), marker `non-gating internal calls also get a bounded`. Covered by `tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts` (add-when-absent, idempotent, preserves content, skips when missing) + a template-emits-it assertion.

## Dark-gate line-map

- UNCHANGED. `nonGatingFailureSwap` is inline-defaulted in `src/commands/server.ts` (`?? true`) and declared as an optional type in `types.ts`; it is NOT an `enabled:` line in `ConfigDefaults.ts`. The dark-gate attributor reads `ConfigDefaults.ts` only and matches `enabled:` lines, so no line shifted. Verified: `tests/unit/lint-dev-agent-dark-gate.test.ts` → green in the run batch.

## Rollback

- Set `intelligence.nonGatingFailureSwap.enabled: false` → non-gating failures re-throw to the heuristic with no swap (today's behavior), no restart-to-rewire needed (config is read live in `resolveConfig`; the field is read at construction, so a restart is needed only if the operator wants to change it after boot — same posture as `swapAttemptTimeoutMs`). To fully revert: remove the `nonGatingFailureSwap` option + `tryNonGatingSwap` + the eligibility/capture block in `evaluate()` + the server wiring + the type + the CLAUDE.md bullet/migration. Additive throughout.

## Tests

- `tests/unit/nongating-failure-swap.test.ts` (13) — the core behavior + both sides of every decision boundary: invocation-failure → one swap; content-error-with-usage → no swap; disabled + absent → old behavior; target down/circuit-open → skip + re-throw ORIGINAL error; gemini-primary (no usage) → conservative swap; herd-safety (never onto claude-code/default while GATING still does); gating unchanged (full-tail swap); maxAttempts=1 vs 2; model tier preserved; per-attempt cap passthrough; slow target abandoned at the cap.
- `tests/integration/nongating-failure-swap-routing.test.ts` (3) — a production-shaped router (computed default + the knob) SWAPS on a non-gating invocation failure; `GET /intelligence/routing` is unchanged (resolution, not swap); `{ enabled:false }` hard-errors.
- `tests/e2e/nongating-failure-swap-lifecycle.test.ts` (2) — real AgentServer init path: the intelligence-routing route is alive AND the wired router performs the swap via the SHIPPED default expression (config unset ⇒ enabled:true), proving the feature is alive + ON, not dark.
- `tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts` (5) — the migrateClaudeMd corrective (add/idempotent/preserve/skip) + template-emits-it.
- Regression: `no-silent-fallbacks`, `lint-dev-agent-dark-gate`, `provider-fallback-swap-timeout`, `per-target-swap-timeout`, `internalFrameworkDefault`, `intelligence-router`, `nature-routing-resolver`, `degradation-ladder`, `opus-claude-cli-gating-guardrail`, `provider-fallback-default-routing`, `intelligence-routing-routes/lifecycle` all green. tsc clean.

## Agent awareness

- A "Non-gating calls also get a bounded swap now" bullet extends the Per-Component Framework Routing section in `generateClaudeMd`, and an idempotent `migrateClaudeMd` corrective subsection reaches existing agents. Proactive trigger documented: "why did my background classifier's error rate drop / does a non-gating call fall back too?".
