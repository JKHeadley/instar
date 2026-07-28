# Convergence Report — Robust Load Assessment (fleet-wide + compaction-surviving)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran via the agent's codex CLI in round 2 (`status: ok`, verdict
"MINOR ISSUES"). gemini-cli was present but its call errored both rounds (`degraded`); per the
aggregate rule, one genuine successful external opinion is enough — the spec received real
cross-model review. The two substantive codex points (Linux two-sample `/proc/stat` delta; verdict is
CPU-capacity, not a universal health oracle) were incorporated.

## ELI10 Overview

The agent needs to answer "is this machine busy, or free to work?" Recently it got this wrong twice —
it read the `uptime` "load average" (~40), thought the machine was slammed, and held off on work. The
machine was actually ~60% idle; the high number was just macOS re-indexing the disk after a reboot.
Load average is a bad ruler here: its 1-minute value spikes wildly, and on Macs it counts programs
*waiting on the disk*, not just *using the CPU*.

This change ships one go-to command, `load-assess.sh`, that looks at the RIGHT things — real CPU
idle %, the agent's own CPU use over the last hour, and *what* is using the CPU (so background noise
like Spotlight is told apart from real work) — and prints a plain verdict (OK / ELEVATED / SATURATED).
Crucially, it makes the "use this, never trust load average" reminder survive *compaction* (when the
agent compresses its memory of a long chat) by injecting it in the startup hook on every event
including compaction. And it ships to *every* agent via the update process, not just the one where it
was built. It's read-only — it measures and reports, never changes anything.

## Original vs Converged

The original draft had the right *idea* but two fatal mechanical errors that round-1 review caught:
1. It said to edit a hook *template file* — but the deployed hook is actually generated from an
   *in-code string* (`getSessionStartHook()` in `PostUpdateMigrator.ts`). Editing the template file
   would have changed nothing on any agent.
2. Its core promise — "survive compaction" — was *false as written*. On compaction the hook does
   `exec compaction-recovery.sh`, which replaces the process, so a reminder placed at the end of the
   hook would never run on compaction. The fix: place the reminder ABOVE that branch, so it prints on
   every event before the hand-off.

Review also added the mandatory CLAUDE.md capability entry (so the agent *knows* the tool exists), a
cross-platform CPU fallback (the original was macOS-only), and honesty that the verdict measures CPU
capacity — not memory/thermal.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1 | lessons-aware (2 CRITICAL, 1 HIGH), decision-completeness (clean), conformance gate (0), gemini (degraded) | 3 | Part 2 → in-code `getSessionStartHook()` above the compact `exec`; new Part 4 CLAUDE.md (generate+migrate); cross-platform CPU; `--json` note; rollout clarity |
| 2 | lessons-aware (CONVERGED), decision-completeness (CONVERGED), codex (MINOR ISSUES), gemini (degraded) | 0 material; 2 minor folded in | Linux two-sample `/proc/stat` delta; verdict CPU-capacity scope honesty; `--json` human-diagnostic-only |
| — | (converged) | 0 | — |

## Full Findings Catalog

**Iteration 1**
- CRITICAL (lessons-aware): Part 2 edited the dead template file, not the in-code `getSessionStartHook()` → would not reach any agent. RESOLVED: spec now targets the in-code method (PostUpdateMigrator.ts:8917), written by `migrateHooks()` (:3085, always-overwrite).
- CRITICAL (lessons-aware): compaction-survival false — `exec compaction-recovery.sh` on compact bypasses a tail block. RESOLVED: block inserted ABOVE the compact-delegate branch; load-bearing integration test asserts presence with `CLAUDE_HOOK_MATCHER=compact`.
- HIGH (lessons-aware): Agent-Awareness Standard — no CLAUDE.md template update. RESOLVED: Part 4 adds `generateClaudeMd()` entry + content-sniffed `migrateClaudeMd()` insert (:3968) + tests.
- LOW (lessons-aware): rollout posture unclear. RESOLVED: Rollout now explicit "live everywhere, no dark gate," noting the inversion of the usual dev-gate posture.
- decision-completeness: confirmed observe-only + `## Open questions: (none)` honest; noted `--json` shape + `top -l 2` macOS-specificity (both addressed in iter 1/2).
- conformance gate: 0 at-risk flags.

**Iteration 2**
- lessons-aware: all 4 prior RESOLVED at code-true level (callsites independently verified); zero new material.
- decision-completeness: CONVERGED; Part 4 introduces no decision point (append-only content-sniffed); no new external side-effect.
- codex (cross-model, MINOR ISSUES): (1) Linux `/proc/stat` needs a two-sample delta — FOLDED IN. (4) verdict overfits CPU-idle (ignores memory/thermal/disk) — FOLDED IN (scope-honesty note). (2) `--json` unversioned weak — FOLDED IN (human-diagnostic-only). (3) hook habituation noise — kept block short, CLAUDE.md carries the durable instruction (acceptable). (5) no alt-telemetry discussion — noted, non-material for an observe-only diagnostic.

## Convergence verdict

Converged at iteration 2. Both internal reviewers returned zero material findings; the codex
cross-model pass returned only minor issues, the substantive two of which were incorporated. Spec is
ready for user review and approval.
