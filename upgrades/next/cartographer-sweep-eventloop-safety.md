# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed instar#1069 — the cartographer doc-freshness sweep freezing the server. On a real tree (366,757 nodes; a 67MB `index.json`), enabling the sweep starved the server's event loop for ~35s at a stretch: `/health` stopped answering, and the lifeline supervisor (correctly) kill-looped the server every 10–15 minutes. Convergence review found the freeze was reachable through **six** distinct main-thread whole-tree operations, and this ships the complete close: the "what's stale?" detect now runs in a **worker thread** (the codebase's first) returning only a bounded candidate list + counts; every `/cartographer/*` read route serves a small **per-host snapshot** (with honest `snapshot`/`snapshotStale`/`lastDetectStatus` provenance) instead of recomputing live; the request-path lazy scaffold is gone (a chunked, yielding **boot-path** build replaces it — including a streamed index write, never one 67MB stringify); the under-sized `git ls-tree` buffer that would crash on a big tree got an explicit 64MB + named refusal; and the author path's per-node 67MB index rewrites became two bounded off-thread writes per pass. The worker is bounded in time (`detectTimeoutMs` → terminate + refuse) AND memory (heap cap + pre-parse byte guard, co-sized so the intended tree parses), runs with an env allowlist (no secrets), and every failure path is a named refusal feeding the existing signal-only breaker — never a silent fall-back to the old walk. A new build-time lint (`lint-no-mainthread-cartographer-walk`) plus an event-loop-lag test harness (<250ms over the real dist worker AND the boot scaffold) make the regression structurally hard to reintroduce. Bonus: `cartographer.freshnessSweep.framework` is now actually honored (explicit-set-only precedence, boot-logged) — it was decorative, which helped the bug hide.

Rollback levers: `freshnessSweep.detectInWorker: false` runs the SAME bounded detect synchronously (never the legacy walk); `freshnessSweep.enabled: false` remains the master kill-switch. Migration parity: new config fields backfill via defaults; `.instar/cartographer/` becomes gitignored; the CLAUDE.md template gains the snapshot-semantics section.

## What to Tell Your User

If you turned on the background "keep the code map fresh" job and your agent's server started dying every few minutes — that's fixed. The heavy map-scanning work now runs off to the side where it can't freeze the server, and the map's health numbers are served from a cached snapshot with an honest age stamp ("as of N minutes ago") instead of being recomputed live. Nothing to configure; the fix applies on update. The sweep itself stays off until you choose to enable it.

## Summary of New Capabilities

- `/cartographer/health` + `/cartographer/stale` now carry snapshot provenance: `snapshot` (`present`/`absent`/`detect-failing`), `snapshotStale`, `ageMs`, `headSha`, `lastDetectStatus` — a broken or never-run detect is visible on the route, not silent.
- `/cartographer/stale` serves a bounded sample with an honest `total` + `truncated` flag (secret-bearing path names filtered out).
- `cartographer.freshnessSweep.framework` is the supported off-Claude routing knob (no manual `componentFrameworks` override needed); the boot log shows what resolved and why.
- New event-loop-safety dials (all with safe defaults): `detectInWorker`, `detectTimeoutMs`, `detectWorkerHeapMb`, `maxIndexBytes`, `snapshotSampleMax`, `gitMaxBuffer`, `detectCandidateHeadroom`, `maxRequestNodes`, `scaffoldChunkNodes`.

## Evidence

- Event-loop-lag harness: detect over a 60,000-entry index in the REAL compiled dist worker AND a ~6,000-file boot scaffold both hold max sampled main-thread lag **< 250ms** (`tests/integration/cartographer-eventloop-worker.test.ts`, 5/5).
- Unit: pure detect module 12/12 (bounded heap ordering w/ frozen golden, zero node-file reads, full refusal taxonomy, secret-filtered sample, index-sourced anti-starvation); refusal→breaker 1/1; routing precedence + Claude-floor 8/8; engine suite 16/16 against the rewritten pass.
- Integration: snapshot-backed routes 11/11 (incl. "no lazy scaffold on request" assertions); refresh/navigate routes 21/21.
- E2E: cartographer lifecycle, freshness lifecycle, dev-gate lifecycle all green on the snapshot contract.
- Full unit suite: 31,778+ passed; the 9 initially-failing files all resolved (3 ratchet updates for this change, 1 dev-gate e2e contract update, 1 exec-bit fix, 1 REAL pre-existing test-isolation bug fixed at root in `emptyPromptCanary-llmFallback` (it polluted `~/.instar` with a persisted signature), 2 machine-env repairs, 1 standalone-green tmux-contention flake).
- Side-effects review + REQUIRED second-pass review: `upgrades/side-effects/cartographer-sweep-eventloop-safety.md` — the reviewer raised 2 material concerns (boot scaffold's final 67MB stringify; the missing boot-scaffold lag test), both fixed before commit.
- Spec: `docs/specs/CARTOGRAPHER-SWEEP-EVENTLOOP-SAFETY.md` (converged 5 rounds, zero material findings final round, approved by Justin). Deferred follow-ups tracked: instar#1073.
