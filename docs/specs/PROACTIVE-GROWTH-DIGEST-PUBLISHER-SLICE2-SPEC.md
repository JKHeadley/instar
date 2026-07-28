---
title: "Proactive Growth Digest Publisher — Slice 2 (cadence + delivery)"
slug: "proactive-growth-digest-publisher-slice2"
author: "echo"
parent-spec: "docs/specs/PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md"
parent-principle: "Close the Loop"
origin-commitment: "CMT-1151"
review-convergence: "2026-06-10T16:09:20.821Z"
review-iterations: 3
review-completed-at: "2026-06-10T16:09:20.821Z"
review-report: "docs/specs/reports/proactive-growth-digest-publisher-slice2-convergence.md"
approved: true
approved-by: "justin"
approved-at: "2026-06-10T17:34:00Z"
---

# Proactive Growth Digest Publisher — Slice 2 SPEC (cadence + delivery)

Status: **proposed** — the unbuilt "Cadence + delivery" slice (§5) of
`PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md`. Slice 1 (the analyst that COMPUTES
the digest + read routes) is shipped and live on the dev agent. This slice wires
the already-existing-but-unwired `monitoring.growthAnalyst.digestCron` to an
in-process publisher that, on a cadence, composes ONE consolidated "growth
check-in" and routes it through the existing flood-guarded post-update path.

Parent spec: `docs/specs/PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md` (§5, §7, §10).
Origin ask: Justin, 2026-06-06, topic 21624 — *"I have YET to have an agent
proactively check in with me about ANY of these."* Origin commitment: CMT-1151.

This slice is **flood-sensitive** (it is the first thing in the growth feature
that actually SENDS), so per the parent spec it gets its own cross-model
convergence review + operator approval before any code ships.

**Convergence note:** this spec was hardened by a Round-1 review panel (security,
scalability, adversarial, integration, lessons-aware + gemini external). The
biggest change vs the first draft: a **multi-machine lease gate** (the in-process
cron would otherwise double-send on a paired agent — the superseded job was
lease-gated and this slice must not silently drop that), a **pure res-free
outbound-guard funnel** (so the publisher provably cannot bypass the dedup/budget/
tone chokepoint), and **calm-week sends suppressed by default** (a weekly
"all healthy" with no action is the exact noise the operator killed burnDetection
for). See §9 for the original-vs-converged diff.

---

## 1. Problem (grounded, verified on disk @ upstream/main v1.3.469)

- `GrowthMilestoneAnalyst.buildDigest()` returns a complete `GrowthDigest`
  (`{ generatedAt, calm, summary, findings[], counts, nextWindowClosesInDays }`)
  — verified at `src/monitoring/GrowthMilestoneAnalyst.ts:577-610`. It already
  AGGREGATES a burst of N expiries into ONE digest object + counts (unit-tested
  at N=500). It computes R1–R6 (R1/R2 maturity, R3 stalling, R4 spec-pattern,
  R5 correction-pattern, R6 dev-gate conformance). It is genuinely observe-only
  (every error path returns a SMALLER digest in the safe direction; it never
  gates an action).
- The analyst is wired LIVE on dev agents behind `resolveDevAgentGate`
  (`src/server/AgentServer.ts:1299-1328`); `/growth/digest|status|findings|tick`
  serve it; `POST /growth/tick` runs observe+compute.
- **The gap:** nothing consumes the digest on a cadence and sends it. The config
  field `monitoring.growthAnalyst.digestCron` (default `"0 11 * * 1"`, Mon 11:00)
  exists in `src/core/types.ts` but is wired to NO sender (`git grep digestCron`
  outside types/ConfigDefaults → empty). The operator never gets a proactive
  growth check-in — the exact silence the parent spec set out to end.
- `initiative-digest-review` (a Sonnet prompt-job, `0 11 * * 1,4` = Mon AND Thu
  11:00 — `src/scaffold/templates/jobs/instar/initiative-digest-review.md:4`)
  nominally covers R3 but is "near-silent — posts ONLY when a genuinely-new
  decision is waiting"; that bar ~never trips, so it effectively never speaks.
  **It runs only on the awake machine** (scheduler is lease-gated:
  `server.ts:3801` `if (config.scheduler.enabled && coordinator.isAwake)`). The
  unified digest supersedes it — and MUST preserve that single-machine property
  (§3.7), which an in-process cron does not get for free.

## 2. Goal

ONE consolidated proactive "growth check-in," on a regular cadence, delivered to
the operator through the existing budget/dedup-guarded surface — reversing the
over-silence WITHOUT overshooting into flood OR into no-action noise. Honors the
same dark → dry-run → live → default-on maturity path the analyst itself reports
on, and is exactly-once across a multi-machine pairing.

## 3. Design

### 3.1 `GrowthDigestPublisher` (`src/monitoring/GrowthDigestPublisher.ts`)

A small in-process component (model after `SessionReaper`'s audit-sink shape and
`PromiseBeacon`'s injected-`sendMessage` shape). It owns NO analysis — it is a
cadence + lease-check + decide-to-speak + format + deliver + audit wrapper around
the analyst.

Constructor deps (all injected — pure, testable):
- `buildDigest: (now: Date) => GrowthDigest` — bound to the live analyst.
- `cron: string` — `monitoring.growthAnalyst.digestCron`.
- `timezone?: string` — IANA tz for both the cron fire AND the rendered date
  (§3.2); default `'UTC'` (croner default), documented.
- `mode: 'off' | 'dry-run' | 'live'` — the rollout stage (§3.4).
- `sendOnCalmWeeks: boolean` — delivery-level calm behavior (§3.4); default
  **false** (do NOT send a no-action heartbeat every week).
- `send: (text: string) => Promise<DeliveryResult>` — the SINGLE funnel to the
  guarded updates-topic path (§3.3). `DeliveryResult = { ok: boolean; reason?: string }`.
- `isAwake: () => boolean` — the multi-machine lease gate (§3.7); default
  `() => true` (single-machine no-op).
- `lastPublishedAt: () => string | null` + the audit log double as the durable
  "did we already publish this window?" record for missed-run catch-up (§3.1).
- `audit: (entry: GrowthDigestAuditEntry) => void` — append-one-JSON-line sink
  (default → `logs/growth-digest.jsonl`), mirroring the sentinel audit pattern.
- `now?: () => Date`, `onError?: (where, err) => void`.

Lifecycle:
- `.start()` — creates `new Cron(cron, { timezone, protect: true, unref: true },
  onFire)` via **croner** (the lib JobScheduler already uses:
  `src/scheduler/JobScheduler.ts:11,263`). No new dep. `protect:true` blocks
  overlapping fires; `unref:true` keeps the timer from holding the process open.
  On `.start()` it ALSO runs a **missed-run catch-up** (below).
- `.stop()` — `task.stop()`; idempotent. Wired into `AgentServer.stop()`
  alongside the other monitors (`AgentServer.ts:3092`), reference nulled.
- `onFire()` → `await this.publishOnce(this.now(), 'cron')`.
- `.publishOnce(now, trigger)` is PUBLIC so a test (and a future
  `POST /growth/publish` debug route, out of scope here) can drive one cycle
  deterministically.

`publishOnce(now, trigger)` algorithm (deterministic, NO LLM):
1. **Lease gate** — `if (!this.isAwake())` → record `{ action: 'skipped-standby' }`,
   return. (A standby machine never sends; mirrors the scheduler gating the
   superseded job had — §3.7.)
2. `mode === 'off'` → record `{ action: 'skipped-off' }`, return. (Belt: the
   publisher is only constructed when mode ≠ 'off', but guard anyway.)
3. **In-flight guard** — if a previous `publishOnce` is still running (sync
   buildDigest is heavy — §3-perf), record `{ action: 'skipped-overlap' }`,
   return. (Belt-and-suspenders with croner `protect:true`, because `publishOnce`
   is also publicly callable.)
4. `digest = buildDigest(now)`.
5. Decide to speak:
   - `!digest.calm` → speak (there are real findings).
   - `digest.calm && sendOnCalmWeeks` → speak (operator opted into heartbeats).
   - `digest.calm && !sendOnCalmWeeks` → record `{ action: 'skipped-calm' }`,
     return. (Default: a no-action week is silent — respects the documented
     burnDetection-noise correction.)
6. `text = formatDigest(digest, { timezone })` (§3.2) — scrubbed + clamped ≤4096.
7. `mode === 'dry-run'` → record `{ action: 'dry-run', wouldSend: text, counts,
   trigger }`, do NOT send, return. The exact would-send message lands in the
   audit log for operator inspection (this is how we show a real sample before
   going live).
8. `mode === 'live'` → `r = await send(text)`. Record `{ action: r.ok ? 'sent' :
   'send-blocked', reason: r.reason, counts, trigger }`. A block (dedup/budget/
   tone) is a NORMAL outcome, never an error, and is never re-acted on (the
   publisher adds a delivery surface, never any authority).
All branches are wrapped so a failure is audited via `onError` and never throws
out of the cron callback (an observe-only-derived component must never crash the
server). The audit entry always carries the digest `counts` so a skipped/blocked
cycle is still inspectable.

**Missed-run catch-up (Scalability S3 — the "check-in never arrives" failure).**
croner schedules only a single `setTimeout` to the next match; it does NOT replay
a fire time that elapsed while the box was asleep or the server was down (unlike
JobScheduler's `checkMissedJobs`). For the proactive check-in that is the exact
failure this slice exists to fix. So on `.start()`, after a settle delay (default
60s — long enough for the multi-machine lease to settle so a machine that boots
`isAwake:false` then acquires the lease isn't wrongly skipped, and the awake
machine doesn't record a premature `skipped-standby` window entry), the publisher
computes the most-recent scheduled fire time at/under `now` (croner
`previousRun()`); if that time is in the past AND the audit log shows no
publish/skip for that window, it runs one catch-up `publishOnce(now, 'catchup')`.
Idempotent: the window key (the missed fire's ISO) is recorded ONLY on a real
send/skip-decision (never on a pre-lease check) so a restart loop can't re-fire
the same window. The catch-up itself still passes the lease gate (only the awake
machine catches up). The settle delay is configurable; the cron sanity-floor
(§3.4) guarantees windows are ≥1h apart so a 60s settle can never straddle two.

### 3.2 `formatDigest(digest, { timezone }): string` — deterministic, pure, exported

Turns a `GrowthDigest` into a compact, readable Telegram message. NO LLM — the
analyst already decided what crosses a rule; the formatter only renders it.

Render rules (all enforced, not hinted):
- **Priority-first, never-truncate-critical** (gemini #2 / parent §10 Q3 → hard
  requirement): findings are ordered by priority (`high` → `normal` → `low`) and
  ALL `priority:'high'` findings + the maturity actions that demand a decision
  (R1 promote, R6 dev-gate-dark) are rendered IN FULL, never capped. Only the
  `low`/`normal` BULK (R3 stalling is the volume driver, 205 today) is capped at
  **K per rule** (default 5) with a "+N more (see full digest)" overflow line.
- **Cap-before-concat**: the formatter applies the per-rule caps and stops
  appending once the running length nears 4096 — it NEVER materializes the full
  500-line string and then slices (Security #3). The whole message is hard-clamped
  to 4096 (post-update's own limit) with a final "…(truncated — full digest at
  /growth)" only if the high-priority set alone somehow exceeds it.
- **Render-boundary scrub (defense-in-depth, Security #1)**: every rendered
  `detail` and `title` is passed through `scrubSecrets()` (`src/monitoring/
  scrubSecrets.ts`) AT THE RENDER BOUNDARY before inclusion. The analyst's
  "HTTP-safe" guarantee is about the pull API; a push channel (chat, phone
  notification preview, screenshot, forward) warrants its own scrub. Each
  rendered `detail` is hard-capped to ≤200 chars (a real cap, not a hint). This
  covers the dry-run `wouldSend` text automatically (same formatter output).
- **Timezone**: the header date is rendered in the injected `timezone` (the SAME
  zone the cron fires in) so "Monday 11:00" and the printed date agree.
- **Calm render**: header + `digest.summary` ("All healthy — N incubating, next
  window closes in Xd"). Note the calm summary carries the changing
  `nextWindowClosesInDays`/counts, so even when calm sends are enabled they are
  not byte-identical week-over-week.

Shape:
```
📊 Growth check-in — <generatedAt in timezone>

<digest.summary>

<high-priority findings, IN FULL, grouped by rule>
<then low/normal bulk, capped K per rule with "+N more">

Read the full digest anytime: GET /growth/digest (or the dashboard).
```

`formatDigest` is pure and exported → unit-tested on calm, single-rule, all-six-
rules, the priority-never-truncate guarantee (a high-priority finding survives
alongside 500 low ones), the scrub pass, and overflow (K+1, 500).

### 3.3 Delivery path — ONE res-free outbound-guard funnel (no second send path)

The digest is a proactive broadcast about the agent's own maturation → it belongs
in the **Agent Updates topic**, NOT the active session topic (same rule as
`/telegram/post-update`). It MUST pass through the SAME guards that route uses.
Grounded constraint (Security #2, Integration MINOR, Lessons F2): the current
`checkOutboundMessage(text, channel, res, opts)` (`src/server/routes.ts:1276`) is
**Express-`res`-coupled** — on a block it calls `res.status(422).json(...)` and
returns a boolean. The publisher's cron callback has NO `res`. So the funnel
extraction is NOT a trivial wrapper; it must DECOUPLE the guard decision from the
response writing, or the path of least resistance during build is the publisher
calling a raw un-guarded `sendToTopic` — silently creating a SECOND send path and
defeating the entire §4 anti-flood guarantee (the Structure-beats-Willpower
failure: two chokepoints instead of one).

Required extraction (the funnel contract):
1. Introduce a pure `evaluateOutbound(text, channel, opts): Promise<{ ok: boolean;
   reason?: string; status?: number }>` carved out of `checkOutboundMessage` —
   the dedup + per-source topic budget + tone-gate + localhost-guard DECISION
   logic, with NO `res`. Behavior byte-identical to today's checks. NOTE: the two
   fire-and-forget observers at the top of `checkOutboundMessage`
   (`observeSelfViolation`, `observePrincipalCoherence` — both observe-only, they
   credit operator-role / principal claims) STAY in the thin route adapter, not in
   `evaluateOutbound`. A proactive growth digest credits no operator role and is
   authored by no principal, so there is nothing for those observers to catch on
   the publisher path; keeping them route-side preserves byte-identical behavior
   for existing callers without emitting meaningless telemetry for the digest.
2. `checkOutboundMessage` becomes a thin route-only adapter: `const v = await
   evaluateOutbound(...); if (!v.ok) { res.status(v.status).json(...); return true }`.
   Existing callers and tests unchanged in behavior.
3. `postToUpdatesTopic(text, { allowDuplicate? }): Promise<DeliveryResult>` (the
   helper the publisher's `send` is wired to): resolve `agent-updates-topic`
   server-side → `{ ok:false, reason:'no-updates-topic' }` if absent (NEVER a
   fallback topic, mirroring the route's 400); else `await evaluateOutbound(...)`
   → `{ ok:false, reason:'guard-blocked' }` on block; else `sendToTopic` →
   `{ ok:true }`.
4. `POST /telegram/post-update` is refactored to call `postToUpdatesTopic`
   (behavior-identical; covered by existing tests + the §5 regression assertions
   on the 400/422/dedup branches).
The publisher's `send` is attached at route-registration time (where `ctx` lives),
e.g. `ctx.growthDigestPublisher?.attachSender(postToUpdatesTopic)`. **The publisher
must never reach `sendToTopic` without going through the shared guard** — asserted
in the wiring-integrity test (§5): the publisher path and the route path invoke
the IDENTICAL `evaluateOutbound`, not two copies.

### 3.4 Rollout mode + config

Per parent §7 (`dark → dry-run → live → default-on`, flag-path
`monitoring.growthAnalyst`). Config fields under `monitoring.growthAnalyst`
(add to BOTH `src/config/ConfigDefaults.ts` AND the `growthAnalyst` type in
`src/core/types.ts:4234-4264`):

- `digestDelivery: 'off' | 'dry-run' | 'live'` — default **`'off'`**, even on a
  dev agent. Deliberate: Slice 1's COMPUTE+EXPOSE is already live on dev agents;
  this slice's new SEND behavior stays opt-in until explicitly advanced, so
  merging the code does not start buzzing anyone. The publisher is constructed
  only when the analyst exists AND `digestDelivery !== 'off'`.
- `digestCron: string` — cadence (already present); default `"0 11 * * 1"`
  (Mon 11:00). **Sanity-floor (Scalability S2)**: at construction, a `digestCron`
  whose two soonest fires are < 1h apart is REFUSED (logged + the publisher does
  not start, treated as misconfig) — `buildDigest` is a synchronous,
  event-loop-blocking pass (~8 InitiativeTracker scans + a full stage-journal
  rewrite each call), fine weekly, a CPU/disk churner per-minute. A fat-finger
  must not turn an observe-only-derived component into a per-minute load.
- `digestTimezone?: string` — IANA tz for cron + render; default `'UTC'`.
- `digestSendOnCalmWeeks: boolean` — default **`false`**. When false, a fully-calm
  week is silent (`skipped-calm`); the operator opts in to a steady "all healthy"
  heartbeat. (Decouples the analyst's `digestEvenWhenCalm` — which governs whether
  the digest OBJECT/API renders a calm summary, fine at its `true` default — from
  whether the publisher SENDS on a calm week. Resolves the calm-nag finding.)

Dogfood path on echo: ship merged at `digestDelivery:'off'` → operator sets
`'dry-run'` → inspect the would-send sample in `logs/growth-digest.jsonl` →
operator sets `'live'`. Fleet stays `'off'` (and analyst itself stays dark
fleet-wide). The live-flip is tracked as the CMT-1151 follow-through so it cannot
silently stall at `off` (close-the-loop).

### 3.5 Supersede `initiative-digest-review` (durable + atomic)

When `digestDelivery === 'live'`, the unified digest is the single voice on
initiatives (R3). Two grounded hazards (Integration NOTE + Adversarial #1):

- **Durability**: disabling the job via the *deployed* `.instar/jobs/instar/`
  manifest REGRESSES on the next instar update (built-in job templates are
  always-overwritten — the exact analyzer-job-revert class). The durable
  supersede is to flip `enabled: false` in the **source template**
  `src/scaffold/templates/jobs/instar/initiative-digest-review.md` at the
  live-flip, so it survives updates. (This ships in the SAME PR that flips echo
  live, not before — while `digestDelivery` is `off`/`dry-run` the unified digest
  doesn't send, so the job must stay enabled until the flip.)
- **Atomicity / two-voice race**: `initiative-digest-review` fires `0 11 * * 1,4`
  — exactly colliding with the publisher's default Monday 11:00. To avoid both
  speaking in the first live window, the source-template disable and the
  `digestDelivery:'live'` flip are ONE change. **Belt (P2-clean close-the-loop):**
  on its first `live` send the publisher checks whether `initiative-digest-review`
  is still enabled and, if so, emits ONE signal line into its audit log +ONE
  low-priority growth finding ("initiative-digest-review still enabled — disable
  to avoid a double initiative voice"). A SIGNAL, never a cross-component
  mutation (the publisher never disables another component's job itself).

### 3.6 Wiring (AgentServer + multi-machine)

Construct the publisher right after the analyst block (`AgentServer.ts:1324`),
gated on the analyst + the delivery mode (telegram / Updates-topic availability is
NOT a construction gate — it is enforced at SEND time by `postToUpdatesTopic`,
§3.3, which returns `{ ok:false, reason:'no-updates-topic' }`; this lets the
publisher boot before the Updates topic is provisioned and simply skip-send until
it exists, and gives the construction-gate wiring test a concrete predicate —
`analyst && digestDelivery !== 'off'`):

```
const digestDelivery = options.config.monitoring?.growthAnalyst?.digestDelivery ?? 'off';
if (this.growthMilestoneAnalyst && digestDelivery !== 'off') {
  this.growthDigestPublisher = new GrowthDigestPublisher({
    buildDigest: (now) => this.growthMilestoneAnalyst!.buildDigest(now),
    cron: ...digestCron, timezone: ...digestTimezone,
    mode: digestDelivery, sendOnCalmWeeks: ...digestSendOnCalmWeeks,
    // GROUNDED API: MultiMachineCoordinator.isAwake is a GETTER (not a method),
    // and the coordinator is `options.coordinator` (not `this.coordinator`). The
    // single-machine no-op keys on `.enabled` exactly like the server.ts
    // precedents (server.ts:3801, 5730 use `coordinator.enabled && ... isAwake`).
    isAwake: () => options.coordinator?.enabled ? options.coordinator.isAwake : true,  // §3.7
    audit: appendGrowthDigestAudit, onError: console.warn, ...
  });
  this.growthDigestPublisher.start();  // sender attached at route registration
}
```
Own try/catch (an init failure here can never cascade). `.stop()` in
`AgentServer.stop()`.

### 3.7 Multi-machine: lease-gated delivery (SERIOUS — was missing in draft)

`AgentServer` (and its in-process monitors) is constructed on BOTH the awake and
the standby machine of a pairing (`server.ts` — construction is not gated by
`coordinator.isAwake`). The §4 "one message per cadence" guarantee holds
PER-PROCESS, not PER-AGENT — so two machines' croner tasks would each fire the
weekly digest → the operator gets it twice (the ~15-min dedup window catches an
exactly-simultaneous duplicate but NOT two sends minutes apart, and is
bypassable). The job this supersedes is immune because the SCHEDULER is
lease-gated (`server.ts:3801`). Moving the work into an in-process cron silently
drops that safety unless we re-add it.

Fix (precedent: ActivitySentinel `server.ts:5729-5730` — "Only the awake machine
scans … so standby machines don't double-digest"): the publisher's `publishOnce`
short-circuits with a `skipped-standby` audit entry when the injected `isAwake()`
returns false. GROUNDED API: `MultiMachineCoordinator.isAwake` is a **getter**
(`get isAwake(): boolean`, `MultiMachineCoordinator.ts:160`), NOT a method — so
the injected thunk is `() => options.coordinator?.enabled ? options.coordinator.isAwake
: true` (single-machine no-op keys on `.enabled`, matching the `server.ts`
precedents). The catch-up path (§3.1) is gated the same way. Asserted by a
wiring-integrity test: a standby coordinator yields ZERO `send` calls.

**Residual handoff edge (bounded, deliberate safe direction).** The audit log
that records "this window was published" is per-machine (`logs/growth-digest.jsonl`).
If a lease handoff falls between a window's fire time and the newly-awake
machine's next `.start()`/catch-up, the new machine — with no local record of the
old machine's send — can re-send that ONE window once. This is bounded (a single
re-send, not a flood), absorbed by the shared `evaluateOutbound` dedup for a
near-simultaneous case, and is the deliberately-chosen direction (the slice's
whole point is "the check-in arrives" over "silently dropped"). Accepted, not
fixed, by design.

## 4. Anti-flood + anti-noise guarantees (non-negotiable)

1. **One message per cadence period, per AGENT** — single `publishOnce` → at most
   one send, AND only the lease-holding machine sends (§3.7).
2. **Object-level aggregation** — analyst collapses N into one digest.
3. **Render-level aggregation** — `formatDigest` caps low/normal per-rule with
   overflow lines (205 stalling → ~5 lines + "+200 more"); high-priority findings
   are rendered in full, never truncated.
4. **Single guarded funnel** — every send goes through the shared res-free
   `evaluateOutbound` (dedup + per-source budget + tone) via `postToUpdatesTopic`;
   the publisher has no second send path. Source label `growth-digest-publisher`.
5. **No per-element topics** — ONE message into the existing Updates topic; never
   a topic per finding. (Bounded Notification Surface ceiling never engages, but
   the burst-invariant CI test still asserts it.)
6. **No no-action noise** — a fully-calm week is silent by default
   (`digestSendOnCalmWeeks:false`); the operator opts into heartbeats.
7. **Off by default** — merging the code sends nothing; delivery is opt-in with a
   tracked live-flip so it can't silently stall dark.

## 5. Test plan (3-tier + burst invariant — Testing Integrity Standard)

- **Unit** (`tests/unit/GrowthDigestPublisher.test.ts`):
  - `publishOnce` matrix over `isAwake × mode × calm × sendOnCalmWeeks ×
    send-ok/blocked` → correct action + audit entry on BOTH sides of every branch.
  - `isAwake:false` (standby) → ZERO `send` calls, `skipped-standby` audit.
  - `mode:'off'`/`'dry-run'`/calm-suppressed NEVER call `send` (spy = 0);
    `'live'` + non-calm calls it exactly once.
  - In-flight guard: a slow `publishOnce` re-entered → `skipped-overlap`.
  - Missed-run catch-up: with a past-due window and no prior audit entry, `.start()`
    fires exactly one `catchup` publish; a second `.start()` (restart loop) does
    NOT re-fire the same window.
  - Cadence sanity-floor: a sub-hourly `digestCron` → publisher refuses to start.
  - `formatDigest` purity: calm, single-rule, all-six-rules; priority-never-
    truncate (one `high` finding survives among 500 `low`); scrubSecrets applied
    to a `detail` carrying a token shape; overflow (K+1, 500 → capped + "+N more",
    whole message ≤4096); timezone-rendered header date.
- **Integration** (`tests/integration/growth-digest-publisher.test.ts`):
  - Real HTTP pipeline: `digestDelivery:'live'` + Updates topic + seeded finding
    → exactly one `sendToTopic(updatesTopicId, …)` + `sent` audit; NO Updates
    topic → `send-blocked reason:'no-updates-topic'`, nothing sent.
  - `digestDelivery:'dry-run'` → `dry-run` audit carrying `wouldSend`, `sendToTopic`
    never called.
  - Refactored `POST /telegram/post-update` behaves identically — assert the
    400 (no topic) / 422 (tone/localhost) / dedup branches, not just 200/!200.
- **Wiring-integrity** (`tests/integration/growth-digest-publisher-wiring.test.ts`):
  - The publisher path and the route path invoke the IDENTICAL `evaluateOutbound`
    (a dedup-duplicate is actually suppressed for the publisher; a missing Updates
    topic actually blocks) — deps are not no-ops.
  - Standby coordinator → publisher makes zero sends.
  - Construction gate: analyst-null OR `digestDelivery:'off'` → publisher null,
    no cron task.
- **E2E** (`tests/e2e/growth-digest-publisher-lifecycle.test.ts`):
  - Production init path: dev-agent config + `digestDelivery:'live'` + Updates
    topic + a seeded past-window proved feature → exactly one growth check-in lands
    in the Updates topic end-to-end; `digestDelivery:'off'` → nothing sent, no
    cron task.
- **Burst invariant** (extend `tests/integration/notification-flood-burst-invariant.test.ts`):
  - 500 findings → exactly ONE message, ≤4096 chars, zero per-finding topics, and
    any `high`-priority finding present is NOT truncated.

## 6. Migration parity (Migration Parity Standard)

- **Config defaults**: add `digestDelivery:'off'`, `digestTimezone` (optional),
  `digestSendOnCalmWeeks:false` to the `growthAnalyst` defaults in `ConfigDefaults`
  AND the `growthAnalyst` type in `types.ts:4234-4264`. `applyDefaults`
  add-missing-only deep-merge backfills existing agents on update (verified:
  `PostUpdateMigrator.migrateConfig` → `applyDefaults`/`deepMerge`) — no separate
  `migrateConfig` block, matching the rest of the block. `digestCron` default
  already present.
- **CLAUDE.md template** (`generateClaudeMd`): when this goes LIVE (not at merge),
  add a one-liner that the agent sends a (default-weekly, calm-suppressed) growth
  check-in to the Updates topic + the `digestDelivery`/`digestSendOnCalmWeeks`
  knobs + `GET /growth/digest` for on-demand. Add a `migrateClaudeMd`
  content-sniff so existing agents gain the awareness. (A dark/off-by-default
  merge needs no live-agent awareness migration; it rides the live-flip, parent
  §9.)
- **Supersede**: at the live-flip, `enabled:false` in the SOURCE template
  `initiative-digest-review.md` (durable across updates — §3.5). No NEW job
  template (cadence is in-process, consuming the existing `digestCron`).

## 7. Rollout

`off` (merge — sends nothing) → `dry-run` on echo (would-send sample to
`logs/growth-digest.jsonl`; operator reviews the real text) → `live` on echo
(single weekly voice; `initiative-digest-review` disabled in source template) →
`default-on` for the fleet only after it proves itself AND the analyst itself is
flipped live fleet-wide (a separate, later decision). Dogfood on echo first — the
feature honors the very maturity path it reports on. The live-flip is the CMT-1151
follow-through (tracked, so the `off` rung can't become a silent-forever dark
ship — the parent feature's own origin bug).

## 8. Open questions (resolved in this revision unless noted)

1. **Sender wiring layering** — RESOLVED: extract pure `evaluateOutbound` +
   `postToUpdatesTopic` helper; attach the sender from route registration so the
   publisher stays in `src/monitoring/` (§3.3).
2. **Supersede vs co-run `initiative-digest-review`** — RESOLVED: supersede via
   source-template disable at the live-flip + a one-time signal if still enabled
   (§3.5). Auto-disable from code rejected (surprising cross-component mutation).
3. **Per-rule cap K + priority** — RESOLVED: K=5 for low/normal bulk; high-priority
   (R1/R6/`priority:high`) NEVER truncated (§3.2).
4. **Cadence + calm cadence** — default weekly Mon 11:00, calm weeks silent
   (`digestSendOnCalmWeeks:false`). OPEN for operator: confirm weekly is the right
   active rhythm, and whether a periodic calm heartbeat (e.g. monthly) is wanted
   despite the default-silent stance.
5. **Timezone default** — `'UTC'` unless `digestTimezone` set; the rendered date
   uses the same zone. OPEN for operator: set `digestTimezone` to their local zone
   so "Monday 11:00" is local.
