<!-- bump: minor -->

## What Changed

Adds a per-branch **PR-push lease** so two of the agent's OWN concurrent sessions can't push competing commits to the same branch — the root of the 2026-06-15 PR #1183 "merge thrash" (two sessions force-pushing over each other, each restarting CI, turning a minutes-long merge into ~2 hours).

A new PreToolUse Bash hook (`pr-hand-lease-guard.js`) runs before any `git push`. It asks the server (`POST /pr-leases/evaluate`) whether another LIVE session of this agent already holds that branch's lease; if so the second session stands down instead of pushing. The decision logic lives in `src/core/PrHandLease.ts` (a per-branch lease store):

- **Ownership is keyed on the conversation TOPIC**, not the session id — so a session that respawns mid-work (compaction, refresh, revival) still recognizes its own lease and never deadlocks against itself.
- One process-wide lock + atomic compare-and-swap takeover (no double-drive), TTL + dead-holder auto-heal, and a 90-minute absolute ceiling so it can never wedge a branch. A live same-machine holder past the ceiling is escalated to the operator, not seized (a long rebuild is legitimate).
- **Fail-open on every uncertainty** — corrupt state, server unreachable, the hook itself crashing, no resolvable branch — all allow the push. A broken guard never blocks real work.
- Coordinates the agent's OWN cooperating sessions only. It is never authority over another person or agent, and a human action always wins.

Ships **dark + dryRun-first**, dev-gated (`monitoring.prHandLease`, developmentAgent-only). In dryRun the full decision loop runs and audits every would-deny to `logs/pr-lease-decisions.jsonl`, but NO push is ever blocked until a deliberate `dryRun:false`. Single-session agents are a strict no-op. v1 is machine-local (cross-machine coordination is a tracked follow-up).

## What to Tell Your User

- "Nothing changes for you right now — this is internal dev-cycle infrastructure, off by default everywhere and in dry-run (observe-only) even on the development agent."
- "Once enabled, if two of my own sessions ever try to push to the same branch at once, one quietly waits instead of starting a tug-of-war — so PRs stop getting thrashed by my own parallel work. You'd only notice it as *fewer* stuck merges."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-branch push lease (anti-thrash) | Automatic once enabled — a PreToolUse hook gates `git push`; dark + dryRun by default (`monitoring.prHandLease`) |
| "Who owns this branch's lease?" | `GET /pr-leases` (Bearer-auth) → per-branch holder topic + derived liveness |
| Decision audit | `logs/pr-lease-decisions.jsonl` (every acquire / renew / yield / auto-heal / release) |

## Evidence

- **Unit** (`tests/unit/pr-hand-lease.test.ts`, 20 passing): `canonicalPushKey` over every refspec variant (explicit / `HEAD:` / `cd &&` / env-prefix / `--delete` / tag); respawn-survival (same-topic, new session → own-topic allow); live-foreign deny; dead→stale; foreign-machine-never-falsely-dead; live-holder-past-ceiling escalate; two-healers CAS race (exactly one wins, loser yields); dryRun ignored; corrupt-state → fail-open + recurrence-attention; tombstone passthrough; derived liveness.
- **Integration** (`tests/integration/pr-lease-route.test.ts`, 8 passing): `POST /pr-leases/evaluate` over the real HTTP pipeline — feature-disabled / bad-request / no-key fail-open; own-topic acquire; live-foreign DENY at `dryRun:false`; the SAME lease only WOULD-deny under default dryRun (never blocks); `GET /pr-leases` 503-when-disabled + derived-liveness list with `holderSessionId` redacted.
- **Ratchets green**: devGatedFeatures-wiring (88), migration-parity-hooks (5), feature-delivery-completeness (101), pretooluse-parity (3), no-bare-require-in-generated-hooks (24). Generated hook `node --check` = SYNTAX OK.
- **Whole-project `npx tsc --noEmit`**: exit 0, 0 errors.
- Spec converged through 4 review rounds (6 internal reviewers + 4 codex/gpt-5.5 external passes + the conformance gate); Phase-5 second-pass: CONCUR.
