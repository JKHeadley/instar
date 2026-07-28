## What Changed

The claim-verification observer now records **why** a protected-cue span was booked as an extraction
gap, instead of only recording that one was. Per `docs/specs/claim-verification-sentinel.md` §2.1,
the deterministic protected-predicate lane is specified to emit
`ExtractionGapSignal {minimumCriticality, reason, span}`. That signal had never been built — the
shipped code returned a deduped list of bare cue-family names, so all three spec-distinguished causes
rendered as the same string.

Each gapped span now carries one of three reasons: `no-overlapping-claim` (the model extracted
nothing there), `unendorsed-overlap` (a claim *did* overlap, but only quoted/hedged/non-endorsed —
the extractor classified it correctly and was charged for a gap anyway), or `invalid-envelope`.

Two correctness fixes came with it:

- The cue scan stopped at the first matching candidate per family, so a later uncovered span was
  never examined. It now scans every span, as §2.1 requires. Gap counts rise as a result — this is
  a measurement fix, not an extractor regression.
- Audit rows written by this path are stamped `schemaVersion: 2`. **Gap rates must not be compared
  across that boundary**: version-1 rows undercount and carry no reason.

## What to Tell Your User

Nothing — there is no user-visible change, no new command, and no behavior difference in any
conversation. This is internal measurement plumbing for a feature that ships dark and runs in
dry-run: it observes and records, and holds no authority to block, delay, or alter any message.

If a user asks why it was worth doing: the observer had been running for days producing a number
nobody could interpret. About 89% of recorded gaps were the completion family, but with only a
family name stored there was no way to distinguish the observer genuinely missing a claim from the
observer being penalised for correctly marking something as hedged or quoted. The reason field
separates those two, which is what the accumulated data was missing.

## Summary of New Capabilities

None for users. Internally, the claim observer's gap events now carry a reason, a byte span, and a
criticality floor per gapped span instead of a bare family name, and the audit rows that record them
are capped per family with an explicit marker whenever trimming occurs, so a trimmed sample can
never be mistaken for a complete one.

## Evidence

- `tests/unit/extraction-gap-signal.test.ts` — 20 tests covering all three reasons, the no-gap case
  (endorsed overlap), the criticality floor per cue family, span correctness, the every-span fix,
  `gapKinds` back-compat, per-family truncation, and rejection of malformed caller payloads.
- Old-vs-new demonstrated directly: on `"The migration is done."` the previous algorithm emits
  `["completion"]` for a hedged overlap **and** for a true no-overlap — identical output, different
  cause. On `"The merge is done. The deploy is finished."` with the first sentence covered, it emits
  `[]` and misses the genuine gap.
- Per-family truncation bug caught in second-pass review and reproduced before fixing: 72 signals on
  a 24-candidate message, of which a flat head-slice kept only `capacity` and dropped `completion`
  and `state` entirely.
- 36/36 green (20 new, 11 pre-existing `claim-observation-v1` untouched, 5 integration
  `completion-claim-stats-route`).
- Side-effects review with second-pass: `upgrades/side-effects/extraction-gap-signal-reason.md`.
