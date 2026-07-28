# Convergence Report — An autonomous run must outlive its session

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer ran in this convergence. Reason: the
cross-model script (`skills/spec-converge/scripts/cross-model-review.mjs`) requires
a built `dist/core/crossModelReviewer.js`, which the fresh P1 worktree does not
have (no `pnpm build`/`node_modules` in the worktree), and the `codex` CLI is not
on PATH in this execution context (codex runs on this machine via the server's own
invocation path, not a shell binary). Convergence therefore ran on the **internal
Claude reviewers + the code-based Standards-Conformance Gate ONLY**. The user reads
this banner before applying `approved: true` — the reduced external-assurance state
is an informed choice. Remediation for a future round: build the worktree dist and
invoke the externals (codex/gemini), or run convergence from a context with a built
dist + codex on PATH.

## ELI10 Overview

Instar can run "autonomous" sessions — you say "go work on this for a while," and it
keeps going on its own. Those runs are meant to survive their session being
recycled (age limit, restart, machine reboot): a "resume queue" revives them. This
spec fixes a real incident where that revival queue was *silently disabled* on the
dev machine, because the machine had been renamed and the queue mistook its own old
name-stamped lock file for a different computer trying to share its files. It shut
down to be safe — and said nothing.

The change adds a constitutional standard ("an autonomous run must outlive its
session") and the fix behind it: when the lock shows a different computer name,
carefully tell apart a *rename of the same machine* (old process dead + files on a
local disk → safely self-heal and keep running) from a *genuine shared-volume
conflict* (any doubt → stay off, but LOUDLY, with a guard-dashboard flag and an
alert). The main tradeoff is safety vs. convenience: auto-taking-over a lock could
corrupt data if it misfired on a real shared drive, so it fails safe on every
uncertainty and ships off-by-default on the fleet, proving itself in dry-run on the
dev agent first.

## Original vs Converged

The original draft was directionally right but leaned on machinery that **does not
exist** and under-specified a **safety-critical** lock:

- **FS detection.** Original said "reuse existing FS-type detection." There is none
  — only a worktree-specific `df -T apfs,hfs` allowlist. Converged: a NEW
  `isStateDirHostLocal` helper, specified as a closed network-FS *denylist* over
  `df -PT`, fail-closed (unknown/timeout/unparseable → treated as NOT local → never
  auto-heal), with a unit truth-table and a shape-drift canary.
- **"Surface a disabled guard."** Original treated this as free. It needs four
  concrete edits (a `guardStatus()` method, a `GUARD_MANIFEST` entry with the
  `component:` join key, an unconditional `guardRegistry.register` callsite) — and a
  lint (`lint-guard-manifest.js`) would have failed the build until both
  `ResumeQueue` and its sibling `ResumeQueueDrainer` were classified. Converged:
  all enumerated, including `ResumeQueueDrainer` → `NOT_A_GUARD` (parent-rides
  precedent). Also corrected a factual error — the *attention item already fires*
  today; only the guard-posture path is new (so the builder won't double-implement
  it).
- **Concurrency.** Original left lock-takeover as "write-temp+rename OR O_EXCL." The
  current lock is a non-atomic TOCTOU. Converged: mandates O_EXCL first-writer-wins
  (the `ProjectRoundLock.ts` precedent), forbids the last-writer-wins option, loser
  re-reads instead of clobbering.
- **Rollout.** Original shipped default-true fleet-wide via migration — a
  corruption-class behavior change NOT actually gated by the "dark on dev" label.
  Converged: fleet default FALSE; dev-agent-only, dry-run-first; the fleet flip is a
  separate later reviewed decision.
- **Undecided edges** (pid recycling, foreign-host-vs-same-host heartbeat) were
  resolved as explicit frontloaded decisions (FD3, FD2/FD6): pid-recycle out of
  scope because it degrades safe (stay-disabled + alert); auto-heal requires
  local-FS AND dead-pid AND stale-heartbeat, FS-local dispositive and first.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | lessons-aware (+foundation audit), decision-completeness | 6 (FS-detection-absent, guard-wiring-absent, pid-recycle, atomic-takeover, contested fleet cheap-tag, foreign-host heartbeat) | Added `## Frontloaded Decisions` (FD1–FD5), rewrote D1/D2, fleet-default→false, enumerated guard wiring, mandated O_EXCL |
| 2 | decision-completeness (convergence) | 1 (guard-manifest lint: `component:` key + `ResumeQueueDrainer` classification) + 1 minor (attention-raise already wired) | Pinned `component:'ResumeQueue'` + `ResumeQueueDrainer`→NOT_A_GUARD; corrected the new-vs-existing surface note |
| 3 | (converged) | 0 | none — round-2's sole blocker closed exactly as the reviewer prescribed; reviewer pre-validated "with the manifest classification pinned, this converges" |

Standards-Conformance Gate: ran (0 authoritative flags; report `degraded: error`,
so non-authoritative — fail-open, continued). The original `parent-principle`
("Cross-Machine Coherence …") did not resolve to a registered standard and was
corrected to "No Silent Degradation to Brittle Fallback".

Convergence mode: **abbreviated** — the two NON-SKIPPABLE reviewers (lessons-aware
with foundation audit, decision-completeness) ran across two rounds; the external
cross-model pass was unavailable-in-context (see banner). For this focused
lock-safety change, the decision-completeness reviewer covered the
security/adversarial/concurrency surface directly (it surfaced the TOCTOU race, the
shared-volume double-writer hazard, and the corruption-class rollout objection).

## Full Findings Catalog

**Round 1 — material (6):**
1. *(lessons + decision-completeness)* Host-local FS detection claimed "reuse
   existing"; no such primitive exists. → FD1: new fail-closed denylist helper.
2. *(both)* D2 "emit guard-posture signal" needs 4 concrete edits + a lint would
   fail; not enumerated. → D2 enumerates all four.
3. *(decision-completeness)* pid recycling undecided ("when determinable"). → FD3:
   out of scope, degrades safe.
4. *(decision-completeness)* atomic takeover undecided; current lock non-atomic
   TOCTOU. → FD4: O_EXCL first-writer-wins, clobber-rename forbidden.
5. *(decision-completeness)* fleet default-true migration of a corruption-class
   change, cheap-tag contested. → FD5: fleet default false, dev-only dryRun-first.
6. *(decision-completeness)* foreign-host auto-heal vs existing same-host heartbeat
   reclaim undecided. → FD2/D1: local-FS AND dead-pid AND ≥5min-stale-heartbeat.

**Round 1 — minor/cosmetic:** D2 surfacing must be always-on, not dryRun-gated
(addressed); migrateConfig touches only `autoHealStaleHostLock` (addressed); Agent
Awareness CLAUDE.md line (added to Migration Parity); `lessons-engaged` frontmatter
(added); pid-recycle wording (resolved via FD3).

**Round 2 — material (1):** guard-manifest lint classification under-specified
(`component:` join key + `ResumeQueueDrainer`). → closed: `component:'ResumeQueue'`
+ `ResumeQueueDrainer`→NOT_A_GUARD (parent-rides). **Minor (1):** the aggregated
attention item already fires today (`raiseResumeAggregated`); only the
guard-posture path is new — corrected so the builder won't double-implement.

All round-1 precedents the rewrite cited were verified to EXIST in code by the
round-2 reviewer: `ProjectRoundLock.ts` O_EXCL (`'wx'` + rename), `WorktreeManager`
`df` detector, the dev-gate machinery, the current TOCTOU + 5-min heartbeat window +
the hard foreign-host invariant.

## Convergence verdict

Converged at iteration 2 (+ the prescribed manifest-classification close). No
material findings remain; the round-2 reviewer's sole blocker was closed exactly as
specified, and it pre-validated that close as converging. Open questions: none. The
spec is single-run-completable and ready for user review and approval. External
cross-model assurance was UNAVAILABLE in this context (see banner) — an informed
approval choice.
