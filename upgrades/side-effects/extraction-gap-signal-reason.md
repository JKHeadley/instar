# Side-Effects Review — ExtractionGapSignal reason + span (spec §2.1 conformance)

**Version / slug:** `extraction-gap-signal-reason`
**Date:** `2026-07-27`
**Author:** `echo`
**Second-pass reviewer:** `required — sentinel/observability surface (see Phase 5 section)`

## Summary of the change

`docs/specs/claim-verification-sentinel.md` §2.1 specifies that the deterministic
protected-predicate lane emits `ExtractionGapSignal {minimumCriticality, reason, span}` when a
protected cue "has no overlapping endorsed claim, has only quoted/hedged/non-endorsed overlap, or
the envelope is invalid." That signal was never built: `git grep ExtractionGapSignal` returned zero
hits across `src/` and `tests/`. The shipped `protectedCueGaps()` returned a deduped list of bare
cue-family names, so all three spec-distinguished causes rendered as the same string.

This change implements the signal. `extractionGapSignals()` (in `src/monitoring/ClaimObservation.ts`)
scans every candidate span for every cue family and returns one signal per gapped span carrying the
reason, the byte span, and the §2.5 criticality floor. `protectedCueGaps()` is retained, now derived
from those signals, so existing counters and the `gapKinds` audit field are unchanged.
`CompletionClaimVerifier.observe()` writes the new `gapSignals` array alongside `gapKinds`, and
`ClaimObservationRecorder.recordEvent()` gains a strictly-clamped, per-family-capped allowlist
branch for it, stamping `schemaVersion: 2`.

`gapKinds` keeps its shape and its consumers, but its *values* are monotone-increasing — see §5.

Files touched: `src/monitoring/ClaimObservation.ts`, `src/monitoring/CompletionClaimVerifier.ts`,
`tests/unit/extraction-gap-signal.test.ts` (new).

**Why now:** the missing `reason` is the measurement blocker that held EVO-005 across eleven review
cycles. 89.1% of gap events (295/331 in the live audit) are the `completion` family, and with only a
family name recorded there is no way to tell a real extractor miss from the extractor being charged
for a span it correctly marked hedged or quoted. Demonstrated concretely: under the old algorithm a
hedged overlap and a true no-overlap both emit exactly `["completion"]`.

## Decision-point inventory

- `protectedCueGaps` / `extractionGapSignals` (`src/monitoring/ClaimObservation.ts`) — **modify** —
  deterministic cue detector. Produces observations only. Holds no blocking authority before or
  after this change.
- `CompletionClaimVerifier.observe` audit emission — **modify** — adds a field to an existing
  dark, dry-run audit row. No change to any return value that a caller branches on.
- `ClaimObservationRecorder.recordEvent` allowlist — **modify** — adds one clamped structural field.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The signal never gates a message. The
feature is dark (`dryRun: true` in production today) and §2.1 states the shadow signal "never
creates a factual claim or verdict." `observe()`'s return contract is untouched.

The nearest analogue to an over-block is over-*counting*: the fixed scan now books gaps the old
first-match-then-break loop skipped, so gap counts rise. That is the correct count per §2.1 ("every
protected-cue span"), but see §5 for the baseline discontinuity it creates.

## 2. Under-block

**No block/allow surface — under-block not applicable.**

What the change still does *not* measure, stated plainly:

- **Cue over-breadth is untouched.** The `completion` regex fires on the noun "fix" (983 occurrences
  in the local message corpus, the single dominant token) and on instar's own term of art "ships
  dark", which means deliberately DISABLED — the opposite of a completion claim. Those produce
  `no-overlapping-claim` signals indistinguishable from genuine extractor misses. Separating them
  requires recording the matched cue token, which is **out of scope here and deliberately so**: §2.6
  fixes a closed audit field list and forbids raw claim text and plain content hashes, so a cue-token
  field is a spec change needing its own convergence and approval.
  <!-- tracked: ACT-1433 -->
- `reason` therefore quantifies the endorsement-filter share of the gap rate exactly, and leaves the
  cue-over-breadth share unresolved. It narrows the ambiguity; it does not eliminate it.
- The `injection` family is assigned a `high` floor rather than its own tier. §2.1 names only
  approval/capacity/completion/credential for `high` and consequential-action premises for
  `irreversible-precondition`; injection markers are conservatively floored at `high` because
  uncertainty rounds up per §2.3.
- **Per-family truncation.** A single turn emitting more than 8 gapped spans in one family keeps the
  first 8 of that family and sets `gapSignalsTruncated: true`. Within-family reason shares are
  therefore biased toward earlier spans on those (rare) rows. The truncation is recorded, so such
  rows can be excluded from a reason-share computation rather than silently skewing it.

## 3. Level-of-abstraction fit

Correct layer. The detector already lives in `ClaimObservation.ts` and already computed the overlap
relation this change reports — the information was being discarded one line after being derived, not
gathered somewhere new. No higher layer could reconstruct it, because only this function sees both
the cue span and the claim's endorsed/quoted/hedged flags at the same time.

This feeds the existing audit lane rather than creating a parallel one, per §2.6's "one bounded
origin-local append/read/rotation path."

## 4. Signal vs authority compliance

**Compliant.** Reference: `docs/signal-vs-authority.md`.

This is a detector producing a strictly richer structured signal. It gains no blocking power, adds
no new code path that can refuse or alter a message, and does not become an input to any authority
in this change. Per §2.1 the gap signal "is the coarse non-LLM recall floor: a high-criticality
observation, not a normalized factual claim, and therefore cannot support/refute."

The `minimumCriticality` field is worth calling out specifically: it is a *label carried on an
observation*, not a threshold anything acts on. Nothing in this change reads it back.

## 5. Interactions

- **`gapKinds` shape preserved; values monotone-increasing.** `protectedCueGaps()` keeps returning
  deduped family names and still populates `gapKinds`. But old ⊆ new strictly: the old loop pushed a
  family iff the *first* pattern-matching candidate was uncovered, the new one iff *any* is, so
  `gapKinds` can gain a family and can never lose one. The existing `toContain('capacity')` assertion
  is safe and all 11 pre-existing tests pass unmodified — but "unchanged" would be wrong, and callers
  comparing counts across the boundary must not treat the two as the same measurement.
- **`coverageIncompleteTurns` shifts too.** `CompletionClaimVerifier` bumps it on `gaps.length > 0`,
  and `gaps` can now be non-empty on turns where it previously was not. That counter moves in the
  same direction and for the same reason, and is not a regression.
- **Baseline discontinuity — the real interaction risk.** Anyone comparing gap rates across this
  deploy sees a step change that is a measurement fix, not an extractor regression. **Split on
  `schemaVersion`**: pre-change rows are `1`, post-change rows are `2`. Key-absence was the first
  proposed marker and is wrong — it only works via a coupling (the verifier happens to write the row
  only when signals exist), and `recordEvent` will legitimately write a `gapSignals`-free row, which
  a dedicated test asserts. The version stamp is the durable marker.
- **`schemaVersion` is per-row-TYPE, not per-file.** `recordEvent` rows are now `2`, while
  `record()` and `recordAuthoritativeOutcome` keep writing `1` into the same
  `claim-observation-audit-v2.jsonl`. Splitting gap rows on `schemaVersion >= 2` is correct because
  gap rows are event rows; an analyst splitting the *whole file* will find claim-observation rows
  stay `1` forever, which is expected and not a bug.
- **Truncation cannot silently bias the sample.** The per-family cap replaced a flat head-slice that
  would have dropped whole trailing families. Because emission is family-outer, that slice kept only
  `capacity` on a busy message and discarded `completion` (the family the statistic is about) and
  `injection` (the adversarial family) entirely — reproduced at 72 signals → 1 surviving family
  before the fix, and covered by a regression test now.
- **No double-fire.** The audit row is emitted once per turn under the existing `gaps.length > 0`
  guard, which is unchanged.
- **Shared metric untouched.** `this.bump('protectedCueGaps')` still iterates deduped kinds, so the
  `/metrics/features` magnitude is not redefined by the richer signal list.

## 6. External surfaces

No route, no schema served to another agent, no user-visible surface. The audit file is local and
already exists. `/completion-claim/stats` is unaffected — its integration test passes unmodified.

Privacy: the new field carries a cue-family name, a reason enum, a criticality enum, and two integer
byte offsets. No message text.

**On whether byte offsets sit inside the §2.6 boundary — the honest argument.** An earlier draft of
this artifact claimed the offsets are "the same class already carried by
`sourceStartByte`/`sourceEndByte` throughout §2.6." That is false and has been removed: in §2.6 those
offsets appear only as HMAC inputs to `claimId`, never as a persisted plaintext field, so this is the
first plaintext persistence of that value. The real basis is threefold:

1. The §2.6 closed field list is already pervasively exceeded by shipped code — `recordEvent` today
   writes `ts, evaluated, flagged, event, verdict, actionKind, hadToolCalls, reason, gapKinds`, none
   of which are in the list, and `record()` persists `actualLatencyMs`, a plaintext un-bucketed
   numeric of exactly the class at issue. `gapSignals` introduces no *new* class of deviation.
2. The forbidden categories are enumerated — raw text, paths, URLs, identities, secrets, credentials,
   commands/results, free-form rationale, plain content hashes. A byte offset is none of them.
3. The §2.6 re-identification concern is about *joining* shape/model/timing/pseudonym. These
   `protected-cue-unextracted` rows carry no join key at all — no `messagePseudonym`,
   `topicPseudonym`, or `claimId` — so the offsets are not joinable to a message or topic.

Residual disclosure is real and worth naming: an offset pair is a coarse sentence-length/position
fingerprint in mode-0600 local operational data. It sits strictly below the existing
`actualLatencyMs` bar. If a reviewer disagrees that (1) is acceptable, the correct response is a
spec-level cleanup of the closed list, not a carve-out for this field.

Clamping: `recordEvent` clamps every field, drops unknown keys, and caps per family — covered by a
test asserting a planted `secretField` never reaches disk. **This guarantee is conditional on
`opts.recorder` being set.** `CompletionClaimVerifier.appendAudit` has a fallback path that writes
the raw row to `logs/completion-claim-audit.jsonl` with no clamping. That is pre-existing (`gapKinds`
has identical exposure) and carries no live risk here because `gapSignals` is internally produced,
never caller-supplied — but the guarantee is not unconditional and should not be stated as such.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and strictly more so than the pooled-rows posture would require.

`gapSignals` never enters the pool projection at all: `readPoolAggregates`/`readPoolPage` read the
corpus path, not the audit path, and the peer merge in `routes.ts` is an explicit field allowlist
(`day, claimShapeId, modelDoor, verifierVersion, count, verdicts`). So there is no pool-side surface
to leak — a reviewer should not go looking for one. (An earlier draft said the field "inherits the
pooled untrusted-display posture," which invited exactly that wasted search.)

The consequence for measurement: a gap-reason figure is per-machine and cannot be assembled across
the pool through any existing read. No user-facing notice, no durable state that strands on topic
transfer, no generated URL.

## 8. Rollback cost

**Low.** The change is additive and observation-only. Reverting the commit restores the prior
function body; no migration, no agent state repair, no data cleanup. Existing audit rows remain
readable either way because `gapSignals` is an optional key that consumers must already tolerate the
absence of (every historical row lacks it). No release is gated on it and nothing reads the field
back yet.

---

## Phase 5 — second-pass review

Required: the change touches a sentinel/observability surface in the claim-verification family.

**Reviewer verdict: "Concern raised" — one blocking finding, since resolved; several should-fixes,
all folded into the sections above.**

**Blocking (fixed).** The persisted `gapSignals` array used a flat `.slice(0, 24)`. Because
`extractionGapSignals` emits family-outer, that silently dropped whole trailing families —
reproduced on a 24-candidate message at 72 signals where only `capacity` survived and `completion`
and `state` were discarded entirely. The bias ran precisely against the change's purpose: the
motivating figure is that ~89% of gaps are the `completion` family, and `completion` was the first
thing dropped. Resolved with a per-family cap of 8 plus a `gapSignalsTruncated` marker, and a
regression test. **This is the finding that justifies the phase** — the change would otherwise have
shipped a measurement instrument biased in the one direction guaranteed to make it useless, and the
bias would not have shown up in any of the tests written before the review.

**Should-fixes, all applied:** the §2.6 span justification was factually wrong and has been rewritten
with the real argument (§6); `gapKinds` was described as "unchanged" when it is monotone-increasing
(§5, summary); the `coverageIncompleteTurns` shift was unlisted (§5); `schemaVersion` was not bumped
and the proposed key-absence split marker rested on a coupling (§5, now `schemaVersion: 2`); the
multi-machine section overstated exposure (§7); the clamping guarantee is conditional on
`opts.recorder` (§6); and two `§2.5` citations were actually `§2.3` (fixed in both the artifact and
the code comment).

**Second round — reviewer verdict: "Concur."** The blocking finding was independently re-verified
against the staged code (72 signals produced → 24 persisted as 8/8/8 across all three families,
`gapSignalsTruncated: true`, `schemaVersion: 2`). The reviewer agreed with capping per-family at 8
rather than raising to 144, on the grounds that the statistic is a per-family reason *share*, so
preserving the family distribution is the property that matters, and that the residual within-family
position bias is *recoverable* because truncated rows are marked and can be excluded.

**One new finding, introduced by the blocking fix, since resolved.** Replacing the flat
`.slice(0, 24)` removed the *unconditional* array bound: the per-family cap alone bounds the array
at 8 × distinct kinds, and `kind` is caller-supplied. Probed at 5,000 invented kinds → 5,000
persisted objects in a ~559KB row, with `gapSignalsTruncated` correctly false because nothing was
dropped per family. Not reachable from the in-tree producer (6 families, ≤48 objects), but
`recordEvent` is deliberately an untrusted-input boundary and `appendBounded` rotates-then-writes
instead of rejecting an oversized row, so an unbounded row would cost audit *history*. Resolved with
an unconditional `.slice(0, 48)` that also sets the truncation marker, plus a hostile-input test.

**Reviewer answers to the two questions posed:**
- **(a) Span inside the privacy boundary:** yes, but not for the reason originally given. Basis
  rewritten in §6.
- **(b) Raising counts mid-soak:** correct; do not flag-preserve the old behavior. The old scan is a
  recall bug, not a baseline — §2.7 sets deterministic protected-gap recall at 1.0 on closed cue
  fixtures, which the broken scan structurally cannot meet. Preserving it would keep accumulating a
  measurement known to be false in a known direction. Old ⊆ new is provable, so the discontinuity is
  monotone and interpretable.

**Open question the review surfaced, not resolved here:** whether the §2.7 readiness clock (≥1,000
admitted messages / 200 settled T0 claims over 14 days) restarts for gap-rate metrics, given that
this changes the definition of the measured quantity mid-window. It plausibly should. That is a
judgment about the soak's validity, not about this code, and belongs to whoever reads the re-soak.
<!-- tracked: ACT-1433 -->

**Confirmed clean by the reviewer:** no blocking authority (nothing reads `gapSignals` or
`minimumCriticality` back — the sole consumer maps to `kind` and discards the rest);
level-of-abstraction fit; rollback cost; no double-fire; and the §2 cue-over-breadth disclosure.
