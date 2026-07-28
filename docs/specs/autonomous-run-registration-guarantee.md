---
title: "Autonomous-Run Registration Guarantee (GAP-B)"
slug: "autonomous-run-registration-guarantee"
author: "echo"
eli16-overview: "autonomous-run-registration-guarantee.eli16.md"
status: draft
parent-principle: "An Autonomous Run Must Outlive Its Session"
review-convergence: "2026-06-15T23:25:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-15T23:25:00.000Z"
review-report: "docs/specs/reports/autonomous-run-registration-guarantee-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "worktree-build-env-split (no cross-model harness assemblable in-context; matches P1/P2/P4 this run)"
single-run-completable: true
approved: true
---
# Spec: Autonomous-Run Registration Guarantee (GAP-B)

Status: CONVERGED (R1 review resolved all blockers; grounded vs canonical main `ace7bee4c` / v1.3.582, 2026-06-15)
Author: Echo (autonomous run, Justin full-preapproval 2026-06-15)
Tracks: P1 GAP-B (the "autonomous run must outlive its session" family; GAP-C standard already shipped, GAP-D shipped #1174 `7ef757d8`)
Review: R1 = foundation-audit (9/9 grounding claims accurate) + decision-completeness (1 BLOCKER B1, 6 MATERIAL, all resolved below).

## Problem

An autonomous run can die invisibly. Last night's death: the session was never a *registered*
autonomous run (no per-topic state file), so it was reaped as a plain idle-timeout — ineligible for
the revival machinery #1157 already ships. Revive-by-default works **only for registered runs**;
registration itself has no structural guarantee and the on-disk convention is fragmented across THREE
paths that disagree.

## Grounding (file:line, current main — all R1-verified accurate)

**Already shipped — do NOT rebuild:**
- `src/commands/server.ts:7220-7226` — on `age-limit` reap, if `autonomousRunRemainingForTopic(stateDir, topicId)` non-null → retag `AGE_LIMIT_ACTIVE_RUN_REASON` + inject `build-or-autonomous-active` evidence → enqueue.
- `src/commands/server.ts:13539-13546` — `buildOrAutonomousActive(topicId)` checks `.instar/autonomous/<topicId>.local.md` exists AND mtime < 30min.
- `src/monitoring/ResumeQueueDrainer.ts:560-566` — drainer re-verifies liveness before spawning (the authority gate; a guard-written stub can NEVER auto-spawn without passing this).
- `src/core/AutonomousSessions.ts:106` — `autonomousRunRemainingForTopic`; `:86-88` — `listAutonomousJobs` reads the legacy `.instar/autonomous-state.local.md` (LIVE consumer — cannot retire).
- `docs/STANDARDS-REGISTRY.md:124-127` — GAP-C constitutional standard "An Autonomous Run Must Outlive Its Session" ALREADY EXISTS and names the host-lock + guard-posture structural guards. **This spec CITES it; does not duplicate.**
- `src/monitoring/ResumeQueue.ts:502-508` + `server.ts:6922` — guardStatus registered unconditionally (#1174).

**The genuine gaps:**
1. **Registration is skippable.** `setup-autonomous.sh:164-169` structurally writes the per-topic file
   — but only if the skill setup runs. Operator says "go autonomous" + agent just works → no file → invisible death. No server `/autonomous/start|register` route exists (R1-confirmed absent).
2. **THREE divergent paths:** `.instar/autonomous/<topicId>.local.md` (per-topic; reaper/revival canonical) · `.instar/autonomous-state.local.md` (legacy single-file; setup ELSE-branch :168; live consumer = `AutonomousSessions.ts:86-88`) · `.claude/autonomous-state.local.md` (what `stopGate.ts:344-345` reads). A per-topic registration is **invisible to stopGate** — confirmed real bug.
3. **Topic is NOT in the stop-hook payload (R1 B1).** The bash stop hook (`autonomous-stop-hook.sh:102-157`) resolves topic by INVERTING `topicToSession` in `.instar/topic-session-registry.json` keyed on its own tmux session name. Server-side `getHotPathState` (`routes.ts:2562,2658`) is called with `{sessionId}` only; `HotPathInputs` (`stopGate.ts:324-331`) has no topicId. So any per-topic read on the server path needs sessionId→topic plumbing first.

## Design decisions (R1-resolved)

**D1 — Canonical path + read precedence.** `.instar/autonomous/<topicId>.local.md` is THE authoritative
per-topic registration (write target). Reads use a fixed precedence: per-topic → `.instar/autonomous-state.local.md` → `.claude/autonomous-state.local.md` (legacy fallbacks, never the topic write target). The legacy ELSE-branch consumer stays (back-compat).

**D2 — stopGate per-topic read + topic plumbing (resolves B1).** Plumb sessionId→topic into
`HotPathInputs` using the SAME `topic-session-registry.json` inversion the bash hook already uses
(`routes.ts` resolves it at the `getHotPathState` callsite from the registry, or the hook passes its
already-resolved topic as an explicit body field — implementer picks the lower-risk one; the hook
already HAS the topic). `readAutonomousActive(topicId?)` then reads the D1 precedence chain.
  - **Unresolved-topic fallback (no-silent-fallback ratchet):** if sessionId inverts to NO topic, read
    BOTH legacy single-file paths; NEVER silently return `autonomousActive:false` on a mere lookup miss
    (that would be a silent fallback — lint-banned). The miss is itself recorded.

**D3 — Registration guarantee = TWO structural layers (resolves M2/M3).**
  - **Primary (already structural):** `setup-autonomous.sh` is the sanctioned sole entry; it already
    writes the per-topic file. The autonomous SKILL.md makes running it non-optional.
  - **Backstop (the new teeth):** the Stop-hook guard. When the gate observes autonomous-flavored work
    in flight (active per-topic run OR strong work-evidence: a fresh open commitment / live build) WITHOUT
    a fresh per-topic registration, it **AUTO-WRITES a minimal TTL-bounded registration stub** AND surfaces
    one deduped attention item ("auto-registered an unregistered autonomous run for topic N"). Auto-write
    is the FIX (a surfaced warning the operator must act on is still willpower — M2); surfacing is the
    complement, not the substitute.
  - **Signal-vs-Authority discipline:** the stub only RECORDS a demonstrably-true fact (work is in flight);
    it carries `provenance: auto-registered-by-guard`; it is mtime-TTL-bounded so a false positive
    self-expires at the existing 30-min window (`server.ts:13541`); it NEVER auto-revives/spawns — the
    drainer's liveness re-verify (`ResumeQueueDrainer.ts:560-566`) remains the only spawn authority.
  - **Two-writer safety (m9):** the stub write is create-if-absent / mtime-refresh-only; it NEVER clobbers
    a richer setup-autonomous.sh-written file with a thinner stub (single-writer-CAS house pattern).

**D4 — Maturation (resolves M6).** D2 + D1 ship LIVE (deterministic bug fixes, safe direction). D3's
auto-write registers in `DEV_GATED_FEATURES` → resolves **ENABLED on developmentAgents (dogfood on Echo)
/ dark on fleet**, dryRun-first. NOT default-false-everywhere (that both fails to fix the incident AND
violates the dev-agent-dogfood standard, STANDARDS-REGISTRY:371-375; "soaking IS dogfooding-on-dev").

## Scope — TWO PRs (resolves M4)
- **PR1 (deterministic, unblocked):** D1 read-precedence + D2 stopGate per-topic read with the
  sessionId→topic plumbing and the explicit unresolved-topic fallback. Tightly coupled (D2 needs D1).
- **PR2 (the guard, dev-gated):** D3 auto-write stub + surface + work-evidence classifier, built on PR1's
  correct read path. Carries the authority question + dark-gate policy; its own convergence sign-off.
- OUT: rebuilding #1157 revival; duplicating the GAP-C standard.

## Migration parity (resolves M5 — load-bearing)
- `setup-autonomous.sh` / `autonomous-stop-hook.sh` / `SKILL.md` are agent-installed via
  `PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed()` (`:2451-2555`, `upgrade(relPath, marker,
  fingerprint, label)` — re-copies only if the deployed file lacks the current MARKER and still matches
  the stock FINGERPRINT). **Any change to these files is INVISIBLE to existing agents unless the PR BUMPS
  the marker** (`REALCHECK_VERIFY` → a new sentinel e.g. `REGISTRATION_GUARD`) AND embeds that sentinel in
  each changed bundled file. Verify the stock fingerprint still matches. Add a migration test: an agent at
  the prior marker receives the new file; a customized (non-stock-fingerprint) script is left untouched.
- stopGate/routes are server code (no migration). New config under `autonomousSessions.registrationGuard`
  → ConfigDefaults + `DEV_GATED_FEATURES` (omit `enabled` per the dev-gate convention).

## Tests (3-tier, both sides of every boundary — resolves m8)
- Unit: D1 precedence (per-topic wins; legacy fallbacks in order; topic-less still works). D2 topic
  resolution: sessionId→topic hit reads per-topic; **MISS falls back to legacy, asserts NOT silently
  false**. D3 classifier: registered=quiet; unregistered+evidence=auto-write+surface; unregistered+no-evidence=quiet. Auto-write idempotency: fires twice → one stub, mtime refreshed, not duplicated; never clobbers a richer file.
- Integration: stop-gate HTTP path returns correct `autonomousActive` for each path variant + the
  unresolved-topic case.
- E2E (the incident, end-to-end): **unregistered autonomous work → guard auto-registers → survives an
  age-limit reap** (extends resume-idle-autonomous-lifecycle). "Surfaced-but-still-dies" is NOT a passing
  E2E for a guarantee.

## Resolved open questions (R1 — answered by reading code, none left open)
- Topic in stop-hook payload? **No** — resolved via topic-session-registry.json inversion (D2/B1).
- Legacy `.instar/autonomous-state.local.md` live consumer? **Yes** (`AutonomousSessions.ts:86-88`) — keep as fallback.
- GAP-C standard exists? **Yes** (`STANDARDS-REGISTRY.md:124-127`) — cite, don't duplicate.
- D3 fork (surface-only vs auto-write)? **Auto-write-as-default is the fix** (M2); surface is the complement.
