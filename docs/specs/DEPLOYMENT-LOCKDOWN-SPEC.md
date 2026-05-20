---
review-convergence: "rev-2 worktree-aligned; supersedes rev-1 with Layer 1 marked shipped (v1.0.8), Layer 3 reframed around agent-home worktree pattern (rebase-onto-main promotion path), and a worktree-pattern alignment summary mapping each memory entry to the layer that honors it"
approved: true
approved-by: "operator (Justin) via Telegram topic 10873"
approved-at: "2026-05-20T08:00:00Z"
---

# Deployment Lockdown — v1.x Standards Spec (rev 2, worktree-aligned)

**Status:** Approved — Layer 1 shipped (v1.0.8); Layer 2 implementing now; Layers 3–7 follow.
**Author:** Echo
**Date:** 2026-05-19
**Companion docs:** Incident case study (5cffded0), ELI16 companion (separate view)
**Goal:** Make accidental deployment of major-version work structurally impossible, **using the worktree development pattern as the carrier for major-feature isolation**.

---

## What changed in rev 2

Rev 1 treated branch isolation (Layer 3) as a workflow-trigger problem: restrict `push` to `main`, exclude `next/v*` branches. That framing is correct but incomplete — it stops the workflow from firing on the wrong ref, but does nothing to keep the wrong code off `main` in the first place.

Rev 2 reframes Layer 3 around our existing **worktree development standard**:

- Major-feature work happens in **agent-home worktrees** at `~/.instar/agents/<self>/.worktrees/<feature>/`, on a `next/v<major>.<minor>.0` branch.
- The shared instar checkout at `/Users/justin/Documents/Projects/instar/` is reserved for `main`-tracking work and patch-tier releases.
- Promotion to `main` is a **rebase**, never a merge — to honor the worktree merge-commit gate bug (`.git` is a file pointer in worktrees, MERGE_HEAD carve-outs fail) and to give us a linear "moment of truth" commit.

This makes the lockdown not a new discipline bolted on top of existing patterns, but a structural enforcement of the worktree pattern we already follow for every other multi-PR initiative.

It also acknowledges what already shipped: **Layer 1 landed as v1.0.8 (PR #265)**. The publish workflow now honors `package.json.version` as version-truth. Rev 2's roadmap drops PR 1 and starts at Layer 2.

---

## Problem (unchanged from rev 1)

The 2026-05-19 deployment misalignment showed that Instar's release infrastructure cannot distinguish between:

1. A routine patch release
2. Work-in-progress on a major version (no holding pattern exists)
3. A deliberate major-version cut (no path to bump major)
4. A session in which the operator has said "no deploy" (no enforcement)

Seven layers, each independently shippable, close the path that made (2) silently behave as (1) for 12+ hours during the v1.0.0 framework-parity work.

---

## Layer 1 — package.json as version-truth ✅ SHIPPED

**Status:** Merged as PR #265, published as **v1.0.8** on 2026-05-19.

The publish workflow at `.github/workflows/publish.yml` now reads `package.json.version` as `LOCAL` and `npm view instar version` as `NPM`, then applies:

| `LOCAL` vs `NPM` | Result |
|---|---|
| `LOCAL > NPM` | publish at `LOCAL` (operator-intended leap — the v1.0.8 path) |
| `LOCAL == NPM` | routine patch bump (unchanged common case) |
| `LOCAL < NPM` | stale; patch-bump from npm (never downgrade) |

Verified by the 9-case fixture at `tests/unit/resolve-publish-version.test.ts`, which includes the exact 2026-05-19 incident as a regression case. v1.0.9–v1.0.13 all shipped through this logic without incident; that's our positive evidence that the layer is live and working.

**What Layer 1 alone does not solve:** the workflow still publishes from every `main` merge that has a non-template NEXT.md. Layer 1 closed the silent-overwrite path; Layers 2–7 close the rest.

---

## Layer 2 — Release-tier config

### What it is
A new file at `.instar/release-tier.json` (committed) declares the active release line:

```json
{
  "tier": "hold",
  "reason": "v1.0.0 work in progress; releases paused",
  "setAt": "2026-05-19T17:00:00Z",
  "setBy": "justin"
}
```

Allowed `tier` values:

- `"patch"` — auto-publish on every NEXT.md-bearing PR (current default, routine maintenance).
- `"minor"` — auto-publish only when `LOCAL.minor > NPM.minor`.
- `"major"` — auto-publish only when `LOCAL.major > NPM.major` **AND** Layer 5 multi-signature is satisfied.
- `"hold"` — auto-publish DISABLED. Any merge to main silently no-ops with a structured log entry **and** a comment on the merged PR.

### How it gates
First step of the publish workflow reads `release-tier.json`. The publish step exits early when the declared tier disagrees with what the current diff would do. The exit is loud: PR comment, structured log, and a mirror to topic 10873 if a deployment-lockdown topic is bound.

### Authority to change tier
A `release-tier.json` change is a versioned commit. Transitions to/from `"major"` require Layer 5 multi-signature. Transitions to/from `"hold"` are single-signature but logged.

### Why it's the highest-leverage layer
This is the layer whose absence allowed the 2026-05-19 incident in the first place. Ship Layer 2 with default `"hold"` and accidental deployment becomes impossible — every future cut requires a deliberate config change.

---

## Layer 3 — Worktree isolation for major work (worktree-aligned)

### Pattern
Major-version work happens in **agent-home worktrees**, not in the shared instar checkout:

```
~/.instar/agents/echo/.worktrees/major-v1.0.0/
  ├─ .git → file pointer
  ├─ package.json          # version: 1.0.0-rc.<n>
  ├─ .instar/release-tier.json   # tier: "hold"
  └─ upgrades/NEXT.md      # hold: true
```

- Branch name: `next/v<major>.<minor>.0` (e.g. `next/v1.0.0`).
- Location: `~/.instar/agents/<self>/.worktrees/<feature>/`, **never inside the shared repo**.
- The shared checkout at `/Users/justin/Documents/Projects/instar/` stays on `main` and is reserved for patch-tier work and merges.

### Why agent-home worktrees specifically
Two memory entries already establish this as our standard:

- `feedback_worktree_default_for_shared_repos` — first action when resuming work in the shared repo is `git worktree add`; never operate on the shared checkout directly.
- `feedback_worktree_in_agent_home` — worktrees must live in `~/.instar/agents/<self>/.worktrees/`, not inside the repo, so the Claude Code sandbox can't EPERM-block them mid-session.

Major-feature work compounds both rationales: it's the longest-running form of multi-PR work we do, so it benefits most from the sandbox-safe location and from physical separation from `main`.

### Why the publish workflow can't fire on it
The publish workflow's `push` trigger is restricted to `branches: [main]`. A `next/v1.0.0` branch never matches. Even an agent that fat-fingered `git push origin HEAD:main` from the worktree would be blocked at the coherence refusal (Layer 6) because `package.json` on the worktree is `1.0.0-rc.<n>` while `main` is on the patch-tier line.

### Promotion path — rebase, not merge
When the major branch is ready to cut:

1. The worktree's branch is **rebased onto `main`**, not merged. This honors the worktree merge-commit gate bug (`feedback_worktree_merge_commit_gate_bug`: `.git` is a file pointer in worktrees, the gate's MERGE_HEAD carve-out fails). It also produces a linear history with no auto-generated merge commit obscuring intent.
2. `release-tier.json` on the rebased branch transitions from `"hold"` → `"major"`. Layer 5 signatures land on the same branch in the same PR.
3. The fast-forward into `main` becomes the deliberate, single, signed promotion commit.
4. After the cut, `release-tier.json` on `main` is moved back to `"patch"` for the next maintenance line.
5. The worktree is left in place (or removed via `git worktree remove`); the major branch can be deleted upstream.

### Inter-session safety (the worktree push-hygiene corollary)
Per `feedback_concurrent_session_push_hygiene`, multiple Echo sessions can have uncommitted work on disk. The major-feature worktree gives each session a physically separate index — so a parallel session's WIP can never accidentally land on the major branch via `npm run test:push`. Same memory entry applies in reverse: when promoting the major branch, stash any other-session WIP **in the shared checkout** by pathspec before the rebase, never `git stash -u` blindly.

---

## Layer 4 — NEXT.md as hold signal

### Mechanism
- A new explicit `"hold": true` frontmatter field in `upgrades/NEXT.md` disables publish even when content exists.
- The major-feature worktree commits `NEXT.md` with `hold: true` for the entire arc; it only flips to `false` at the cut commit.
- Sessions launched with the "no deploy" constraint MUST verify NEXT.md is in template state OR `hold: true` at session start AND session end. The check runs in a session-boundary hook.
- A failed check halts the session with: "release-tier-hold-required for no-deploy session; NEXT.md has shippable content. Add `hold: true` to its frontmatter or empty it before continuing."

### Worktree interaction
Because NEXT.md is per-branch, the hold signal **rebases with the branch**. Even if the major branch landed on main with `hold: true` still set, no publish would fire. Removing `hold: true` is a one-line commit on its own — deliberate, reviewable, traceable.

### Why this matters
Layer 4 is the operational counterpart to Layer 2. It makes the hold state observable from the document author's seat, not just from the release-tier config. Authors writing NEXT.md content during major-version work can mark it as held, and the workflow honors that locally.

---

## Layer 5 — Multi-signature for major bumps

### Mechanism
Major-version bumps require **two operator signatures** in `.instar/release-signatures/<version>.sig`:

```json
{
  "version": "1.0.0",
  "signedBy": "justin",
  "signedAt": "2026-05-19T20:00:00Z",
  "signature": "<ed25519-detached-signature-of-canonical-release-manifest>"
}
```

The publish workflow verifies both signatures using Ed25519 public keys at `.instar/release-keys/*.pub`. A major-tier bump without two valid signatures refuses to publish.

### Where signatures get added
Signatures are added to the **major-feature worktree's branch** in the rebase-and-promote PR. They land alongside the `release-tier.json` transition to `"major"`. Both signatures must exist before the workflow will publish; if either is missing, the workflow comments on the PR explaining what's needed.

### Why two signatures
Highest-stakes operation in Instar's release process. Two signatures means no single principal — including an automated agent — can ship a major version unilaterally. Cost: one coordinated step at major-cut time (rare by definition).

### Patches & minors
No multi-signature requirement. Layer 5 only activates for major-tier publishes.

---

## Layer 6 — npm-vs-package.json coherence refusal

### Status
**Partially live** — Layer 1's `LOCAL < NPM → never downgrade` clause is the foundation. Layer 6 adds the loud-refusal hardening:

- Coherence check runs **before any side-effectful step** (no version bump, no NEXT.md rename, no npm publish).
- On refusal: structured PR comment, structured log, **mirror to topic 10873**. The mirror is what makes the operator hear about it within seconds, not when they next check GitHub.
- The check also fires on `LOCAL == NPM` when the diff includes a NEXT.md transition out of hold — i.e. it catches "operator forgot to bump package.json before clearing hold."

### Why this matters
The 2026-05-19 incident's silent overwrite (`LOCAL=1.0.13` → `NPM=0.28.125`) is the canonical case this layer prevents. The current workflow logs the bump but does not surface it to the operator; the silent log is what allowed the misalignment to survive 12+ hours undetected. Layer 6 makes refusal a visible event.

---

## Layer 7 — Incident-memory injection at session start

### What this is
This case study and the rev-2 spec are referenced as required-reading in Echo's session-start hooks. The hook checks whether the current session has the "no deploy" constraint marker (autonomous-mode state, operator instruction, etc.). If yes, the case study is appended to the context-dispatch table with a `BEFORE any merge` trigger.

### Memory entries
- `feedback_verify_npm_publish_state` (already saved 2026-05-19) — operational rule: `npm view instar version` after every PR merge during no-deploy windows.
- `feedback_deployment_lockdown_layers` (to be added) — pointer to this spec; the agent reads it when the project repo is instar and a release-related action is staged.

### Why this matters
Memory survives compaction. Hooks fire even when the agent has forgotten broader context. Together they ensure future Echo cannot make the same assumption without first re-reading the case study.

---

## Worktree-pattern alignment summary

| Worktree standard (memory) | How Layer 3 honors it |
|---|---|
| `feedback_worktree_default_for_shared_repos` | Major work never operates on the shared checkout — always in an agent-home worktree |
| `feedback_worktree_in_agent_home` | Worktrees live at `~/.instar/agents/<self>/.worktrees/<feature>/`, sandbox-safe |
| `feedback_worktree_merge_commit_gate_bug` | Promotion is rebase-onto-main, never merge; linear history, no MERGE_HEAD gate bug |
| `feedback_concurrent_session_push_hygiene` | Per-branch index means parallel sessions can't bleed WIP into the major branch |
| `feedback_finish_means_merge` | "Cut v1.0.0" = rebased onto main, CI green, signed, published, npm verified — not "PR opened" |
| `feedback_release_notes_in_same_pr` | The cut PR contains the alignment guide; not a follow-up |

---

## What this spec does NOT do (unchanged from rev 1)

- It does not block patch-tier auto-publish. The vast majority of releases are patches; that workflow stays frictionless.
- It does not require operator approval for every patch.
- It does not address npm credential rotation or registry compromise.
- It does not retroactively unpublish or deprecate v0.28.122–v0.28.125. That's the alignment plan's concern, separate document.

---

## Implementation slice (revised — Layer 1 already shipped)

In dependency order:

1. ~~PR 1 — Layer 1: package.json as version-truth.~~ **Shipped as PR #265 / v1.0.8.**
2. **PR 1 (new) — Layer 2:** Add `release-tier.json` schema + reader. Workflow consults file. Initial value committed as `"hold"` to immediately disable auto-publish until the (b) alignment plan is ready. *This is the unblocking PR.*
3. **PR 2 — Layer 6:** Loud-refusal hardening. PR-comment + Telegram mirror on coherence failure. Foundation already in workflow; this is the surfacing.
4. **PR 3 — Layer 4:** NEXT.md `hold: true` frontmatter; session-boundary verification hook.
5. **PR 4 — Layer 3:** Worktree pattern is already standard; this PR formalizes it in CONTRIBUTING + workflow trigger restriction to `branches: [main]`.
6. **PR 5 — Layer 5:** Multi-signature requirement and verification.
7. **PR 6 — Layer 7:** Memory + session-start hook wiring. Lightest PR; ships last.

Each PR ships through `/spec-converge` then `/instar-dev` with the full pre-push gate. PRs 1, 2, and 6 (new numbering) gate the (b) alignment cut.

---

## Verdict

The seven layers transform deployment from a "trust + narrative" system into a "structure + verification" system. Layer 1 is live. The remaining six can ship through the worktree pattern they're describing — `~/.instar/agents/echo/.worktrees/deployment-lockdown/` with `next/lockdown-v1` as the branch, rebased onto main per PR.

**The single highest-leverage next move:** ship Layer 2 with `release-tier.json` initialized to `"hold"`. That single PR pauses all future auto-publish until an operator explicitly transitions the tier. Every subsequent layer is defense in depth.

Awaiting your review of rev 2 — once you ack, I'll cut Layer 2 from a fresh worktree at `~/.instar/agents/echo/.worktrees/deployment-lockdown/`.
