# External review pass 16 — reviewer's verbatim final answer

**ARCHIVED LATE — the SEVENTH lapse, and the first where the verdict was absent while its repairs were
already in the tree.** Review pass 17 found it: fifteen verdicts on disk, no pass 16, and `git log
--all --diff-filter=A` showed no pass-16 blob anywhere in history. So every claim the repair commit made
about pass 16 — "load-bearing 3", "the first pass to answer YES", "eight of nine injected attacks
refused" — was unauditable at the moment I made it. That is the defect this directory was created to
prevent, recurring in the commit immediately after the one that restored the convention for pass 15.

Pass 16 is the first pass in the series to answer *"is magnitude genuinely declining?"* with **yes**.
Run against the frozen tree at `d5c9b5dd2`. Exploration logs are NOT kept; only the final answer block.

---

```text
FINDINGS

1. SEVERITY: major — Repair (a) made leg (4) reachable without the bound leg (4) exists to impose: a never-swept gap dated 9999-12-31 passes forever, and the guard's own diagnostic claims that is exactly what it prevents. `canonicalFutureDate` applies no time policy, so `gap.countdown` now accepts any round-tripping date up to the DATE_RE ceiling. Clean A/B on identical input: at the PARENT, rc=1 — "its countdown is 9999-12-31, not a YYYY-MM-DD date. An unvalidated countdown lets `never` sit green forever (review pass 3, finding 6)." At HEAD, rc=0 — `clean — 8 gap(s), 7 swept …, 1 unswept (dated)`. 2999-01-01 behaves identically. There is no ceiling anywhere: the only hit for horizon/9999/MAX_ is the message text nine lines above the changed line, which names "a far-future countdown beside an honest-looking absence" as an attack found by independent injection. The everSweptGapIds arm still refuses the re-unsweep case, so exposure is bounded to a NEWLY recorded failure-shape — precisely the record the propagation loop exists to force into a sweep. The commit says "Proven both ways: a future-dated unswept gap is accepted and reported; an expired one still fails." Both reproduce. The third — a date that can never expire — was not tested and is the one the same file already had on record.

2. SEVERITY: major — Repair (c) announced the withdrawal of ~8% and left the claim standing 14 lines later in the same article, which re-falsifies the universal the withdrawal was written to save. Line 170: "No derived percentage of THIS measurement is published as a current claim" and "The ~8% claim is withdrawn as a current reading." Line 184, untouched by the frozen commit: "The honest reading remains that this article was ~8% enforced while reporting far better." "Remains" is present tense, and line 170 itself certifies that ~8% belongs to this measurement. Percent-token census of the article, parent vs HEAD: 14 → 18 tokens, ~8% 2 → 3, 92% 0 → 1 (new). The repair that withdrew the figure INCREASED its publication count from 2 to 3. `git show` confirms the registry diff is exactly one line — line 184 was never grepped. Fifth consecutive pass to turn on a replacement sentence, by the cause the replacement sentence itself names twice.

3. SEVERITY: major — pass15-verdict.md is absent. Sixth archive lapse, committed inside the repair for the fifth. Fourteen files, pass1–pass14. The branch's own convention is "archive the pass-N verdict, alone and before any repair". The frozen commit performs the pass-15 repairs AND files pass-14, without filing pass-15. Consequence: everything the frozen commit asserts about pass 15 is an unverifiable paraphrase — verbatim the defect pass 5 created this directory to prevent.

4. SEVERITY: minor — A fresh count-about-itself error, introduced by the frozen commit into two artifacts: "the second of eight records" where there are seven. Live counts: gaps.length === 7, floor.knownGapIds.length === 7. The likely source is the probe's own `8 gap(s)` line carried into prose. This lands in the family whose dedicated guard was committed as "a count about itself must be true", and lint-registry-self-counts cannot reach it.

5. SEVERITY: minor — Repair (b) replaced a false machine-readable claim with a different false one, in a field that is mechanically inert for this record. The guard's arm is `if (evaded.standard && !evadedResolves && evaded.hadNoFingerprint !== true)`. "Iterative Audit to Convergence" DOES resolve, so the flag is never consulted — all four states pass identically. The guard defines the field as meaning the named standard "carries no enforcement fingerprint"; the record's own adjacent note concedes the opposite. It also leaves a latent trap: if that article ever loses its fingerprint, this record passes on a flag set for an unrelated reason.

6. SEVERITY: minor — Repair (f) commits an instrument that COPIES the guard's rules while the constitution says the figures come from rules IMPORTED verbatim, and the constitution still does not cite the instrument. The copies are byte-identical today and the cited line numbers are correct — but the same commit refuses the identical shortcut elsewhere ("splitting one definition into two policies rather than copying the parsing"). Two opposite rulings on duplication in one commit. Second half: `git grep measure-orphan-referents -- docs/` returns nothing.

7. SEVERITY: nit — The guard header says "the ordinals are dropped rather than restated" in the sentence that restates two ordinals. I re-derived all four numbers: 46 total steps, 45 node steps, ordinals 35 and 43. The numbers are correct and reproducible; the defect is only that the sentence describes an edit it did not make, in a file whose subject is that failure.

8. SEVERITY: nit — Carried, unchanged: the branch's only branch-caused test failure is still red (the deliberate areaAudit assertion). Deliberate and operator-ruled; recorded because the Zero-Failure Standard is labelled NON-NEGOTIABLE and this is structurally unclosable while review continues.

Critical: none.

REGRESSION-CHECK

(a) canonicalDate split — NEW DEFECT (finding 1). The split itself is well made: roundTripsAsDate is the single shared definition, neither wrapper re-implements parsing, and the other callers are unweakened. The diagnosis was correct and I confirmed it. Both advertised directions reproduce. The third direction is the defect.

(b) GAP-skip-announced-and-habituated — CLEAN on the flip, NEW DEFECT on the withdrawal (finding 5). I produced the pass line myself rather than accepting it. The flip is defensible. One caveat: the `unswept (dated)` clause has never actually printed in a real run, so the "habituation" the shape is defined by is absent. The why is honest about this, so I grade it a weaker match, not a false one.

(c) ~8% withdrawal — NEW DEFECT (finding 2).

(d) "36 of 45" — CLEAN on substance, NIT on self-description.

(e) pass14-verdict archived late with lateness in the header — CLEAN, and the header is candid. Superseded by finding 3.

(f) measure-orphan-referents.mjs — PARTIAL, NEW DEFECT (finding 6). It reproduces the published table exactly, which I ran rather than assumed: 201 / 49 / 25 / 15. All seven values reproduce. The allowlist rationale is accurate.

Pass 9 → pass 15 repairs, re-tested by execution — all still hold. Full 46-step lint chain: green.

MECHANISM-CHECK

(a) PARTIAL — unreachability closed and proven; the arm it opened is unbounded. One-line fix available.
(b) PARTIAL — the verdict flip is CLOSED and reproducible; the evaded withdrawal is OPEN.
(c) OPEN. (d) CLOSED on the load-bearing order claim. (e) CLOSED for pass 14; broken again for pass 16.
(f) PARTIAL — reproduces all seven counts exactly, the strongest single result in this pass.

MY-ACCOUNT-CHECK

Re-derived: every load-bearing/raw-major series for passes 1–14 against the archived verdicts; the seven-record gap population; the 46/45/35/43 chain ordinals; the orphan table; the percent census; the archive file list; the if: always() count; baseline absence from origin/main; all guard behaviours.

One discrepancy: finding 4. I also initially suspected the author's load-bearing series understated the archived major counts — that suspicion was WRONG, and I record it because the prompt asked: the series is each reviewer's own number from its own TRAJECTORY block, and the author transcribed it faithfully. My initial grep over-counted by matching SEVERITY: major inside REGRESSION-CHECK prose.

MAGNITUDE-METRIC

Load-bearing enforcement integrity. Unchanged from passes 5–15. One clarification this pass forces: a repair that makes a previously-unreachable arm reachable WITHOUT the bound its contract promises counts as load-bearing, because the arm now certifies "visibly unswept and dated" while the dating carries none of the forcing property the word implies. Under it, this pass is 3.

TRAJECTORY

Load-bearing, passes 1→16: 4 → 4 → 5 → 4 → 4 → 4 → 4 → 4 → 3 → 5 → 5 → 5 → 5 → 6 → 5 → 3.
Raw major, passes 1→16: 5 → 7 → 6 → 4 → 4 → 4 → 5 → 5 → 5 → 6 → 6 → 6 → 6 → 6 → ? → 3.

Yes, magnitude is declining — and I want to be precise about how much that is worth. 6 → 5 → 3 is two consecutive drops to the series' lowest reading, and the composition improved on the axis that matters most: I attacked nine mechanism arms and eight refused correctly, the full 46-step lint chain is green, and every published number I re-derived reproduced exactly. Pass 14 could not say that; pass 13 could not say that. The single mechanism defect is narrow, one-line-fixable, and confined to the arm the repair was about.

Against that: the series has rebounded from 3 once already (pass 9 → 10 went 3 → 5), so one reading at 3 is inside historical noise; and the generator is unbroken at 10 of 10 — every one of my six findings lives inside a pass-15 repair or its commit.

CONVERGENCE

Not met. The criterion has two limbs and the branch satisfies one.

Magnitude declining — yes, defensibly, for the first time in this series.

Remainder converted to expiry-dated named work — no. Findings 1 and 2 are fresh, undated, and neither is tracked. Finding 1 is the disqualifying one, and not because of its size: it is a REGRESSION. The identical input that the parent commit refused, the frozen tip accepts and prints clean over. A branch whose latest commit re-opens a precondition its own guard file records as a previously-injected attack cannot be closed on a trend argument — the trend is the reason to expect the NEXT pass to be small, not a reason to stop looking. And finding 3 removes the ability to audit the trend at all for the pass that produced this commit.

The honest summary: this is the first pass where I can say the machinery is substantially right and the residue is bookkeeping. It is also the tenth consecutive pass where the previous repair generated the next findings, and the first in four where one of them is a live behavioural regression rather than a stale sentence.

COHERENCE

No — narrowly, and less badly than before. The repository's account of its MECHANISMS is now largely accurate: every count I re-derived was right, every order claim verified, eight of nine attacks refused as documented, and the disclaimers are unusually honest. Its account of ITSELF still diverges in six places: line 170 vs line 184 on ~8%; the universal falsified in its own article; the ordinals sentence; "second of eight records"; "imported verbatim" vs a copying instrument; and the failure message claiming its validation stops a countdown sitting green forever while 9999-12-31 does exactly that.

VERDICT

reject. The window's machinery is in better condition than at any prior pass — the lint chain is green, eight of nine injected attacks were refused exactly as documented, and all eleven published figures I re-derived independently reproduced to the digit, which is the first time this series can say that. But the frozen commit re-opens a concrete hole its own guard file records as a previously-injected attack: a never-swept enforcement gap dated 9999-12-31 is refused at the parent and prints clean at HEAD, so leg (4)'s countdown is now a label rather than a deadline, and the repair was certified "proven both ways" on two of the three directions that matter. Alongside it, the repair that withdrew ~8% left the claim standing fourteen lines later and raised its publication count from two to three; and pass15-verdict.md — the sole auditable source for everything this commit says it is fixing — is missing from the archive for the sixth time, in the commit that files the fifth. Fix the countdown horizon, delete the surviving ~8% sentence, and file pass 15; on this trajectory the next pass has a real chance of being the one, and I would not want it closed on the strength of a commit that made a guard weaker than the commit before it.
```
