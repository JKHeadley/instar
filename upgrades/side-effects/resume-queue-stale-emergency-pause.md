# Side-Effects Review — Resume queue: stale emergency-stop pause auto-recovery

**Version / slug:** `resume-queue-stale-emergency-pause`
**Date:** `2026-06-14`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `cross-model (codex-cli:gpt-5.5, gemini-cli:gemini-2.5-pro) via /spec-converge — 6 rounds`

## Summary of the change

A paused resume queue used to early-return `{blocked:'paused'}` at the top of
`ResumeQueueDrainer.tick()`, silently stranding every waiting revival for the life of
the pause. A MessageSentinel emergency-stop (topic-scoped in its real intent) sets a
GLOBAL pause that never lifts, so a stale emergency stop on one topic permanently
disabled the revival net for all topics (the 2026-06-14 4-hour-silent-strand
incident). This change replaces that early-return with two layers, both at the same
chokepoint and both inert on a dry-run queue: **Layer 1** (signal-only) raises ONE
deduped `paused-waiting` aggregated attention notice when the queue is paused with
waiting work; **Layer 2** (bounded behavior change, on by default) auto-resumes a
STALE emergency/sentinel pause when an `AGE_LIMIT_ACTIVE_RUN_REASON` entry was queued
strictly more than `staleEmergencyPauseAutoResumeMin` (default 60) minutes after the
pause began, then falls through to normal draining. Files touched:
`src/monitoring/ResumeQueueDrainer.ts` (the two layers + 2 config keys),
`src/core/WorkEvidence.ts` (new `isAutoResumableEmergencyPauseReason` predicate),
`src/monitoring/ResumeQueue.ts` (`pause()` now upgrades an auto-resumable pause when a
deliberate halt arrives), `src/commands/server.ts` (thread the 2 code-defaulted keys),
`src/core/types.ts` (2 optional config keys), `src/scaffold/templates.ts` +
`src/core/PostUpdateMigrator.ts` (Agent Awareness), and the 3 test tiers.

## Decision-point inventory

- `ResumeQueueDrainer.tick()` paused-queue branch — **modify** — was an
  unconditional early-return; now runs Layer 1 (signal) + Layer 2 (a bounded
  authority change that REMOVES a stale over-broad block).
- `ResumeQueue.pause()` overlap semantics — **modify** — first-writer-wins gains a
  deliberate-halt UPGRADE (a non-auto-resumable reason overrides an existing
  auto-resumable pause; never the reverse).
- `isAutoResumableEmergencyPauseReason()` — **add** — the centralized closed-world
  predicate that decides which pause reasons are auto-resumable.

## 1. Over-block

No new block/allow surface is ADDED. Layer 2 strictly REMOVES a block (a stale global
pause). The only way this could "over-block" is by FAILING to auto-resume when it
should — which is the safe direction (the queue stays paused, exactly today's
behavior, and Layer 1 keeps alerting). Concrete safe-side cases that intentionally do
NOT auto-resume: a fresh emergency pause (active-run queued < threshold after
pausedAt), a deliberate `autonomous stop-all` pause, a plain mid-work entry (reason ≠
`AGE_LIMIT_ACTIVE_RUN_REASON`), a malformed `pausedAt`/`queuedAt`, `autoResumeStalePause:false`,
or a dry-run queue. All keep the pause — none wrongly clear it.

## 2. Under-block

Layer 2 could in principle clear a pause the operator wanted kept. Mitigations: (a)
the staleness window (default 60 min) means a fresh "kill everything" is never
auto-undone; (b) only the strongest re-engagement signal
(`AGE_LIMIT_ACTIVE_RUN_REASON`, queued AFTER the stop) triggers it; (c) **every topic
the operator actually stopped stays blocked by the per-topic `operatorStopSince`
validation in `validateReality` even after the queue auto-resumes** — verified by a
unit test (`operatorStopSince:() => true` still yields `invalidated:operator-stop`
post auto-resume); (d) a deliberate `autonomous stop-all` is never auto-cleared and
now UPGRADES an in-flight emergency pause so a later deliberate halt wins. The known
accepted residual (gemini r2/r5): an autonomous run that was contextually old but only
age-reaped after the stop satisfies the predicate — accepted because the per-topic
guard still blocks a genuinely-stopped topic, and the entry queued-after-stop
genuinely reflects a run left running through the stop window.

## 3. Level-of-abstraction fit

Correct layer. Layer 1 is a low-cost SIGNAL feeding the EXISTING aggregated attention
surface (`raiseAggregated` → the single `resume-queue:aggregate` P17 item) — it does
not run parallel to a smarter gate, it reuses the one that exists. Layer 2 is a
deterministic predicate over durable queue state at the drainer chokepoint where the
strand happens; it does not re-implement any existing primitive, and it explicitly
DEFERS the real per-topic safety decision to the already-existing finer-grained
`operatorStopSince` gate rather than duplicating it. The pause-reason classification
lives in one centralized, tested predicate rather than being re-derived per callsite.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — Layer 1 produces a signal consumed by the existing aggregated attention gate.
- [x] Yes — but the logic NARROWS authority toward a finer-grained gate that already
  exists. Layer 2 REMOVES an over-broad, stale, blunt block (the global pause) only
  when a precise deterministic staleness predicate holds; it does not ADD a new
  brittle blocker, and every revived candidate still passes ALL deterministic reality
  gates AND the per-topic `operatorStopSince` validation. The substring reason match
  is anchored to a closed, internally-generated set of pause reasons, centralized in
  one tested predicate, with a mechanical `src/`-callsite-scan test pinning every
  current reason's verdict so a future reason can't silently change behavior; a
  non-match resolves to the SAFE side (pause stays). Per signal-vs-authority, the
  change is strictly additive to safety on the stopped topic and removes a
  false-negative-on-revival for unrelated topics.

## 5. Interactions

- **Shadowing:** the new branch runs in place of the old `if (queue.isPaused()) return`
  early-return — it can either keep the pause (same as before) or fall through to the
  rest of `tick()` (which runs all the existing calm/quota/reality gates unchanged). No
  existing check is shadowed; the fall-through ADDS the gates rather than skipping them.
- **Double-fire:** Layer 1 dedupes on `(pausedAt | waitingCount)` so it cannot drip
  every tick; the existing `raiseResumeAggregated` in server.ts collapses all kinds
  into one rolling item. No double-notice.
- **Races:** `pause()`/`unpause()` are synchronous mutations on the single-writer,
  lockfile-guarded, in-memory-authoritative queue; the drainer's `ticking` re-entrancy
  guard prevents overlapping ticks. `unpause()` correctly accumulates `frozenMs` into
  each waiting entry's TTL clock (uses the existing lever, not a raw flag).
- **Feedback loops:** the auto-resume → spawn → (if it re-reaps) re-enqueue path is
  already bounded by the resurrection cap in `ResumeQueue.considerEnqueue`. A topic
  that keeps getting reaped-and-revived still hits `maxResurrections` and gives up
  loudly — Layer 2 does not bypass that cap.

## 6. External surfaces

- **Other agents on the same machine:** none — per-machine queue.
- **Install base:** the two config keys are code-defaulted (absent from
  ConfigDefaults). Existing agents pick up the new drainer behavior on update+restart.
- **External systems:** none. No Telegram/Slack/GitHub/Cloudflare call added beyond
  the existing attention surface (Layer 1 reuses it).
- **Persistent state:** `unpause()` mutates the existing `state/resume-queue.json`
  pause fields and a new `pause-upgraded`/`auto-resumed-stale-pause`/`paused-waiting`
  audit event in `logs/resume-queue.jsonl`. No schema field added to entries or
  persisted state. The Layer-1 dedupe marker is in-memory only.
- **Timing:** the staleness comparison uses the queue's single injected clock; strict
  `>`; malformed timestamps fail safe.
- **Operator surface (Mobile-Complete):** no NEW operator-facing action. The existing
  `POST /sessions/resume-queue/resume` lever (dashboard/phone-reachable) is unchanged;
  Layer 1 points the operator at "ask me to resume it, or resume it from the dashboard"
  (no raw API in the user-facing body).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer/markup
file, no approval page, and no grant/revoke/secret-drop form. (The CLAUDE.md template
+ migrator edits are agent-awareness text, not an operator UI.)

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The resume queue is one-queue-per-machine: a
single-writer lockfile (`state/resume-queue.lock`, pid + hostname + heartbeat), a
host-local state dir, and a hard invariant that a foreign-host lock is refused (never
probed/reclaimed). Pause/unpause state lives in that per-machine
`state/resume-queue.json`. Both layers are pure additions to the per-machine drainer
tick: Layer 1 routes through the existing per-machine `resume-queue:aggregate`
attention item (no new cross-machine surface, no generated URL); Layer 2's `unpause()`
mutates only the local queue and acts only on locally-queued entries. No timestamp
crosses a machine boundary (`pausedAt`/`queuedAt` are always same-process-stamped). A
topic transfer already closes the source session and the queue does not follow a moved
topic, so there is no strand-on-transfer concern. Emits a user-facing notice (Layer 1)
— it routes through the per-machine attention surface and is deduped per pause episode,
so no one-voice violation; holds durable state (the per-machine pause record, which
does not strand on transfer because the queue is machine-local); generates no URLs.

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert the PR and ship as the next patch.
- **Data migration:** none. No persisted entry/state schema field added. Existing
  `state/resume-queue.json` files are read/written exactly as before (the new audit
  events are append-only log rows).
- **Agent state repair:** none. `monitoring.resumeQueue.autoResumeStalePause: false`
  disables Layer 2 instantly (read live at tick time, no restart needed for the read —
  though a config change requires a session/server restart to load). Reverting restores
  the prior permanent-pause behavior exactly.
- **User visibility:** no regression during a rollback window. The worst case after a
  rollback is the return of the original bug (a stale pause can strand again) — but
  Layer 1's alert and Layer 2's behavior are independent, and Layer 1 carries no
  behavioral risk.

## Migration parity

- **Config defaults:** `staleEmergencyPauseAutoResumeMin` (60) and
  `autoResumeStalePause` (true) are CODE-defaulted in `ResumeQueueDrainerConfig` /
  `DEFAULT_RESUME_DRAINER_CONFIG` and threaded from `monitoring.resumeQueue.*` in
  server.ts via `?? default` — deliberately NOT frozen into ConfigDefaults (preserving
  the fleet flip, consistent with the other resumeQueue.* keys). **No `migrateConfig()`
  change needed** — existing agents pick up the new behavior on update+restart with the
  code defaults.
- **CLAUDE.md template:** added a bullet to `generateClaudeMd()` (new agents via init)
  AND a dedicated idempotent `PostUpdateMigrator` block sniffed on the unique phrase
  `autoResumeStalePause` (existing agents, even those that already have the resume-queue
  section — the parent block's `/sessions/resume-queue` sniff would otherwise skip
  them). Both are content-sniffed and safe to run repeatedly.
- **No hook/skill changes.**

## Conclusion

The review (6 spec-converge rounds with two real cross-model reviewers) hardened the
change substantially: the topic-scoped emergency-stop premise went from asserted to
code-cited; `pause()` gained a deliberate-halt upgrade so a later `stop-all` is honored
over an in-flight emergency pause; the substring match was centralized and mechanically
enforced by a callsite-scan test; Layer-1 dedupe became count-aware; clock/boundary
discipline and the per-topic-guard dependency were made explicit and test-backed. The
change is strictly additive to safety on a genuinely-stopped topic and removes a
false-negative-on-revival for unrelated topics. All three test tiers are green (unit
51, integration 9, e2e 8). Clear to ship.

## Second-pass review (if required)

**Reviewer:** cross-model external pass (codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro), 6 rounds
**Independent read of the artifact: concur**

The external reviewers converged to MINOR ISSUES with no architectural objection; the
final round (codex r6) produced zero new material findings. Every prior-round finding
is resolved in the spec/code or recorded as an accepted tradeoff / Future item
(`pauseKind` enum), with the lone fresh round-5 finding (pause-upgrade) implemented.

## Evidence pointers

- Spec: `docs/specs/resume-queue-stale-emergency-pause.md` (frontmatter
  `review-convergence`, `cross-model-review: codex-cli:gpt-5.5`, `approved: true`).
- Convergence report: `docs/specs/reports/resume-queue-stale-emergency-pause-convergence.md`.
- Tests: `tests/unit/resume-queue-drainer.test.ts` (51), `tests/integration/resume-queue-routes.test.ts` (9), `tests/e2e/reap-notify-resume-queue-lifecycle.test.ts` (8).
