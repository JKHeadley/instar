---
title: Respawn Context Capsule — a killed working session resumes its task, not just its conversation
status: converged
review-convergence: 2026-06-05 (Codey adversarial review, PR #833 comment 4632349115 — all 3 open questions resolved, verify-before-action made mandatory; Echo concurred and applied the edit)
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

### Verify-before-action (MANDATORY reader requirement — convergence edit, Codey review)

A stale/wrong capsule's risk is not data loss; it is **false confidence** — a high-quality hallucination seed that walks the respawn into the wrong worktree or a merged branch. Hint-not-authority is therefore ENFORCED at the reader, not left to prose:

1. **Injected language carries the verification order**: the RESUMING WORK block MUST instruct the respawn to verify the checkout (worktree exists, branch matches, base reachable, hooks active) BEFORE any edit, commit, push, or PR action. Stale capsules (past `maxAgeHours`) are injected with lower-authority language — "possible prior work-state found; verify before continuing" — never "resume this task".
2. **Path canonicalization + allowlist**: `checkout.worktreePath` is canonicalized (symlinks resolved) and MUST fall inside the agent's worktree convention area (`~/.instar/agents/<agent>/.worktrees/`). A path outside the allowlist, or one whose canonical form diverges from the recorded form, is reported as divergence — never followed.
3. **Claims, not state**: `branch`, `baseRef`, `baseSha`, and `hooksVerified` are claims to verify against live git, not state to trust. If `openedPr` is merged/closed, or the branch no longer points near `baseSha`, the respawn reports the divergence and proceeds from ground truth.
4. **Divergence is reported, loudly**: any failed verification is surfaced in the session's first output (and the capsule retired/flagged), so a wrong capsule can never silently steer work. Distrust Temporary Success applies to the capsule itself.

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

## Resolved convergence questions (Codey review, 2026-06-05 — PR #833 comment 4632349115)

1. **Gate-hook write policy: only-if-exists.** The gate updates an existing capsule's gate fields; it never CREATES one. Creation belongs to explicit session intent or the structural worktree writer — unconditional creation would make ordinary maintenance commits look like resumable tasks the session never opted into.
2. **Codex/Gemini loop-driver checkpointing: yes, narrow.** At its turn boundary the loop-driver refreshes existing capsule metadata only (`updatedAt`, session identity, verified cwd/worktree). It never synthesizes a task or `nextAction` from conversation text — the session owns `nextAction` via explicit writer calls.
3. **Non-dev / pure-conversation sessions: skip entirely.** No task ⇒ no capsule; the absence of a capsule is itself the correct signal there (conversational sessions are where a stale capsule would mislead most).

Builder/overseer sizing confirmed in review: Codey builds (store, worktree writer, loop-driver checkpoint, injector, tests — the live failures happened in his operating loop); Echo owns convergence + the acceptance bar (adversarial stale-capsule cases). Automatic Stop-hook capture stays OUT of this slice.

Pinned live fixture (from the #834 relay cycle): ledger cycle `8ee9b174-cde7-4194-bc2e-b5069574d798` (codey-to-gemini, cycle 3, telegram-playwright, 2026-06-05T12:33:08Z) — Codey's 12:55Z restart recovery succeeded only after a manual context re-injection; the capsule makes that handoff structural.
