# Convergence Report — Test-agent leak guard

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, `gpt-6-astra`) ran on all six rounds. The Anthropic
clean-door second read (`claude-code`) was attempted in round 1 and degraded with an error; it is not a
cross-model opinion and does not affect this flag. Gemini was not signed in on this machine.

## ELI10 Overview

A test script made a throwaway copy of an Instar agent in a temporary folder and pretended its home
folder was that temporary folder. The Mac's start-at-login system and the Claude login both belong to
the person, not to the pretend home, so the throwaway got installed as a permanent background job and
ran scheduled work on the operator's real Claude subscription for five days.

This change makes Instar recognise a throwaway agent by where it lives (a temporary folder, or a
pretend home) and then: never installs it as a start-at-login job, refuses its scheduled jobs, gives it
an expiry time when it is created, and has it remove its own start-at-login job and stop when the time
is up. Agents in normal folders are unaffected. Every rule has an explicit override for the rare case
where someone really wants a long-lived agent in a temporary folder.

The main trade-off: Instar cannot tell whether a session would use the operator's real login, so it
assumes it would. A test that needs scheduled jobs must say so with one setting.

## Original vs Converged

- **Originally** every installer was guarded by one check, but the fleet-watchdog migration loaded a
  machine-wide job on its own. **After review** that migration is guarded too.
- **Originally** a sandboxed HOME alone also blocked scheduled jobs. Review showed real agents can run
  with a different HOME (systemd units, containers), so now a sandboxed HOME at runtime only blocks the
  start-at-login install; jobs are refused for temp-folder projects and recorded throwaways.
- **Originally** only new agents got an expiry. Review pointed out that agents that already leaked
  would never expire, so the server now backfills a 24-hour expiry for a temp-folder agent with no
  record.
- **Originally** teardown matched "the plist mentions our folder" and unloaded by file. Now it matches
  the exact working directory, checks the loaded launchd job's own working directory before unloading
  (so a same-name real agent is never stopped), deletes files before unloading, records progress in a
  marker under a lock, retries at most five times, and then idles instead of restart-looping.
- `$TMPDIR` is no longer treated as a temp root (a user can point it inside their home).
- `scheduler.allowOnThrowawayAgent` is added explicitly to the config loader (it would otherwise have
  been dropped).
- `--keep` writes an explicit exemption record; `--keep` with `--expires-in` is refused.

- **After convergence (second-pass review of the build):** a sandboxed HOME alone no longer records an
  expiry at init (it only blocks autostart), and the server prints one boot line when auto-start is
  off. Both narrow the change; neither adds a decision point.

## Iteration Summary

Standards-Conformance Gate: ran (2 flags) in round 1 — "Verify the State, Not Its Symbol" (addressed:
exact ownership checks, explicit unmeasurable cases) and "Bug-Fix Evidence Bar" (addressed: a live
macOS reproduction script is added). Later rounds: not re-run (unavailable as an automated step in
this session after round 1; the round-1 flags were engaged directly).

Internal reviewer model: claude-opus-5-5 subagents (two subagents covering the six lenses:
security + adversarial + lessons-aware; integration + scalability + decision-completeness), round 1.

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security/adversarial/lessons, integration/scalability/decisions, conformance gate | 17 | 9 | fleet-watchdog guard, call-site table, reason/effect table, boot backfill, exact ownership, fixed temp roots, config loader fix |
| 2 | codex | 3 | 1 | `--keep` record, persisted ownership, launchctl working-directory parse |
| 3 | codex | 3 | 1 | always check the loaded label, re-check file ownership on retry, deterministic-policy rationale |
| 4 | codex | 2 | 1 | delete-all-then-unload-once, Linux loaded-unit ownership, bounded retry |
| 5 | codex | 2 | 1 | outcomes (complete/retryable/quarantined), lock + atomic marker |
| 6 | codex | 3 | 0 | pid-only lock takeover, install takes the same lock, one outcome handler; two items accepted at cap |

## Proportion

Tier 2 (touches autostart, scheduler admission and process lifecycle on every agent). Six rounds of
six. Rounds 4–6 were about teardown failure handling after the spend is already stopped; that is the
long tail, and the round cap stopped it.

## Left behind

- Throwaways in normal folders with the real HOME are not detected by location (follow-up).
- Override use is console-logged, not separately audited.
- A misclassified agent raises no attention item.
- Pre-existing: the install path's `bootout` of a same-name label; `systemctl` calls without a
  test-runner guard in the existing Linux installer.
- Round-1 precision items: wording of the root-cause trigger ("every server start"), Linux leak is
  macOS-only, path aliasing in matching (folded in), PostUpdateMigrator refusal recorded as skipped
  (folded in), dashboard label (folded in), CLAUDE.md sniff string (folded in).
- Accepted at the cap: "complete" means the unload was accepted, not re-verified; a failed final
  marker write after a successful unload, or no supervisor, gets no further retry. Neither can
  restart spending, because the scheduler gate and the funnel already refuse.

## Full Findings Catalog

Round-by-round raw findings are in the session scratchpad review outputs; every design finding above
is listed with its resolution in "Original vs Converged" and the iteration table.

## Convergence verdict

Converged at the round cap (6). The last round's design findings were teardown failure-handling edge
cases; the cheap ones were applied and two were accepted with reasons (none affects safety, security
or data loss, because spending is stopped independently of teardown). Spec is ready for approval.
