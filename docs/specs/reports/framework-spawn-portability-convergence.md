# Convergence Report — Framework-spawn portability

## ELI16 Overview

A Codex-only agent ("codey") was answering Telegram messages by
starting Claude sessions instead of Codex sessions. The whole point
of installing an agent as Codex-only is that it runs on Codex — so
this was a direct violation of the user's setup choice.

The cause was a split-brain config problem. The setup wizard saves
your framework choice in one field (`enabledFrameworks`), but the
code that actually starts a session was reading two *other* fields
that the wizard never sets. On top of that, the specific code path
that handles incoming messages didn't read any config at all — it
just hardcoded "claude-code." So Codex agents always fell back to
Claude when a message came in.

The fix makes `enabledFrameworks` the authority that flows into the
running agent, and routes both session-start paths (message-driven
and scheduled-job-driven) through the same resolution logic. Because
the fix derives the framework at config-load time from a field
existing agents already have on disk, deployed Codex agents are
fixed the moment they update — no reinstall, no migration.

## Original vs Converged

The original draft proposed only fixing the hardcoded default in the
message-handling spawn path (Bug 1). Review surfaced that this alone
would not fix anything: even after reading config, the config field
the runtime consulted was empty for every wizard-installed agent,
because the wizard writes `enabledFrameworks` while the runtime read
`sessions.framework`. The converged spec adds the second, deeper fix
(Bug 2) — making `resolveConfiguredFramework` read `enabledFrameworks`
and storing the result as a first-class `config.framework` value —
and clarifies that BOTH spawn paths must resolve identically. The
converged spec also documents why no migration is needed (load-time
derivation fixes existing agents), which the original left ambiguous.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | integration, adversarial, security | 5 | Added Bug 2 (config-field mismatch) as the load-bearing root cause; documented precedence order; documented no-migration rationale; added explicit `INSTAR_FRAMEWORK=claude-code` env handling; clarified per-call override remains highest precedence |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Iteration 1**

- **integration (high)** — "Fixing the hardcoded default in
  spawnInteractiveSession is insufficient: the wizard persists
  `enabledFrameworks`, but `resolveConfiguredFramework` reads
  `sessions.framework` + env, neither set by the wizard. The runtime
  will still resolve claude-code." → Resolved: added Change 1
  (resolveConfiguredFramework reads enabledFrameworks[0]) and Change 2
  (Config.load stores resolved framework as config.framework).

- **integration (high)** — "Two spawn paths (spawnSession,
  spawnInteractiveSession) must resolve framework identically or the
  bug recurs on the path that wasn't fixed." → Resolved: Change 3
  routes both through resolveInteractiveFramework with
  configFramework: this.config.framework.

- **adversarial (medium)** — "Does this fix already-deployed codey
  without forcing a reinstall? If it requires a config migration, the
  fix is incomplete for the agent that hit the bug." → Resolved: added
  "Why this fixes existing agents on update" — load-time derivation
  from on-disk enabledFrameworks, no migration needed.

- **security (low)** — "Precedence must keep per-call options.framework
  authoritative so a caller can still force a framework; ensure the new
  enabledFrameworks input does not override an explicit per-call or env
  choice." → Resolved: documented precedence — per-call > sessions.framework
  > env > enabledFrameworks[0] > claude-code.

- **integration (low)** — "INSTAR_FRAMEWORK=claude-code env value
  previously fell through to default; now that enabledFrameworks can
  override the default, an explicit claude env must be honored over
  enabledFrameworks." → Resolved: added explicit claude/claude-code env
  branch ahead of the enabledFrameworks check.

**Iteration 2** — No material findings. Converged.

## Convergence verdict

Converged at iteration 2. No material findings in the final round.
The fix is narrow (one precedence change, one config field, two
one-line spawn-path edits), fully covered by the new
framework-spawn-portability unit suite, and fixes deployed Codex
agents on update without a migration. Spec is ready for user review
and approval.
