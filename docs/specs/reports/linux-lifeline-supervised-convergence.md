# Convergence Report — Linux lifeline is marked supervised, so its self-restart runs

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family external pass ran on all five rounds through the agent's codex CLI. Gemini was not authed (`gemini-not-authed`), so it did not run. The Claude clean-door reviewer was available but was not run: the machine's CPU was saturated, and it is not a cross-model opinion.

## ELI10 Overview

Every instar agent has a lifeline, a small always-on process that collects Telegram messages and keeps the server running. When the lifeline's watchdog sees it is stuck, it exits on purpose and expects the operating system to start it again. On Linux that never happened. The Linux service starts the lifeline through a shell script, which hides the fact that systemd will restart it. So the lifeline always decided an exit would be fatal and stayed stuck. The Mac launch file has carried a "you are supervised" setting for exactly this reason. This change gives the Linux service file the same setting, both on new installs and through an update that edits existing files.

Review then found a deeper problem in the restart logic that this change turns on. The limit on self-restarts only controlled how often (one every 10 minutes), never how many. The alarm meant to catch a restart loop could never fire, because of a counting mistake. Luna had exactly such a loop on 2026-10-12: 21 restarts in four hours, unreported. The converged change fixes this on every platform:
- at most 6 watchdog restarts per rolling day;
- an alarm that can fire;
- a single report when self-repair gives up;
- a report when the restart-history file is corrupt.

The trade-off: if a late restart is the one that would have fixed something, it now waits for the day's window to roll. In exchange, the operator is told instead of never.

## Original vs Converged

Originally the spec was one line in a service file plus a migration, and it claimed the existing restart brakes were enough. Review showed that claim was false: no total limit existed, the storm alarm was dead, and a corrupt history entry could slip through. Several cost and safety statements were also wrong:
- the server-stop behaviour;
- message persistence through a no-op step;
- an operator opt-out that the next regeneration would erase.

The converged spec adds:
- the daily cap and the alarm fix, with real restart data from two agents on the Mac Studio;
- corrupt-entry detection and its report;
- the documented drop-in opt-out;
- the update and version-skew restarts that also switch on for Linux;
- KillMode's two-message reload reporting;
- corrected cost and survival statements.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal (six lenses), codex | 5 | 10 | cost, storm alarm + daily cap, opt-out via drop-in, upgrade restarts named, persistence claim |
| 2 | internal, codex | 4 | 8 | existing test rewritten, version-skew keeps server, malformed entries are corrupt, shared cooldown wording |
| 3 | internal, codex | 2 | 4 | Luna's loop cited with trade-off, corrupt file reported, server-stop claim corrected |
| 4 | codex | 1 | 5 | notification promise corrected (storm vs exhaustion) |
| 5 | (converged) | 0 | 3 | none (wording only) |

Standards-Conformance Gate: ran once, before round 1 (1 flag: Capacity Safety — No Unbounded Self-Action, a cooldown bounds frequency not count). That flag was confirmed by the internal reviewer and resolved by the daily cap. It was not re-run on later rounds. Internal reviewer model: the session's model (Opus 5.5), one subagent covering all six lenses per round. That is proportionate to a small spec on a saturated machine; this departs from six separate reviewers. Internal reviewer round 5: not re-run. Its round 4 had 0 design findings, and edits since were the precision fixes it requested plus the codex wording correction. Externals ran on every round because the body changed each time.

## Proportion

Tier 2 (fleet-wide unit migration), about 4 source files and 200 lines with tests. 5 rounds of a 6 cap. ⚠ High for the original one-line idea; the rounds were spent because review found real defects in the restart foundation the change switches on, not on wording.

## Left behind

- `RestartOrchestrator` quiesce budget is 1s, so a watchdog exit may leave the server running (adopted by the next lifeline). Existing on macOS. For `noForwardStuck`/`consecutiveFailures` that restart may then fix nothing and still use one of the 6. Worth its own change.
- A corrupt rate-limit file still blocks all self-restarts until rewritten (now reported); moving it aside automatically is not done.
- `selfRestartExhausted` is raised once per process; a process that survives the window rolling over will not report a second exhaustion episode.
- Reporting goes through the lifeline's `DegradationReporter`; delivery to the operator when the forwarding path is the broken part is not re-proved here.
- Clock skew allows one restart outside the caps per skew event (existing).
- "Every self-heal exit on Linux is skipped" holds for generated units without an operator-set variable; a hand-written unit with the variable was already supervised.
- Luna's 409 loop cause (second poller) is a hypothesis; the logs are gone.
- An inherited `INSTAR_SUPERVISED=1` makes test-mode detection supervised inside agent sessions (same as macOS); not audited across all tests.
- End-to-end delivery across forwarding and acknowledgement is the existing design and is not re-proved; the spec now claims only the queue and offset guarantees.

## Full Findings Catalog

Round 1, internal:
- D1: restart cost is not 15s; the watchdog bucket stops the server too.
- D2: the storm alarm can never fire for watchdog restarts (it counts history only) → loop with no bound.
- D3: the opt-out claim is false (template regeneration overwrites it).
- D4: plannedUpgrade/versionSkew also become live on Linux.
- D5: "the queue is persisted before exit" is false (persistAll is a no-op).
- Precision: env inheritance in test mode; corrupt file blocks silently; clock skew; "takes effect" wording; reload-failure message; CRLF; quoted Environment forms; insert position; fleet unprotected until restart.

Round 1, codex: precision only (verify the wrapper exits; narrow losslessness; qualify timing).

Round 2, internal:
- D: the existing storm test is now red.
- D: versionSkew keeps the server (false claim).
- Precision: macOS sample size, rolling-window wording, alert reach, reload messages, insert position, test-stub claim.

Round 2, codex:
- D: malformed history entries pass validation.
- D: the cooldown is shared, not per-bucket.
- Precision: offset ordering.

Round 3, internal:
- D: the cap evidence ignores Luna's 21-restart loop.
- Precision: a corrupt file is never reported; evidence path.

Round 3, codex:
- D: the server shutdown in a watchdog restart is not awaited (1s quiesce). Resolved as a corrected claim; the adoption path prevents a second server; quiesce budget left behind.
- Precision: losslessness, skew.

Round 4, internal: 0 design; precision: a self-contradiction on Luna, one path, "harmless" too broad.

Round 4, codex: D: "the operator hears at the 6th restart" is false for spread-out restarts → wording now distinguishes storm from exhaustion. Precision: losslessness.

Round 5, codex: 0 design; precision: event emission vs delivery, once-per-process across the window, scope of "every Linux".

## After convergence: second-pass review

The `/instar-dev` second-pass reviewer raised one concern: suppressed restart attempts (unsupervised, shadow-install deferral) were written to the history and would use up the new cap, so a Linux lifeline stuck in the old state could arrive at its first supervised start with no budget. That was resolved by counting only entries the orchestrator marks `exited: true` immediately before exit. It is now in the spec's Change §4 and covered by tests (orchestrator records only on a real exit; unexited and pre-upgrade entries do not count).

## Convergence verdict

Converged at round 5. The final round found nothing that changes what gets built; 9 items left behind, listed above. Spec is ready for approval.
