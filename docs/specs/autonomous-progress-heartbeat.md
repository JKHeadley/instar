---
title: "Autonomous-Session Progress Heartbeat — convert the report-every-30m instruction into a structural timer"
slug: autonomous-progress-heartbeat
parent-principle: "Structure beats Willpower"
eli16-overview: autonomous-progress-heartbeat.eli16.md
status: approved
approved: true
approval-context: "Approved by Justin (topic 12476, 2026-06-16): explicit 'yes, please proceed' directing this build as the next autonomous-session item, after I presented the offer to build it. Autonomous-session standing instruction: 'Decisions are reversible + dark-shipped: make the call and keep going; do not stop to ask for a steer.' Ships dark on the fleet + dry-run-first on dev, fully reversible (a PR). The converged design + plain-English overview were presented in-channel before build."
review-convergence: "2026-06-17T04:52:07.448Z"
review-iterations: 3
review-completed-at: "2026-06-17T04:52:07.448Z"
review-report: "docs/specs/reports/autonomous-progress-heartbeat-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 1
---

## Problem (the incident this closes)

On 2026-06-16 (topic 12476), during a 24h autonomous run, the agent finished a milestone, told the user "PR #1206 is armed to merge," then went fully heads-down for ~an hour fixing that PR's CI — real work the whole time (commits, subagents, gate fixes) — but emitted ZERO user-facing message during it. From the operator's side, an hour of silence is indistinguishable from a stall. The operator asked: "Did the session stall?"

This is the **busy-but-silent-to-user** failure mode: the session is actively producing output (so it is NOT frozen), no inbound user message is pending (so presence proxying never triggers), yet the agent has not spoken to the topic in a long time.

The autonomous skill ALREADY instructs "report real milestones every ~30m." That instruction is **willpower** — a line in a prompt the agent blows past when absorbed in a multi-step task. The **real fix** is the agent reliably sending its own milestones; this spec does NOT replace that. Per the constitution's foundational principle (Structure beats Willpower), a behavior that matters needs a structural backstop for when willpower lapses. This spec builds that backstop: a sparse, hedged liveness signal that fires ONLY when the agent has genuinely gone silent on the user for a long stretch while still doing real work.

## The honesty constraint this design is bound by (read first)

An earlier draft of this feature was a cadenced TIMER that emitted an assertive line — *"Still working — ~N min since my last update."* That design is **rejected**, because it re-creates the exact zero-information filler that the operator-approved `docs/specs/HONEST-PROGRESS-MESSAGING-SPEC.md` §B1 deliberately SUPPRESSED. §B1 killed the PromiseBeacon "still on it, no new output since last update" line precisely because a periodic "still working" claim carries no real information and trains the user to ignore the channel. Re-introducing that under a new component name would be a regression of approved honesty work.

So this feature is redesigned as an **honest, hedged, change-gated, sparse liveness BACKSTOP** — not a progress simulator. The binding rules:

- It is a **backstop**, not a reporter. The intended fix remains the agent sending milestones; this only catches a long lapse.
- It fires on **a genuine corroborated recent-output-change signal + a LONG user-silence gate**, never a bare timer.
- Its wording is **purely observational**, never an assertive "still working" / "still going" claim. It surfaces what was last OBSERVED, framed as untrusted context, and invites the user to reach out — it never asserts a first-person progress claim of any kind.
- It is **per-run bounded** (widening backoff + a hard cap on heartbeats per run), so a 24h silent-but-working run yields a handful of liveness lines, not dozens.

### How this differs from the suppressed PromiseBeacon filler (explicit reconciliation)

| Dimension | Suppressed §B1 filler | This backstop |
|---|---|---|
| Trigger | bare cadence timer (10m), fires on unchanged frame | LONG user-silence gate (≥25m) **AND** corroborated recent output change |
| Wording | assertive "still on it, no new output" | purely observational — "I haven't posted here in a while — last observed activity was «…»; message me if you need me" (no "still working"-class assertion) |
| Information | zero (heartbeat for its own sake) | real, observed signal (output advanced) + last-observed focus framed as untrusted |
| Scope | per open commitment | per live autonomous run with no commitment |
| Cadence | every 10–20m, unbounded | widening backoff, hard per-run cap |
| Subject | a task the user may have moved on from | a topic the user themselves has been silent on while a run is active |

The §B1 filler spoke ON A TIMER about a commitment. This speaks RARELY, on corroborated movement, about an autonomous run the user has not heard from in a long while — a structurally different and much higher bar.

## Why the existing safeguards don't cover it

- **ActiveWorkSilenceSentinel** (`src/monitoring/ActiveWorkSilenceSentinel.ts`) detects sessions whose tmux OUTPUT went silent for ≥30m, and when it re-captures the frame and the session `looksActivelyWorking===true` it **suppresses by design**. It is a stuck-detector keyed on *terminal output silence*, not *user-facing silence*; a busy session is exactly what it stays quiet about, and its escalations go to `/attention`, not a topic heartbeat.
- **PresenceProxy** (`src/monitoring/PresenceProxy.ts`) fires only when an INBOUND user message goes unanswered past tier thresholds (`handleUserMessage()` requires `event.fromUser`). With no pending inbound message, a proactively-silent autonomous run is entirely outside its scope.
- **PromiseBeacon** (`src/monitoring/PromiseBeacon.ts`) is **commitment-scoped** — it only fires for a `Commitment` row with `beaconEnabled:true`. An autonomous run with no open commitment gets no beacon. And per HONEST-PROGRESS-MESSAGING §B1, its unchanged-frame heartbeat is now suppressed anyway.

**The gap is real and unowned:** output advancing + no inbound message pending + ≥N minutes since the agent last spoke to the topic — and nothing structurally turns that into one honest, sparse liveness line.

## Design — a new sibling monitor `AutonomousProgressHeartbeat`

A new component in `src/monitoring/AutonomousProgressHeartbeat.ts`, wired in `src/commands/server.ts` alongside PromiseBeacon, that **reuses PromiseBeacon's proven primitives without owning them** (a sibling, not a PromiseBeacon mode — the unit of work differs fundamentally: PromiseBeacon binds to a `Commitment`, this binds to a live autonomous run with no commitment; fitting it into PromiseBeacon would mean fabricating synthetic commitments with a foreign lifecycle).

### Tick + per-topic predicate (cheap-first ordering)

A periodic `tick()` (every 60s, like ActiveWorkSilenceSentinel). The tick is **re-entrancy-guarded** (a `ticking` boolean latch, or a self-scheduling `setTimeout` chain — never overlapping `setInterval` callbacks), because the emit step is `await`ed and a tmux capture can block.

For each topic with a live autonomous run, predicates are evaluated **strictly cheapest-first**, short-circuiting on the first failure. Every predicate is an in-memory read — including the output-change check (#8), which reads a snapshot ActiveWorkSilenceSentinel already computed (see §Shared-snapshot dependency), so the heartbeat performs ZERO tmux captures of its own:

1. **Autonomous run active** (cheap, in-memory state): `autonomousRunRemainingForTopic(stateDir, topic, now).active` (`src/core/AutonomousSessions.ts`).
2. **Not mid-handoff** (cheap, file marker): the run's state file does NOT carry a `moved_to:` / `move_suspended_at` marker (`suspendAutonomousTopicForMove` writes these). A run mid-move is about to fire from the destination machine — this machine must stay silent on it. (See Multi-machine, §7.)
3. **Destination warmup elapsed** (cheap, timestamp): the run has been active ON THIS MACHINE for ≥ one full `silenceThresholdMinutes` window. A freshly-resumed machine has empty local Telegram history and cannot see that the source machine just spoke; the warmup grace blocks a spurious emit until local history is meaningful.
4. **Session alive** (cheap): `SessionManager.isSessionAlive(session)`.
5. **Silent-to-user past threshold** (cheap timestamp over cached history): minutes since the most-recent OUTBOUND entry (`fromUser===false`) in `TelegramAdapter.getTopicHistory(topicId)` ≥ `silenceThresholdMinutes` (default 25). ANY outbound to the topic — the agent's own conversational reply, a proxy send, anything logged with `fromUser:false` — resets this window (see §Silence-clock self-reset).
6. **Emit-cooldown elapsed** (cheap, LOCAL map): now − `lastHeartbeatAt[topic]` ≥ the current per-run backoff interval (≥ `silenceThresholdMinutes`). This is the LOCAL throttle that the inert dedup used to be mistaken for (see §Throttle).
7. **Per-run heartbeat budget not exhausted** (cheap, LOCAL counter): this run has emitted fewer than `maxHeartbeatsPerRun` (default 6) heartbeats. A 24h silent-but-working run yields a bounded handful of lines, never ~50.
8. **Recent output change** (CHEAP — a pure in-memory `lastOutputAt` comparison, NO capture of its own): read the `lastOutputAt` snapshot ALREADY computed by ActiveWorkSilenceSentinel's existing 60s tick (a shared/cached read of `OutputActivityTracker.snapshot()` from `src/monitoring/sentinelWiring.ts` — see §Shared-snapshot dependency). The matching session's `lastOutputAt` must have ADVANCED within a recent window (`recentOutputChangeWindowMs`, default 5m) — i.e. the spinner-immune scrollback hash genuinely changed recently. An *instantaneous* spinner glyph is NOT sufficient (`looksGeneratingNow` alone would pass a wedged session mid-tool-call — the 26-min API-stall class). **This predicate proves ONLY that the session's TERMINAL OUTPUT CHANGED recently — a pure liveness signal. It does NOT prove that work is meaningfully PROGRESSING:** a noisy log loop, a retry storm, or a tight error-print loop also advances `lastOutputAt`. The hedged, observational wording (§Content) is deliberately liveness-only and never makes a progress claim, precisely because this signal cannot distinguish real progress from output churn.
9. **One-voice free** (cheap): the shared `ProxyCoordinator.tryAcquire(topicId, 'autonomous-heartbeat')` succeeds (a NEW third `ProxyHolder` value). If PresenceProxy or PromiseBeacon already holds the topic, the heartbeat stays silent — the user hears ONE voice.

If any predicate fails → no emit. The acquire/release of the ProxyCoordinator lease is wrapped in a `try/finally` within the SAME tick: the lease is released unconditionally on every path (emit, send-failure, exception), never held across ticks. A leaked lease would permanently silence PresenceProxy/PromiseBeacon for that topic.

To keep the tick O(1) per topic, `ParallelActivityIndex.activities(now)` is fetched ONCE per tick and indexed by topic, not re-queried per topic.

### Shared-snapshot dependency (predicate #8 pays ZERO extra capture cost)

Predicate #8 does NOT capture tmux frames. `OutputActivityTracker.snapshot()` captures EVERY running session in one pass on ActiveWorkSilenceSentinel's existing 60s tick — there is no way to capture "only the rare already-silent set," because the snapshot is taken whole, and a per-tick cap on the heartbeat could not bound a sweep the heartbeat does not perform. So this design takes the opposite approach: the heartbeat **reads the `lastOutputAt` value ActiveWorkSilenceSentinel already snapshotted** (a shared/cached in-memory read), making predicate #8 a pure `lastOutputAt` comparison with **zero** additional capture cost on the heartbeat's own tick.

This makes the shared snapshot a **hard wiring dependency**: the heartbeat is constructed with a reference to the same `OutputActivityTracker` snapshot source ActiveWorkSilenceSentinel reads, and it must NEVER fall back to its own `captureOutput`. If the shared snapshot is unavailable or its `lastOutputAt` for the session is absent/stale, predicate #8 fails CLOSED (no emit) — it never reaches for an independent capture. (There is consequently **no `maxCapturesPerTick` knob** — see §Frontloaded Decisions; it would be unenforceable and unneeded, since the heartbeat performs no captures.)

### The throttle (three explicit mechanisms — NOT dedup)

The original draft leaned on `OutboundContentDedup` as a flood backstop. That is **inert here and is removed from the safety argument**: dedup is an exact-fingerprint match, and the heartbeat text varies on every emit (minutes-silent, focus, time-remaining all change), so two heartbeats never fingerprint-match and dedup never fires. The real throttle is three LOCAL mechanisms, stated explicitly:

1. **User-silence threshold gate** (predicate #5): nothing emits until the topic has had no outbound for ≥ `silenceThresholdMinutes`. Any outbound resets the clock.
2. **Per-topic emit-cooldown** (predicate #6): an in-memory `lastHeartbeatAt[topic]` map; the next heartbeat for a topic cannot fire until ≥ the current backoff interval (floor `silenceThresholdMinutes`) has elapsed since the last one.
3. **Per-run backoff + budget** (predicate #6 interval widening + predicate #7 cap): successive heartbeats on the SAME continuously-silent run use a widening interval (e.g. 25m → 40m → 60m → 90m, capped) AND the run is hard-capped at `maxHeartbeatsPerRun` total. A 24h silent-but-working run therefore yields ≤6 hedged lines, not a stream.

### Content (hedged, scrubbed, untrusted-framed — never an assertive claim)

The line is honest liveness, NOT a progress claim. It surfaces the last-OBSERVED focus framed as quoted/untrusted context, and is **purely observational** — it carries no "still working" / "still going"-class assertion:

> "I haven't posted here in a while — last observed activity was «<focus>». Message me if you need me."

- **`focus`** is the matching topic's `focus` from `ParallelActivityIndex.activities(now)` (derived from the most-recently-reinforced goal/decision; falls back to the autonomous job `goal`). It is LLM-derived from conversation/feedback content and therefore **attacker-influenceable**. Before it is used in the message AND before it is stored into the status route's `lastEmits`, `focus` MUST pass a deterministic boundary scrub:
  - Run it through the existing credential/secret/path scrub patterns (reuse the `credential-leak-detector` / outbound-scrub regex set). **On ANY scrub match, DROP focus entirely** and use the generic hedged liveness line (below) — never emit partially-redacted attacker content.
  - **Length-clamp** to ≤200 chars.
  - **Escape** for the Telegram formatter (the message is sent on the `isProxy` path; `focus` is interpolated, so it must be HTML-escaped for `TelegramMarkdownFormatter`).
  - It is presented inside `«…»` as quoted context — the line never says "I am working on X" as a first-person assertion; it says "last observed activity was «X»", i.e. a purely observational statement about untrusted state, with no "still working"/"still going"-class claim appended.
  This is a **boundary scrub** — a deterministic structural validator, not a new LLM gate — and is therefore signal-vs-authority compliant.
- **Generic fallback** (focus unavailable OR scrub-dropped OR clamped to empty): "I haven't posted here in a while on this autonomous run. Message me if you need me." No focus, no interpolated content, no "still going"-class assertion.
- The message deliberately carries **no fabricated time-remaining claim**. If a session-clock figure is included it is read verbatim from `readSessionClocks` (respecting the TIME_CLAIM advisory) and is itself subject to the same hedged framing; the default line omits it to keep the claim minimal.

### Send (no dedup dependency — the payload is variable-shape)

Sends through the SAME canonical funnel PromiseBeacon uses: the `sendMessage(topicId, text, {source:'autonomous-heartbeat', isProxy:true, tier:1})` callback → POST `/telegram/reply/:topicId`. This inherits:
- **Tone-gate skip** (`isProxy:true`) — no LLM tone review on the heartbeat path (and the gate-stall is the very thing we're avoiding). The deterministic boundary scrub above replaces what a tone gate would otherwise catch.
- **No topic-flood exposure** — replying to an EXISTING topic is not budgeted (the AttentionTopicGuard / topicCreationBudget gate only NEW topic creation).

The payload is **NOT fixed-shape** — it interpolates variable `focus` and minutes — so `OutboundContentDedup` does NOT and cannot throttle it. The throttle is the three LOCAL mechanisms above, full stop.

### Silence-clock self-reset (one-voice extended to the primary speaker)

The silence window in predicate #5 is reset by ANY outbound entry to the topic with `fromUser===false` in `getTopicHistory` — which crucially includes the agent's OWN conversational replies, not just proxy/heartbeat sends. The moment the agent itself speaks to the topic, the heartbeat clock restarts; the backstop only ever fills a genuine silence the primary speaker left. This is the one-voice guarantee extended to the primary speaker, and it is a REQUIRED test (§Testing).

**dryRun faithfulness:** in dryRun the heartbeat does NOT send, so no `fromUser:false` entry is written — meaning the silence clock would never advance from its own activity. Therefore dryRun MUST gate on the LOCAL `lastHeartbeatAt[topic]` cooldown (predicate #6) and the per-run budget (predicate #7) EXACTLY as live does. Without that, dryRun would log a "would emit" line on EVERY tick once a topic crossed the silence threshold — a flood AND a false preview. dryRun therefore exercises the SAME cooldown + budget gates as live; it only swaps the final `sendMessage` for a log line.

## Signal vs Authority

Compliant (`docs/signal-vs-authority.md`). This is a **signal-only notifier**: it emits a liveness message and never gates, blocks, delays, or rewrites anything. It holds no blocking authority. Predicates 1–9 are cheap structural detectors (run-active, not-mid-move, warmup-elapsed, session-alive, silence-window, cooldown, budget, recent-output-change, lease-free) feeding a single emit/no-emit decision — none is a brittle content filter with a block path. The `focus` scrub is a deterministic boundary validator on outbound content (drop-and-fallback), not an LLM authority gate. The ProxyCoordinator lease is the existing one-voice authority, reused, not a new one.

## Side-effects review (pre-loaded for the gate)

1. **Over-fire / re-create §B1 filler (the CRITICAL risk):** mitigated by the whole pivot — it is NOT a bare timer. It fires only on a LONG user-silence gate (#5) AND corroborated recent output change (#8), with purely-observational wording, a per-topic cooldown (#6), a widening per-run backoff + hard cap (#7), and the one-voice lease (#9). The honesty reconciliation table above states explicitly how this differs from the suppressed PromiseBeacon line. dryRun-first ensures the behavior is observed before it ever sends. **Exhausting `maxHeartbeatsPerRun` (≈6) is SAFE, not a coverage gap:** a genuine OUTPUT-STALL after the cap is a DIFFERENT failure mode owned by ActiveWorkSilenceSentinel (≥30m of terminal-output silence → `/attention`), which is NOT bounded by this cap — so the cap bounds only this feature's liveness chatter without re-opening stall detection. The two features are disjoint by construction: this one fires while output is MOVING; the sentinel fires while output is SILENT.
2. **Under-fire (miss a real silence):** acceptable failure direction — a missed heartbeat is the status quo; this only ever ADDS liveness, never suppresses a real message. Predicates fail CLOSED (no emit) on any uncertainty (can't read history, shared snapshot unavailable, `lastOutputAt` absent/stale / recent-output-change uncertain).
3. **Level-of-abstraction fit:** monitoring layer, sibling to the other proxies, sharing their coordinator AND sharing ActiveWorkSilenceSentinel's `OutputActivityTracker` snapshot (predicate #8 is a cached read, never its own capture) — correct. Not a PromiseBeacon mode (commitment-lifecycle mismatch).
4. **Signal vs authority:** signal-only; see above. The `focus` scrub is a boundary validator, not authority.
5. **Interactions:** the ProxyCoordinator lease (acquired/released in `try/finally` within one tick) prevents double-firing with PresenceProxy/PromiseBeacon (one-voice) and a leaked lease can never silence them. It does not shadow them: PresenceProxy answers inbound-unanswered, PromiseBeacon answers commitments, this answers proactive autonomous silence — disjoint triggers. The agent's own conversational reply resets the silence clock (one-voice extended to the primary speaker).
6. **External surfaces:** it sends user-facing Telegram messages — the whole point. Bounded by the silence gate + cooldown + per-run backoff/cap + the boundary scrub on interpolated content. No other external surface. Ships dark on the fleet.
7. **Multi-machine posture (corrected, with honest residual risk):** the `ProxyCoordinator` lease is **in-memory / per-machine ONLY** — it gives ZERO cross-machine protection. Telegram history and any dedup are likewise machine-local. This is NOT claimed as "machine-local by design / no defect." The cross-machine double-voice risk is real and is mitigated by two explicit predicates: (a) **skip emit when the run file carries a `moved_to` / `move_suspended_at` marker** (predicate #2 — the run is mid-handoff; the destination will own it), and (b) a **destination warmup grace** (predicate #3 — don't fire until the run has been active on THIS machine for ≥ one full silence window, so a freshly-resumed machine with empty local Telegram history can't fire blind to the source having just spoken). An autonomous run lives on one machine at a time; these two predicates close the common windows (mid-move overlap, post-move warmup) where two machines could both speak.

   **ACCEPTED residual risk (stated honestly):** this `moved_to`-marker + destination-warmup coordination is **file-marker + timer based**, and is therefore NOT airtight against clock skew, a crash mid-move, partial/torn writes of the run-state file, or duplicated run state. A rare cross-machine **double-speak** therefore remains possible. This is ACCEPTED because the feature only ever ADDS one hedged, purely-observational liveness line — a rare duplicate of such a line is low-harm (two near-identical "I haven't posted in a while" notes), never a wrong action or a contradictory claim. The **inverse** tradeoff is also accepted: predicates #2 + #3 trade the (rare) double-speak for a bounded **double-SILENCE** gap of roughly one silence-window during a handoff (neither machine emits while the marker/warmup holds). That gap is acceptable because conversation continuity across a handoff is handled by the resume/continuation path, NOT by this heartbeat — the heartbeat is a backstop for a *silence*, and a brief extra silence during a machine move is exactly the status quo this feature is layered on top of. Note that `ProxyCoordinator` is **machine-local**; a distributed lock or a structured cross-machine IPC liveness-event approach would be the more robust long-term direction, and is explicitly **OUT OF SCOPE** for this dark-shipped v1 (see §Architectural tradeoffs / future work).
8. **Scalability:** predicates are evaluated cheap-first with short-circuit, and **every predicate is an in-memory read** — predicate #8 reads ActiveWorkSilenceSentinel's already-computed `lastOutputAt` snapshot (§Shared-snapshot dependency), so the heartbeat performs ZERO tmux captures of its own (no `maxCapturesPerTick` knob is needed or present). `ParallelActivityIndex.activities()` is fetched once per tick and indexed by topic. The status route's `lastEmits` is a ring buffer (last ~50). The tick is re-entrancy-guarded. The lease is released in `finally`.
9. **Rollback cost:** trivial. Dark on fleet (flag-off = no behavior). On a dev agent, set `enabled:false` or `dryRun:true`. No durable state mutation (all throttle state is in-memory), no migration to unwind beyond config keys.

## Architectural tradeoffs / future work

Two deliberate tradeoffs are accepted for this dark-shipped v1, both pointing at the same more-robust long-term direction:

- **Presentation-layer scraping (the trigger's substrate).** The output-change signal ultimately derives from synchronous tmux frame capture — screen-scraping the *presentation* layer — which is brittle (frame format can change) and a perf risk (the `execFileSync` block can stall the loop). v1 accepts this because (a) it matches the established sentinel-family pattern (ActiveWorkSilenceSentinel already works this way), and (b) per §Shared-snapshot dependency the heartbeat REUSES that sentinel's existing snapshot rather than adding any capture of its own, so it inherits the cost already being paid and adds none. The more robust long-term pattern is the **agent process emitting structured liveness events** via local IPC / a local queue, decoupling monitoring from the terminal presentation entirely. That is **future work, OUT OF SCOPE for v1.**
- **Per-machine coordination (the multi-machine substrate).** As stated in side-effects §7, cross-machine de-duplication relies on file markers + a warmup timer, not a shared authority. The robust long-term direction is a **distributed lock or structured cross-machine IPC liveness-event** mechanism. Also **future work, OUT OF SCOPE for v1.**

Both are noted here so the v1 substrate choices are an explicit, recorded tradeoff rather than an unexamined default.

## Frontloaded Decisions

These are decided, not open. (There is no Open Questions section — every choice is resolved here.)

- **silenceThresholdMinutes = 25.** Matches the autonomous skill's ~30m milestone cadence with margin, and sits well ABOVE the suppressed §B1 filler's 10–20m cadence — a deliberately much longer gate so this is a backstop, not a heartbeat.
- **tickIntervalMs = 60000** (60s, like ActiveWorkSilenceSentinel) — the check cadence, not the emit cadence.
- **Message shape:** purely observational liveness — "I haven't posted here in a while — last observed activity was «<focus>». Message me if you need me." Generic fallback when focus is unavailable/scrubbed. Never an assertive "still working" / "still going" claim.
- **focus length-cap = 200 chars + HTML-escaped + scrubbed.** The cap, the escape, and the credential/secret/path scrub-then-drop-to-generic are frontloaded: on any scrub match, drop focus and use the generic line.
- **Per-run backoff + cap:** widening interval (e.g. 25m → 40m → 60m → 90m, floor = `silenceThresholdMinutes`) with `maxHeartbeatsPerRun = 6`. Bounds a 24h silent run to a handful of lines.
- **recentOutputChangeWindowMs = 5m** — how recently the scrollback hash must have advanced for predicate #8 to pass.
- **No `maxCapturesPerTick` knob:** removed by design. Predicate #8 reads ActiveWorkSilenceSentinel's already-computed `lastOutputAt` snapshot (§Shared-snapshot dependency), so the heartbeat performs no captures of its own — a per-tick capture cap would be unenforceable (the snapshot is taken whole by the sentinel) and unneeded (the heartbeat adds zero capture cost).
- **Config floor clamps:** `silenceThresholdMinutes` clamped to a minimum of ~5; `tickIntervalMs` clamped to a minimum of ~30000ms. A misconfiguration cannot turn this into a spammer.
- **Graduation criterion (dryRun → live on dev):** ships `dryRun: true`. It flips to `dryRun: false` on a dev agent ONLY after N days (target ≥3) of dryRun logs show ZERO false or wedge-class emits (no "would emit" against a frozen/recently-spoke/mid-move topic), operator-confirmed. The fleet `enabled` flag stays OFF entirely pending that dev soak — fleet promotion is a later, separate decision.
- **Not a PromiseBeacon mode:** a sibling component, because the unit of work (live autonomous run, no commitment) does not fit PromiseBeacon's commitment lifecycle.

## Config + gating

`config.monitoring.autonomousHeartbeat` (typed on `MonitoringConfig`, mirroring `parallelWorkSentinel`):
- `enabled` — OMITTED in ConfigDefaults (the dev-gate decides via `resolveDevAgentGate`): live on a `developmentAgent`, dark on the fleet.
- `dryRun` — default `true` (`rawCfg.dryRun !== false`): logs the intended heartbeat without sending until deliberately flipped (gated on the SAME cooldown/budget as live). The graduated-rollout ladder.
- `silenceThresholdMinutes` — default 25, clamped to a minimum of ~5.
- `tickIntervalMs` — default 60000, clamped to a minimum of ~30000.
- `maxHeartbeatsPerRun` — default 6.
- `recentOutputChangeWindowMs` — default 300000.

## Status route

`GET /autonomous-heartbeat` (Bearer-auth, 503 when dark) → `{ enabled, dryRun, silenceThresholdMinutes, lastTickAt, topicsConsidered, lastEmits: [{ topicId, at, minutesSilent, focus, dryRun, suppressedReason? }] }`. `lastEmits` is a ring buffer (last ~50). `focus` stored here is the ALREADY-SCRUBBED value (never raw attacker content). Observe-only.

## Testing (all three tiers + the new decision boundaries)

- **Unit — the per-topic predicate, both sides of EVERY boundary:**
  - FIRES when: autonomous-active + not-mid-move + warmup-elapsed + alive + silent≥N + cooldown-elapsed + budget-remaining + recent-output-change (shared-snapshot `lastOutputAt` advanced) + lease-free.
  - SUPPRESSES on each failing predicate, tested individually: not autonomous / mid-move marker present / warmup NOT elapsed / not alive / spoke-recently / cooldown-not-elapsed / per-run-budget-exhausted / **frozen-spinner (instantaneous spinner but shared-snapshot `lastOutputAt` did NOT advance)** / **shared snapshot unavailable or `lastOutputAt` absent/stale → fail-closed, no own-capture fallback** / another holder owns the lease.
  - **own-conversational-send-resets-clock:** a `fromUser:false` history entry (the agent's own reply, not a proxy send) pushes the silence window back and suppresses.
  - **dryRun-respects-cooldown:** in dryRun, after one "would emit," the next tick does NOT log again until the cooldown elapses (proves dryRun gates on `lastHeartbeatAt`).
  - **focus-scrub-drops-on-match:** a `focus` containing a credential/secret/path pattern → the emitted/logged line is the GENERIC fallback, and `lastEmits.focus` carries no raw secret. Length-clamp + HTML-escape covered.
  - Content builder: purely-observational untrusted-framed line with focus present vs generic fallback; no "still working"/"still going"-class assertion; no fabricated time claim.
  - Backoff: successive heartbeats on a continuously-silent run widen the interval and stop at `maxHeartbeatsPerRun`.
- **Integration:** `GET /autonomous-heartbeat` → 200 on dev agent with real fields; 503 when dark.
- **E2E "feature is alive":** production init path constructs + ticks the component (wiring-integrity: not dead code), and a simulated silent + output-moving autonomous topic produces an emit (or a dryRun log) via the real send funnel; a recently-spoke topic, a frozen-spinner topic, and a mid-move-marker topic each produce none.
- **Wiring-integrity:** the component is constructed in server.ts, the ProxyCoordinator holder enum includes the new value, the lease is released in `finally`, the send callback is the same funnel PromiseBeacon uses (not a null no-op), and predicate #8 reads ActiveWorkSilenceSentinel's shared `OutputActivityTracker` snapshot (the dependency is injected, not null, and the heartbeat never calls `captureOutput` itself). The tick is re-entrancy-guarded.

## Migration parity

- Config default in `ConfigDefaults.ts` (`enabled` omitted; `dryRun:true`; thresholds/backoff/capture defaults).
- CLAUDE.md template awareness section (`generateClaudeMd`) — what it is, the status route, the proactive note that the agent no longer relies on remembering to report, AND an explicit line distinguishing it from the suppressed PromiseBeacon filler (this is a proactive autonomous-silence backstop, NOT the commitment-cadence "still on it" line that the honest-progress work removed) — see §CLAUDE.md awareness reconciliation below.
- `PostUpdateMigrator` — backfill ONLY `dryRun` / `silenceThresholdMinutes` / `tickIntervalMs` (+ the `maxHeartbeatsPerRun` / `recentOutputChangeWindowMs` defaults) with existence checks, the framework-shadow marker, and the CLAUDE.md section keyed on a named content-sniff anchor. It must **NEVER write `enabled`** — writing it would pin existing dev agents dark and defeat the `resolveDevAgentGate` dev-gate. The migration is idempotent (every key existence-checked).

### CLAUDE.md awareness reconciliation

The generated awareness section must explicitly distinguish this feature from the suppressed PromiseBeacon "no new output" filler that HONEST-PROGRESS-MESSAGING removed — otherwise an agent (or a reviewer) reads it as a regression of the honesty work. The framing: *"A proactive backstop that posts ONE purely-observational liveness line when an autonomous run has gone silent on you for a long stretch while its terminal output is still changing — this is NOT the commitment-cadence 'still on it' heartbeat that was removed; it fires only on a long user-silence gate with corroborated recent output change (a liveness signal, NOT a progress claim), and the wording is observational, never an assertive 'still working' / 'still going' claim."*

## Rollback lever

`config.monitoring.autonomousHeartbeat.enabled:false` (fleet) or `dryRun:true` (dev) — read at the tick chokepoint; no restart of the watched sessions needed. All throttle state is in-memory, so disabling leaves nothing to unwind.
