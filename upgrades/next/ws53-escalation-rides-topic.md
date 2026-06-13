# WS5.3 — escalation rides a moved topic (model-tier escalation follows a topic across a machine move)

<!-- bump: patch -->

<!--
  NOTE: dark/additive. A new ephemeral EscalationHintStore + a new sub-flag
  models.tierEscalation.ridesTopic (default false) added to the const
  DEFAULT_TIER_ESCALATION_CONFIG (in ModelTierEscalation.ts, referenced by
  ConfigDefaults.ts) — NOT an inline `enabled:` line, so the dark-gate line-map
  is UNCHANGED (verified 16/16). The hint rides the EXISTING authenticated
  topic-profile acquire pull (no new verb). The destination re-admit is
  literally ModelSwapService.swap(name,'escalated') → governor.admit() — the
  SAME chokepoint a fresh escalation uses, so the safety invariant (a refused
  guard yields default tier, never a bypass) is structural, not promised.
-->

## What Changed

When a topic running on the escalated (ultra Fable) tier is moved between my machines via `POST /pool/transfer`, the live escalation no longer silently drops on the resumed session.

- **Source capture (`/pool/transfer`)** — when the moving topic has a LIVE session on this machine running on an escalated model id, and the topic is not pinned `escalationOverride:'suppress'`, the source files an ephemeral `EscalationHint` keyed by topic. A non-escalated / suppressed / default-tier topic files nothing.
- **The carry (existing acquire pull)** — the hint rides the EXISTING authenticated `topic-profile-pull` acquire pull (no new verb, no broadcast, N-machine-safe). The serve handler PEEKS the source hint; the destination's apply-landing — AFTER the mandatory ownership recheck — drives the re-admit for the now-owned topic. The same-machine (target==self) path consumes the local hint at the resumed-session spawn.
- **Destination re-admit (the safety invariant)** — re-admission is literally `ModelSwapService.swap(name,'escalated')`, which calls the destination's own `EscalationGovernor.admit()` — every cost guard intact (quota headroom, per-account concurrent-escalation cap, hourly budget, daily ultra-token cap, TTL, dwell/hysteresis). Admitted → swapped; refused (any guard) → left default; `suppress` consult → never escalated. The hint is a TRIGGER carry, never a tier grant: there is no second admit path, so escalation can never be smuggled across.
- **Ephemeral, not a pin** — the hint lives in its own TTL-bounded (6h), consume-once file (`state/model-tier-escalation/rides-topic-hints.json`), never resolved into the durable topic profile.
- **Dark** — the whole path is behind `models.tierEscalation.ridesTopic` (default false) under the existing `tierEscalation.enabled`. With escalation off (the fleet default), it is a strict no-op. Single-machine installs are a no-op.
- **Awareness** — an "Escalation rides a moved topic" bullet extends the existing Model-Tier Escalation section in both `generateClaudeMd` (new agents) and an idempotent `migrateClaudeMd` additive-bullet patcher (existing agents).

A precise per-trigger hint label (carrying the actual originating trigger rather than the generic transfer audit label) is DEFERRED as a tracked follow-up (CMT-1416): the live trigger that escalated a session is not durably recorded per-session today, and the destination governor re-evaluates from real state regardless, so the precise label is audit-nicety, not load-bearing.

## What to Tell Your User

When you run me on more than one machine and move a heavy-work conversation from one to another, the bigger model it was using no longer silently disappears the moment the conversation resumes on the new machine. The new machine asks itself whether that conversation should be on the bigger model and re-runs its own cost checks first — quota, budget, anti-flapping, how many big-model sessions it is already running. Only if all of those pass does it put the resumed conversation back on the bigger model. If they do not, or if you pinned that topic to never escalate, it simply runs on the normal model. So the bigger-model state follows your moved conversation, but it is always re-priced against the machine it lands on, never smuggled across to dodge a budget. This ships off by default and does nothing at all on a single machine.

## Summary of New Capabilities

`models.tierEscalation.ridesTopic` (default false) — when on (under `tierEscalation.enabled`), a topic moved via `POST /pool/transfer` while escalated carries its escalation trigger as an ephemeral hint, and the destination re-admits the resumed session through its own EscalationGovernor cost guards. New exported `EscalationHintStore` (the ephemeral per-topic hint carrier). No new HTTP route; rides the existing `/pool/transfer` + `topic-profile-pull` surfaces.

## Evidence

- `tests/unit/escalation-hint-store.test.ts` — the EscalationHintStore lifecycle (file / peek-without-consume / consume-once / TTL expiry / suppress-clear / durable restart round-trip / corrupt-file = no-hint = safe / all() prune); the topic-profile pull serve-handler peek carry (the hint rides the existing pull, independent of the durable profile present/absent branch; omitted when unwired = back-compat); and THE NAMED SAFETY INVARIANT driven through ModelSwapService against a synthetic governor — a REFUSING governor yields default tier (never a bypass, the guard is always consulted), an ADMITTING governor swaps, a suppress consult refuses, an already-on-tier re-run is a no-op. Green.
- `tests/integration/escalation-rides-topic.test.ts` — the cross-machine carry + re-admit end to end against a mock governor: a transfer payload carrying the hint + governor ALLOW → swapped; the SAME payload + governor REFUSE → default (the bypass invariant); a hint landing while the topic is owned ELSEWHERE never fires the re-admit (ownership recheck); no source hint → no re-admit. Green.
- `tests/e2e/escalation-rides-topic-lifecycle.test.ts` — Phase-1 "feature is alive" on the production AgentServer init path: the EscalationHintStore is constructed and exposed via `getEscalationHintStore()`; with `tierEscalation.enabled` false the store is alive but inert (file/peek never throw, empty by default); `POST /pool/transfer` is alive and returns the honest dark 503 on a single-machine install (never 404/500). Green.
