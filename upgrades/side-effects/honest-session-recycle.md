# Side-Effects Review — Honest Session Recycle

**Version / slug:** `honest-session-recycle`
**Date:** `2026-06-14`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (2 non-blocking concerns, both resolved)`

## Summary of the change

When a session is reaped at its per-session lifetime cap (`reason: 'age-limit'`)
but its Telegram topic still has an ACTIVE autonomous run, the recycle is a
continuation (the run respawns), not a death. ReapNotifier now stamps that fact
at ingest and emits honest "🔄 recycled at its lifetime cap — your autonomous run
has Xh left, resuming; no work was lost" copy instead of the false "🪦 reached its
maximum allowed runtime" gravestone. Files: `src/monitoring/ReapNotifier.ts`
(new optional dep `autonomousRunActiveFor`, ingest stamp, four render branches,
two pure helpers), `src/commands/server.ts` (wires the dep via a new
`autonomousRunRemainingForTopic`), `src/core/AutonomousSessions.ts` (the extracted
run-remaining helper). No SessionManager / kill-chokepoint change.

## Decision-point inventory

- `ReapNotifier.onReaped` ingest — **modify** — stamps `autonomousRunActive` when
  an `age-limit` reap has an active run; affects only NOTICE WORDING, never
  whether a notice is sent.
- `ReapNotifier` render (single/aggregate/unbound/legacy) — **modify** — branch the
  per-event copy on the stamp.
- The reap/respawn behavior itself — **pass-through** — unchanged.

---

## 1. Over-block

No block/allow surface — this change only chooses notice WORDING. It can never
suppress a notice: the only effect of the recycle branch is gentler copy; the
notice is always still sent. Over-block not applicable.

## 2. Under-block

No block/allow surface. The nearest analogue is "could a real death be softened
into a recycle?" — covered: the stamp requires `reason === 'age-limit'` AND an
active run with remaining > 0. A stuck-session death (`idle-zombie`,
`watchdog-stuck`, etc.) is never softened even mid-run (unit-tested). A run past
its window returns null → death copy stands.

## 3. Level-of-abstraction fit

Correct layer. The wording decision lives in ReapNotifier (the existing single
listener that already owns "is this a disappearance worth a notice?"). The
autonomous-state lookup lives at the server wiring layer (which has the state) and
is computed by one shared helper `autonomousRunRemainingForTopic` in
AutonomousSessions.ts — the same module that owns the run-window data — so the
recycle copy and any future caller agree on "is this run in-flight, how long
left?". SessionManager's kill chokepoint is deliberately NOT touched (lowest blast
radius).

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface. It is pure presentation: a
  signal (the autonomous-run fact) consumed to choose honest wording. It holds no
  authority over reaping, respawning, or whether a notice fires. Fails toward the
  loud legacy copy on any error.

## 5. Interactions

- **Shadowing:** none — the branch is inside the existing notice formatter; it
  does not run before/after any other check.
- **Double-fire:** none — still exactly one `sessionReaped` → one notice per the
  existing coalescing; this only changes the text.
- **Races:** the autonomous-run state is read at INGEST (synchronously when the
  event arrives), not at the SUMMARY release (which can be ~30 min later), so the
  "X left" figure reflects reap time and can't drift to a stale/negative value at
  render. The reported `remainingSeconds` is a point-in-time snapshot, by design.
- **Feedback loops:** none — reads autonomous state, writes only notice text.

## 6. External surfaces

- Telegram: the user-visible reap notice text changes for the active-run recycle
  case (🔄 + "no work was lost") — this is the intended fix. All other reap
  notices are byte-identical.
- No other-agent, GitHub, Cloudflare, or persistent-state surface. No new route.
- **Operator surface (Mobile-Complete):** no operator-facing actions added — this
  is an outbound notice wording change only. Not applicable.

## 6b. Operator-surface quality

No operator surface — not applicable. No `dashboard/*` or approval/grant/secret
form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Reap notices are emitted by the machine that owns
and reaps the session; the autonomous run state read (`config.stateDir`) is that
same machine's. A recycle on machine A is narrated by machine A in the topic — the
correct single voice for that event (the reaping machine is authoritative about
its own reap). No durable state is created (notice text only), so nothing strands
on topic transfer. No URLs generated. One-voice: the notice rides the existing
ReapNotifier coalescing + reap-notice drain, which already own single-emission.

## 8. Rollback cost

Pure code change — revert the three files and ship a patch. No persistent state,
no migration, no agent-state repair. During any rollback window the only
regression is the notice reverting to the old (alarming-but-not-harmful) wording.
No user data affected. The feature is also inert by construction when no
autonomous run is active (the common case) — it only ever activates on an
age-limit recycle of a live run.

## Conclusion

The review produced one design refinement during the build: the run-remaining
computation was extracted from an inline server.ts block into a single tested
helper (`autonomousRunRemainingForTopic`) so the run clock has one source of
truth. The change is wording-only with a fail-loud default and full both-sides
test coverage (recycle vs death; active / over-window / paused / no-run / missing
duration / throws). Clear to ship pending the high-risk second-pass concurrence.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (high-risk: reap-notifier / session-lifecycle)
**Independent read of the artifact: CONCUR** (verified: fail-open is airtight across three layers; cannot silence a notice; terminal-death mislabeling is prevented by the `age-limit` + `remaining>0` guard; run-state read at ingest not render; pure presentation, no blocking authority).

Two non-blocking concerns raised — **both resolved before commit:**

- **Test-tier coverage.** Resolved: added `tests/integration/honest-session-recycle-wiring.test.ts`, which composes the REAL `autonomousRunRemainingForTopic` helper with the REAL ReapNotifier over a temp stateDir (the dep is non-null and delegates to the real run-window read) — the wiring-integrity tier. Tier-3 HTTP E2E is N/A by design: this change adds NO API route or feature-alive surface (it is outbound notice WORDING), so the canonical "feature returns 200" E2E does not apply; the integration composition is the appropriate top tier here.
- **Copy over-promised self-resume.** Resolved: respawn is message-triggered today (spec F1), so the copy was corrected to "no work was lost. I'll pick it back up on my next turn — send a message if I stay quiet" (single) / "it resumes on its next turn" (legacy) — no "resumes automatically" claim.

## Evidence pointers

- `tests/unit/reap-notifier.test.ts` — honest-recycle describe block (6 tests):
  recycle copy, never-contradicts-clock, no-run-death, only-age-limit, throws-fails-safe, over-window-death.
- `tests/unit/AutonomousSessions.test.ts` — `autonomousRunRemainingForTopic`
  describe block (4 tests): in-flight remaining, numeric/string topic, over-window
  null, no-run/paused/missing-duration null.
- `tests/integration/honest-session-recycle-wiring.test.ts` — real helper composed
  with real notifier (2 tests): in-flight run → honest recycle copy with real
  computed remaining; no run file → terminal death copy.
- `npx tsc --noEmit` clean; 51/51 unit + 2/2 integration tests green.
