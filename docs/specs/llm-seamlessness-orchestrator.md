---
kind: "spec"
id: "llm-seamlessness-orchestrator"
title: "LLM-Driven Seamlessness Orchestrator (lease-gated, propose-only, preload-focused)"
summary: "A lease-gated, background tier-1-supervised LLM loop whose value is ANTICIPATORY judgment — proposing which working-set artifacts / project context a conversation will likely need on its current machine BEFORE the user asks (preload), and SURFACING (never auto-executing) a machine-move suggestion to the operator. It is SIGNAL-ONLY: it never auto-moves a live user conversation, never opens a second placement path (deterministic RebalancePlanner/PlacementExecutor owns load-balancing), and always yields to failure-driven movement (mesh-self-heal). Placement is NOT the LLM's job; anticipatory preload is."
status: draft
author: Echo
date: 2026-07-03
risk-class: "signal-first — re-scoped after round 1 from an auto-actuating placement loop (which duplicated the deterministic placement layer AND let an LLM self-authorize moving a live conversation) to a propose-only preload signal. The only ever-auto action is a truly side-effect-free preload hint on an operator-ratified allowlist; every machine-move is propose-to-operator. Ships dark → dryRun-first → live, operator-only flip, one authority increment at a time."
parent-principle: "Signal vs. Authority (an LLM loop is signal-only unless authority is earned + gated — an LLM must NEVER self-authorize an irreversible-feeling move on a predicate it evaluates itself). Also engages No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes (the P19 caps: ≤3 proposals/tick, per-topic cooldown, oscillation breaker, give-up), Placement-is-single-owner (PlacementExecutor: ALL placement routes through one component with structured-DATA policy, never ad-hoc/LLM logic), failure-movement-wins-over-optimization (subordinate to mesh-self-heal), graduated-rollout, and verify-existing-behavior-before-asserting-it (round-1: `/topics` was fabricated, `/projects` was the wrong system)."
lessons-engaged:
  - "Foundation reality (round-1, grep-verified): `/coherence/fetch-working-set` + `/pool/transfer` (confirm:false/true) are REAL + correctly shaped. But `GET /topics` DOES NOT EXIST (use `GET /topic/list` + `GET /pool/placement?topic=N`) and `GET /projects` is the InitiativeTracker spec-round system, NOT a code-project catalog (use `GET /project-map` + `GET /topic-bindings`). A builder using the draft's reads would hallucinate targets."
  - "Placement is single-owner (PlacementExecutor doc): ALL placement decisions route through one component whose policy is structured DATA validated against a fixed schema — NEVER ad-hoc/LLM logic. The deterministic RebalancePlanner (built, unwired) already owns load-balancing with pins/hysteresis/cooldown. This spec must NOT open a second LLM-driven placement path — load-balancing stays deterministic; the LLM's role is anticipatory PRELOAD, where judgment about 'what will be needed next' genuinely helps."
  - "Signal vs Authority: the draft let an LLM 'auto-confirm if load-shedding-driven' — self-authorizing a move of a LIVE user conversation (and `isMidReply` is hardcoded false at the transfer route, so a live interactive convo has NO consent gate). That is capability-granting-itself-authority. Inverted: propose-only; a move of a topic with a live interactive session is ALWAYS operator-confirmed."
  - "Subordinate to failure-driven movement (mesh-self-heal-graduation, spec #5): both features move the same topics via the same `/pool/transfer` planner. Failure-driven movement (stale-owner-release, lease-handback) ALWAYS wins; the optimizer never proposes for a topic in an active self-heal / lease-flap / splitBrain episode."
  - "132MB-flood + over-proposing: a best-effort optimizer that runs every tick and 'proposes 1-3 actions' institutionalizes make-work. A healthy warm pool yields ZERO proposals most ticks; silence is the good outcome. Audit logs write decision-change-only."
approved: true
review-convergence: "2026-07-04T01:42:37.909Z"
review-iterations: 2
review-completed-at: "2026-07-04T01:42:37.909Z"
review-report: "docs/specs/reports/llm-seamlessness-orchestrator-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# LLM-Driven Seamlessness Orchestrator (lease-gated, propose-only, preload-focused)

**Status:** DRAFT (re-scoped after round 1: propose-only + preload-focused; placement stays deterministic)
**Owner:** Echo
**Created:** 2026-07-03
**Goal Alignment:** Goal B (Seamless agent across machines)

## Glossary & source-of-truth

- **tier-1 supervised loop** — a scheduled job with `supervision: 'tier1'` (Haiku wrapping tools + validation); runs ONLY on the lease-holding machine (the scheduler runs jobs only on the lease-holder).
- **working-set** — a conversation's produced artifacts under `.instar/` (see WORKING-SET-HANDOFF-SPEC + intelligent-working-set-lazy-sync).
- **preload** — fetching a likely-needed artifact/context BEFORE the user references it.
- **placement / load-balancing** — deciding which machine serves a topic; owned by `PlacementExecutor` + `RebalancePlanner` (deterministic, structured policy), NOT this loop.
- **Source of truth:** sessions=`GET /sessions`; per-topic list/context=`GET /topic/list` + `GET /topic/context/:id`; ownership/pin=`GET /pool/placement?topic=N`; pool=`GET /pool`; projects-on-disk=`GET /project-map` + `GET /topic-bindings`. (Round-1: `/topics` and the code-catalog `/projects` do NOT exist.)

## Problem

Working-set/context sync is on-demand — you wait until you reference a file, then it fetches. There's no anticipatory intelligence saying "this conversation will likely need project X's report next; preload it now." Deterministic scoring (recency/frequency) handles the easy cases, but *which* of many candidates a conversation will actually need next is a judgment call. Goal B wants that anticipation. (Load-balancing is a DIFFERENT problem, already owned deterministically — this spec does not re-solve it.)

## What this loop is NOT (round-1 deconfliction)

- **NOT a placement engine.** Machine load-balancing stays with the deterministic `RebalancePlanner`/`PlacementExecutor` (structured policy, no ad-hoc logic). This loop may FEED a signal (e.g. "topic T's working set lives on machine A") into that policy as data, but never emits a raw LLM move decision for load-balancing.
- **NOT an authority over live conversations.** It never auto-moves a topic with a live interactive session.
- **NOT a competitor to mesh-self-heal.** Failure-driven movement (spec #5) always wins; this loop yields.
- **NOT a model/door selector** (topic 29723) — its supervisor model is a fixed Haiku tier; it does not touch model selection.

## Alternatives considered (why an LLM at all — round-1/codex)

**This is fundamentally predictive cache-prefetching (round-2, codex #4):** the preload half is a cache warmer, and most of it IS solved by classic techniques — recency/frequency scoring, a bounded prefetch queue, cache-admission policy, feature-based ranking. So those are used FIRST (cheap, reproducible, no LLM). The LLM is a LAST-resort ranker invoked ONLY for the residual a rules/feature model is weak at: correlating a conversation's *current semantic focus* with *which* of several plausible artifacts it will need next (e.g. "this thread just pivoted to the Slack spec → preload the slack-parity report, not the mesh one"). If deterministic scoring already has a clear winner, the LLM is skipped — and per F4's A/B gate, the LLM is only enabled at all if it beats the deterministic ranker by a minimum lift. Load-balancing/placement is NOT an LLM decision (deterministic planner owns it). The LLM earns its place on exactly one axis (semantic-focus preload ranking) or not at all.

## Design

A **lease-gated** tier-1 loop (default 15m cadence — not 5m; a preload optimizer is not urgent) that, ONLY on the lease-holder:
1. Reads bounded state (top-N by staleness/activity — NOT the whole pool): active topics on THIS machine + their current focus, the working-set records for those topics (what exists where), project-map + bindings.
2. Deterministically ranks preload candidates; invokes the LLM only for the residual judgment call, with ALL state rendered inside an `<untrusted-data>` envelope (topic names / paths / focus are user-influenced — data to reason about, never instructions).
3. Emits `[{ action, targetTopic, detail, authorityLevel }]` where `action ∈ { preload-artifact, placement-signal }`.

### Authority levels (explicit — round-1/codex #3; round-2/codex #2 removes any LLM-authored move)
- **`auto-prefetch`** — ONLY `preload-artifact` of a truly side-effect-free artifact (see the invariants below) may actuate without confirm, via `POST /coherence/fetch-working-set`. Bounded by budget (below).
- **`placement-signal`** — the loop does NOT emit a machine-move suggestion at all (round-2/codex #2: even an operator-surfaced "suggest-move" is a parallel placement-advisory system). Instead it writes STRUCTURED EVIDENCE (e.g. `{topic, workingSetHomeMachine, recentFocus, staleness}`) into the deterministic `PlacementExecutor`/`RebalancePlanner` policy input. **The deterministic planner ALONE decides whether a move exists** — the LLM never authors a move, not even as a suggestion. This keeps placement single-owner (PlacementExecutor's "structured DATA, never ad-hoc logic" rule) and eliminates the second placement path entirely.
- There is NO `auto-transfer` and NO LLM-authored `suggest-move`. The load-shedding auto-confirm from the prior draft is REMOVED. The LLM's only two outputs are a bounded preload and a structured signal to the deterministic planner.

### "Side-effect-free" invariants for auto-prefetch (round-2, codex #1 + internal)
An `auto-prefetch` is admissible ONLY if ALL hold: it fetches an artifact **already owned on another machine** (no creation of new user work — only a local copy lands, plus the audit row); within the coordinator's caps + its `secretFlagged`/`tooLarge`/oversized REFUSALS (inherited, not weakened); bounded by a **per-window disk-byte budget**; it NEVER mutates ownership/leases, never deletes/locks remotely, and never evicts an artifact referenced THIS session (LRU that protects live-referenced files); and it respects the same privacy jail as the working-set engine (`.instar/`-rooted, no credentials). "Side-effect-free" is thus a defined contract, not an assertion.

### Actuation guards (every proposal)
- **Re-validate at execute** (not just at read): the actuation layer re-checks live ownership/pin (`GET /pool/placement?topic=N`) — a stale read is never ground truth (compare-and-act).
- **Yield to failure-movement:** refuse any proposal for a topic in an active stale-owner-release / lease-handback / lease-flap / `splitBrainState` episode.
- **Respect pins + provenance:** never suggest moving a `pinned` or recently-user-moved topic.
- **Audit-BEFORE-actuate** to `logs/orchestrator-actions.jsonl` (machine-local), recording action + authority basis, so a crash mid-action leaves a trace.

## Multi-machine posture

- **The loop itself** — runs ONLY on the lease-holding machine (`syncStatus.holdsLease === true`, checked at tick entry — NOT delegated to the optional scheduler role guard, which fails open). A standby machine's loop is a strict no-op (Tier-3 test asserts it).
- **Action audit log** (`logs/orchestrator-actions.jsonl`) — **machine-local-by-design** (`machine-local-justification: hardware-bound-resource` — records what THIS machine actuated; a replicated audit double-counts a single move). Pool-scope read merges by machine.
- **Ephemeral proposal/dedup state** — **machine-local** (only the lease-holder proposes; short-lived).
- **The oscillation-blacklist + per-topic move cooldown** (thrash safety) — **replicated** (round-2, codex #5): lease movement changes the learner, and a machine-local blacklist would be LOST on failover, so the new lease-holder could re-propose a move the prior holder already learned thrashes. This safety state replicates via the WS2 store machinery (type-clamped, tombstoned) so "don't move topic T again" survives a failover. (The ranking feedback memory below stays machine-local for now — losing it degrades quality, not safety; replicating it is a tracked follow-up. <!-- tracked: topic-29836 -->
- **Feedback memory** (below) — **machine-local** for now (each lease-holder's measured outcomes); replicating it is a tracked follow-up (would ride the WS2 replicated-store machinery with type-clamp + untrusted envelope + a retention/rate-cap entry — NOT hand-rolled). <!-- tracked: topic-29836 -->

## Frontloaded Decisions

1. **F1 — Signal-only default:** the loop PROPOSES; the only auto action is `auto-prefetch` of an allowlisted side-effect-free artifact. Machine-moves are always suggest-to-operator. (Contested-and-rejected any "ships dark ⇒ auto-actuation is cheap" — moving a live conversation is real authority.)
2. **F2 — Lease-gated single-runner:** runs only on the lease-holder, checked at tick entry.
3. **F3 — Placement stays deterministic, LLM emits NO move:** load-balancing AND any move decision is RebalancePlanner/PlacementExecutor's alone. This loop emits only a `placement-signal` (structured evidence) into that planner's policy input; it never authors a move, a suggestion, or a raw LLM transfer. The deterministic planner decides whether a move exists (including any anticipatory user-follows-their-work move) — the LLM contributes a data input, never a decision.
4. **F4 — dark→live flip is OPERATOR-ONLY,** per-increment, evidence-gated on a measured clean dry-run soak. `auto-prefetch` and any future auto action are SEPARATE increments, each with its own soak (the ladder is not compressed). **The LLM call must EARN its cost (round-2, codex #3):** during dry-run, the LLM's preload ranking is A/B-compared against deterministic-only scoring; the LLM increment is enabled ONLY if it shows a minimum measured LIFT (preload hit-rate) over deterministic-only. If deterministic scoring is within the lift threshold, the LLM is never invoked — the loop runs deterministic-only. This is the objective function the LLM is judged against (not "sensible").
5. **F5 — Endpoints (grep-verified):** `GET /sessions`, `GET /topic/list`, `GET /topic/context/:id`, `GET /pool`, `GET /pool/placement?topic=N`, `GET /project-map`, `GET /topic-bindings`; actuate via `POST /coherence/fetch-working-set` + (suggest-only) `POST /pool/transfer`. NEW: `POST /intelligence/... /tick {"dryRun":true}` (Bearer + spawn-cap funnel), `GET /...audit`, config `multiMachine.seamlessOrchestrator.{enabled,dryRun}` (beside the systems it coordinates with; via `migrateConfig()`, existence-checked; absent-is-default).
6. **F6 — P19 brakes (numbers):** max proposals/tick = 3 (enforced in the parse layer, extras discarded); per-topic actuation cooldown ≥ 30m keyed on the last actuated action regardless of direction (> any reversing system's cadence); dedupe key = `topic+action+target`; oscillation breaker: after 3 moves of a topic in a window → blacklist + ONE deduped attention item, stop proposing for it; breaker after K failed/reverted actuations → loop goes inert (dry-run) LOUDLY.
7. **F7 — Budget:** the LLM call routes through `LlmQueue` on a LOW-priority lane (yields to safety-gating calls under spawn-cap saturation) with a daily spend cap; state read bounded to top-N; the loop SUSPENDS under active load-shed pressure (reads the SessionReaper pressure tier — via the injected reaper or `GET /sessions/reaper` `pressure.inputs`; a load optimizer that runs during a crisis worsens it). Cost-bearing `job`-category call — routes per the framework policy.
8. **F8 — Feedback memory (round-1 F9/codex #2):** structured MEASURED outcomes only (`{topic, action, target, outcome: improved|worsened|reverted}` from audit-log deltas — did the moved topic move back within the window? did the preloaded file actually get referenced?), NOT LLM free-text self-narration; bounded size + decay; if re-fed to the prompt, inside the `<untrusted-data>` envelope; it may only ever RAISE the confidence bar / SUPPRESS a proposal, NEVER lower a confirm requirement or grant authority.
9. **F9 — Self-heal-before-notify:** a best-effort optimizer that can't improve STAYS SILENT (it never tells the operator "I keep failing to balance load" — pure noise); the only notices are the oscillation-breaker/give-up items, tone-gated through `/attention`, deduped per episode, never a new topic.
10. **F10 — Agent Awareness:** a CLAUDE.md-template entry ("why did my conversation move / why did a file appear preloaded? → the orchestrator; read `/…/audit`") ships with it — a proactive feature that touches the user's conversations must be explainable.

## Open questions

*(none)*

## Blocking dependency (honest)

The Tier-3 live-verify (dry-run on the real pair → confirm proposals are sane → measure) needs the **real Mini+Laptop pair; the Laptop is offline** — a named BLOCKER. Single-machine logic (lease-gate no-op on standby, brakes, envelope, feedback-outcome derivation, endpoint reads) is unit+integration testable now.

## Implementation Strategy

- **Phase 1** — lease-gated tier-1 job skeleton + bounded grep-verified state reads + `<untrusted-data>`-enveloped prompt + deterministic-first candidate ranking.
- **Phase 2** — proposal schema + authority-level classification + actuation guards (re-validate, yield-to-failure, pins, audit-before-actuate).
- **Phase 3** — ships DARK; then dryRun-first: logs would-actuate proposals, actuates NOTHING; dry-run audit is the soak evidence.
- **Phase 4 (separate increments, operator-gated)** — increment A: `auto-prefetch` allowlisted side-effect-free preloads (after a clean dry-run soak). increment B (later): none beyond A without a new spec — machine-moves stay suggest-only.
- **Phase 5** — structured feedback-outcome derivation (F8), suppress-only.
- **Live-verify (BLOCKED on Laptop).**

## Test Plan

**Tier 1 (Unit):** lease-gate no-op on standby; proposal parse caps to 3 + discards extras; per-topic cooldown blocks a re-proposal; oscillation breaker blacklists + raises one item; untrusted-envelope render of a hostile topic name; feedback-outcome derived from audit delta (not free-text); auto-prefetch allowlist rejects a non-allowlisted path.
**Tier 2 (Integration):** grep-verified endpoint reads return expected shape; dry-run produces the would-actuate audit; a proposal for a topic in a self-heal episode is refused; a suggest-move for a live interactive topic routes to attention, never `/pool/transfer` auto.
**Tier 3 (E2E, real pair — BLOCKED on Laptop):** dry-run on the pair → proposals are sane (OBJECTIVE metric, not "sensible": every proposed target is a real currently-owned topic/machine; zero proposals for pinned/self-heal topics); enable `auto-prefetch` on one machine → measure referenced-preload hit-rate + zero live-conversation auto-moves.

## Success Criteria

- [ ] Loop runs ONLY on the lease-holder (standby = no-op, tested).
- [ ] **Silence when nothing to do is a SUCCESS** — a healthy warm pool yields zero proposals; no "1-3/tick" target (round-1 F11).
- [ ] No LLM-authored move of any kind (not auto, not a suggestion); the LLM emits only a bounded preload + a structured `placement-signal` into the deterministic planner, which alone decides moves.
- [ ] No second placement path — all move decisions stay with the deterministic planner.
- [ ] Yields to failure-driven movement (never proposes into a self-heal episode).
- [ ] Brakes enforced (cap 3, cooldown ≥30m, oscillation breaker, give-up).
- [ ] auto-prefetch is allowlisted + budget-bounded + suspends under load-shed.
- [ ] Live-verified on the real pair (GATED on Laptop online).

## Failure Modes

- **Both machines propose** → lease-gated single-runner.
- **LLM moves a live conversation** → removed; the LLM authors no move at all (only a structured signal to the deterministic planner).
- **Duplicate placement path / fights RebalancePlanner** → placement + all move decisions stay deterministic; loop only feeds structured signals.
- **Auto-prefetch harm (disk/eviction/privacy)** → the defined side-effect-free invariants (disk-byte budget, no eviction of session-referenced files, inherited refusals, `.instar/` privacy jail).
- **Blacklist lost on failover** → the oscillation-blacklist + move cooldown replicate (thrash safety survives a lease move).
- **LLM cost without value** → A/B lift gate: the LLM is enabled only if it beats deterministic ranking; otherwise deterministic-only.
- **Fights mesh-self-heal** → yields; failure-movement wins.
- **Thrash** → per-topic cooldown ≥30m + pin/provenance read + oscillation breaker.
- **Prompt injection via topic/path** → `<untrusted-data>` envelope + execute-time target re-validation.
- **Cost/low-value work at scale** → LlmQueue low-priority + daily cap + bounded read + suspend-under-load-shed + deterministic-first (skip LLM when a clear winner exists).
- **Poisoned feedback memory** → structured measured outcomes only, suppress-only, bounded+decay, enveloped.
- **Over-proposing** → silence-is-good success criterion; cap 3; deterministic-first.

---

**Related specs:** mesh-self-heal-graduation (authoritative machine-move layer — this yields to it), intelligent-working-set-lazy-sync (the preload target), slack-multi-machine-parity; RebalancePlanner/PlacementExecutor (the deterministic placement owner — do not duplicate).
