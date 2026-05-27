# Side-Effects Review — Mentor-onboarding job (§19.4)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** The live mentor loop, shipped DORMANT. Pure tick core (`runMentorTick`), thin runner
(`MentorOnboardingRunner`), routes (`GET /mentor/status`, `POST /mentor/tick`), AgentServer wiring,
`mentor.*` config defaults, CapabilityIndex entry, and a built-in job template (`enabled:false`).
**Files:** `src/scheduler/MentorOnboardingTick.ts`, `src/scheduler/MentorOnboardingRunner.ts`,
`src/server/routes.ts`, `src/server/AgentServer.ts`, `src/server/CapabilityIndex.ts`,
`src/config/ConfigDefaults.ts`, `src/scaffold/templates/jobs/instar/mentor-onboarding.md`,
`tests/unit/MentorOnboardingTick.test.ts`, `tests/unit/MentorOnboardingRunner.test.ts`,
`tests/integration/mentor-routes.test.ts`, `tests/e2e/mentor-onboarding-lifecycle.test.ts`,
`upgrades/NEXT.md`.

## Principle check (Phase 1)

Does this involve a decision point that gates info flow / blocks actions / constrains behavior?
**Yes — and it's built signal-only.** The tick *decides* whether to act (canary→budget→safe-window),
spawns a constrained sub-agent, and writes findings. But none of it has authority over the user's
world: today it only writes to the read-only ledger (no mentee-delivery path is wired yet — see
Live-promotion blockers). It ships dormant (`mentor.enabled=false`, `mode:'off'`), so the production
default is `POST /mentor/tick → {ran:false, reason:'disabled'}` — no spawn, no spend, no contact.

## The seven questions

1. **Over-block.** The safe-window check is conservative: `isMenteeBusy()` treats ANY running
   session as "busy," so the mentor errs toward not-interrupting (correct bias). The budget cap and
   min-interval floor likewise skip rather than act. No legitimate *required* action is blocked —
   the mentor is purely additive.

2. **Under-block.** The Stage-B *deep* log-forensics (assembling the mentee's rollouts/diffs and
   LLM-classifying them) is not yet wired — `runStageBForensics` returns `[]` today, so the loop's
   real signal is the Stage-A leak detector (§4.3) + the funnel. This is a tracked follow-on
   (<!-- tracked: topic-13435 -->), not a silent gap: the funnel logs every run, so a loop producing
   no findings is visible, not hidden. `getSurface` returns an empty history until the conversation
   source is wired (same tracked follow-on) — meaning until then Stage A has thin context, which the
   off-by-default + dry-run-first rollout is designed to surface before live.

3. **Level-of-abstraction fit.** The orchestration is a PURE function (`runMentorTick`) with all
   side-effects injected — the structural guarantees (canary-first, fail-closed budget, safe-window)
   are in code, not the job prompt. The runner is thin glue; the job template is a thin timer that
   pokes `POST /mentor/tick`. Spawn enforcement is delegated to the right layer (SessionManager
   `--allowedTools`). This is the correct decomposition.

4. **Signal vs authority.** Compliant. The tick produces signal (ledger findings) only — it never
   merges code, advances graduation, or gates another component, and no mentee-delivery path is wired
   yet. Authority stays with the human (§6/§8). The empty Stage-A tool grant is CLI-enforced, not
   self-policed.

5. **Interactions.** The runner reuses `ledger.captureRun` (funnel logs every run), `MentorStageA`
   (empty grant + leak detector), and SessionManager.spawnSession. Min-interval + per-day counters
   live on AgentServer and advance only via the `onTickRan` hook (so skipped ticks don't consume the
   budget). A busy-session check prevents the mentor from interrupting other work. No shadowing of
   existing sentinels; the mentor never kills/restarts anything.

6. **External surfaces.** Two new routes behind Bearer auth (e2e: 401 without). A built-in job that
   ships `enabled:false` (e2e asserts this). `mentor.*` config flows through the canonical
   ConfigDefaults registry → existing agents get it via `applyDefaults` on migration (no bespoke
   migrator block; matches `sessionReaper`/`topicIntent`). CapabilityIndex entry surfaces the routes.
   No mentee-delivery path exists yet (Live-promotion blockers), so even `live` mode only observes.

7. **Rollback cost.** Low. Dormant by default; revert removes the routes/job/config. No data
   migration (the ledger/funnel tables are §19.1/19.2). The job auto-uninstalls when the template is
   removed (installBuiltinJobs prunes slugs no longer in the templates dir).

## Phase 5 — second-pass (REQUIRED here; deferred from §19.3)

This change spawns sub-agents and contains gating logic, so a dedicated reviewer audited it
independently. Their verdict is appended below (concur, 0 blocking concerns).

## Live-promotion blockers (must close before `mentor.mode` → `live`) <!-- tracked: topic-13435 -->

The second-pass surfaced three items that are unreachable while dormant but MUST be closed before the
graduated-rollout flips the mentor to `live`. They are explicitly NOT ship-blockers for this dormant
change; they are the gate for activation:

1. **No mentee-delivery path is wired.** The tick surfaces `stageAMessage` but nothing forwards it to
   the mentee. The persist-only delivery (§6) must be built + tested before `live` can actually
   contact anyone. (Code comments + Q1/Q4/Q6 above corrected to say this.)
2. **Spawn poll robustness + real budget accounting.** `spawnStageA` polls 90×2s then captures the
   pane; on poll-exhaustion it must kill the session and capture a `stage-a-timeout` finding rather
   than read a partial transcript and orphan the tmux session. And `dailySpendCapUsd` is presently a
   run-count cap (`maxRoundsPerDay`) — wire real cost accounting or rename the knob before live.
3. **Async tick.** The 180s poll runs on the `POST /mentor/tick` request thread; before live, return
   `202` + poll completion via `/mentor/status` (avoid the gate-latency-vs-client-timeout failure).

All three are gated behind `mentor.enabled=false` today and covered by the off→dry-run→live promotion
discipline (each step needs Justin's sign-off), so the dormant ship is safe.

## Testing

- Tier 1 (unit): 8 `runMentorTick` (gate order: canary→budget→safe-window→Stage A→leak→Stage B→
  capture; fail-closed budget before contact; leak capture; spawn-failure self-report) + 6 runner
  (dormant short-circuit, busy/min-interval unsafe, status).
- Tier 2 (integration): 4 — `/mentor/status` 503/200; `/mentor/tick` disabled-by-default + runs-when-enabled.
- Tier 3 (e2e "alive"): 5 — real AgentServer boot, status 200-not-503 + dormant, tick disabled on the
  production path, /capabilities surfaces it, 401 without auth, job template ships `enabled:false`.
- Affected push-config suite vs canonical main: 3431 + 300 capability tests green, no regressions.

## Reviewer second-pass

**Concur with the review — with three non-blocking concerns to track.**

Independent audit of `MentorOnboardingTick.ts`, `MentorOnboardingRunner.ts`, the `buildMentorRunner`
wiring in `AgentServer.ts`, the `/mentor/status` + `/mentor/tick` handlers in `routes.ts`, and
`MentorStageA.ts`/`ConfigDefaults.ts`. The core safety properties hold:

- **Signal vs authority (Q1): clean.** The tick only writes to the read-only ledger via `capture`
  and returns a `stageAMessage` string. It never kills/gates/blocks any component. `isMenteeBusy`
  only makes the mentor skip *itself*. No brittle blocking authority anywhere.
- **Fail-closed / canary-first (Q2): real.** Order in `runMentorTick` is canary → budget →
  safe-window → Stage A → leak → Stage B → capture. The budget gate (line 108) precedes the only
  spawn (line 116). Every skip returns early before `capture`, so there is no partial
  Stage-A-without-capture. Canary failure self-reports and halts.
- **Dormancy (Q3): genuinely inert.** `DEFAULT_MENTOR_CONFIG` and `ConfigDefaults.mentor` both ship
  `enabled:false`/`mode:'off'`. `tick()` short-circuits to `{ran:false,reason:'disabled'}` BEFORE
  touching any service. With defaults, `POST /mentor/tick` cannot spawn or spend. Verified by the
  `enabled:true + mode:'off'` unit test.
- **Budget/min-interval counters (Q5): no double-count, no bypass.** `onTickRan` fires only when
  `result.ran` (runner line 95); all five skip reasons return `ran:false` → counters do not advance
  → skipped ticks consume no budget.
- **Two-hats (Q6): structurally enforced.** `STAGE_A_ALLOWED_TOOLS = []` is passed as
  `allowedTools: [...STAGE_A_ALLOWED_TOOLS]`; the leak detector runs on the transcript and a leak is
  captured as a finding. Empty-grant is CLI-enforced, not prompt-policed.

**Concern 1 (non-blocking) — the artifact overstates live-mode delivery; there is in fact NO
delivery path wired at all.** The artifact (lines 20, 44, 58) and the code comments
(`MentorOnboardingTick.ts:155-156`, `155` "delivered only in `live` mode by the runner") describe a
"persist-only path" that messages the mentee in `live` mode. That path does not exist: `tick()` in
`MentorOnboardingRunner.ts` returns `stageAMessage` and the route handler in `routes.ts:4275-4276`
simply JSON-returns the result; nothing ever forwards the message to the mentee (no
`messageRouter`/`relay`/`inject` call in the runner, tick, or route — grep-confirmed). This is
actually SAFER than advertised (live mode cannot contact anyone today — it is functionally
dry-run-plus-counter), so it is not a blocking safety issue. But it makes the "Signal vs authority /
live mode would message the mentee" framing inaccurate and means the highest-risk surface (actual
outbound contact) is entirely unbuilt and *untested*. The "delivered via the persist-only path"
comments should be corrected to "delivery is a tracked follow-on; live mode currently runs the loop
without contacting the mentee," and the live-delivery work tracked alongside the §19.4 follow-on
(topic-13435). Fix: amend the artifact + the two `MentorOnboardingTick.ts` comments; track delivery
as not-yet-built.

**Concern 2 (non-blocking) — the spawn poll can leak/orphan a Stage-A session, and the budget gate
counts ticks, not dollars.** In `buildMentorRunner` (`AgentServer.ts:675-680`) the spawn polls
90×2s = 180s for the session to disappear from `listRunningSessions()`. `maxDurationMinutes:5` does
NOT bound the spawn within the poll window: the timeout is enforced lazily by the monitor tick with
a 20%-or-60-min buffer (`SessionManager.ts:598-602`), so a wedged Stage-A session is only reaped at
~6 min — after the poll has already given up at 3 min. When the poll falls through, the code
captures whatever is on the pane and returns it as the "transcript" of an *unfinished* session
(garbage-in to the leak detector), while the tmux session keeps running until the monitor reaps it.
This is bounded (it will be reaped) and dormant today, but at live cadence (10-min floor, 24/day) a
chronically-slow mentee could overlap a still-running prior Stage-A against the next tick's
`isMenteeBusy` check (which would then correctly skip). Separately, `dailySpendCapUsd` (0.5) is
declared in config and the artifact calls the gate a "daily spend cap," but `budgetOk` only checks
`mentorRunsToday < maxRoundsPerDay` — it never accounts dollars. The cap is a *run-count* cap, not a
spend cap. Fix before live promotion: (a) treat poll-exhaustion distinctly from
session-completed — if the session is still running at 90 iterations, kill it explicitly and capture
a `stage-a-timeout` finding rather than returning a partial pane as a clean transcript; (b) either
wire `dailySpendCapUsd` to a real cost accounting (TokenLedger) or rename it / drop it from the
config + artifact so it isn't mistaken for a spend ceiling.

**Concern 3 (non-blocking) — the 180s synchronous poll runs on the request thread of
`POST /mentor/tick`.** `tick()` awaits `spawnStageA`, which awaits the 90×2s loop, so a live tick
holds the HTTP request open up to ~3 min. The built-in job is the only caller today and can tolerate
it, but any client (or the job runner's own HTTP timeout) hitting `/mentor/tick` will block or 408
mid-tick. This is the gate-latency-vs-client-timeout failure mode the team has hit before. The tick
core is non-blocking; the issue is purely the synchronous-spawn wiring in `buildMentorRunner`. Not a
dormant-mode risk. Fix before live: make `/mentor/tick` kick the tick and return `202 accepted`
(fire-and-poll via `/mentor/status`), or bound the request with an explicit handler timeout that is
distinct from spawn completion.

None of the three blocks dormant ship: with `enabled:false` the tick never runs, so the spawn/poll,
the (absent) delivery, and the spend-cap mislabel are all unreachable in production today. They are
promotion-blockers for `live`, not ship-blockers for this dormant change. They must be resolved (and
the delivery path actually built + tested) before `mentor.mode` is flipped to `live` — recommend the
graduated-rollout track gate `dry-run → live` on closing all three.

BLOCKING CONCERNS: 0

## Post-push CI fixes

Two CI checks caught issues, both fixed:
- `route-completeness.test.ts` requires every `catch (err)` to pair with an `err instanceof Error`
  check; the `/mentor/tick` handler used `(err as Error).message`. Switched to
  `err instanceof Error ? err.message : String(err)`.
- `Docs Coverage` enforces a per-type floor; the new `mentor-onboarding` job dropped the `job`
  floor (85%) since it was undocumented. Documented it in `reference/default-jobs.md` +
  `architecture/the-living-system.md` (job coverage → 86%).
