# Side-Effects Review — Threadline Warm-Session A2A Integration

**Version / slug:** `threadline-warm-session-a2a`
**Date:** `2026-06-04`
**Author:** `Echo (instar dev agent)`
**Second-pass reviewer:** `not required (Tier 1 — additive + dark-gated)`

## Summary of the change

Phase 2 of A2A continuity: keep a verified peer's reply session **alive** between
messages and **inject** follow-ups, instead of cold-spawning each time. The first
message spawns a persistent **interactive** session (not throwaway `-p`), registered
in a new `WarmSessionPool` keyed by threadId; subsequent messages inject into the
live session (no spawn, no 30s cooldown); a reap tick evicts on TTL/pressure; on
eviction the next message falls back losslessly to the shipped `--resume` path
(#746). Three correctness/security fixes ride along: `claude.exe` added to the
inject allowlist (live macOS Claude panes report `claude.exe`, so live-inject was
dead-on-arrival); grounding-on-inject (wrap injected body in the untrusted-data
preamble); per-thread isolation + `WarmSessionPeerConflictError` guard.

Dark-shipped behind `threadline.warmSessionA2A.enabled ?? !!config.developmentAgent`.
Files: `src/messaging/types.ts`, `src/threadline/WarmSessionPool.ts`,
`src/threadline/ThreadlineRouter.ts`, `src/commands/server.ts`,
`src/config/ConfigDefaults.ts`, `src/core/types.ts`,
`src/messaging/SpawnRequestManager.ts`, `src/core/SessionManager.ts`,
`src/core/frameworkSessionLaunch.ts` + unit/integration/e2e tests.

## Decision-point inventory

- `ALLOWED_INJECTION_PROCESSES` (`src/messaging/types.ts`) — **modify (additive)** — add `claude.exe`. Widens which live panes accept an injected message; only matters for the A2A inject path (Telegram uses a different non-allowlisted path).
- `WarmSessionPool.admit` (`src/threadline/WarmSessionPool.ts`) — **new** — throws `WarmSessionPeerConflictError` if a different peer owns the thread; caps/TTL/LRU eviction.
- `ThreadlineRouter.tryInjectIntoLiveSession` (`src/threadline/ThreadlineRouter.ts`) — **modify** — wrap injected body in grounding preamble; `pool.touch` on success.
- `ThreadlineRouter.handleInboundMessage` new-spawn path — **modify (gated)** — when `preferWarmSession`, request an interactive keep-alive spawn + `pool.admit`; pre-spawn `peek` conflict → cold-spawn fallback.
- `server.ts` relay decision + `spawnSession` callback + reap tick — **modify (gated)** — resolve `warmEnabled`, construct pool (null when off), branch the spawn callback on `opts.interactive`, periodic `reapExpired` + `killWarmSessionByName`, `.unref()`, cleared on shutdown.
- `ConfigDefaults` / `ThreadlineConfig` — **new (additive)** — `warmSessionA2A` caps with no `enabled` (resolved via dev-gate).
- `SessionManager.spawnInteractiveSession` + `frameworkSessionLaunch` — **modify (additive)** — new `sessionId?` option → `--session-id` on the interactive claude launch (mutually exclusive with `--resume`).

## 1. Over-block

The new `WarmSessionPeerConflictError` could *withhold* a warm session from a
legitimate same-thread message if peerId were computed inconsistently. Mitigation:
peerId is the same stable sender fingerprint used for the thread's trust/ownership
checks; same-peer refresh is explicitly tested as allowed. On any conflict the
message is **not dropped** — it falls back to a normal cold-spawn. So the worst
"over-block" outcome is "no warm speedup," never "message rejected." The trust
floor (`verified`) gates *warmth*, not *delivery*: a below-floor peer still gets the
unchanged cold-spawn reply.

## 2. Under-block

`claude.exe` widens the inject allowlist — could an unintended process now be
injected into? No: inject is keyed on the pool's own `sessionName` (a session this
agent spawned + admitted), not a free scan of panes; the allowlist is a
defense-in-depth process-name check on top of an already-owned session handle. The
grounding-on-inject wrap closes the prior gap where a peer's raw body reached the
session without untrusted-data framing. Residual: a malicious *verified* peer can
still keep one warm session pinned (bounded by perPeerCap 1 + ttl 600s + globalCap
3) — a resource bound, not a content-leak (per-thread isolation means nothing to
leak across peers).

## 3. Level-of-abstraction fit

`WarmSessionPool` is a pure registry (no I/O); the router owns the
spawn/admit/inject/touch decisions; the server owns process construction + the kill
primitive (`killWarmSessionByName` resolves tmux-name → session-id → kill, because
`killSession` keys by session id). The interactive `sessionId` option lives at the
launch builder, mirroring the existing `--resume` plumbing. Correct layering — the
pool never touches tmux, the router never builds argv.

## 4. Signal vs authority compliance

The trust floor is a **resource** control (who may keep a session warm), not a new
authority/approval surface. No gate is relaxed. Inbound trust gates are untouched.
Trust comparison uses an explicit `TRUST_ORDER` index (never string `>=`, which
would make `'verified' >= 'trusted'` true alphabetically) — guarded by a test.

## 5. Interactions

- Builds on #746: on eviction, `get()` + `jsonlExists(uuid)` resume the thread via
  `--resume` — the e2e test forces an evict and asserts the next message resumes
  (entry intact). `onSessionComplete` demote/persist is unchanged.
- The interactive worker keeps project MCP (does **not** set `disableProjectMcp`),
  matching the `-p` path, so `threadline_send` is available — the warm worker can
  actually reply.
- Re-verified after rebasing onto current main (v1.3.243, which added #747 Telegram
  delivery dedupe + #748 duplicate-response guard): tsc clean; warm unit (105) +
  integration (5) + e2e (1) + esm/empty-catch/no-direct-destructive/no-silent-
  fallbacks gates all green. No-silent-fallbacks net count unchanged (warm
  fail-opens annotated `@silent-fallback-ok`).

## 6. External surfaces

New config block `threadline.warmSessionA2A` (additive; `applyDefaults` deep-merges
nested objects — verified by test, no `PostUpdateMigrator` patch needed). No new
HTTP route. CLAUDE.md/template: warm sessions are internal robustness — no
agent-facing capability surface added. Migration-parity: config is additive +
existence-checked; dark by default on the fleet (developmentAgent gate).

## 7. Rollback cost

Low. Flag-off (or `developmentAgent` false) is byte-for-byte the current cold-spawn
path — proven by flag-off tests. Full revert = the listed source files; no persisted
format change (the pool is in-memory only). `claude.exe` allowlist + grounding-on-
inject are independently safe to keep even if the warm path is reverted.

## Framework generality

Per the **Framework-Agnostic — and Framework-Optimizing** standard, the warm path
must work for EVERY agentic framework (claude-code / codex-cli / gemini-cli /
future), not just Claude. Two parts were initially Claude-leaning and are now
routed through the framework abstraction:

- **Inject allowlist.** `ALLOWED_INJECTION_PROCESSES` was a hardcoded shells +
  `claude`/`claude.exe` list — a non-Claude warm worker's pane process (`codex`,
  `gemini`) would be refused. It is now DERIVED: `shells ∪ FRAMEWORK_INJECTION_
  PROCESS_NAMES` (new `src/core/frameworkInjectionProcesses.ts`), a
  `Record<IntelligenceFramework, …>` so the compiler forces an entry per framework.
- **Warm spawn framework.** The interactive keep-alive spawn now passes
  `framework: _defaultFramework` (the local agent's framework) to
  `spawnInteractiveSession`, so a codex/gemini agent's warm worker launches in its
  own framework with its own MCP/permission flags. The deterministic `sessionId`
  is mapped per-framework by `frameworkSessionLaunch` (claude pins `--session-id`;
  codex/gemini ignore it and resume by their own mechanism) — not a Claude
  assumption, it's the abstraction's job.

**Enforced (structure, not willpower):** (1) compiler exhaustiveness on the two
`Record<IntelligenceFramework, …>` maps; (2) `tests/unit/framework-agnosticism.test.ts`
fails if any framework's injection-process entry is empty, a launch builder is
missing, or the allowlist drifts from `shells ∪ registry`; (3) the `/instar-dev`
precommit gate (`assertFrameworkGenerality`) requires this very section for any
change to the launch/inject abstraction surface.

## Conclusion

Low-risk, additive, dark-gated. Completes the rapid-fire A2A continuity case on top
of the shipped turn-based foundation, with per-thread isolation removing the shared-
listener leak concern entirely. Both sides of every boundary are tested (warm-on
inject vs flag-off cold-spawn; same-peer refresh vs peer-conflict fallback; evict →
resume). Live Echo↔Dawn production round-trip is the orchestrator's standards-met
gate (post-deploy).

## Second-pass review (if required)

Not required — Tier 1 (additive, dark-gated, single subsystem). The subsystem-scale
shape (a new pool + lifecycle wiring) was handled via spec-converge + an ELI16
review surfaced to the operator before merge, per the A4 ceremony.
