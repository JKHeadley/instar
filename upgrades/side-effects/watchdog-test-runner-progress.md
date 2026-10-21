# Side-Effects Review — Test-runner floor extended by measured progress, and its interruptions announced

**Version / slug:** `watchdog-test-runner-progress`
**Date:** `2026-10-20`
**Author:** `Echo`
**Second-pass reviewer:** `not yet performed — see §Second-pass review`

## Summary of the change

`SessionWatchdog`'s test-runner floor expired on wall clock alone. Past the
floor the hard ceiling (default 1800s) is already exceeded, so every fail-closed
path votes to interrupt and the kill becomes arithmetic rather than a judgement
— on 2026-10-20 a healthy full suite was SIGINT-ed at 3610s, and a `git push`
running a pre-push tier at 3615s. Neither was announced: the only trace was
`.instar/watchdog-interventions.jsonl`, while the harness that launched the
suite reported a clean exit.

Two changes. (1) Past the floor, protection is held open while the candidate's
subtree CPU time is still advancing between polls, bounded by a new three-hour
absolute ceiling; `'unknown'` (no readable CPU column, unparseable cell) extends
nothing, so behaviour on an unmeasurable platform is byte-identical to before.
(2) An interrupted test run produces one user-facing line at the FIRST
intervention of an episode, carried by a new `stuckCommandKind` field on the
intervention event.

## Decision-point inventory

- `classifyTestRunnerProtection()` — modify — past the wall-clock floor the verdict now also consults measured progress, bounded by `MAX_TEST_RUNNER_ABSOLUTE_MS`.
- `TestRunnerProgressTracker.observe()` — add — turns two CPU readings of one pid into `progressed` / `idle` / `baseline` / `unknown`. Pure, injected clock.
- `parseCpuTime()` — add — reads a `ps -o time=` cell; returns `undefined` rather than `0` for anything unreadable.
- `subtreeCpuMs()` — add — sums a candidate's own CPU plus its descendants' from the already-captured snapshot.
- `SessionWatchdog.getChildProcesses()` — modify — the single existing `ps` call gains a `time=` column; no new subprocess.
- `formatWatchdogUserMessage()` — modify — a test-runner interruption is surfaced at `CtrlC` level, which is silent for every other command.

## 1. Over-block

Not an over-block risk in the usual direction — this change REMOVES blocking in a
narrow case. The corresponding risk is over-PROTECTION: a test run stuck in a
loop that burns CPU without progressing is protected to the full three hours
instead of being interrupted at one. The trade is explicit: three hours of a
wasted core against an hour of real work destroyed and reported as success. The
protection applies only to commands already matching the argv contract (or above
one), never widens the matched set, and is ended by the absolute ceiling, by the
first `idle` verdict, or by an unreadable measurement.

## 2. Under-block

A genuinely hung run that is also burning CPU evades the judge for up to three
hours. A hung run that is quiet (the common case — blocked on a lock, on stdin,
on a socket) is released at the next poll after the floor, exactly as before. A
platform whose `ps` has no readable time column keeps today's behaviour in full,
which is the deliberate fail-toward-status-quo direction.

## 3. Level-of-abstraction fit

The measurement sits at the same layer as the floor it extends: the lifecycle
component that owns Ctrl+C, deciding whether to hand a candidate to the
contextual judge. It adds no second stuckness judge — the question it answers is
mechanical and local ("has this subtree consumed CPU since I last looked?"), and
every ambiguous case still reaches the existing LLM authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — deterministic logic is appropriate: this is an invariant floor over a
  mechanically measurable fact, not a judgement about intent. It can only ever
  SPARE a process; it can never cause an interruption that would not otherwise
  have happened.

The tracker has no authority over anything except the watchdog's own destructive
Ctrl+C, and only in the sparing direction. The user-facing notice is a report of
an action already taken.

## 4b. Judgment-point check (Judgment Within Floors standard)

The extension is a floor, not a judge: `progressed` / `idle` is a threshold over
a measured quantity with both sides unit-tested, and everything outside the
enumerated test-runner shapes is untouched. The LLM judge remains the arbiter for
every ambiguous command, and regains authority over test runs at the absolute
ceiling.

## 5. Interactions

- **Shadowing:** the test-runner branch still returns before the 2h external-wait checks, unchanged. A protected run also still adds its pid to `protectedSubtrees`, so its children are not separately judged.
- **Double-fire:** the notice fires only when `stuckRetryCount === 0` and the level is `CtrlC`, so one episode yields one line even though escalation can record up to five interventions. A later force-kill still adds its own existing line — truthfully, since that is a second, worse event.
- **Races:** a poll landing sooner than the 20s sample gap reports the STANDING verdict rather than a fresh one, so a protected run cannot flip to unprotected on timing alone. Samples are per-pid and are dropped after 30 minutes without observation, so pid reuse can at most produce one bounded extension (a reading below the baseline re-baselines rather than judging).
- **Feedback loops:** none. The tracker is read-only with respect to processes; it never signals, spawns, or writes.

## 6. External surfaces

No new route, no new config key, no network call, no credential, no file. The
existing `ps` invocation gains one column (no extra subprocess). The intervention
JSONL gains three additive fields (`stuckCommandKind`, `stuckElapsedMs`,
`stuckRetryCount`) that older readers ignore. One new class of user-facing
message: a single plain line when a test run is interrupted — strictly MORE
honesty than the silence it replaces, and bounded to one per episode.

Risk worth naming: the `ps` row regex gained a field. A parse failure would blind
the watchdog entirely rather than loosen it. The new column is POSIX, the fields
are read positionally, and the regex is exercised against the live process table
in an integration test (755/755 rows parsed when verified by hand on darwin).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The only operator surface is the new message. It names the duration, says
plainly that nothing the run finished was kept, states that it needs to run
again, and carries no command, path, signal name, or jargon — asserted by test.
It does not ask the operator to do anything; it offers that they can tell me if
the run was healthy.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** a watchdog observes and actuates only local
processes, and CPU readings are local operational truth. No pool-wide authority,
no replicated state, no topic transfer, no URL. Each machine decides for its own
sessions exactly as it did before.

## 8. Rollback cost

Revert the patch. No state to clean up: the tracker is in-memory, the JSONL
fields are additive, and the awareness bullet would merely overstate protection
until the revert propagates. The added `ps` column disappears with the revert.

## Conclusion

The change closes a failure where the guard's own expiry, not a judgement, was
destroying healthy work and reporting success. It extends protection only on
measured evidence, bounds that extension, leaves unmeasurable platforms exactly
as they were, and makes the interruption it still performs visible. Clear to
ship on the three-tier gate; the honest residual is CPU-as-proxy, stated above
rather than designed away.

## Second-pass review (if required)

**Reviewer:** not yet performed. Recorded here rather than claimed: this lands
on the three-tier test gate plus the live incident evidence
(`logs/server.log` 2026-10-21T02:27:46Z and 04:55:50Z). The two judgement calls
a reviewer should press on are (a) CPU time as the progress proxy and (b) the
one-poll `baseline` grace, both argued in §1 and §5.

## Evidence pointers

- `tests/unit/watchdog-test-runner-progress.test.ts` — tracker semantics, CPU parsing, both sides of every bound
- `tests/unit/watchdog-notifications.test.ts` — the notice: wording, once-per-episode, no jargon
- `tests/unit/session-watchdog-test-runner-floor.test.ts` — unchanged, and still passing: the proof that an unmeasured run behaves as before
- `tests/integration/session-watchdog-safe-wait.test.ts` — the watchdog pipeline past the floor, plus the real process table carrying an advancing CPU column
- `tests/e2e/watchdog-test-runner-progress-alive.test.ts` — a real `npm test` subtree, real CPU readings, real 21s sample gaps

## Class-Closure Declaration (display-only mirror)

`defectClass: guard-expiry-destroys-healthy-work`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/e2e/watchdog-test-runner-progress-alive.test.ts and tests/unit/watchdog-test-runner-progress.test.ts, howCaught: the E2E ratchet spawns a real npm-test subtree, ages only the clock past the floor, and proves across two real 21-second polls that an advancing-CPU run reaches neither the stuck judge nor a signal while a CPU-frozen one is still interrupted AND produces a user-facing line; the unit ratchet pins both sides of the floor, the absolute ceiling, and the unmeasurable-platform case that must stay unchanged }`.
