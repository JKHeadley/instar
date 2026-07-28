# Side-effects review — enrol-unjustified-stop-gate

**Change:** enrol `UnjustifiedStopGate` into the LLM-Decision Quality Meter
(`pending:backlog:decision-quality-enrolment` → `wired`), with an identity-only
provenance context and an explicitly declared `measurement-only` grading posture.

**Why this point:** at ~1343 calls / 7 days (`GET /metrics/features`) it is the
highest-volume UNENROLLED decision point in the census, and the second-busiest
gate overall. This is the second half of the run's census task — the half where
the backlog actually shrinks rather than merely becoming legible.

**Tier:** 1 — one census entry, one context builder, one provenance block. No new
route, config key, flag, or durable store.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**Nothing.** Enrollment adds an `options.provenance` block to an existing
provider call. It introduces no predicate, no branch, and no rejection path. The
gate's continue/allow/escalate verdict is computed exactly as before — asserted
directly by a test rather than argued.

The one build-time narrowing: the census ratchet now requires this point to stay
declared. Removing the enrollment without updating the census fails CI, which is
the intent.

## 2. Under-block — what failure modes does this still miss?

- **It records decisions; it does not grade them.** This is the honest half and
  is declared as `gradingPosture: 'measurement-only'` with a ≥40-char argument,
  so `findWiredWithoutGraders` reports it as an explicit posture rather than a
  silent contradiction. **The census number improves and the point is still not
  measured end-to-end** — anyone reading "wired" without reading the posture will
  overestimate what exists. That is why the posture is declared, tested, and
  stated in the release note.
- **Volume is capped at `budget:300`/day.** A day with more than 300 stop
  decisions archives the first 300; the `decision_quality` row is still written
  for every settlement, so counts stay complete while the archive is valved. A
  loud `droppedByBudget` counter surfaces the truncation.
- **The context is a fixed projection.** If a future reader needs a field I did
  not include, the history will not have it retroactively. I chose the minimum
  that reconstructs decision shape; widening later is additive but not backfillable.

## 3. Level-of-abstraction fit

The context builder is a private method on the gate, because only the gate knows
which of its inputs are trusted evidence and which are untrusted session text.
Building it anywhere else would require exporting that distinction — and a
downstream builder that guesses wrong is precisely how a transcript ends up in
a provenance store.

The provenance block rides the existing `options` argument alongside
`attribution`, so enrollment adds a signal rather than displacing one (tested).

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. Enrollment holds **no authority at all** — it is
pure observability. The settlement seam consumes the block and records on its own
path; it never reaches the model and never alters the verdict.

The gate itself remains what it was: an LLM authority with a deterministic
fail-open contract. This change deliberately does not touch that.

**The content-bearing contract is the safety property here**, and it is enforced
by test rather than by care: the fixtures plant a fake API key and a fake
password in the untrusted input, and the tests assert neither appears anywhere in
the serialized context. A hash-distinctness test prevents a constant or empty
hash from making the identity field useless while still passing the leak tests.

## 5. Interactions

- **`/metrics/features`** — unchanged; `attribution.component` is preserved
  (explicitly tested, because losing it would silently drop this component from
  the cost surface).
- **The census ratchet** — the pending baseline shrinks by exactly one line, which
  is the direction it is allowed to move. The typed-registration check
  independently verifies the enrolling source imports `DP_UNJUSTIFIED_STOP_GATE`
  rather than restating the string.
- **The breaker / fail-open path** — untouched. A provenance write failure is
  contained by the recorder's own fail-open contract, so it cannot convert into a
  stop-decision failure.
- **The prompt hash** — reused as `promptId`, so a row records WHICH prompt
  decided. The gate already computed it; nothing new is derived.

## 6. External surfaces

- No route, config key, flag, env var, CLI, message, or notification.
- `GET /decision-quality` will show one more `wired` point and one fewer
  `pending`. Field shapes unchanged.
- No user-visible behaviour whatsoever.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified.** The census is a shipped source constant, byte-identical on every
install, so every machine enrolls the same point with the same volume valve and
content class. The provenance rows themselves inherit the meter's existing
posture — this change adds no new state surface, no notice, and no generated URL.

## 8. Rollback cost

Revert. The census entry returns to `pending:` (restoring the baseline line), the
provenance block disappears, and previously-recorded rows remain inertly in the
store — harmless, and still readable if the enrollment returns.

## Second-pass review

**Not required** by the Phase-5 trigger list: enrollment makes no block/allow
decision, touches no session lifecycle, and adds no gate. The gate it observes is
unchanged.

Self-review, recorded rather than skipped:

1. **Is this the honest version or the number-improving version?** The
   temptation was real: flipping `pending` → `wired` shrinks census debt whether
   or not anything can be graded. I took the declared `measurement-only` path
   because the census distinguishes it and `findWiredWithoutGraders` surfaces it
   — the gap stays visible instead of being absorbed into a better-looking
   number. If that posture did not exist I would not have shipped this as-is.
2. **Could the untrusted text leak by a route I did not consider?** The context is
   an explicit allowlist of derived values, not a filtered copy of the input, so
   a new input field cannot appear in the row by default. The leak tests assert
   absence of planted secrets rather than presence of expected keys, which is the
   direction that catches accidental widening.

Tests: 11 new unit tests; 72 green across the affected suites.
