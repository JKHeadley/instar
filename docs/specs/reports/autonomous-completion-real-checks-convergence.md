# Convergence Report — Autonomous completion: real-checks verification

*Spec: `docs/specs/autonomous-completion-real-checks.md` · slug `autonomous-completion-real-checks`
· author echo · tracked as ACT-152 · converged 2026-06-10 over 3 review rounds.*

## ELI10 Overview

When the agent runs on its own (autonomous mode), it keeps working until a goal is met. Today a
second, independent mind decides "is it met?" — but that mind only **reads what the agent wrote**.
If the goal is "all tests pass," it decides the agent is done when it sees the agent *say* the
tests passed. It never runs the tests. So a wrong claim — misread output, a stale folder, or just
an over-confident "done" — can slip through.

This change lets a job carry a real command (like `npm test`, a build, or a quick check) that
actually gets **run** before the agent is allowed to stop. The new flow: the reading-mind says
"looks done" → the system runs the real command → only if it actually passes does the agent stop.
If the command fails, the agent doesn't stop; it gets the failure handed back as "the real check
failed, here's why — fix it and keep going." It's **opt-in**: a job that doesn't declare a command
behaves exactly as today, so nothing changes for anything that doesn't use it.

The most important safety properties, in plain terms: the real command can only ever make the
agent **keep working longer** — it can never make the agent stop early. If it fails, times out, or
is unclear, the agent keeps going (the safe direction), and the time limit is still the hard
backstop. And there's a brake: if the check keeps failing (usually because it was mis-written),
the system stops re-running it, tells you about it, and lets you fix it — instead of silently
spinning until the clock runs out.

## Original vs Converged (what the review actually changed)

The first draft was a clean idea with five real holes the review caught. In plain terms:

1. **It would have checked the wrong folder.** The first draft ran the command from the agent's
   home folder. But the main use case — an autonomous *build* — runs inside a separate work folder
   (a "worktree"). So `npm test` would have tested the wrong code, the exact stale-folder problem
   this feature exists to fix. The converged spec captures the real working folder when the job
   starts and runs the check there.

2. **It could spin forever burning quota.** The first draft's only brake against a check that
   keeps failing was the overall time limit. The review (citing the project's "No Unbounded Loops"
   law) flagged that a failing check re-runs *and re-spends the expensive reading-mind* on every
   loop. The converged spec adds a real brake: after a few failures it stops re-running, raises one
   notification to you, and waits — bounded, not a runaway.

3. **It would have silently turned itself off on Macs.** The first draft relied on a `timeout`
   command that doesn't exist on a stock Mac (the main platform). It would have failed quietly,
   disabling the whole feature without anyone noticing. The converged spec uses a portable timeout
   that always works and also cleans up any leftover sub-processes.

4. **It mis-described how the check's output flows back.** A subtle one: the review found the spec
   described the wrong path for how the command's output reaches the reading-mind, which would have
   made a safety test check the wrong thing. The converged spec corrects the path and the test so
   an agent can't make its "check" print "all tests passed" and have that fake corroboration
   counted later.

5. **It under-stated the trust boundary.** The first draft claimed the command was "the same
   trust" as the goal text. The review pushed back: the goal text is only *read*, but this command
   is *executed* — the first executed, agent-editable field in the loop. The converged spec is
   honest that this strengthens against honest mistakes (the real goal), not against an agent
   deliberately gaming it (which it already has bigger powers to do), and it adds an audit log so
   any gaming is at least *detectable* afterward, plus hardening for the fact that the command runs
   unattended (a fixed safe environment, a secret-scrubber on the output, and a coarse block on
   obviously-destructive commands).

The core idea survived every round unchanged: a real, deterministic check, layered on top of the
independent reading-mind, that can only ever *withhold* a stop — never *cause* one.

## Iteration Summary

| Round | Reviewers | Material findings | Outcome |
|-------|-----------|-------------------|---------|
| 1 | security, adversarial, scalability, integration, lessons-aware (all 5 internal) | ~20 (5 distinct HIGH classes) | spec rewritten |
| 2 | all 5 internal (verify + new) | security ✅, integration ✅, lessons-aware ✅; adversarial 1 HIGH + 2 LOW; scalability 2 MED + 2 LOW | spec refined |
| 3 | adversarial, scalability (the two open) | 0 material (both CONVERGED) | **converged** |

## Full Findings Catalog

### Round 1 (initial)
- **HIGH (security, scalability):** `timeout`/`gtimeout` absent on stock macOS — the gate would
  silently no-op fleet-wide. → Portable timeout ladder (`timeout`→`gtimeout`→perl-alarm→keep-working).
- **HIGH (scalability):** output capture buffered whole before clamp (1GB-log risk). → `head -c`
  source bound (65536) before the 2000-char clamp.
- **HIGH (lessons-aware F2 / adversarial #4) — P19 No Unbounded Loops:** failing check re-runs +
  re-fires the LLM judge every met-iteration until duration; only brake was the duration limit
  (the forbidden single-cap). → Real-check breaker (backoff + breaker + cap) in `CD_BACKOFF_STATE`.
- **HIGH (lessons-aware F4) — wrong CWD:** running from agent-home tests the wrong tree for builds.
  → Structurally-captured `work_dir`/`verification_cwd`.
- **HIGH (adversarial #1):** "same trust as the condition" is wrong — first agent-writable EXECUTED
  field; `fm_get` strips quotes. → Honest framing + audit + `bash -c` (no eval) + quote-preserving
  read.
- **MEDIUM (security):** sanitize/clamp order (credential-split evasion); env inherits authToken.
  → Pinned scrub-before-clamp order + scrubbed env + authToken/Bearer redaction.
- **MEDIUM (adversarial #2):** check output re-enters the judge's transcript (fake corroboration).
  → DATA-labeling + fence treatment + round-trip test.
- **MEDIUM (lessons-aware F8) — L12:** unattended execution of an agent-influenceable command. →
  Destructive-pattern pre-block.
- **HIGH (integration):** migration plan named no function/markers, omitted SKILL.md + migrateClaudeMd.
  → Concrete §7 (named functions, marker bumps, ConfigDefaults:613 nesting, CD_CFG read).
- **MEDIUM (scalability, lessons F7) — B24:** timeout budget vs the registered Stop-hook timeout;
  exit-code via `${PIPESTATUS[0]}`. → §10 budget analysis + mechanical exit rule + 124/127 tests.
- **MEDIUM (lessons F5) — P13/A-Wall-Is-a-Hypothesis:** guidance wording. → §5.4 canary-pinned template.

### Round 2 (verification)
- security, integration, lessons-aware → **CONVERGED** (all round-1 must-fixes resolved, refs
  verified file-accurate).
- **HIGH (adversarial H1):** §5.3 mis-described the output data path (it rides `systemMessage`, not
  the continuation prompt; reaches the judge only via agent echo). → §5.3 corrected; test fixed to
  the real round-trip; fence designated operative defense.
- **LOW (adversarial H2):** destructive pre-block is obfuscation-bypassable. → honesty sentence.
- **LOW (adversarial H3) / MEDIUM (scalability):** perl-alarm orphans child process group on macOS.
  → `setpgrp` + group-kill + `--kill-after`; grandchild-reap test.
- **MEDIUM (scalability):** new breaker's fail-direction on corrupt sidecar unspecified. → fail
  CLOSED (keep verifying) + atomic writes.
- **LOW (scalability):** breaker-OPEN can strand a finished run for a cooldown. → documented design
  choice (keep-working, bounded + surfaced; degrade-to-floor deliberately not taken).
- **LOW (scalability):** `head -c` mid-multibyte truncation breaks the next judge's JSON. → UTF-8
  scrub before clamp/encode + test.

### Round 3 (verification)
- adversarial → **CONVERGED** (H1/H2/H3 resolved; perl group-kill snippet executed and verified;
  no new material).
- scalability → **CONVERGED** (all 4 resolved; breaker-strand accepted as documented design choice;
  one cosmetic prose fix on "one attempt per cooldown" applied; no new material).

## Cross-model (external) reviewer posture

`skipped-abbreviated`. This convergence ran the full **internal** five-reviewer panel (security,
adversarial, scalability, integration, **and the mandatory lessons-aware pass**) across three
rounds, but skipped the external GPT/Gemini/Grok models. This is the documented abbreviated path
for a focused, single-subsystem change; the lessons-aware pass — the structural defense against an
author converging their own spec — was NOT skipped and is what caught the two most important
findings (the P19 brake and the wrong-CWD correctness bug).

## Convergence verdict

**Converged at iteration 3.** No material findings in the final round from either remaining
reviewer. All round-1 and round-2 must-fixes are resolved with file-accurate references verified
against the live hook + migrator code. The spec is ready for user review and the `approved: true`
tag.
