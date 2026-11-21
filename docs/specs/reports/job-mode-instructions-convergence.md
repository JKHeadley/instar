# Convergence Report — Job sessions load a short job-mode instruction set

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran in all six rounds (every round's body hash changed, so none was delta-skipped).

## ELI10 Overview

Every scheduled job starts a fresh AI session that first reads the agent's whole instruction file and memory index, about 80 thousand tokens before any work in a probe. Jobs need very little of that. This change gives job sessions a short set of instructions created fresh at launch, and tells Claude Code to skip the long files. In a probe, that took about 51 thousand tokens off the first turn.

Only jobs shipped with Instar whose exact prompt has been reviewed switch over by default. Custom jobs keep everything until someone opts them in, and any job can be switched back with one setting. After a job runs, the agent checks the session's own record to confirm the long files really weren't loaded, and goes back to full instructions on that machine if they were.

The tradeoff is a little machinery for safety: a per-job check, a one-time probe for each new Claude Code version, and an allowlist. In exchange, the saving is measured and verified rather than assumed.

## Original vs Converged

- Originally the short file lived on disk and could be stale, tampered with, or synced from another machine. Now the text is created in memory at each launch and passed directly, so no file is trusted.
- Originally every shipped job defaulted to short instructions, and job mode was inferred from a job name. Now an explicit launch option is set only by the scheduler. The default applies only to verified shipped jobs whose exact prompt is on a reviewed list, so new or changed jobs start with full instructions.
- Originally only CLAUDE.md was excluded. Measuring showed Claude Code then falls back to AGENTS.md, so both are excluded now (about 51 thousand tokens saved instead of 39 thousand).
- Restricted spawns (confined tools, no auth token, the feedback executor) and the triage spawn keep today's launch.
- The "did it really skip the files" check gained a clear pass, fail and unknown, a positive control per Claude Code version, per-job locked state with clear-generation, and a split between the configured and effective mode, so one failure can never lock a job out permanently or overwrite an operator's choice.
- Overrides are keyed by origin and slug. A migration journals the overrides it creates and undoes only unchanged ones.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, internal (all lenses) | 13 | 4 | explicit option, AGENTS.md, confinement, transcript check, origin+trust default |
| 2 | codex | 4 | 0 | jobs.json-only field, origin:slug overrides, partial-evidence rules, no per-machine values |
| 3 | codex, internal | 5 | 6 | reviewed allowlist, migration carry, restricted spawns, render check |
| 4 | codex, internal | 5 | 3 | inline text (no file), body-hash review key, migration journal, first-reply boundary |
| 5 | codex | 3 | 1 | shared safety clauses, per-job locked state, positive control |
| 6 | codex | 3 | 1 | multi-source control, clear generation, configured vs effective mode (applied at cap) |

Standards-Conformance Gate: ran (9 flags) before round 1. All were addressed: the 6 KB size became a guide, reporting is per incident, disclosure follows CLAUDE.md, user jobs default to full, the Codex gap became a work card, posture was reworded, a state-not-symbol check was added, and attribution was quoted. Internal reviewers: one Claude subagent (Sonnet 5.5) covered all six lenses per round under the token-pacing limit of one subagent at a time. The authoring session ran on Opus 5.5.

## Proportion

Tier 2 (it changes the instruction text unattended sessions receive). The spec is about 210 lines. 6 of 6 rounds were used. ⚠ That is many rounds for one launch-flag change, driven mostly by the self-verification check rather than the core change.

## Left behind

- Round-6 design findings were applied at the cap without a further review round. None concern safety, security or data loss: the worst case of a flaw in the check is a job running with full instructions (more tokens) or with job-mode text when the exclusion silently failed (the job-mode safety text is still present).
- Precision: launch-record size, a stale test wording and numbering were fixed in passing.
- Codex job sessions: a work card under the context budget project.
- The remaining ~29 thousand tokens (system prompt, tool and skill lists): a separate lever, noted for the context budget project.

## Full Findings Catalog

Round 1 (codex): no recovery route after a fail; memory not covered by the check; origin is not the same as reviewed; no writable override for shipped jobs; probe-only measurement (precision). Round 1 (internal): confinement uses a settings file, not an object; flag placement in both paths; no plumbing for the option; cwd and exclusion path; hooks under confinement; origin semantics; transcript format unverified; fallback flag storage and clearing; transcript read cost; rollback versus validator; plus 3 precision items.
Round 2 (codex): frontmatter validator skips a job on an unknown key; slug-only override follows forks; partial-evidence ambiguity; port embedded in a synced file.
Round 3 (codex): shipped full-list should be inverted; migration loses an explicit choice; a synced file from another version. Round 3 (internal): restricted spawns beyond confinement; no integrity check on system-prompt text; plus precision items.
Round 4 (codex): check-then-read window; review keyed by slug not body; migration override not reversed; 256 KB prefix ordering. Round 4 (internal): Change 1/7 contradiction; atomic write.
Round 5 (codex): positive control needed; mandatory clauses must be shared; concurrent state writes; rollback wording (precision). Round 5 (internal): none (precision: launch-record size).
Round 6 (codex): control must cover every source; stale probe after a clear; configured versus effective mode; probe-delta wording (precision).
Each was resolved as described in Original vs Converged.

## Experience fit

Source: Justin's 14:23 PST request (relayed by the Chief of Staff) to prioritize token efficiency. The ordinary journey is invisible to the person: jobs simply cost less. The contrasting case is a custom job that needs its full instructions: it keeps them by default, so nobody has to notice a breakage and fix it. No approvals are involved. Evidence limit: savings are probe measurements until the PR's scheduler measurement.

## Convergence verdict

Converged at round 6, the Tier 2 cap. The last round's three design findings were folded in. None touch safety, security or data loss, so per the cap rule they are recorded here rather than sent to the operator. The spec is ready to build.
