# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

### Context-Death Pitfall Prevention (shadow mode)

Agents will no longer self-terminate mid-plan citing "context death" when context remains to complete the work. This release ships the full detection + authority infrastructure in **shadow mode** (observing, never blocking). The enforce-flip requires ≥14 days of shadow telemetry + ≥20 operator annotations from ≥2 distinct reviewers, per spec design.

**What the feature does:** When a Claude 4.7 agent attempts to stop mid-task with "drift to continue-ping," "fresh session," "compaction imminent," or similar unjustified self-termination language, a server-side LLM authority (`UnjustifiedStopGate`) evaluates whether the stop is justified. In shadow mode it only logs the decision; in enforce mode it would return a reminder nudging the agent to continue or produce concrete evidence.

**Ships inert by default.** `mode='off'` short-circuits every evaluation. No change in runtime behavior until an operator explicitly runs `instar gate set unjustified-stop --mode shadow`.

**New surfaces:**

- **Server routes** (all require bearer auth):
  - `GET /internal/stop-gate/hot-path` — mode + kill-switch + session state for the Stop hook
  - `POST /internal/stop-gate/evaluate` — decision-point authority call
  - `GET/POST /internal/stop-gate/log` — evaluation log query + annotation
  - `POST /internal/stop-gate/mode` — flip mode (`off`/`shadow`/`enforce`)
  - `POST /internal/stop-gate/kill-switch` — emergency disable
- **CLI:** `instar gate {status,set,kill-switch,log}` for operators
- **Persistence:** `server-data/stop-gate.db` (SQLite, WAL, 0600 perms) — per-agent
- **Health:** `/health` now exposes `gateRouteVersion: 1`

**Security hardening:** `/internal/*` now enforces bearer auth on all paths (was previously bypassed on localhost — caught in second-pass review and hardened in the same PR).

**Per-session continue ceiling:** After a session issues 2 continue-pings within its lifetime, the 3rd is `force_allow`ed automatically + the session is marked stuck — prevents infinite nudge loops even with a buggy authority.

**Identity text hardening:** Fresh agents and existing agents on update get an explicit "context death is not real — if your window allows another turn, take it" marker block appended to `CLAUDE.md` and `AGENT.md`. Operators can pin the marker to a custom string via `.instar/identity-pins.json`.

**Compaction recovery test:** A new e2e harness (`tests/e2e/compaction-harness.ts`) spawns isolated Claude Code subprocesses with simulated compaction to verify the recovery hook re-injects identity correctly. A regression guard asserts the recovery output never contains "fresh session" or "start over" phrasings.

## What to Tell Your User

Your agent has new protection against a subtle failure mode where Claude 4.7 models sometimes rationalize an unjustified stop mid-task (citing "context death" or "fresh session needed") when there's plenty of context left to finish. The protection is currently in observe-only mode — it's watching real Stop events and logging decisions to build confidence before any enforcement flips on. I can show you the evaluation log any time you want to see what it's learning.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shadow-mode gate observing Stop events | automatic on update; operator flips via gate CLI |
| Operator mode flip (off/shadow/enforce) | instar gate set unjustified-stop --mode MODE |
| Evaluation log + annotations | instar gate log |
| Emergency kill-switch | instar gate kill-switch --engage |
| Health-reported gate version | GET /health returns gateRouteVersion=1 |

## Evidence

The spec (docs/specs/context-death-pitfall-prevention.md) was converged across 5 GPT/Gemini/Grok review rounds before implementation began. During Phase 5 second-pass review of PR3, an independent reviewer subagent identified a critical finding: /internal/* routes bypassed bearer auth when the request originated from localhost. This was hardened in-PR (see src/server/middleware.ts in commit 42cb9ee) — bearer token is now required on every /internal/* path regardless of origin; X-Forwarded-For headers are also rejected to prevent header-spoofing from a trusted proxy.

Reproduction of the auth-bypass issue pre-hardening:
- Before: curl against /internal/stop-gate/hot-path from localhost returned 200 with gate state regardless of auth header.
- After: same request without a bearer token returns 401 Unauthorized; requests with forged X-Forwarded-For headers are also rejected.

The positive side of the gate (actually blocking an unjustified stop in enforce mode) is **not reproducible in dev** — it requires a real Claude 4.7 session emitting an unjustified stop decision against a live authority. This is exactly why the spec hard-gates the enforce flip on ≥14d of shadow telemetry + ≥20 operator annotations from ≥2 distinct reviewers. Shadow-mode observation over the coming weeks will produce the real-world evidence needed before any enforcement is enabled.

Unit + integration + e2e test coverage: 128+ tests across PR0a–PR4 covering gate routes, DB persistence, sentinel intent classification, guardian-pulse degradation consumption, identity text migration, compaction recovery, and the operator CLI. All green on PR #56 CI (run 24601956119).

## Deployment Notes

- No operator action required on update. The gate is off by default.
- To activate shadow on your agent after update: instar gate set unjustified-stop --mode shadow.
- The enforce flip (--mode enforce) is available via CLI but is not recommended until the spec's data gate (≥14d shadow + ≥20 annotations from ≥2 operators) is met. A threshold-enforcement guard for the CLI itself is tracked as a follow-up.
- Kill switch: instar gate kill-switch --engage disables all evaluation immediately regardless of mode.

## Rollback

Downgrading to the previous version removes the gate routes and CLI. Existing stop-gate.db files become orphaned but harmless (≤ few KB, can be deleted manually). No other state is touched.
