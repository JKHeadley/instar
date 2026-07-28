# Convergence Report: Autonomous-Run Registration Guarantee (GAP-B)

Spec: `docs/specs/autonomous-run-registration-guarantee.md`
Grounded vs: canonical main `ace7bee4c` / v1.3.582
Date: 2026-06-15 · Author: Echo (autonomous run, Justin full-preapproval)

## Process
- **R1 — two parallel reviewers** off a fresh worktree on current main:
  - Foundation/grounding audit (Explore): verified all 9 grounding file:line claims ACCURATE; resolved the 3 open questions against source.
  - Decision-completeness + lessons-aware (Plan): 1 BLOCKER, 6 MATERIAL, 2 MINOR, mapped against instar standards (Structure>Willpower, Migration Parity, dev-agent-dogfood, no-silent-fallbacks, follow-up-laundering).
- Cross-model: UNAVAILABLE-in-context (codex/gemini harness unassemblable without full worktree install; no activation history). Recorded honestly — matches P1/P2/P4 in this run.

## Findings → resolutions
| ID | Sev | Finding | Resolution in spec |
|----|-----|---------|--------------------|
| B1 | BLOCKER | D2 "topic from stop-hook payload" is factually wrong — topic absent from payload; server gate has no topicId | D2 rewritten: plumb sessionId→topic via `topic-session-registry.json` inversion (the mechanism the bash hook already uses) + explicit unresolved-topic fallback that never silently returns `autonomousActive:false` |
| M2 | MATERIAL | Surface-loud-only does NOT fix the incident — the run still has no file, still dies | D3: auto-write a TTL-bounded, provenance-stamped registration stub IS the default fix; surface is the complement. Stub records a true fact (work in flight), self-expires at 30min, never auto-spawns (drainer re-verify is the only spawn authority) |
| M3 | MATERIAL | Stop-hook is detect-after-the-fact, not Structure>Willpower | D3 framed as two layers: setup-autonomous.sh sole-entry (primary, already structural) + Stop-hook auto-write backstop (teeth) |
| M4 | MATERIAL | One change does too much | Split: PR1 = D1 precedence + D2 stopGate read (deterministic) · PR2 = D3 guard (dev-gated, own sign-off) |
| M5 | MATERIAL | Migration section hand-wavy | Concrete: bump `migrateAutonomousStopHookTopicKeyed` marker `REALCHECK_VERIFY`→new sentinel, embed in changed bundled files, + migration test |
| M6 | MATERIAL | Dark-default violates dev-agent-dogfood standard | D3 ships via `DEV_GATED_FEATURES` (ENABLED on dev / dark fleet), dryRun-first — not default-false-everywhere |
| M7 | MATERIAL | Open questions laundered to "convergence will decide" | All 3 resolved by reading code, recorded in spec |
| m8 | MINOR | Missing test boundaries | Added: topic-unresolvable, auto-write idempotency+TTL, migration-marker, incident E2E |
| m9 | MINOR | Two writers of the per-topic file | Stub is create-if-absent / mtime-refresh-only; never clobbers a richer file |

## Verdict
**CONVERGED.** Blocker B1 + all 6 materials resolved in the revised spec. Single-run-completable per PR.
Build order: **PR1 first** (deterministic D1+D2, unblocked, ships live), then **PR2** (D3 guard, dev-gated).

## Build handoff (exact wiring, current main)
- `src/server/stopGate.ts` — `readAutonomousActive(topicId?)` D1 precedence; `HotPathInputs` (`:324-331`) gains topic.
- `src/server/routes.ts` — `getHotPathState` callsites `:2562,:2658` resolve sessionId→topic from `topic-session-registry.json`.
- `src/core/AutonomousSessions.ts:106` — `autonomousRunRemainingForTopic` (read path; do not change behavior).
- `src/core/PostUpdateMigrator.ts:2451-2555` — marker bump for migration parity (PR with any skill-script change).
- PR2 only: `src/core/devGatedFeatures.ts` (+ConfigDefaults) for `autonomousSessions.registrationGuard`; the Stop-hook gate auto-write + attention surface; work-evidence classifier consuming `CommitmentTracker.getActive()`.
