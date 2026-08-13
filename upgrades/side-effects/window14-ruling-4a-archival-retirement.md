# Side-effects review — ruling 4a, archival retirement

**Change.** Two field headings — `Retired` and `Retirement held` — are added to the two closed
classification lists (`src/core/StandardsRegistryParser.ts` and its hand-kept mirror in
`scripts/standards-coverage.mjs`), both as **NARRATIVE**. The substance is in the constitution: 25
articles gain a retirement record, 1 has its provenance relabelled, and 3 gain a held-live record
with a dated owner.

**Tier declared: 1.** Same shape as the previous entry in this window — two enumerations gain two
entries so an existing scanner recognizes headings that now appear in the document it scans. No
decision logic, no new authority, no runtime branch. Authorisation for the constitution content is
the operator's ruling on the 4a escalation, recorded in the topic and in the application record.

## 1. Over-block

Nothing is rejected. Both lists are exclusion sets; adding an entry can only narrow what is scanned.

## 2. Under-block

The same two as before, unchanged: nothing checks that a heading's classification matches its
content, and the two lists are hand-kept mirrors. This change adds two entries to each. A third is
now worth naming: **nothing enforces that a `Retired` article stops being cited as binding.** The
record says the article no longer governs, and a reader or a reviewer must honour that. It is a
judgment-bound property, consistent with how this registry already treats obligations it cannot lint.

## 3. Level-of-abstraction fit

Right layer. The classification belongs at the parse, and the retirement status belongs in the
article rather than in a side file — a reader who arrives at the article learns immediately that it
no longer governs and which live article carries its obligations.

The alternative shape — deleting the article body, or the heading — was measured and rejected. It
would drop the article from the parser (87 → 62), move every area's enforcement ratio, break 5 of the
6 declared parent relations, and leave 29 citations from surviving articles pointing at nothing. The
operator's second condition forbids exactly that outcome.

## 4. Signal vs. authority compliance

Compliant, conservative direction. No blocking authority is added. `Retired` and `Retirement held`
are filed as NARRATIVE for the same reason as `Fails` and `Judgment-bound`: a status is not evidence
of a guard, and a retired article's record must never be scanned as an enforcement citation.

## 5. Interactions

- **The parentage lint is the positive control here.** It passes clean at 87 articles and 13
  relations, all resolving and bidirectional — which is only true because *The Body and the Mind* is
  HELD LIVE rather than retired. Five articles declare it as their parent; retiring it would have
  broken the build, and the ruling held it for exactly that reason.
- Measured after the change: **0** surviving articles declare a retired parent; **29** citations from
  surviving articles into retired ones, all resolving because the headings are preserved.
- `enforced-ratio` unchanged at 0.7356, `dangling` 0, `unrecognized-sections` 0, article count 87.

## 6. External surfaces

None. No route, message, config or runtime behaviour. The constitution text is visible to any agent
that reads it, which is the intent.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, trivially: both files are repository source and replicate by being merged
and released. No runtime state, no per-machine record, no generated URL, no notice.

## 8. Rollback cost

Near zero and no migration. Reverting the two list entries restores prior behaviour; the ratchet
would then report the new headings as unrecognized and fail loudly rather than silently. Reverting
the constitution text alone leaves the list entries inert.

## Conclusion

No issue identified that blocks the change. Three are recorded rather than fixed: the list
duplication, the absence of a check that a classification matches its content, and — new here — that
nothing mechanically prevents a retired article from being cited as binding.
