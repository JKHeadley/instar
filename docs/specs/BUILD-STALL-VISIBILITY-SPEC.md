---
title: "Build Stall Visibility — Three Fixes for the Silent /build Wait"
slug: "build-stall-visibility"
author: "echo"
status: "converged"
review-convergence: "2026-04-19T19:20:00Z"
review-iterations: 1
review-completed-at: "2026-04-19T19:20:00Z"
review-report: "docs/specs/reports/build-stall-visibility-convergence.md"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-04-19"
approval-note: "Approved via Telegram topic 2169 — 'Yes' after reviewing ELI10 summary of 13-finding internal review."
---

# Build Stall Visibility

## Problem

On 2026-04-19 an echo session running `/build` went silent for 18+ minutes while the full test suite ran. The user (Justin) could not tell whether the agent was working, stuck, crashed, or waiting for quota. The session was actually fine — just inside a long `Monitor` wait on `npm test` — but nothing surfaced that fact. Three compounding gaps produced the opaque "dead air" experience:

1. **A referenced hook file was never deployed to disk.** Every time `/build` fired a `Stop` event, Claude Code tried to run `.instar/hooks/instar/build-stop-hook.sh` because the file is listed in `.claude/settings.json`. The file was missing, so the hook emitted `bash: No such file or directory` six times during the stall. Non-blocking, so no failure propagated — but the structural enforcement the skill depends on wasn't actually running.
2. **`/build` has no heartbeat while it waits inside a long tool call.** When the test suite, `tsc`, or any similar command takes 10–20 minutes, the skill emits no user-facing signal. The existing standby lifeline (20s/2min/5min tiers) classifies this as "agent is actively working" and stays silent — correctly, because the agent *is* working, but that distinction is invisible from outside.
3. **The lifeline cannot distinguish "actively working on new output" from "blocked on a long-running tool."** Its signal today is just "did the pane keep churning?" — which is true for a Monitor holding a subprocess open. An 18-minute wait and an 18-minute flurry of productive work look identical.

## Three fixes

### Fix 1 — Deploy `build-stop-hook.sh` on every upgrade, and flag drift

Move `build-stop-hook.sh` from a one-shot conditional copy in `src/commands/init.ts` into the canonical `PostUpdateMigrator.migrateHooks` loop. Every instar upgrade writes the file, the same way every other instar-owned hook is written. Share the content with `init.ts` via `PostUpdateMigrator.getHookContent('build-stop-hook')` so both paths produce the same bytes.

Add `PostUpdateMigrator.validateHookReferences(hooksDir, result)` — runs at the end of `migrateHooks`. Parses `.claude/settings.json` and reports drift between hooks referenced in settings and files present on disk.

**Safety guards (from review):**

- **Parse robustness.** `validateHookReferences` wraps `JSON.parse` in try/catch; bounds file size (64 KB cap) before parse; on any failure emits one `result.errors` entry and continues. Settings.json parse failure NEVER aborts `migrateHooks` — hook deployment happens first (see ordering below), validation second, so a malformed settings.json cannot block the deployment Fix 1 is fixing.
- **Path resolution.** Every extracted command path is resolved with `path.resolve(projectDir, match)` and verified to be a descendant of `projectDir + '/.instar/hooks/'` (prefix check on resolved path + separator). Symlinks are not followed (`fs.lstat`). Path-traversal strings (`../`) cannot escape the hook tree.
- **Scope split.** Missing files under `.instar/hooks/instar/` (instar-owned) go to `result.errors` — these are always bugs. Missing files under `.instar/hooks/custom/` or any other prefix go to `result.warnings` — may be user intent (hand-edited to reference not-yet-installed custom hooks). Agents' CI that keys on `errors.length === 0` is preserved for the legitimate case.
- **Ordering.** `migrateHooks` writes `build-stop-hook.sh` BEFORE calling `validateHookReferences`. Validator runs last, so a structural issue in settings.json cannot prevent the file it flags from existing.
- **Content hash assertion.** On every migrator run, the written `build-stop-hook.sh` is immediately re-read and its SHA-256 compared against the expected hash of `getHookContent('build-stop-hook')`. Mismatch emits a tamper warning and triggers a single overwrite retry. Catches silent filesystem corruption and partial-write races.

Signal-vs-authority: the validator is a hard structural invariant check at the system boundary (file existence), which `docs/signal-vs-authority.md` explicitly permits as brittle-blocking. It has no runtime message-flow authority. Errors are reports, not migration blockers.

### Fix 2 — `/build` emits mid-run heartbeats

Inside the `/build` skill's long-tool waits, emit a one-line status update to the channel the agent was invoked from (Telegram topic or Slack channel) at two triggers:

- **Phase boundary** — once per transition (PLAN → EXECUTE → VERIFY → HARDEN → COMPLETE).
- **Wall-clock cadence** — every ~5 minutes of continuous tool time inside a phase, with no new agent text output between AND no outbound message of any kind in the last 4 minutes (debounce).

**Routing (from review).** Heartbeats are dispatched through `ProxyCoordinator` as a typed `build-progress` event. `PresenceProxy` suppresses its generic 5-min standby message while a `build-progress` event is active for the same topic/channel (single-authority principle — one progress message per tick, not parallel streams). `PromiseBeacon` listens for `build-progress` events whose phase matches a tracked commitment and refreshes the beacon window rather than firing a duplicate nudge.

**Content shape.**

- Template: `"/build — <phase>, tool=<toolName>, elapsed=<Nm>, status=<still-working|no-progress-detected>"`.
- `toolName` comes from an **allowlist** (`Monitor`, `Bash-test`, `Bash-tsc`, `Bash-install`, `Bash-lint`, `Bash-other`). Never raw argv, paths, or stdout. Prevents secrets/path leakage.
- `<phase>` is from the enumerated phase set. Never free-form.
- `status` flips to `no-progress-detected` after three consecutive heartbeats with zero child-stdout byte delta (crying-wolf mitigation — real hang doesn't read as "still working").

**Concurrency and idempotence.**

- Heartbeat state is keyed by `{runId, phase}`. Only the outermost `/build` for a given `runId` emits. Nested/chained builds register as children and inherit the outer run's heartbeat owner — no double-emission.
- Per-worktree advisory lock around phase transitions. A second `/build` started in the same worktree rejects with "already running (runId=…)".
- Per-channel token-bucket at the dispatch layer: min 60s between heartbeats, burst 3. Fast phase boundaries (PLAN→EXECUTE in seconds) coalesce to one summary line within a 60s window.

**Gate routing.** Heartbeats are classed `system-structural` — a templated-outbound kind. `OutboundGate` fast-paths this class: structural validators only (non-empty, within length bound, fields match the template), no LLM tone-gate invocation. Rationale: templated system messages with enumerated fields are not agent prose and do not need judgment. Addresses gate_latency_vs_client_timeout memory. Sentinel still observes them for telemetry.

Signal-vs-authority: produces a typed signal that feeds the existing `ProxyCoordinator` authority. No new block/allow decision. Tone-gate bypass is permitted because the content surface is enumerated (template + allowlisted fields), not free-form — doc §"When this principle does NOT apply," structural-validator case.

### Fix 3 — Long-tool-wait detection in the lifeline

Extend the lifeline's "is the agent working?" heuristic to distinguish two cases: "agent is producing new text output" (healthy churn) vs. "agent is blocked on a single tool that's been running >N minutes with no new output between" (long-wait). When the long-wait case is detected, the standby message the lifeline emits swaps from generic ("agent is still working") to specific ("agent is blocked on `<tool>` — elapsed Nm with no new output").

**Threshold and hysteresis (from review).**

- Enter long-wait state at 8 minutes single-tool wall time with no interleaved agent text.
- Exit long-wait only after 60s of sustained new agent-text output — prevents flapping on tools that emit one line after 7:59 then resume silence.
- State transitions are the only emit trigger — not every tick. Prevents churn at the threshold.

**Feature flag (from review).** `lifeline.longToolWaitDetector` — default `false` for the release that introduces the detector. Flip default to `true` in the following release after telemetry confirms low false-positive rate on the explicit opt-in cohort. Threshold (minutes), exit-hysteresis (seconds), and escalation cap are all tunable through config without code deploy.

**Escalation cap.** After 30 min of continuous long-wait (configurable), escalate once to the attention queue — NOT a repeat 5-min-cadence message. Prevents user habituation to the standby line when a tool is genuinely hung.

**Detector state.** Single `lastAgentTextTimestamp` cursor plus `currentToolName` maintained across lifeline ticks. O(1) per tick; no re-read of full scrollback.

Signal-vs-authority: this is a detector change. It produces a richer signal (tool identity + elapsed time + zero-delta boolean) that feeds the existing standby authority in `PresenceProxy`. No new blocking decision added. `PresenceProxy` is the one authority deciding whether to post and what to say.

## Non-goals

- **Stopping long test runs.** Tests taking 18 minutes is a separate problem. This spec only addresses visibility.
- **Replacing the quota-exhaustion detection** in standby (shipped in v0.25.1). That path handles a different failure mode and is orthogonal.
- **Changing the /build pipeline's structure.** Phases, gates, and state machine stay as-is.

## Acceptance

- Every instar upgrade installs `build-stop-hook.sh` unconditionally.
- `validateHookReferences` reports any missing `.instar/hooks/instar/*` path listed in settings.json.
- `/build` emits a heartbeat to the agent's source channel at each phase transition AND every ≤5min of continuous tool time inside a phase.
- The lifeline's standby message becomes tool-specific when a single tool has been running >8 min with no interleaved agent text.
- Full test suite green, TypeScript clean.
- Side-effects artifact produced covering all three fixes.

## Rollback

Each fix is independently revertable:
- Fix 1 — revert three files, patch release.
- Fix 2 — revert skill edits + heartbeat helper, no persistent state touched. `ProxyCoordinator` stops receiving `build-progress` events; `PresenceProxy` falls back to generic standby behavior automatically.
- Fix 3 — flip `lifeline.longToolWaitDetector: false` (config-only rollback, no deploy). Hard rollback: revert detector change; authority layer unchanged.

## Dashboard surface

Heartbeats emit as SSE events on `/events` with type `build.heartbeat` (fields: `{runId, phase, tool, elapsedMs, status}`). The dashboard session card renders the latest heartbeat under the session status line. Additive surface; no new auth or gating.

## Multi-machine

Heartbeat runtime state is in-memory per agent server — nothing git-synced, no cross-machine coordination needed. `instar-dev-traces/` already namespaces by machineId (agent registry convention). No new sync surface.

## Evidence (pre-fix)

Captured 2026-04-19 from tmux `echo-instar-agent-robustness`:

```
⏺ Ran 6 stop hooks (ctrl+o to expand)
  ⎿  Stop hook error: Failed with non-blocking status code:
     bash: .instar/hooks/instar/build-stop-hook.sh: No such file or directory

✻ Cogitated for 5m 12s · 1 shell, 1 monitor still running
  Waiting for the full-suite monitor to fire before committing.
```

User observation: "What happened here? Why did the session stall?"
