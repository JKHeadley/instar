# External review pass 15 — reviewer's verbatim final answer

**ARCHIVED LATE — the SIXTH lapse, and it happened inside the commit that filed the fifth.** Review pass
16 found this file absent: fourteen verdicts on disk, no pass 15. The commit that repaired pass 15's
findings also filed `pass14-verdict.md`, wrote a header calling the previous lapse *"the worst, because
pass 14's headline was reported to the operator in my own words with no auditable source behind it"* — and
did not file its own. So everything that commit asserted about pass 15 was, for a day, exactly the defect
its own header condemned. Pass 5 created this directory for this reason: *"five external verdicts, all
reported to the operator in my own words, none of them on disk."*

Run against the frozen tree at `7a717f5d1`. Exploration logs are NOT kept; only the final answer block.

---

```text
FINDINGS

1. SEVERITY: major — The branch is red on 12 tests across 6 files; the repository's account, written in the pass-14 repair, states it is red on one. `npx vitest run` → Test Files 6 failed | 3045 passed, Tests 12 failed | 47817 passed, exit 1. The pass-14 repair commit and the comment it added both certify a single residual red: "So the branch is still red, honestly, on the audit-currency gate." The other eleven are: 5 × standards-registry-asset, 3 × standards-coverage-route, 1 × builtin-manifest, 2 × gemini E2E. I attributed each rather than asserting: `dist/data/standards-registry.md` hashes to a stale mid-branch build ~21 commits back, so the 8 asset/route failures are stale-dist; builtin-manifest.json is a gitignored generated artifact; the 2 gemini failures are GEMINI_API_KEY absent. But `npm test` is `vitest run` with no pretest and CI's unit job does not build either, so no reading makes this green. Pass 14's finding was that thirteen passes never ran the suite; the repair ran it, fixed the one assertion it was told about, and then re-certified the residual as a single deliberate red — the "fix the demonstrated instance, then certify the class" generator, applied to the very finding that exposed it.

2. SEVERITY: major — Repair (b) replaced a false universal with a narrower universal that is also false, falsified by the one figure the same sentence excuses. The new text: "No derived percentage of THIS measurement is published as a current claim … The surviving percentages are the SUPERSEDED historical values — 62%, 54%, 63% — and `~8%`, which is a different measurement entirely." `~8%` is not a different measurement. Its introducing commit reads: "Four measurements — 62%, 54%, 63%, now 92% — … the honest reading is that this article was ~8% enforced." 92% was the then-current orphan share; `~8%` is its complement — the same 217-marker population, expressed the other way round. It is published in the present tense and is now stale on its own terms. So a derived percentage of THIS measurement is published as a current claim, in the paragraph banning exactly that. This is the fourth, and the common factor holds.

3. SEVERITY: major — The new gap record claims to have evaded a fingerprint at a moment and on a surface that fingerprint does not declare, and the guard cannot see it. `GAP-skip-announced-and-habituated` sets `evaded.standard = "Iterative Audit to Convergence"`, `atMoment = "push-time"`, `hadNoFingerprint = false` — only the second record in seven to assert a real fingerprint was got past. That fingerprint declares `moments: commit-time, ci-time`. The specimen is `scripts/pre-push-smoke.mjs` at push-time — neither a declared moment nor a cited surface — and the record's own `how` concedes it "sits OUTSIDE the fingerprinted population." Worse, that fingerprint's Coverage argument already says "Running a single pass and never opening an audit record at all is NOT covered by anything." So nothing was evaded; the failure landed in a hole the fingerprint had already declared. `lint-enforcement-gap-records.mjs` validates that `evaded.standard` resolves but never compares `atMoment` against that fingerprint's declared moments — so this passes clean.

4. SEVERITY: major — The new gap record's only substantive UNMATCH verdict rests on a reason its own cited guard falsifies. Three of the four unmatched entries are `surfaces: NONE` articles, so *One Failure Teaches Every Guard* is the single evaluable unmatch. Its stated reason: the coverage-reducing conditions "FAIL the build rather than printing a note beside a pass." There is a fourth condition, explicitly legal under the guard's own leg (4): an unswept-but-dated gap. Proven by execution — I added one record with `sweep: null` and today's countdown: `clean — 8 gap(s), 7 swept against the live population of 6 fingerprinted standard(s), 1 unswept (dated)`. That is standing debt announced beside the word `clean` — bit-for-bit the criterion used to MATCH *Deferral = Deletion*.

5. SEVERITY: major — Leg (4) of the gap guard is unreachable, and its refusal message misstates why. Documented contract: "`sweep: null` is legal and honest, but it requires a countdown date and fails once expired." In code, an unswept gap needs `canonicalDate(gap.countdown)` — which returns false for anything beyond `Date.now() + 24h` — and then fails if `countdown < today`. The only satisfiable value is today. Proven: `countdown: "2026-09-07"` — the exact date every other countdown in this repository uses — is refused with `is UNSWEPT (sweep: null) and its countdown is "2026-09-07", not a YYYY-MM-DD date`. It is precisely a YYYY-MM-DD date; it is rejected for being in the future. A history-oriented validator was reused for a forward-looking field. Introduced at the pass-3 repair; eleven subsequent passes did not reach it.

6. SEVERITY: minor — Repair (f) published a new wrong self-count while correcting a wrong attribution. The header now says "position 36 of 45 in the lint chain". The chain has 46 `&&`-separated steps. Under all-steps: 36 and 44 — ordinals right, denominator wrong. Under node-steps-only (45): 35 and 43 — denominator right, ordinals wrong. "36 of 45" holds under neither.

7. SEVERITY: minor — The "surviving percentages" enumeration is incomplete. It names 62%, 54%, 63% and `~8%`. The article also carries 89% and 47%. Six distinct values survive; four are enumerated.

8. SEVERITY: minor — `pass14-verdict.md` is absent from the archive. The directory holds pass1–pass13 only. Archive completeness has been a finding in passes 6, 7 and 9; this is the fifth instance and the one that makes "load-bearing rose 5 → 6" unverifiable by any later reader.

9. SEVERITY: minor — `docs/specs/enforcement-fingerprint-measurement.md` §1 publishes a stale surface count under a reproducibility claim: "Build-time lint chain | 42", beneath "Counted from the tree, not asserted. Each number is reproducible." Live count: 45.

10. SEVERITY: minor — `tests/unit/standards-registry-asset.test.ts` self-heals only the ABSENT asset, never the STALE one — and then misattributes its own failure, asserting a packaging regression that has not occurred. An existence check where a freshness check was needed. Pre-existing on origin/main; this branch triggers it eight times.

11. SEVERITY: nit — "the honest range … is 15 to 25 of 201" does not name its reading. Both are the all-tokens reading; under the occurrence reading the corresponding range is 22 to 31.

12. SEVERITY: nit — the instrument behind the constitution's own table is not in the repository. The registry says "two independent replays" and the side-effects doc describes an extracting instrument; no such script is committed. (I reproduced all nine values independently, so the numbers are right; the evidence is not there.)

13. SEVERITY: nit — the dated notes in `standards-coverage-ratchet.test.ts` are out of chronological order.

Critical: none.

REGRESSION-CHECK

(a) ratchet snapshot 87→88 — NEW-DEFECT. The numbers are correct. The reasoning for the deliberate red does not hold: it is a false dilemma. The staleness is already enforced by `standards-coverage.mjs --check` which CI runs; asserting the OBSERVED value forges nothing, since the acceptance record is the audits JSON either way; and the cost is unpriced — this pass produced the evidence that eleven further failures rode in behind the normalized red.

(b) false universal deleted rather than re-scoped — NEW-DEFECT (findings 2 and 7).

(c) JSON-comment paragraph corrected — CLEAN. Verified three behavioural claims by probe; all hold.

(d) monotonicity claim retracted — CLEAN, and the strongest repair in the batch. I rebuilt the cited fixture and it orphans at the parent and resolves at HEAD. The "no measured change" half also holds: I compared orphan SETS, not counts — 201 vs 201, symmetric difference 0.

(e) both readings published — CLEAN. All nine table rows and both complements reproduce.

(f) header corrected — NEW-DEFECT (finding 6).

(g) new gap record + sweep — NEW-DEFECT (findings 3 and 4). Both matches are real, not padding — I ran the guards. The shape IS genuinely distinct from alive-but-inert: the two sweeps produce different match sets (0 vs 2) over the same population.

Pass-9 through pass-14 repairs: all hold.

MECHANISM-CHECK

(a) PARTIAL. (b) OPEN. (c) CLOSED. (d) CLOSED. (e) CLOSED. (f) PARTIAL. (g) PARTIAL.

MY-ACCOUNT-CHECK

Re-derived: the raw-major series, machine-counted where format permits — matches the author's published series at every measurable point. Carried: pass 1's count and the load-bearing series.

Discrepancies: (1) the pass-14 verdict is not on disk, so its headline is an unauditable paraphrase; (2) "the branch is still red on the audit-currency gate" is false — 12 tests in 6 files; (3) "the sweep guard concedes nothing on its pass path" is false by execution; (4) the side-effects narrative says "positions 36 and 44 of the chain", which is correct, while the same commit's code says "36 of 45" — the account is right and the artifact is wrong, the reverse of the usual direction, and worth crediting; (5) the self-correction that the area audits were mislabelled BLOCKED when they are UNDONE is sound and I checked it.

MAGNITUDE-METRIC

Load-bearing enforcement integrity. This pass: 5. Raw major: 5.

TRAJECTORY

Load-bearing, 1→15: 4 → 4 → 5 → 4 → 4 → 4 → 4 → 4 → 3 → 5 → 5 → 5 → 5 → 6 → 5.
Raw major, 1→15: 5 → 7 → 6 → 4 → 4 → 4 → 5 → 5 → 5 → 6 → 6 → 6 → 6 → ? → 5.

Not genuinely declining. Eleven consecutive passes in the band 3–6. Four of my five load-bearing findings are new inside the repairs made since pass 14 — the ninth consecutive pass at which the previous repair introduced a new load-bearing defect.

There is real, countable progress I will not flatten: three of seven repairs are fully CLOSED, one with the best evidence in the run (a set-identity check over the live corpus), and (e) is the first time the six-times-wrong number has survived an independent re-derivation intact. The generator has also narrowed — of my five, only two are mechanism; the other three are the account.

CONVERGENCE

No. Magnitude is not declining; the blocking condition is unmet for the ninth consecutive pass; and two hard gates remain shut — `standards-coverage --check` exits 1 and `vitest run` exits 1 against a NON-NEGOTIABLE Zero-Failure Standard. A change cannot converge on a state it cannot reach.

COHERENCE

No. Four concrete disagreements, each found by running the machinery: the branch is red on twelve not one; the constitution publishes `~8%` in the present tense while banning exactly that; the gap registry says the sweep guard prints no concession beside a pass, and it does; and a guard header publishes a chain position no counting convention reproduces.

VERDICT

reject. Three of the seven repairs since pass 14 are fully closed, one of them — the monotonicity retraction, verified by orphan-set identity rather than by count — is the best-evidenced repair of the entire run, and the six numbers in the corrected table survive independent re-derivation exactly. But the same batch introduced four new load-bearing defects, which makes this the ninth consecutive pass at which the previous pass's repair generated the next pass's findings. The sharpest instance is the one that matters most — pass 14's whole contribution was that nobody had run the test suite, and the repair fixed the single test it was handed and then certified the branch as red on one thing while eleven other tests were failing. Add a culminating gap record whose evasion claim its own cited fingerprint does not support and whose one substantive unmatch reason a two-minute probe refutes, a guard leg that is unreachable by construction with a diagnostic that misstates why, and two gates that both exit 1 so no green state exists to converge on — and the criterion is not met. A fifteenth honest reject.
```
