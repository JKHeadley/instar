# Calm Transient-Episode Alerting (machine-coherence + rope probe)

**Status:** DRAFT — pre-convergence. Written 2026-07-11 from the topic-29836 alert-noise investigation; must run `/spec-converge` and receive `approved: true` before any build.

**Operator directive (topic 29836, 2026-07-11):** "Can you look into all of the alerts I've been getting? Either they are too noisy or this needs to be fixed. Also, we should take this opportunity to review why these issues are being handled/fixed internally automatically, and how we can upgrade our system to handle them automatically (if they are real issues)."

## The problem (verified, not assumed)

The operator's 🔔 Attention hub received a burst of HIGH machine-coherence alerts + NORMAL rope-probe notices on 2026-07-11 (9 machine-coherence-guard items since 7/10; 8 of 13 pool items raised by the Laptop). **Every flagged condition was real AND self-healed within ~30 minutes** — version skew during a routine rolling auto-update (restored notices at 6:09 PM and 7:20 PM), and rope latency demotion while the Laptop's mesh links warmed up after it rejoined.

Verified mechanics (from source, v1.3.827):

- `classifyVersionSkew` (machineCoherenceEvaluate.ts) already grace-gates: patch-only skew confirms only after `versionSkewGraceMs` (default 45 min, MachineCoherenceSentinel.ts) of continuous skew; major-minor confirms in 2 ticks. **The gate worked as designed — the update wave simply outlasted it** (the Laptop lagged ~72 min). The alert then fired at HIGH with a fix-it/leave-it decision prompt for a condition that healed itself 27 minutes later.
- On heal, the episode manager (machineCoherenceEpisodeManager.ts `closeEpisode`/'restored') resolves the attention item with a note ("machine-coherence restored — … held for N ticks") — which lands as a SECOND hub message. Net: every transient episode costs the operator two-plus notifications, one of them HIGH.
- The rope prober's slow-but-alive escalation ("answers probes but stays demoted — probing continues at the floor cadence", raised NORMAL via the attention sink wired in server.ts) is purely informational: it names no action, and by its own text the system is already handling it. Exhaustion ("not recovering") is the actionable sibling.

The system IS self-healing correctly. The defect is narration: it alerts at decision priority on states it is mid-way through healing, and speaks twice per episode.

## Design principles

1. **Alert = action needed or persistent.** A condition the system predictably heals (a rolling update in flight and progressing) is not operator-actionable; only a STALLED heal is.
2. **One episode, one voice.** A transient that self-heals produces at most one calm, low-priority line — never an alarm plus a separate all-clear.
3. **Signal-only changes.** Nothing in this spec changes what is DETECTED, gated, or recovered — only when/at-what-priority/how-often the operator is told. Detection, episode state, audit trails (logs/machine-coherence.jsonl, sentinel events) are untouched.
4. **Fail toward today's behavior.** Every predicate failure (can't read updater progress, can't edit a message) falls back to the current alerting, never to silence beyond what today ships.

## M-P1 — Progress-aware patch-skew confirmation

Replace the fixed 45-min grace with a progress-extended one for the `version` dimension, patch-only severity:

- While patch-only skew is within `versionSkewGraceMs` → unconfirmed (today's behavior).
- Past grace, BEFORE confirming: check **lag progress** — has the lagging machine's advertised `instarVersion` ADVANCED (any increase) within the last `versionSkewProgressWindowMs` (default 30 min)? If yes, extend (reset the grace clock once per advance). An advancing laggard is an update wave in motion, not an incident.
- Confirm (and raise) only when skew has persisted past grace WITH NO advance in the progress window — i.e., the laggard's updater looks stalled — or immediately per today's rules for `major-minor`.
- Hard ceiling: `versionSkewStallCeilingMs` (default 3 h) — skew older than this confirms regardless (a laggard crawling one patch per 25 min for hours is still broken).
- Data source: the same coherence adverts the evaluator already compares (last-seen version per machine + advert timestamps). No new channel. Unreadable/ambiguous progress → treat as no-advance (fail toward today's louder behavior).

## M-P2 — Self-healed episodes speak once, calmly

- **Priority honesty:** a patch-only version-skew episode raises at **NORMAL**, not HIGH (self-heal is its statistically normal outcome; the fix-it/leave-it decision prompt is retained). `major-minor`, flag, manifest, and protocol episodes keep today's priority. A patch-only episode that later trips the stall ceiling is re-raised at HIGH (escalation on persistence, not on appearance).
- **The restored line stops being a second notification:** on 'restored', instead of posting a new hub message, EDIT the episode's original hub message to prepend a resolution banner ("✅ Healed itself — <keys> agree again across <nicknames> (<duration> open)"), via the existing attention-item → hub-message mapping. If the edit fails (message too old, id unknown, API error) → fall back to today's separate resolve note sent SILENT (disable_notification). Either way the attention item resolves exactly as today.
- No change when the operator interacted (fix-it/leave-it/ack) — an episode a human touched closes with today's explicit notification.

## M-P3 — Rope slow-but-alive routes to the digest, not the hub

- The `rope-probe-slow-alive` escalate-once no longer raises an attention item. It records to `logs/sentinel-events.jsonl` (existing rope-health audit surface) and is picked up by the existing `rope-health-digest` job (the daily digest already classifies degraded ropes — this is its exact intended content).
- `rope-probe-exhausted` (not recovering) keeps its attention item unchanged — that one names a genuinely stuck state.
- Wiring: the server's attention-sink wrapper for the prober filters by escalation id prefix; the prober itself is untouched (it already treats the sink as best-effort observability).

## Config

Under `monitoring.machineCoherence`: `versionSkewProgressWindowMs` (30 min), `versionSkewStallCeilingMs` (3 h), `patchSkewPriority` ('NORMAL'), `resolveEditsOriginal` (true). Under `monitoring.ropeHealth`: `slowAliveToDigest` (true). All hot-tunable where the component reads config live; absent keys preserve shipped defaults. Rollback = flip the relevant flag; every mechanism degrades to exactly today's behavior.

## Explicitly out of scope (tracked separately)

- **Agent-level (cross-machine synced) quiet-settings** — the deeper fix for "the Laptop missed the Mini's quieting." Requires its own design (config-sync semantics, authority, conflict rules) and an operator decision; being brought to the operator as a design before any build (CMT-834).
- Message FORMATTING (shipped separately: PR #1454).
- Any change to detection, episode lifecycle audit, duplicate-reconciliation, or the fix-it/leave-it consent flow.

## Open questions for convergence

1. Exact mechanics of the restored-note post today: confirm whether the resolve note rides `updateAttentionStatus` or a direct hub send, and whether the hub message id is durably retrievable for the edit path (episode state currently stores `attentionItemId`; the hub MESSAGE id mapping must be verified/added).
2. Should M-P1's progress check also cover the FLAG dimension when the divergent flag's value converges monotonically during a rolling config migration? (Default position: no — flags don't "progress"; keep 2-tick confirm.)
3. Multi-machine raiser election interaction: the progress-extended clock is per-raiser state; verify the elected-raiser handoff (N1 identity) doesn't reset the clock and re-grace indefinitely under raiser flapping (candidate: persist first-seen-at in the shared advert marker, as the confirmation engine already does for grace).
4. Priority for a patch-skew episode whose laggard is the LEASE HOLDER (serving machine lagging may deserve more urgency?). Default: same NORMAL.

## Test obligations (Testing Integrity Standard)

- Unit: progress-extension predicate (advance resets once per advance; no-advance confirms; ceiling overrides; unreadable adverts → no-advance), priority selection per dimension/severity, restored-edit fallback ladder (edit-ok / edit-fail→silent-note), rope sink filter (slow-alive suppressed to log, exhausted passes).
- Integration: episode lifecycle end-to-end with a simulated update wave (skew → advance → extend → heal → ONE edited message); stall path (no advance → NORMAL raise → ceiling → HIGH re-raise).
- E2E: feature-alive checks for the config keys + the digest routing.
- Live-pair verification on the real Mini+Laptop before enabling beyond the dev agent (Live-User-Channel Proof; multi-machine fixes must be live-verified — synthetic symmetric state gives false confidence).
