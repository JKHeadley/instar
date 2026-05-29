# Convergence Report — Cross-Session Coordination Signal (light, advisory)

- Spec: `docs/specs/cross-session-coordination.md`
- Owner: echo
- Approved direction: Justin, topic 15579, 2026-05-28 ("go with a light fix for now …
  learn to collaborate slowly and smoothly"), chosen from an explicit
  light / medium / heavy menu, with the build described before approval.
- Iterations: 3 substantive design-review passes (below).

## Scope under review

A LIGHT, advisory cross-session signal: a shared append-only scratchpad of recent
high-impact structural actions + voluntary "I'm about to do X" intents, surfaced to
an acting session as an in-response `coordinationWarning`. Never blocks, never mutates
target state. Explicitly NOT hard locks / leader election (the heavy path Justin
declined for now).

## Iteration 1 — initial design

Settled the storage model (atomic temp+rename JSON ledger, reload-per-op for
cross-process safety, TTL prune + hard cap), the action taxonomy
(`intent` / `config-flag` / `commitment-withdraw` / `other`), and the advisory-only
contract (record + warn, never block, never touch the target). Decided default-ON
housekeeping with no Telegram escalation in v1 — the in-response warning + `GET
/coordination/recent` + JSONL audit give full observability without re-introducing
the topic-spam risk that the attention-flood work just closed.

## Iteration 2 — implementation review (caught real issues)

1. **Double-count reconciliation (commitment-withdraw recording site).** The first
   design proposed subscribing to `CommitmentTracker`'s `withdrawn` event AND recording
   in the withdraw route — which double-counts. Resolved to a single source: record in
   the `POST /commitments/:id/withdraw` route handler. Rationale: all *agent-initiated*
   withdrawals are route-driven (the route is the single agent-facing path), so this is
   the single source, gives no double-count, and lets the warning ride back on the same
   HTTP response. Code-internal lifecycle transitions (expiry) are not withdrawals and
   are deliberately not recorded. Spec updated to match.

2. **Actor-resolution correctness.** Decided `coordinationActor()` must resolve a
   SESSION-level discriminator only (`X-Instar-Session` / `X-Instar-Actor` header, or
   body `actor`) and must NEVER fall back to the agent id — every session of one agent
   shares the agent id, so using it would wrongly suppress the very cross-session
   warning we want. Unknown actor is treated as "potentially a different session" so the
   signal errs toward surfacing.

3. **Intent-dedup bug (found via the integration test, fixed).** The action-identity
   used for dedupe was `kind + target + value`. Two *different* intents both have no
   target/value, so they collapsed into "the same action" and the warning was wrongly
   suppressed. Fixed: intents are events, not states — they are never deduped. Dedupe
   now applies only to state-flip kinds (config-flag / commitment-withdraw / other),
   where two sessions writing the identical kind+target+value genuinely are one write. A
   regression unit test locks the boundary.

## Iteration 3 — testing-integrity + standards pass

- All three tiers built and green: unit (16), integration (8, exercising both real
  incident vectors — config-flip + withdraw over live HTTP), e2e lifecycle (6, booting
  the real AgentServer → feature alive, 200 not 503), migration-parity (5).
- Migration parity: config default in `ConfigDefaults.SHARED_DEFAULTS`
  (applyDefaults propagates to existing agents), `migrateClaudeMd` awareness section +
  `generateClaudeMd` template, CapabilityIndex entry. Unit-tested.
- No-silent-fallbacks: the coordinator's advisory catch blocks carry
  `@silent-fallback-ok` markers (persistence failure must never break a calling route);
  verified the file contributes zero to the lint count.

## Open / deferred

- Incident #1 (stale `active:true` liveness ghost) — a distinct staleness bug, not a
  coordination signal; candidate next step <!-- tracked: topic-15579 -->.
- Buzz-on-conflict Telegram toggle — small future addition if it proves wanted
  <!-- tracked: topic-15579 -->.

## Convergence

No open design contradictions. The advisory-only contract, single-source recording,
session-level actor resolution, and intent-distinctness are settled and test-locked.
Converged.
