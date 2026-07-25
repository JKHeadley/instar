# Side-effects review — dated-commitment-reminder

**Change:** commitments gain a first-class `checkInAt`; a recurring reconciler
posts exactly one fixed-template reminder to the commitment's topic when that
instant arrives; a built-in job drives it. ACT-724 (critical, pinned).

**Spec:** `docs/specs/dated-commitment-reminder.md` (2 review rounds; round 1
returned SERIOUS ISSUES and inverted the send/stamp ordering).

**Ships dark:** dev-agent gated + `dryRun` defaulting true + job manifest
`enabled: false`.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

- **A dated commitment with no `topicId` is never reminded** (`no-topic`). A
  reminder with nowhere to go is not a reminder; it is reported as a skip reason
  rather than silently dropped, and appears in the `pending` list.
- **An unparseable `checkInAt` fails closed.** Deliberate: coercing it would make
  the commitment look overdue since epoch and fire immediately — the exact
  boot-fire shape fixed in `scheduler-never-run-window` days earlier.
- **A pass is capped at 25.** An overdue backlog drains across passes rather than
  flooding a topic. The cap logs when it drops work, so a truncated pass is never
  reported as a complete one.
- **Only `pending` counts as open.** A status added later is treated as not-open
  (no reminder) until classified deliberately. Safe direction, but it does mean a
  future status would silently stop reminders until someone adds it to the set.

## 2. Under-block — what failure modes does this still miss?

- **"Structurally impossible" is not yet true.** ACT-724 asks that a dated
  commitment without a reminder be impossible. Shipping dark means the watcher
  can be off, so a dated commitment CAN exist with nothing watching. What IS
  structural today: given the reconciler runs, no individual commitment can be
  missed (coverage is a property of the scan, not of a per-commitment
  registration). The creation-time gate that closes the rest is the declared
  graduation step, and it cannot itself ship dark. Called out because the spec's
  own framing over-claimed until review pushed back.
- **A duplicate is possible in one narrow window** — crash between send and
  stamp. Accepted, and mitigated by the relay's existing content dedup rather
  than by design novelty. Stated plainly instead of claimed away.
- **Clock jumps** shift a reminder in time (late on a backwards jump, early on a
  forwards one) but cannot double-send or permanently suppress.
- **No escalation if a reminder is ignored.** Out of scope: this delivers the
  date, it does not chase. The beacon owns chasing.

## 3. Level-of-abstraction fit

The decision (`isCheckInReminderDue`) is pure and lives in
`checkInReminderCore.ts`; the effects (CAS, send, retry) live in the reconciler;
the cadence lives in a built-in job. That split is what let both sides of every
clause be tested without a store, a clock, or a transport.

**The alternative I rejected is the more standard one.** A transactional outbox
(`reminder_deliveries` with pending/sent/failed) is the textbook answer and is
genuinely better at volume. Rejected here because the commitment record already
IS durable single-writer state: a second store would add a consistency boundary
— a new class of divergence bug — to serve tens of commitments. The fields on the
commitment are a degenerate outbox with exactly one row per commitment. If volume
ever justifies it, the migration is mechanical.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. Both decision points are `invariant`:

- **The due predicate** is arithmetic over durable state (open ∧ date arrived ∧
  unstamped ∧ routed ∧ retries remain). No competing signals, nothing to weigh.
  The failure being fixed was an ABSENT mechanism, not a bad judgment.
- **The reminder text** is a fixed template, deliberately not model-authored.
  Generating it would add a judgment where none is wanted and a failure mode
  (provider down) on a path whose entire purpose is to not fail.

**Deliberate gate bypass, argued:** the reminder rides the deterministic delivery
path, not the LLM tone gate. The tone gate fails closed, and a reminder that can
be held by a failing gate is the defect this feature exists to fix. This is not
weakening a safety control — the control is inapplicable, because the message
carries no agent prose for it to judge. Nothing model-generated reaches the user
through this path.

## 5. Interactions

- **PromiseBeacon** — untouched. `checkInAt` is a NEW field precisely so beacon
  cadence (`nextUpdateDueAt`, `softDeadlineAt`) is not overloaded; a one-time
  dated reminder and a rolling nudge cadence stay independent.
- **`CommitmentTracker.mutate`** — the existing single-writer CAS is reused, not
  replaced. Two passes racing cannot double-stamp.
- **The relay's content dedup** (`outboundContentDedup`) — now load-bearing for
  this feature's duplicate story. Documented in both the spec and the reconciler
  so a future change to that window is understood to affect this.
- **The scheduler** — this is why `scheduler-never-run-window` shipped first. A
  reminder job on the old scheduler would have fired at boot.
- **`installBuiltinJobs`** — writes both `jobs/instar` and `jobs/schedule` for
  built-ins, which is exactly why ACT-724's defect (b) (the two-file dance) does
  not apply: that dance is only manual for USER jobs.

## 6. External surfaces

- **New:** `POST /commitments/check-in-reminder/pass`, `GET
  /commitments/check-in-reminder`. Both Bearer-authed, both 503 when dark.
- **New built-in job** `commitment-checkin-reminder`, `enabled: false`.
- **New commitment fields** — additive and optional; existing records load
  unchanged, no migration.
- **User-visible:** one message per dated commitment, at its date, in its own
  topic. Fixed template. The only user-facing text this change introduces.
- **A transport is required only to SEND.** A dry run needs none — surfaced by
  the Tier-3 test, which would otherwise have reported the feature dead on an
  agent with no messaging configured.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified, with a single-executor rule.**

- `checkInAt` / `checkInReminderSentAt` / `checkInReminderAttempts` /
  `checkInReminderFailedAt` live on the commitment record and inherit the
  commitment store's existing posture. No new state surface.
- **The pass must run on ONE machine.** The built-in job is per-machine (each
  machine runs its own scheduler), so on a pool the pass must be lease-gated the
  way the benchmark-divergence analysis pass is. Belt-and-braces: even if two
  ran, the CAS stamp makes the second a no-op — the lease prevents wasted work,
  the CAS prevents the duplicate.
- **HONEST GAP:** the lease gate is specified in §Multi-machine posture but the
  job ships `enabled: false`, so it is not yet wired in this change. Enabling the
  job on a multi-machine pool BEFORE adding the lease check would risk two
  machines both passing — the CAS still prevents a duplicate reminder, but the
  work would be duplicated. Recorded as a precondition of enabling, not as done.
- No notice routing, no generated URL, nothing that strands on topic transfer.

## 8. Rollback cost

Disable `commitments.checkInReminder` or the job manifest. The reconciler is the
only reader of these fields; commitments keep them inertly. No migration, no
durable cleanup, no agent-state repair. Reverting the commit is equally safe.

## Second-pass review

**Required** — this sends messages to users (outbound messaging is on the Phase-5
trigger list).

Two rounds of external cross-model review, the first of which returned **SERIOUS
ISSUES** and changed the design:

1. **Stamp-before-send made zero delivery a designed outcome.** A failed send
   left the commitment marked `checkInReminderSentAt` and permanently
   ineligible. Inverted to send-then-stamp with bounded retry; the duplicate risk
   is covered by the relay's existing dedup. A regression test asserts a failed
   send never reads as sent.
2. **"Structurally impossible" over-claimed** for a feature behind a disableable
   flag. Split into what is true now versus at graduation.
3. **Time semantics under-specified** — `checkInAt` is now defined as an absolute
   instant with normalization at the creation boundary, and DST/clock-jump
   behaviour is stated.
4. **Cadence and scale omitted** — 5-minute cadence, worst-case lateness, the
   in-memory store's actual size, per-pass cap and backlog drain are now stated.
5. **Alternatives not compared** — outbox, durable queue, one-shot entries, and
   per-commitment scheduler entries are now compared with reasons.

Self-review found one thing the reviewer did not: the Tier-3 test initially
asserted that `AgentServer` self-constructs the `CommitmentTracker`. It does
not — `server.ts` injects it — so the routes 503'd on the real boot path while
Tier 2 passed happily against a hand-assembled context. That is exactly the
wiring assumption Tier 3 exists to break, and the test now mirrors the
production entrypoint. It also surfaced the dry-run/transport coupling in §6.

Tests: 41 unit + 10 integration + 4 e2e = 55.


## Class-Closure Declaration

**Class:** `unbounded-self-action` · **Closure:** `guard` · **Enforcement:** ratchet
**Citation:** `tests/unit/self-action-convergence.test.ts`

This change adds a self-triggered controller: a cadenced pass that SENDS
messages to users without a human in the loop. Under the "Capacity Safety — No
Unbounded Self-Action" standard that has to be proven to CONVERGE under
sustained pressure, not merely be individually correct.

Registered as `check-in-reminder-pass` in `src/testing/selfActionRegistry.ts`.

**Steady-state bound.** The emit is gated by a durable per-commitment attempt
counter (`CHECK_IN_MAX_ATTEMPTS = 5`), persisted through the CAS `mutate()`
BEFORE the send — so a crash-loop cannot buy fresh attempts, and the registry's
restart model (which reconstructs from durable state) settles at the same bound.

**Settling brake.** Two terminal states, both durable: a successful send writes
`checkInReminderSentAt`, making the commitment permanently ineligible; repeated
failure exhausts the counter and writes a loud `checkInReminderFailedAt`.

**Modeled at the worst case.** The registry model has every send FAIL, so the
success stamp never lands and only the attempt counter can stop it. Without that
counter the model emits once per tick forever and the ratchet fails — which is
the point: the bound is load-bearing, not decorative.

**Instantaneous mass** is separately bounded by the per-pass cap (25), which logs
when it defers rather than dropping silently.
