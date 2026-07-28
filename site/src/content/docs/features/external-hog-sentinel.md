---
title: External-Hog Zombie Auto-Kill Sentinel
description: A dev-gated, watch-only-until-armed watcher that surfaces sustained external CPU hogs and auto-kills exactly one narrow class — orphaned editor extension-host zombies — behind a mechanical veto-only safety floor and a PIN-gated arm.
---

Some background helper processes — the little program an editor spins up to run an extension — can
get orphaned when their editor window closes and then quietly peg your CPU for hours. One such
zombie (a VS Code MongoDB-extension host) pinned ~2.2 cores for ~24 hours. The **External-Hog
Zombie Auto-Kill Sentinel** watches for that pattern: it surfaces *any* sustained external CPU hog
(broad observability) and can auto-kill exactly **one narrow class** — orphaned Electron editor
extension-host wrappers — and nothing else.

## The two-key kill rule

A kill executes **iff `floor_pass && classifier === 'kill'`** — a two-key AND of independently
necessary conditions:

- **The mechanical safety floor can only VETO a kill, never order one.** Kill-*safety* is carried
  entirely by the deterministic floor: same-uid non-root, the specific spawning parent is dead
  (orphaned-owner), not a launchctl-managed job, a sustained N-window CPU delta, a code-defined
  allowlist class, and a fresh kill-time CPU re-confirm.
- **The intelligence carries EFFECTIVENESS, not safety.** The model decides kill/leave/alert
  *within* the set the floor already proved safe — it can only ever SPARE a process, never widen the
  target set. A prompt injection in an attacker-controlled process name can at worst get a kill of a
  zombie-shaped process the attacker themselves crafted, never anything outside the floor.

## Safety posture

Ships **dev-gated DARK on the fleet** (`monitoring.externalHogSentinel.enabled` is omitted from
defaults, so `resolveDevAgentGate` resolves it — live on a development agent, dark on the fleet) and
**watch-only `dryRun`** even there. A real kill needs a deliberate **PIN-gated arm**
(`POST /external-hog/arm`); the armed marker binds the operator's PIN consent to the current
allowlist-class content-hashes, and a disarm can never be silently un-done (epoch monotonicity).

## Surface

- `GET /external-hog` — status (honest guard posture, `on-stale` when blind) + the durable arm state.
- `POST /external-hog/arm` — PIN-gated (a Bearer token cannot arm a real kill).
- `POST /external-hog/disarm` — Bearer (the safe direction).

## Architecture (the modules)

The feature is built as small, independently-reviewed pure modules with the impure edges isolated:

- **`ExternalHogSentinel`** — the composition shell that holds cross-tick state and delegates each
  scan to the orchestrator.
- **`ExternalHogScanTick`** — the orchestrator that composes every module into one scan tick.
- **`ExternalHogFloor`** — the pure veto-only safety floor + the code-defined allowlist.
- **`ExternalHogSampler`** — stage-1 candidacy (cross-tick CPU delta).
- **`ExternalHogSustained`** — the stage-2 N-window sustained-CPU confirmation (anti-spike).
- **`ExternalHogCpuDelta`** — monotonic-clock core-equivalents math.
- **`ExternalHogFactBuilder`** — the deterministic fact + identity derivation (ownerAppRunning, etc.).
- **`ExternalHogClassifier`** + **`ExternalHogClassifierPrompt`** — the kill/leave/alert verdict
  parse + the injection-hardened prompt boundary.
- **`ExternalHogKillFunnel`** — the hardened kill sequence (watch-only by construction).
- **`ExternalHogKillLedger`** — the P19 respawn breaker + kill ledger.
- **`ExternalHogArmMarker`** + **`ExternalHogArmStore`** — the PIN-arm authorization gate + its
  durable, epoch-monotone marker.
- **`ExternalHogGuardStatus`** — the honest `/guards` posture rule.
- **`ExternalHogOwnership`** — the instar-owned ancestry walk.
- **`ExternalHogProcTable`** — the `ps` table parser.
- **`ExternalHogNoticeCoalescer`** — P17 notice coalescing.
- **`ExternalHogRealAdapters`** + **`ExternalHogServerPrimitives`** — the impure edge binding the
  pure modules to the real OS (ps/launchctl/lsof, `process.kill`, the model call, the §4.5 kill-time
  CPU re-confirm probe).

## When to use it

Ask "what's pinning my CPU / is anything a runaway?" and read `GET /external-hog` — `recentOutcomes`
lists the sustained hogs, killed or left-alive. If an editor helper was killed, it was an armed,
orphaned (its editor dead), sustained editor-exthost zombie that both the floor and the model
cleared. On the fleet the routes 503 (dark) — the feature is a strict no-op there until deliberately
enabled and PIN-armed.
