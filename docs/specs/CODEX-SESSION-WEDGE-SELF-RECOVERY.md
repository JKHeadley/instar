# Codex Session-Wedge Self-Recovery — design (Phase 1, 12h autonomous)

**Status:** grounded gap-analysis (pre-spec-formalization)
**Tier:** 2 (fleet-wide session-reliability; self-healing)
**Author:** Echo · **Date:** 2026-06-03
**Origin:** Apprenticeship maiden voyage — Codey's (codex) conversational mentor session wedged and would NOT self-recover; it took a manual lifeline restart, then a full server restart + queued-message replay, by an external agent (Echo) to revive it.

**Requirement (Justin, 2026-06-03):** an INSTAR agent must **self-recover** — a codex agent must detect and heal its OWN wedged conversational session with NO external nudge. External/team recovery (the loop-driver) is a backup layer only; an independent agent has to heal itself no matter what.

## The wedge (grounded)

State observed: the codex **server was healthy and up** (uptime 78h, `/health` responding), but the **conversational session was paused** at the codex idle prompt ("Session paused. Send a message to resume."), and **delivered messages were not draining into a turn** — the lifeline reported messages "delivered to the session" yet no codex turn ran. The session sat dead while everything *looked* alive.

## Why nothing self-recovered it (the gap)

- **`ServerSupervisor`** (`src/lifeline/ServerSupervisor.ts`) monitors + auto-restarts the **server**. The server was UP → no action. It has no view of per-session turn progress.
- **`SessionWatchdog`** (`src/monitoring/SessionWatchdog.ts`) detects a **stuck Bash command** and escalates Ctrl+C → SIGTERM → SIGKILL → kill-tmux-session. Codey's session had no stuck child command — it was *paused with no active turn* → not its shape → missed.
- **`StuckInputSentinel`** (`SessionManager.fireStuckInputRecovery`, `:2904`) is the closest: it tracks an injected message and fires recovery if the injection is stuck at the prompt. But its recovery did not escalate to the server-restart + queue-replay that was actually required for a wedged codex session — so the wedge persisted.

Net: there is **no detector for "server healthy + session has pending/delivered input but makes no turn progress"**, and **no self-escalation path that ends in a server restart + replay**. That gap is the bug.

## The fix — self-recovery, escalating, autonomous

A per-session **progress-stall self-recovery** owned by the agent's OWN watchdog/supervisor (no external agent):

1. **Detect** (new signal): a session has delivered/queued input (lifeline shows pending) AND has made no turn progress (no new transcript/jsonl growth, no active child process, session at the idle/paused prompt) for > a threshold. This is "input present, not draining" — distinct from idle-with-no-input and from stuck-bash.
2. **Self-escalate recovery** (autonomous, the sequence Echo had to do by hand):
   - L1: re-inject / wake the session (send-keys), verify a turn starts.
   - L2: if still stalled → restart the **lifeline** (it re-polls + re-injects).
   - L3: if still stalled → restart the **server** via `ServerSupervisor` (kill cli.js server → launchd/supervisor respawns) and **replay the queued messages** on boot.
   - Each step verified (turn progress observed) before declaring recovered; audited to `logs/sentinel-events.jsonl`.
3. **Backup layer (not primary):** an external/team driver (the apprenticeship loop-driver) may ALSO perform this sequence on a peer — but the agent self-heals first, alone, no matter what.

## Precise extension point (grounded 2026-06-03)

`StuckInputSentinel` (`src/core/StuckInputSentinel.ts`) ALREADY detects a stuck prompt
(message at `❯`, no activity indicator, hash unchanged) and fires a BOUNDED escalation —
attempt 0,1 → `Enter`, attempt 2 → `C-m`, attempt 3 → `Enter+sleep+Enter` — then marks the
record **exhausted** and STOPS. That keypress ladder is the right first tier, but it tops
out at keypresses: it never escalates to the lifeline/server restart that Codey's wedge
actually required. **The fix is a new deeper escalation tier appended after the keypress
attempts exhaust AND the input is still stuck (still not draining):**
  - Tier A (existing): Enter / C-m keypresses (StuckInputSentinel attempts 0–3).
  - **Tier B (new): restart the lifeline** (re-poll + re-inject) — verify a turn starts.
  - **Tier C (new): restart the server** via `ServerSupervisor` + **replay the queue** — verify.
Each new tier is high-confidence-gated (input genuinely present + no progress + prior tier
exhausted), verified-recovery between steps, audited, and bounded (no restart loop). This is
the agent self-performing exactly the lifeline→server→replay sequence Echo did by hand.

## Reuse, don't reinvent

- Extend the existing `StuckInputSentinel` / `SessionWatchdog` rather than a parallel detector — they already track injection + per-session state. The new tiers hang off StuckInputSentinel's existing exhausted-record path.
- The L3 server-restart + replay is exactly what `ServerSupervisor.restart` + the lifeline queue-replay (`TelegramLifeline` "Replaying N queued messages") already do — wire the watchdog to trigger them autonomously on a confirmed input-not-draining stall.
- Ships behind a config gate, observe/dry-run first (it kills+restarts), graduated-rollout track. Migration-parity for existing agents.

## Tests (3 tiers)
- Unit: the stall detector (input-present + no-turn-progress + server-up → eligible; vs idle-no-input, vs active-turn → not eligible) and the escalation state machine (L1→L2→L3, verified-recovery between steps).
- Integration: a simulated paused session with a delivered-but-undrained message → the watchdog self-escalates to the server-restart trigger (dry-run assert).
- E2E: the wired self-recovery path is alive (server boot → watchdog → escalation primitives reachable).

## Cross-process trigger design (grounded 2026-06-03 — the load-bearing constraint)

A process-boundary fact decides the whole shape of L2/L3, and the original draft
glossed it:

- **`StuckInputSentinel` runs in the SERVER process** (`src/commands/server.ts:4512`).
- **`ServerSupervisor` (the restart authority) runs in the LIFELINE process**
  (`src/lifeline/TelegramLifeline.ts:286`). The lifeline supervises the server and
  owns queue replay (`TelegramLifeline.replayQueue()`).

So the sentinel **cannot call `ServerSupervisor.performGracefulRestart()` directly**
— it lives in a different process. L2/L3 must cross the boundary. The clean shape
(and the one that respects Signal-vs-Authority):

- **Detection = signal, in the server** (sentinel). **Restart = authority, in the
  lifeline** (ServerSupervisor). The sentinel does not own the restart; it REQUESTS
  one and the lifeline decides + executes.
- **Mechanism: a dedicated recovery-request signal file** (e.g.
  `state/session-recovery-requested.json`), NOT the reserved
  `state/lifeline-restart-requested.json` (that one is version-skew-only and
  documented hands-off). The request carries `{ sessionId, tier, observedAt,
  reason, attemptId }`. The lifeline polls it on its existing tick, executes the
  requested tier (re-deliver the pending message to that session for L2; restart
  the server + `replayQueue()` for L3), and writes a result/ack the sentinel reads
  back to VERIFY recovery (turn progress observed) before clearing the request.
- **Idempotency + boundedness:** the request is keyed on `(sessionId, attemptId)`;
  the lifeline ignores a duplicate request for an in-flight recovery; the sentinel
  will not re-request while one is unacked, and gives up after the bounded ladder
  (no restart loop — open item #2).

This means the L3 "fix" is not "kill the conversational session" — the wedge is a
delivered-but-undrained message, and what actually cleared it live was the
lifeline RE-DELIVERING the queued message (`Replay complete: 1 delivered`). So the
targeted primitive is **re-deliver-to-this-session**, with full server-restart +
replay as the heavy fallback only when re-delivery alone doesn't drain.

**Tier (revised, process-aware):**
- L1 — server/sentinel, direct: `fireStuckInputRecovery` keypresses (existing).
- L2 — request → lifeline: re-deliver the pending message to the wedged session;
  verify a turn starts.
- L3 — request → lifeline: `ServerSupervisor.performGracefulRestart()` + `replayQueue()`;
  verify. Hard-gated (open item #2) — highest blast radius.

## Detection is already codex-aware (grounded 2026-06-03)

`StuckInputSentinel.evaluateSession` (`:221–241`) ALREADY branches by framework: a
codex session with a pending injection uses MARKER-based detection
(`isMarkerStuckAtPrompt(pane, marker)` at the codex `›` prompt) — the exact wedge
shape (an injected message stuck at the prompt, not draining into a turn). So the
**detector fires for the codex wedge today**; what's missing is escalation *past
the keypress ladder*. No new detector is needed — the escalation hangs off the
existing exhausted-record path.

## Refinement: tiers A/B are SERVER-side, only tier C crosses to the lifeline

Re-injecting a message into a tmux session is a SERVER-side op (`SessionManager`),
and the sentinel runs in the server — so the cheaper tiers do NOT need the channel:

- **Tier A (server, existing):** `fireStuckInputRecovery` keypresses (Enter / C-m).
- **Tier B (server, NEW, direct):** re-inject the full pending MESSAGE (not just
  Enter) — a stronger server-side recovery the sentinel performs itself. No
  cross-process hop.
- **Tier C (lifeline, NEW, via channel):** `ServerSupervisor.performGracefulRestart()`
  + `replayQueue()` — the only tier that genuinely needs the lifeline (that's where
  ServerSupervisor lives), so it goes through `SessionRecoveryChannel`. Highest
  blast radius; hard-gated; ships dark + dry-run first.

So `SessionRecoveryChannel` is the boundary for **tier C only**; tiers A/B stay
in-process. This shrinks the cross-process surface to the single dangerous action.

## Build increments (each committed + tested; feature ships dark until complete)

1. **[done] `SessionRecoveryChannel`** — cross-process request/ack channel (tier C).
2. **Sentinel escalation state machine** (server) — after keypress exhaustion, if
   enabled: tier B re-inject (verify), then on continued stall request tier C via
   the channel, read the ack, verify, bound it (no restart loop), audit every
   transition. Emits requests but nothing executes them yet → safe/dark.
3. **Lifeline consumer** — on the lifeline tick, read pending requests, execute
   tier C (`performGracefulRestart` + `replayQueue`) with dry-run support, ack.
4. **Config gate** `monitoring.codexWedgeRecovery` (default off; `dryRun` first),
   graduated-rollout track, migration-parity.
5. **Tests** — unit (state machine + channel), integration (request→ack dry-run),
   E2E (wired path alive).

## Load-bearing finding: the restart-loop bound MUST be durable (grounded 2026-06-03, mid-Increment-3)

Tier C restarts the SERVER — and the server is where StuckInputSentinel's escalation
state machine lives. **A server restart wipes the sentinel's in-memory records,
including the `escalationTimeoutTicks` bound.** So if the session is STILL stuck
after the restart, the fresh sentinel re-detects → re-runs the keypress ladder →
re-escalates → requests another restart → **restart loop**, because the in-memory
bound reset to zero on the very restart it was meant to bound.

Fix: the restart bound must be **durable** (survive the server restart). The
LIFELINE consumer (which executes tier C and does NOT restart with the server)
enforces a per-session **durable cooldown**: before executing a tier-C restart it
checks `lastRestartAt(sessionId)`; if within `restartCooldownMs` it does NOT
restart — it acks `failed` (cooldown), and the (fresh) sentinel then gives up
bounded. Storage: extend `SessionRecoveryChannel` with `recordRestart/lastRestartAt`
backed by a durable file the lifeline owns. This is the real guard against the
highest-blast-radius failure mode (a wedge that restart can't fix → infinite
restarts). Increment 3 implements the executor AND this durable cooldown together.

Verification model: the lifeline acks `recovered` on MECHANICAL success (restart +
replay completed) — it cannot see panes, so it does not verify semantic drain. The
new sentinel verifies semantically: drained → no new request; still stuck → one
more request → lifeline's durable cooldown blocks the re-restart → bounded stop.

## Open (for spec-formalization + cross-model review)
1. The exact "no turn progress" signal for codex `exec --json` vs interactive TUI (jsonl growth + child-proc + prompt-state, per StaleSessionBackstop's ProgressSnapshot).
2. Server-restart blast radius: L3 restarts the whole agent — gate it hard (only on a high-confidence, verified input-not-draining stall past a long threshold) to avoid restart loops.
3. Interaction with the silently-stopped trio + ContextWedgeSentinel (which already respawns for the thinking-block wedge) — this is the SIBLING for the paused-input-not-draining wedge.
4. The recovery-request signal contract (fields, ack/clear protocol, where the lifeline-side consumer hangs off its tick) — needs to be specced concretely before build; reuse the version-skew signal *pattern* but a dedicated file + consumer.
