# Side-effects review — Dashboard scoped-session revocation completeness (SEC-044 + SEC-045)

Spec: `docs/specs/dashboard-scoped-session-revocation.md` (converged 7 rounds, cross-model codex-cli:gpt-6-astra).
Ships **dark** behind `security.dashboardScopedToken.enabled` (default false). With it off, every path here is unreachable and behaviour is byte-identical to today (the master-token path is untouched).

In-scope files: `src/server/DashboardSessionStore.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`, `tests/unit/dashboard-session-store.test.ts` (+8), `tests/integration/dashboard-scoped-session-revocation.test.ts`, `tests/e2e/dashboard-scoped-session-revocation-alive.test.ts`, `src/data/awareness/dashboard-scoped-session-revocation.md`.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
The one real over-block is the STRICT reuse model: a legitimate client whose refresh **response** is lost on the network retries the same token, which is now treated as reuse → the family is invalidated and the owner re-enters their PIN. This is a deliberate, declared tradeoff (the standard refresh-token-rotation model; §2 of the spec, "Verify the State"): the alternative — an idempotency window that hands the successor back to any re-presenter — was proven (codex round-4 HIGH) to let a thief shadow the rotation chain, which is far worse than a rare re-PIN. The re-PIN happens only on a dropped *refresh response*, not on every refresh. A pathologically-reconnecting legitimate client could also trip the per-family tombstone cap (`8×maxTokens`) → one re-PIN; the cap is far beyond any real client.

## 2. Under-block — what failure modes does this still miss?
- A thief who steals a LIVE token and uses it read-only WITHOUT ever refreshing is not detected by reuse-detection (there is no reuse) — but the token still expires at its TTL, the family at its absolute cap, and PIN rotation / revoke-all / the owner's logout all end it. Reuse-detection is one layer, not the only one.
- Cross-machine: `revoke-all` ends sessions on THIS agent only. A session on another machine's dashboard is ended by PIN rotation (fleet-wide via PIN replication), not by this control — by design, and named accordingly (§Multi-machine).

## 3. Level-of-abstraction fit
Correct layer: the revocation state lives in `DashboardSessionStore` (the same server-side, digest-keyed store that owns the tokens), and the HTTP surface is the existing `/dashboard/session/*` family. `revokeAll()` already existed; this wires its callers (PIN rotation) and completes the store's lifecycle invariants. No new subsystem.

## 4. Signal vs authority compliance
The FAMILY is the authority for "is this session alive"; a single token digest is a signal a refresh can erase. Every revocation path resolves and acts on the family (live-or-tombstone), never on a lone live digest. Reuse-detection is a brittle deterministic detector driving an irreversible action (invalidate) WITHOUT an LLM authority — explicitly within `docs/signal-vs-authority.md`'s exemption for irreversible/transport-dedup guards (false-pass catastrophic, false-block cheap = re-PIN). Confirmed by the lessons-aware pass.

## 5. Interactions
- `revokeAll()` fires `onFamilyInvalidated` listeners → closes open WS/SSE streams (existing mechanism).
- The new scheduled prune timer and the SSE heartbeat per-delivery check both call `invalidateFamily`/`verify` — idempotent, no double-fire harm (invalidate on an already-revoked family is a no-op).
- `/dashboard/session/refresh` and `/revoke` are registered BEFORE `authMiddleware`, so a CONSUMED token reaches the store (required for reuse-detection + old-token logout). `/revoke-all` is also pre-authMiddleware and does its own master-OR-step-up gate.
- The per-family cap and family-count bound can `invalidateFamily` under extreme load; this only ever ends the OFFENDING family, never an innocent one (codex round-4 MEDIUM-1 fix).

## 6. External surfaces
One new HTTP route: `POST /dashboard/session/revoke-all` (dark-404 when disabled; 403 step-up-required otherwise). No change visible to other agents or the master-token/API path. **User-visible effect when the feature is later enabled (condition 1):** rotating the PIN now also signs out active dashboard browser sessions (previously it did not); a dropped refresh response now occasionally asks for a re-PIN. Both are the intended security behaviour, surfaced in the awareness entry + release note.

## 7. Multi-machine posture
`DashboardSessionStore` is machine-local by design (`physical-credential-locality`): live heap-bound session tokens cannot and must not replicate across machines. Revocation is per-machine; the fleet-wide path (PIN rotation) already exists and fans out via PIN replication. The `revoke-all` control is named for its real scope ("this agent"), not "everywhere". Full treatment in the spec's Multi-machine section (contested across rounds 4–6, resolved).

## 8. Rollback cost
Trivial: the feature ships dark, so a straight `git revert` fully undoes it with no migration, no state repair, and no live impact (nothing was enabled). The config flag default (false) is unchanged.

## (process note) Round count
This began declared Tier-1 (dark, reversible) and was re-tiered to **Tier-2** mid-review once the reuse-detection + stream-lifecycle depth surfaced two HIGH security findings. 7 convergence rounds, each (through round 6) finding a real build-changing issue. Full trail: `docs/specs/reports/dashboard-scoped-session-revocation-convergence.md`.

## Second-pass review

**Concern raised, then addressed.** An independent implementation reviewer (reading the actual code vs. the spec across 10 check areas — Phase 5) confirmed the core store state machine is correct and faithful (refresh reuse-before-lookup, per-family cap before mint, tombstone-on-every-removal, invalidateFamily with no leak, issue() family-count termination, prune() order, the constant-time step-up-gated revoke-all, and pre-authMiddleware consumed-token wiring all verified against line numbers). It found **no high-severity bugs** and three issues, all now fixed:

- **[MED, fixed] SSE per-delivery check verified TOKEN liveness, not FAMILY liveness** — `verify()` is live-token-only, so an ordinary token rotation while an SSE stream was open would force-close a *healthy* stream every refresh cycle (the exact behaviour the live-stream graduation proof would catch). Fixed: added `DashboardSessionStore.familyLiveForToken()` (resolves the family via live-OR-tombstone and checks `!revoked && now < absoluteMaxMs`), wired a new `dashboardScopedSessionFamilyLive` RouteContext function, and switched the heartbeat check to it. A rotated token's stream now stays open; only a revoked/past-deadline family closes it. Covered by a new unit test (`familyLiveForToken stays TRUE across a token rotation`).
- **[LOW, fixed] revoke-all absent from `isDashboardCredentialRoute`** — the route self-gates (pre-authMiddleware, master-OR-step-up), so it was harmless, but the spec named the credential-route layer. Added `/dashboard/session/revoke-all` to `DST_CREDENTIAL_EXACT` as defense-in-depth (keeps its step-up requirement if ever moved onto the authed router).
- **[LOW, fixed] per-delivery check only on the 15s heartbeat, not the 5s poller** — added the same family-live check to the job-state poller so a dead-family stream stops at its very next delivery (the spec's wording), not only on the heartbeat.

Re-verified after the fixes: tsc clean; 21 unit tests pass.

## Follow-up correction

- The awareness entry `src/data/awareness/dashboard-scoped-session-revocation.md` used an `id:` front-matter key, but the awareness-entry-registry allows only `title` (and optional `requires`). This made the registry log one error on every migration run and failed all ~67 PostUpdateMigrator unit tests. Fixed to `title:`. No runtime change.
