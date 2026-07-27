# Side-Effects Review — Periodic Goal Re-Alignment Phase 1

**Version / slug:** `periodic-goal-realignment-phase1`
**Date:** `2026-07-27`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds the observation-only first slice of periodic goal realignment:
Telegram operator provenance survives `TopicMemory`, verified instruction-shaped
messages enter a durable candidate inbox, semantic extraction is checkpointed before
append-only priority events, and a cadence-shaped reviewer writes dry-run verdicts
visible through authenticated `GET /goal-realignment`. It changes
`TopicMemory`, Telegram/shared logging, config/types/capability/route registration,
server wiring, a new `GoalRealignment` module, tests, and the approved spec's single
operator-amended lifetime decision. There is no injection or action path.

## Decision-point inventory

- `detectCandidatePriority` — **add** — recall-biased deterministic detector decides
  which verified messages enter the holding list; it cannot create authority or
  retire a priority.
- `GoalRealignmentIntake` provenance eligibility — **add** — hard boundary requiring
  exact authenticated operator UID plus explicit `forwarded:false`.
- `PriorityExtraction` — **add** — context-rich semantic classification proposes
  priority/restatement/supersession/completion states, with exact authored grounding
  and conservative confirmation thresholds.
- `AlignmentReviewer` — **add** — semantic signal producer labels current run focus;
  `diverged` is mechanically downgraded to `indeterminate` without valid two-sided
  evidence.
- `GoalDigestBuilder` — **add** — deterministic materialized projection excludes
  only explicitly superseded or confirmed-addressed priorities; age never retires
  authority.

---

## 1. Over-block

No message-delivery or work-action block surface exists. A legitimate operator
instruction that lacks every deterministic signal can fail to enter the Phase 1
candidate inbox; this is an observation false negative, not a blocked user action.
The detector intentionally recognizes broad imperative, priority, status, and
confirmation language, while the dry-run status counters and inbox make recognized
classification failures visible.

Legacy `TopicMemory` rows whose forwarded state is unknown are excluded from
authority. That can omit a legitimate historical operator message, but accepting an
unknown forwarded row would permit quoted third-party content to become authority.
New ingress persists explicit provenance.

---

## 2. Under-block

No block surface exists. Remaining observation misses include implicit priorities
without instruction-shaped language, paraphrased completion that the extractor
cannot ground to an exact authored substring, and active-run focus expressed outside
the registered condition/goal/task rows. These fail toward missing signal or
`indeterminate`, never action.

The source-history recovery read is bounded to 500 recent rows. If it reaches the
bound it returns `complete:false` and performs no partial reconciliation, preventing
false completeness but leaving the candidate backlog dependent on live intake until
the source volume is reduced or a later implementation provides pagination.

---

## 3. Level-of-abstraction fit

The deterministic matcher is correctly a low-level detector feeding a durable inbox,
not an authority. Semantic extraction is correctly delegated to the registered
`GoalPriorityExtractor` reflector with existing priorities and authored/quoted
separation. The `AlignmentReviewer` is also a registered reflector and produces only
a stored observation. Mechanical citation validation sits below the model because
exact identity, substring, enum, and size checks are enumerable invariants.

The coordinator composes existing `TopicMemory`, `TopicOperatorStore`,
`AutonomousRunStore`, shared `LlmQueue`, dev-agent gating, and capability routing. It
does not introduce a parallel operator identity store, run state writer, or general
workflow engine.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The candidate detector and both model-backed components emit structured evidence.
They cannot block work, mutate the planner/run file, inject session context, notify
the operator, or trigger recovery. `dryRun: true` is structural: the reviewer has no
injection dependency to call even if configuration is accidentally changed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The candidate regex is not used at a competing-signals authority point; it only
admits additional rows into a holding list. Semantic priority meaning and alignment
remain reflector judgments. Exact sender/forwarded provenance, schema validation,
idempotency, and two-sided citation grounding are enumerable invariant floors named
in the driving spec's decision-point table.

---

## 5. Interactions

- **Shadowing:** the new `onMessageLogged` handler chains the pre-existing callback
  before enqueueing intake. It does not replace TopicMemory, Presence Proxy, topic
  intent capture, Usher, or correction learning callbacks.
- **Independent boot:** initial wiring accidentally sat inside Presence Proxy's
  initialization scope. Review moved it to its own Telegram/dev-gated boot path and
  a source-level test pins ordering before `let presenceProxy`.
- **Double-fire:** live intake and startup history reconciliation can see the same
  message. The source-derived idempotency key and checkpoint/event IDs collapse both
  paths to one extraction/event.
- **Races:** coordinator intake is serialized through `intakeTail`; review awaits the
  tail and is guarded by `reviewInFlight`. Atomic runtime writes precede event
  application.
- **Feedback loops:** reviewer output writes only its own audit/runtime status. It
  never enters the autonomous state file or message history, so it cannot become its
  own focus or source evidence.
- **LLM contention:** both reflectors use the existing shared background queue.
  Unchanged digest+focus hashes reuse the prior verdict with zero model calls.

---

## 6. External surfaces

- New authenticated pull-only `GET /goal-realignment`; no mutation/action endpoint.
- `TopicMemory` schema moves from 4 to 5 with one nullable `forwarded` column and a
  tested automatic migration. Existing unknown values remain safely unknown.
- New permission-restricted local stores:
  candidate/checkpoint runtime, append-only priority events, and a scrubbed bounded
  verdict log. The state registry declares resolution, compliance/archive, and
  rotating-log retention respectively.
- Development agents resolve the omitted enable flag live; fleet agents resolve dark.
- No Telegram/Slack/attention notices, generated URLs, or operator actions are added.
  Mobile-complete operator actions are therefore not applicable.
- LLM/provider timing can fail. Failures increment pull-visible counters and leave a
  recognized candidate pending instead of silently classifying it away.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval form, grant/revoke page, or other operator action
surface is touched. The only surface is an authenticated JSON status read, so this
section is not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN for Phase 1 dry-run observation.** The ledger is local to
the machine that owns the active autonomous run and has authenticated Telegram
history. Phase 1 neither speaks nor controls work, so it cannot double-notify or
create cross-machine authority. `GET /goal-realignment` reports this machine's
diagnostic state only.

This slice emits no user-facing notices and generates no URLs. Durable rows can stay
on the original machine if a topic transfers; they are not presented as a pool-wide
answer, and active transfer delivery is explicitly outside this observation-only
slice. The full approved design requires router-authoritative source reads,
owner-fenced replicated correctness metadata, and a transfer freshness barrier
before any later session-facing behavior is eligible. Phase 1's local evidence does
not grant that later authority.

---

## 8. Rollback cost

- **Hot-fix release:** disable explicitly with
  `monitoring.goalRealignment.enabled:false` or revert the code and ship a patch.
- **Data migration:** the added nullable SQLite column is backward-compatible and
  need not be removed. New goal-realignment state is isolated under its own directory
  and log.
- **Agent state repair:** none required. Keeping the append-only evidence is safer
  than deleting it; a later re-enable can reuse it.
- **User visibility:** none during rollback because Phase 1 sends nothing.

---

## Conclusion

The review found and fixed two substantive integration issues before commit: runtime
wiring was coupled to Presence Proxy, and production checkpoints persisted only a
re-serialized parsed result instead of exact provider output. It also added explicit
confirmed-addressed evidence, bounded resolved inbox/checkpoint state, archival
priority segments, and rotating verdict logs. With those corrections, the change is
a dev-gated, pull-visible signal producer with no action authority and is clear for
Tier 2 validation and ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

The change does not touch outbound/inbound blocking, dispatch, session lifecycle,
recovery, a guard/gate/sentinel/watchdog, or other Phase-5 trigger. Its periodic loop
computes a bounded observation and cannot actuate.

---

## Evidence pointers

- `tests/unit/goal-realignment-phase1.test.ts`
- `tests/unit/topic-memory-forwarded-provenance.test.ts`
- `tests/integration/goal-realignment-routes.test.ts`
- `docs/specs/reports/periodic-goal-realignment-phase1-validation.md`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is being fixed. The cadence-shaped reviewer is not
an `unbounded-self-action` controller: it does not restart, swap, respawn, spawn,
notify, retry delivery, re-drive, or kill. Its only self-triggered effect is a
dry-run observation; unchanged semantic input spends zero calls, overlapping ticks
singleflight, and provider failure records a counter rather than self-retrying.
