# Side-effects review — topic-intent task-context capture (rung 1)

**Scope**: Generalize topic-intent capture from conversational facts/decisions to
**task contexts** (method/audience/goal) — the working-frame category that caused
the founding methodology-drift incident ("we're testing over Telegram") and that
rung 0 structurally can't catch. Same store, new ref kinds, per-kind decay
horizons, an "Active task frame" briefing block, an ArcCheck frame-drift signal,
and per-kind observability. Spec: `docs/specs/topic-intent-task-context-capture.md`
(approved by justin; Claude-authored + manual review — see spec's honest
convergence note).

**Files touched**:
- `src/core/TopicIntent.ts` — extend `RefKind` with `method|audience|goal` +
  `TASK_CONTEXT_KINDS`/`isTaskContextKind`; per-kind `DECAY_PROFILES` +
  `decayProfileFor`; `projectConfidence` gains an optional `refKind` param
  (omitted → long profile = rung-0 behavior, byte-for-byte); the three callers
  pass `ref.kind`; `CaptureCounters.refkind_created` (additive, defaulted) +
  `bumpCaptureCounters` optional `refKindsCreated` arg.
- `src/core/TopicIntentExtractor.ts` — `buildExtractorPrompt` teaches the
  task-frame kinds; `translateProposal` validates `refKind` against an allowlist
  (`VALID_REF_KINDS`) so a garbage/poisoned kind never creates a ref.
- `src/core/TopicIntentArcCheck.ts` — **new `contradicts-frame` verdict**: a draft
  contradicting a task-context ref fires at **tentative-or-above** (frames decay
  fast and are often only tentative; drifting from one is the founding-incident
  failure). The existing `contradicts-settled` rule is scoped to fact/decision so
  its behavior is unchanged.
- `src/core/TopicIntentBriefing.ts` — partition refs into a distinct
  **"ACTIVE TASK FRAME"** block (method/audience/goal) vs the SETTLED/TENTATIVE
  proposition blocks; `BriefingResult.counts.frame` added.
- `src/core/TopicIntentCapture.ts` — `captureTurn` passes the created refKinds to
  `bumpCaptureCounters` for the per-kind breakout.
- `src/server/topicIntentRoutes.ts` — `capture-metrics` funnel exposes
  `refkind_created`.
- Tests: `tests/unit/TopicIntent-task-context.test.ts`,
  `tests/integration/topic-intent-task-context.test.ts`,
  `tests/e2e/topic-intent-task-context-lifecycle.test.ts`; updated one existing
  briefing-counts assertion for the additive `frame` field.

**Under-block**: The new ArcCheck frame rule is signal-only and fires at
tentative-or-above — deliberately *lower* threshold than settled propositions,
so it won't *miss* a frame drift just because the frame is only tentative. No new
path can suppress a real capture: task-frame extraction rides the same fail-open
pre-filter as rung 0.

**Over-block**: The only "block"-shaped behavior is ArcCheck, which is a signal
(never a veto) per [[feedback_signal_vs_authority]]. A false frame-drift signal
costs one "confirm?" nudge, never a blocked send. The refKind allowlist is the
only new hard reject, and it only drops malformed proposals (no valid kind is
excluded).

**Level-of-abstraction fit**: Task contexts are modeled as additional `RefKind`
values in the *same* store and the *same* extraction/confidence/decay machinery —
not a parallel system. The extractor stays the single extraction point (one LLM
call, extended prompt); the store stays the single authority; the briefing/ArcCheck
stay the single surfaces. Per-kind decay is a lookup keyed by the ref's own kind,
not a special-case branch.

**Signal vs authority**: Capture records; ArcCheck (incl. the new frame rule)
signals; neither blocks. The pre-filter remains a brittle detector with no veto.

**Interactions**:
- `projectConfidence` signature gained a 4th optional param. All existing callers
  that omit it get the long profile → **rung-0 confidence math is provably
  unchanged** (pinned by an explicit regression test across 5 time points).
- The founding-incident e2e caught a real gap during the build: frame contradiction
  needed to fire at tentative tier, which the original (authoritative-only)
  contradicts rule didn't cover — hence the new `contradicts-frame` rule. (This is
  the e2e earning its keep, exactly as intended.)
- `capture-metrics` GET and the briefing GET keep their existing metering
  side-effects (rung 0); `refkind_created` rides the same lock.
- Additive `CaptureCounters.refkind_created` is `undefined` on pre-rung-1 files and
  handled everywhere (`?? {}`, lazy-init in the bump) — no migration needed.

**External surfaces**:
- `capture-metrics` funnel gains `refkind_created: Record<kind, count>`.
- The briefing text gains an "ACTIVE TASK FRAME" section when frame refs exist.
- New `ArcCheckVerdict` kind `contradicts-frame`.
- No new endpoint, no config-shape change. (The spec's optional
  `topicIntent.capture.decayProfiles` override is NOT built — decay profiles are
  code constants for v1; the config override is a tracked refinement
  <!-- tracked: cwa-decay-profile-config --> so the numbers can become operator-
  tunable later without a code change.)

**Cost**: Zero new per-turn LLM calls — the task-frame extraction is folded into
the existing single fast-tier call (a slightly longer prompt). The whole loop
stays inside the rung-0 cost envelope (pre-filter + rate ceiling + LlmQueue cap +
QuotaTracker shedding).

**Migration parity**: Additive `RefKind` values (free-text-tolerant on read) +
per-kind decay constants (rung-0 kinds keep exact numbers) + additive
`refkind_created` (defaulted) + the briefing block + the new ArcCheck verdict.
Server-side — every agent gets it on update. No hook/template/skill/config-shape
change.

**Rollback cost**: Low, strictly additive. Revert: drop the task-frame prompt
guidance + the `contradicts-frame` rule + restore the single decay profile;
fact/decision behavior is untouched throughout. The rung-0 kill-switch
(`topicIntent.capture.enabled`) disables the whole loop including this.

**Convergence honesty**: Claude-authored + manual standards/lessons review only;
full `/spec-converge` + `/crossreview` multi-model tooling is absent on this host.
Ratified by Justin with that caveat explicit. The CI suite + the founding-incident
e2e are the strongest current evidence; a fuller multi-model review remains
advisable before relying on rung 1 in anger.
