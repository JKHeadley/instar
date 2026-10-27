---
# user_announcement — SILENT BY DEFAULT (mature-update-announcements spec).
user_announcement:
  - audience: agent-only
    maturity: stable
    headline: "A lifeline catch-up restart no longer kills a running local verify"
    body: "HUMAN-REQUIRED: one or two plain sentences for the user, matching the maturity above"
---

## What Changed

**Local verify survives lifeline restarts; interrupted runs are counted and go first** (spec: `docs/specs/local-verify-survives-restart.md`; incident: `docs/issues/local-verify-killed-by-update-restart.md`).

- A lifeline-only restart no longer stops the server: drift auto-promote (the lifeline 20+ patches behind the server), a version-skew (426) handshake, and the coordinated planned-upgrade signal all keep the server (`restartKeepsServer(bucket)`; `RestartRequest.keepServer` overrides). Quiesce settles its synchronous teardown first and calls `ServerSupervisor.detach()` instead of `stop()`; a competing stop request (watchdog, external signal) arriving in that window still stops the server before exit. The next lifeline adopts the running server, also when it is alive but not answering yet; only a gone session is respawned. Watchdog and operator restarts are unchanged.
- A local-verify run killed by a server stop (clean or unclean) keeps its attempt, gets a persisted `interruptions` count and a `resumeFirst` mark, and is audited `interrupted`.
- The starved signal also fires after 2 interruptions of the same head (`reason: interrupted`) — at boot for a restored entry, and over the in-flight entry — and it is now wired: `local-verify:starved:<pr>` becomes an attention item ("PR #N cannot finish its check"), upserted so a later episode of the same PR reopens it. Before, `onStarved` was never connected and the signal only reached the audit log.
- After a restart an interrupted PR starts ahead of the boot-time `main` verify, unless `main` is known red; the mark clears when it starts.

## What to Tell Your User

If you use the local test line for merges: a check that is running is no longer killed when my Telegram helper restarts itself to catch up on versions (the server keeps running and the new helper picks it back up). If a check does get killed (for example by a manual restart), it now counts, it goes first once I am back, and if it is killed twice I raise an attention item saying which PR is stuck instead of staying silent.

## Summary of New Capabilities

- `GET /local-verify` queue entries carry `interruptions` and `resumeFirst` when a server stop killed their run.
- New attention item `local-verify:starved:<pr>` when a PR's check waits 3+ hours or is killed by restarts twice.

## Evidence

- Observed (2026-10-26, Mac Studio): `.instar/logs/local-verify.jsonl` 06:23:53Z `cancel pr 2350 … reason shutdown` 23 minutes into the run; the lifeline log at the same second: `[Lifeline][DriftPromoter] firing self-restart: diff=20, reason=drift-auto-promote`; `auto-updater.json` `pendingUpdate: null` (not an update restart). The two update restarts that night (04:44Z, 05:37Z) had waited for the running verify. PR 2350 showed `attempts: 0` after four hours in first place.
- Tests: unit (`LocalVerifyService.test.ts` interrupted-runs suite, `mainHealth.test.ts`, `RestartOrchestrator.test.ts`, `drift-restart-keeps-server.test.ts`), integration (`local-verify-routes.test.ts`: `GET /local-verify` across a simulated restart shows the entry counted, interrupted and started ahead of `main`), e2e (`local-verify-lifecycle.test.ts`: the production-built service sends the starved signal to `hooks.signal`).
