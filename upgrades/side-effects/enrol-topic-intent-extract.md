# Side-effects review — enrol-topic-intent-extract

**Change:** enrol `TopicIntentExtractor` into the LLM-Decision Quality Meter
(`pending:backlog:decision-quality-enrolment` → `wired`), identity-only context,
declared `measurement-only`.

**Why this point:** ~733 calls / 7 days — the highest-volume unenrolled decision
point remaining after the stop gate (#1632). This continues the census task's
"enrol the highest-volume scenarios", which is plural and where the backlog
actually shrinks.

**Tier:** 1 — one census entry, one inline context, no new module.

---

## 1. Over-block — what does this reject that it shouldn't?

Nothing at runtime: enrollment adds an `options.provenance` block to an existing
call. No predicate, no branch, no rejection path. At build time the census
ratchet now requires this point to stay declared, which is the intent.

## 2. Under-block — what does this still miss?

- **Recorded, not graded**, and declared as such. Grading an extraction needs a
  downstream fact — was the proposed signal later affirmed, contradicted, or
  silently dropped? Those transitions exist in the intent store; joining them to
  a decision row is real plumbing. The census shows the posture rather than
  implying measurement that does not exist.
- **`budget:200`/day caps the archive**, not the counts — the decision_quality
  row is written for every settlement, and a truncation surfaces on the
  droppedByBudget counter.
- **The context is a fixed projection.** A field a future reader wants will not
  exist retroactively. Chosen minimum reconstructs decision shape; widening is
  additive but not backfillable.

## 3. Level-of-abstraction fit

The context is built inline at the callsite because that is the only place that
knows which inputs are untrusted (the turn, the rolling summary) versus derived.
Exporting that distinction so a downstream builder could guess is how a summary
ends up in a provenance store.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. Enrollment holds **no authority**: the settlement
seam consumes the block and records on its own path; it never reaches the model
and never alters the extraction.

**The safety property is the content-bearing contract**, enforced by test rather
than by care. This extractor's leak surface is unusually wide — it reads a raw
turn AND a rolling conversational summary, so a leak here republishes far more
than one message. The fixtures plant a fake API key and password in the message
and a fake token and file path in the summary; the tests assert none of the four
reach the serialized context. A hash-distinctness test prevents a constant or
empty hash from passing those tests while making the identity field useless.

The context is an **allowlist of derived values**, not a filtered copy, so a new
field on `ExtractorInput` cannot appear in a row by default.

## 5. Interactions

- **Degrade-safety** — the extractor's core guarantee is that it returns `[]`
  rather than breaking the conversation path it is attached to. Enrollment must
  not put a new throw in front of that; three tests cover provider-throws,
  provider-missing, and the degrade callback still firing with the right reason.
- **`/metrics/features`** — `attribution.component` preserved (explicitly
  tested; losing it would silently drop this component from the cost surface).
- **The census ratchet** — the pending baseline shrinks by exactly one line, the
  direction it may move. The typed-registration check independently verifies the
  source imports `DP_TOPIC_INTENT_EXTRACT` rather than restating the string.

## 6. External surfaces

- No route, config key, flag, env var, CLI, message, or notification.
- `GET /decision-quality` shows one more `wired`, one fewer `pending`. Shapes
  unchanged. No user-visible behaviour.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified.** The census is a shipped source constant, byte-identical on every
install, so every machine enrolls the same point with the same valve and content
class. The rows inherit the meter's existing posture; no new state surface, no
notice, no generated URL.

## 8. Rollback cost

Revert. The census entry returns to `pending:` (restoring the baseline line), the
provenance block disappears, previously-recorded rows remain inertly.

## Second-pass review

**Not required** by the Phase-5 trigger list — no block/allow decision, no
session lifecycle, no gate. The component it observes is unchanged.

Self-review, the thing I went looking for: **is the summary genuinely excluded,
or only the message?** It would be easy to guard the obvious field and miss the
larger one. The fixture plants distinct secrets in BOTH, and the assertions name
both — because "we tested the leak path" is worth nothing if it tested the
smaller of two.

Tests: 11 new; 42 green across the affected suites.
