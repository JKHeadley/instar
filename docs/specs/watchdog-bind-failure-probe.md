---
title: Fleet watchdog bind-failure probe
date: 2026-05-19
author: echo
review-convergence: internal-plus-second-pass-2026-05-19
approved: true
approved-by: Justin
approved-via: Telegram topic 5447 ("please go ahead" at 2026-05-19 18:48 UTC)
eli16-overview: watchdog-bind-failure-probe.eli16.md
---

# Spec — Fleet watchdog bind-failure probe

**Date:** 2026-05-19
**Author:** echo
**Status:** in-flight (approved 2026-05-19 in topic 5447)

## Background

On 2026-05-17 I shipped the fleet watchdog + peer-escalation (PR #245). The watchdog detects "launchd has loaded the plist but the process keeps exiting" (crash-loop), heals what it can, and escalates to a healthy peer's `/attention` endpoint after N consecutive heal failures.

Two days later, AI Guy went down in a way the watchdog didn't detect.

The failure: a `codex-server-smoke` plist had been revived alongside Sunday's housekeeping. Both `ai.instar.codex-server-smoke` and `ai.instar.ai-guy` were configured for port 4040. On reboot, codex-server-smoke bound 4040 first. AI Guy's *lifeline* came up fine (no launchd crash-loop — launchd sees a healthy process), but its *server* couldn't bind. Inside the lifeline, the supervisor tried to spawn the server 4,163 times over two days; every attempt failed with "Health check failed" / "server didn't bind in spawn window." The supervisor logged "Suppressing duplicate server down notification (4163 suppressed this outage)." No alert reached Justin.

The watchdog from PR #245 has no signal for this shape — its only failure detector is `launchctl list <label>` showing `LastExitStatus != 0` with no PID. AI Guy's lifeline had a PID and a clean exit status; the failure was one layer deeper.

## Goal

Add a fleet-watchdog probe that detects "lifeline is alive but the agent's server is unreachable or bound by a different agent." After this ships, the AI-Guy-stuck-behind-codex pattern surfaces to Justin via the existing tone-gated peer escalation within ~15 minutes, instead of indefinitely.

## Scope

### Change 1 — `probe_server_identity` function in the fleet watchdog

**File:** `src/templates/scripts/instar-watchdog.sh`.

For each agent that launchctl reports as loaded-and-running (a PID exists, `LastExitStatus == 0`), the new probe:

1. Reads the agent's `.instar/config.json` from the plist's `WorkingDirectory`. Extracts `port`.
2. If `port` is null/empty: skip — this agent doesn't run a server (some agents are lifeline-only).
3. `curl -sS --max-time 5 http://localhost:$port/health` — parses the response body.
4. If curl fails OR returns non-200: the server is unreachable.
5. If the response is 200 but the body's `project` field does NOT match the agent name (label minus `ai.instar.` prefix), some OTHER agent is on the port — this agent's server is locked out.

Either condition (unreachable, or wrong project) is a `BIND-FAIL` signal. Logged as:

```
BIND-FAIL: ai.instar.ai-guy — port 4040 owned by codex-server-smoke (expected ai-guy)
BIND-FAIL: ai.instar.ai-guy — port 4040 unreachable while lifeline alive (PID 89873)
```

### Change 2 — Reuse the existing heal + escalate path for `BIND-FAIL`

After detecting BIND-FAIL, the watchdog calls `try_self_heal "$project_dir" "$label"` (same as for crash-loops). If the heal can't fix it (the shadow-install is fine, it's just a port collision the watchdog can't unstick on its own), the consecutive-fail counter increments and after 3 cycles (~15 min) escalates via `escalate_via_peer`.

The `try_self_heal` function adds one new heal step: **kill conflicting tmux sessions for the agent**. The pattern that bit AI Guy was `ai-guy-server` tmux session missing entirely (the supervisor's spawn-into-tmux had been failing for 4,163 cycles). The new step:

- Detects the agent's expected tmux session name (`<projectName>-server`).
- If the session is missing AND BIND-FAIL is the signal, request a lifeline restart by clearing the agent's `lifeline-started-at.json` marker (the lifeline rebuilds its supervisor state on next start) and bootout/bootstrap-ing the launchd job.

If the conflicting party is a peer instar agent (the actual scenario today), the heal cannot recover by itself — the OTHER agent's server is legitimately running on the port. In that case the heal returns "no fixable issues found" and the counter advances. Per PR #245's contract, after 3 cycles the user gets a peer-escalated Telegram message: "AI Guy is offline — repair attempts aren't working — want me to dig in?"

### Change 3 — Diagnostic payload upgrade

When `escalate_via_peer` fires for a BIND-FAIL, the alert payload's `summary` includes the conflicting-party context if known. Default copy still passes the B12 jargon screen:

> "AI Guy hasn't been able to start its server because another agent is using its port. My repair attempts haven't fixed it. Want me to dig in?"

If conflicting party can't be determined: fallback summary is the existing "offline for about X minutes" copy.

The payload's `description` always remains "Want me to dig in?" (B14 CTA compliance).

## Non-goals

- **Not changing the per-agent supervisor.** PR #111 already added bind-failure escalation INSIDE the supervisor for the case where the server's own preflight detects the issue. This PR adds the OUTSIDE-the-lifeline detection layer: when the supervisor's escalation never reaches the user because the supervisor itself is in the suppression-loop state, the watchdog independently detects the same condition.
- **Not auto-resolving port conflicts.** Picking which agent gets the port when two are configured for the same one is a policy decision (configuration error, not a runtime decision). The watchdog surfaces the conflict; the human resolves it.
- **Not modifying config.json.** The watchdog is strictly read-only on agent configuration.

## Acceptance criteria

1. **Probe — happy path.** Healthy agent with correct project on its configured port: probe returns 0, no log lines emitted at non-verbose level.
2. **Probe — port held by wrong project.** Set up fixture A on port P with project name "A"; configure fixture B's plist with port P. Probe of B emits `BIND-FAIL: ai.instar.B — port P owned by A (expected B)` and triggers `try_self_heal`.
3. **Probe — port unreachable.** Lifeline alive but server not running on the configured port. Probe emits `BIND-FAIL: ai.instar.X — port P unreachable while lifeline alive` and triggers `try_self_heal`.
4. **Escalation cadence.** Three consecutive BIND-FAIL detections for the same label trigger `escalate_via_peer` once. Counter resets on next successful probe.
5. **No false alarms for lifeline-only agents.** An agent with no `port` in config.json is skipped by the probe; no BIND-FAIL log line emitted.
6. **Payload includes conflict context.** When the probe knows the conflicting project, the escalation summary names it. When unknown, falls back to the generic offline copy.
7. **Tone gate compliance.** Test asserts the escalation payload has no B12 jargon (`crash-loop`, `lifeline`, `shadow`, `launchd`, `pid`).

## Signal-vs-authority compliance

Reference: `docs/signal-vs-authority.md`.

- `probe_server_identity` is a structural detector. Inputs: file existence (`config.json`), curl HTTP code, JSON response field. Output: a signal (BIND-FAIL with structured context). No block/allow decision is made.
- The counter (`consecutive-heal-fails`) is a brittle threshold (`>= 3`). Per the principle's §"When this principle does NOT apply", this is an idempotency-key / mechanic, not a judgment call.
- The escalation payload is a *candidate* user-facing message. The decision to ship that message rests entirely with `MessagingToneGate` via the `/attention` route (the existing authority). On 422, the safe-template retry from PR #245 still applies.

This PR adds NO new blocking authority.

## Interactions

- **PR #245 (fleet watchdog + peer escalation).** This PR's BIND-FAIL path feeds the same `try_self_heal` → counter → `escalate_via_peer` pipeline. No changes to the escalation surface.
- **PR #111 (lifeline self-heal hardening).** That PR added in-supervisor bind-failure escalation. This PR adds the parallel out-of-lifeline detection layer. Both can fire on the same outage; idempotency-by-id in `/attention` (using the existing per-cycle suffix) prevents duplicate Telegram topics.
- **v3 Self-Healing Remediator (approved 2026-05-13, not yet built).** This is more plumbing that Tier-3 Fleet Intelligence will absorb. The probe becomes a `Probe` in v3 terms; its output feeds the Remediator's audit log; NovelFailureReviewer clusters bind-failure patterns. Until then, this is the minimum plumbing that surfaces the AI-Guy-stuck-behind-codex outage class.

## Rollback

Pure code change to one bash template + tests. Revert and ship as a patch release. No persistent state changes. No user-visible regression during rollback.
