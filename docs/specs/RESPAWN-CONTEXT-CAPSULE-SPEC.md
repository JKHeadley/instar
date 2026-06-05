---
title: Respawn Context Capsule — a killed working session resumes its task, not just its conversation
status: draft
review-convergence: pending
approved: false
owner: echo
builder: codey (his #60 proposal, generalized; echo oversees)
date: 2026-06-05
eli16-overview: RESPAWN-CONTEXT-CAPSULE-SPEC.eli16.md
fixtures:
  - "2026-06-04 respawn-cascade: server restart killed Codey's build session mid-PR; the respawn re-derived its checkout WRONG (wrong repo version, stale deps, gate-sha mismatch) → 6-friction ~50min recovery slog (memory: cycle_server_bounce_respawn_cascade)"
  - "2026-06-05 12:55Z: Codey's server v-bounce killed his session minutes into task #83; mentor (echo) manually re-anchored via a context-rich Telegram message — worked, but required a HUMAN-equivalent in the loop"
  - "2026-06-05 worktree-hooks arc (#829/#830/#832): respawned/manual sessions recreated build checkouts with no hooks and wrong bases — the 'build checkout' half of the same gap, now structurally fixed; this spec covers the WORK-STATE half"
---

# Respawn Context Capsule

## Problem

When infrastructure kills a working session (server update restart, reap, crash, host pressure), the respawn path restores the CONVERSATION (CONTINUATION summary + recent messages) but not the WORK STATE. The session knew: which task it was on, which worktree/branch it was building in, how far through the gate it was, and what the next concrete action was. The respawn re-derives all of that ad hoc — sometimes wrongly (fixture 1), sometimes only because a mentor hand-fed it (fixture 2). The conversation-level CONTINUATION is necessary but not sufficient: it summarizes what was SAID, not where the WORK stood.

This is the apprenticeship program's #1 hardening item ("a respawned dev session must deterministically re-establish its fleet-PR build checkout"), generalized per Codey's #60 proposal to any working session.

## Fix shape (capsule = small, durable, structured work-state)

A per-session **work capsule**: one JSON file under the agent's state dir, written at cheap checkpoints by the WORKING session, read by the RESPAWN path and injected alongside CONTINUATION.

### Capsule contents (closed set, no free text beyond `nextAction`)

```json
{
  "version": 1,
  "sessionName": "instar-codey-chat-with-codey",
  "updatedAt": "2026-06-05T13:05:22Z",
  "task": { "id": "#83", "title": "Gemini final-output relay fix" },
  "checkout": {
    "worktreePath": ".worktrees/gemini-relay-fix",
    "branch": "codey/gemini-relay-fix",
    "baseRef": "JKHeadley/main",
    "baseSha": "b5f5905ef",
    "hooksVerified": true
  },
  "gate": { "tier": 1, "trace": null, "artifactsStaged": [] },
  "nextAction": "reproduce: drive a gemini session to completion, capture what the relay extracts vs the pane tail",
  "openedPr": null
}
```

Hard rules: **no secrets, no message content, no LLM-authored prose** except the single `nextAction` line; byte-capped (4KB); atomic write (tmp+rename).

### Writers

1. **Explicit**: a tiny CLI/HTTP call (`instar capsule set …` / `POST /sessions/:name/capsule`) the session invokes at natural checkpoints — worktree created, gate passed, PR opened. The instar-dev gate's pre-commit hook MAY append the gate fields automatically (it already knows tier/trace/artifacts at evaluation time — zero new session effort).
2. **Structural floor**: `instar worktree create` writes the `checkout` block itself on success (it knows every field). A session that never explicitly checkpoints still gets the highest-value block for free (fixture-1's whole cascade was checkout re-derivation).

### Reader / injection

The respawn path (bridge CONTINUATION spawn AND watchdog/sentinel recovery respawns) reads the capsule for the session being replaced and injects a bounded block into the spawn prompt:

> RESUMING WORK (capsule, written 13:05Z): task #83 — Gemini final-output relay fix. Checkout: .worktrees/gemini-relay-fix @ codey/gemini-relay-fix (base JKHeadley/main b5f5905ef, hooks verified). Gate: Tier-1, no trace yet. Next action: reproduce — drive a gemini session to completion, capture what the relay extracts vs the pane tail.

Staleness: capsules older than `capsule.maxAgeHours` (default 24h) are surfaced as "POSSIBLY STALE" rather than dropped — the session decides. A capsule for a COMPLETED task (openedPr merged) is retired by the writer at PR-merge checkpoint or ignored by age.

### Lifecycle / ownership

- One capsule per session NAME (the respawn inherits the name → trivially finds it).
- Killed-and-respawned: capsule survives (it's state-dir, not session-dir).
- Deliberate completion: the session clears its capsule at task close (explicit call; the Stop-hook integration is a follow-up, not this slice).
- The capsule is a HINT, never authority: a respawn that finds reality diverging from the capsule (worktree gone, branch merged) reports the divergence and proceeds from ground truth — Distrust Temporary Success applies to the capsule itself.

## Non-goals (this slice)

- NOT a transcript/conversation store (CONTINUATION already exists).
- NOT crash-instant state (checkpoint granularity is "natural milestones", not every tool call).
- NOT cross-machine sync (per-machine state dir; the multi-machine pool already moves sessions with their own mechanism).
- NOT automatic Stop-hook capture (follow-up once the manual+structural writers prove value).

## Components & tests (Tier-2, three tiers per the Testing Integrity Standard)

1. `src/core/WorkCapsuleStore.ts` — load/save/clear, atomic, byte-cap, staleness; unit tests both sides of every boundary (valid/oversized/corrupt/stale/missing).
2. Worktree-create writer (InstarWorktreeManager) — integration test: create → capsule has checkout block.
3. Gate writer (instar-dev pre-commit append of gate fields) — sandbox-repo test mirroring the audit-staging harness.
4. Respawn injector (the bridge spawn path + SessionRecoveryChannel) — integration: kill+respawn with capsule present → spawn prompt contains the RESUMING WORK block; e2e: the production spawn path mirrors server.ts wiring (feature-alive test).
5. Routes `GET/POST/DELETE /sessions/:name/capsule` — integration; 503-when-disabled e2e.
6. Ships behind `sessions.workCapsule` (developmentAgent pattern: live on echo+codey, dark fleet) with migrateConfig parity.

## Open questions for convergence

1. Should the gate hook write the capsule UNCONDITIONALLY (every gated commit) or only when a capsule already exists (session opted in)? (Lean: only-if-exists — keeps the gate's job narrow.)
2. Codex/gemini parity: codex sessions have no Claude hooks — the explicit CLI writer covers them, but should the codex loop-driver checkpoint automatically? (Lean: yes, one call at its turn boundary — cheap.)
3. Capsule for NON-dev sessions (pure conversation): skip entirely (no task ⇒ no capsule) — confirm.
