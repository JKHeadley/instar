# External review pass 18 — reviewer's verbatim final answer

**Filed BEFORE the repairs this time**, which is the whole point. Review pass 19 found this file absent —
the ninth lapse and the **fourth consecutive** — and noted that each of the last four was filed only after
the next reviewer asked. Its prescription was explicit: *"archiving the verdict BEFORE the repair commit
rather than after the next reviewer asks."* Doing that here, in its own commit, ahead of anything else.

Pass 18 recorded load-bearing **2** — the series' lowest — and called itself *"the strongest pass of the
eighteen"*. Run against `bf5f375ba`. Exploration logs are NOT kept; only the final answer block.

---

```text
FINDINGS

1. SEVERITY: major — The horizon "sweep" was never performed. lint-enforcement-gap-records.mjs still carries its own second copy of the bound, and six statements assert otherwise. Repair (b)'s stated design is one exported definition consumed by both countdown guards. Only lint-documented-only-countdown.mjs imports COUNTDOWN_HORIZON_DAYS. lint-enforcement-gap-records.mjs:276 retains const HORIZON_DAYS = 180 and imports nothing from the shared module. The commit which added the export never touched that file.

Demonstrated two ways: setting the lib constant to 5 moved only the countdown guard (50 horizon failures) while the gap guard stayed at 180; and diverging the gap guard 180→200 left the branch fully green.

Six assertions are false as a result: baseline-history.mjs:114 ("ONE definition, both callers"), :103 (repair (c) itself: "Both callers now share the horizon defined below, so the division is real again"), :118 ("a bound duplicated into two guards is two things that can drift" — given as the reason for a placement that did not happen), lint-documented-only-countdown.mjs:126 ("the two guards cannot drift apart the way they just did"), the eli16 explainer, the side-effects log, plus the commit body.

This is the shape pass 17 named — fix the instance, skip the pattern — recurring inside the repair for it, and it makes repair (c) a falsified sentence replaced by a second falsified sentence about the same subject in the same commit. Note: pass 17's live hole is genuinely closed — both guards do enforce 180 today. What is defective is the duplication and the six claims that it is gone.

2. SEVERITY: major — The new suite cannot detect that drift, and two article-level arms are wholly uncovered. Both horizon tests assert /beyond the \d+-day horizon/, which matches any value, so no divergence is detectable. Separately, disabling the article-level horizon arm or the article-level expiry arm leaves 20/20 green — the test that appears to cover them rewrites every date, so the sub-obligation arm alone satisfies the assertion. Both arms are load-bearing and I confirmed by injection that they work — this is a coverage hole, not a live hole. Also uncovered: scripts/lib/baseline-history.mjs has zero tests despite being where repairs (b) and (c) landed.

3. SEVERITY: major — A pass-3 finding recorded as closed is still live, on the two reader-facing surfaces, one of which no pass has ever examined. lint-deferral-referent-resolves.mjs states of 178/110/62%: "Do not quote either." Two files quote it unqualified as their headline: the eli16 explainer and upgrades/next/deferral-tracking-verified-not-assumed.md — the release note that ships. The current figure is 201 of 217. The eli16 contains zero supersession markers. upgrades/next/ appears in no archived verdict across eighteen passes. The log's pass-3 repair row claims "all corrected or explicitly marked SUPERSEDED"; that is false.

4. SEVERITY: minor — A wrong count-about-itself, in the final commit. The side-effects log says the [SUPERSEDED — …] convention was "already used four times". It was used twice, both annotating one correction; the "four" counts two prose cells that merely describe a fix.

5. SEVERITY: minor — the side-effects log still records pass 1 as "six major findings". The archived verdict is 5 major + 1 minor. Passes 6 and 10 both corrected this; neither correction reached the log.

6. SEVERITY: minor — "Two of the eleven streak defects were arms I made unreachable" over-attributes one. pass15-verdict.md dates gap-guard leg (4) to the pass-3 repair and excludes it from the post-pass-14 new-defect set.

7. SEVERITY: minor — pass17-verdict.md has never existed in git history. Eighth archive lapse. Every pass-17 claim rests on author prose — the condition pass 5 created the archive to eliminate.

8. SEVERITY: nit — against this prompt. Claim (f) says pass16 was archived "before the repairs". False: that commit is a descendant of both repair commits. The repo is honest — the commit subject reads "with repairs already landed" and its body admits the inversion. Claim (b) ("imported by both") is likewise false, per finding 1.

Critical: empty.

REGRESSION-CHECK

(a) behavioural tests — CLEAN on the sabotage claim, NEW-DEFECT on coverage. I ran eight independent sabotages in an isolated copy: gap-horizon → 1 named test; countdown-horizon → 1; partition → 2; indented → 3; no-verdict → 1; sub-expiry → 1; dup-tracked-id → 1; gap-expiry → 1; comment-stripping → 3. Every one isolated exactly as claimed; restored gives 20/20. The suite is genuinely sabotage-proven. Coverage is finding 2.

(b) horizon sweep — NEW-DEFECT. Finding 1.

(c) "Same division" correction — NEW-DEFECT. The replacement sentence is false.

(d) "imported verbatim" — CLEAN. Both live assertions removed; remaining hits are archived reviewer text and an explicit withdrawal record. I also checked the header's byte-identical claim: the three copied lines are identical to the guard's.

(e) inline SUPERSEDED markers — CLEAN on the three markers and the ordinal; NEW-DEFECT on the self-count. Bracketed uses went 2→6; the file diff is +35/−3 (genuine in-place edits, unlike pass 17's +54/−0). Finding 4.

(f) archive — PARTIAL. Archived alone, but after both repairs.

Passes 9–17 repairs still hold. Verified by injection: shell/JSON/TS comment stripping all refuse; genuine referent resolves; indented headings 1–3 refuse and a fenced example does not; both duplicate-heading halves refuse; leg 4 accepts in-window and refuses expired and beyond-horizon; sweep-partition refuses. Untested-but-working arms confirmed live: article-level horizon, article-level expiry, gap freshness, duplicate gap id. Lint chain green; the single red unit assertion is exactly the declared known-open, and coverage figures 88/0.75 match the updated snapshot.

MECHANISM-CHECK

(a) PARTIAL — real, verified, sabotage-proven; blind to drift and to two article-level arms; the shared lib untested. (b) OPEN — the sweep did not happen. (c) OPEN — corrected to another falsehood. (d) CLOSED. (e) PARTIAL — corrections applied, self-count wrong. (f) PARTIAL — alone, but after.

MY-ACCOUNT-CHECK

I re-derived: pass-17 absence from git history; pass-1 severities (5 major + 1 minor vs "six major"); pass-16's trajectory line and its three convergence limbs; the SUPERSEDED counts at HEAD and parent; the archive ordering by ancestry. I carried, without re-deriving line by line, the per-pass totals for passes 2–15 and the streak-counter quotations.

Discrepancies: findings 5, 6, 7. Pass 16's own account (load-bearing 3, first YES, 6→5→3) is fully supported by the now-archived verdict — the author transcribed it faithfully, though it was unauditable when written. Pass 17's "six load-bearing" is unverifiable.

MAGNITUDE-METRIC

The series' own metric — load-bearing enforcement integrity — kept for comparability. I count 2: findings 1 and 2. Finding 3 is a falsely-closed documentation defect (serious, but not machinery); 4–8 are bookkeeping and process.

TRAJECTORY

4, 4, 5, 4, 4, 4, 4, 4, 3, 5, 5, 5, 5, 6, 5, 3, [6 — unverifiable], 2.

Magnitude is genuinely declining, and 2 is the series' lowest reading. But pass 16 already warned that the series rebounded from 3 once (9→10 went 3→5), and pass 17's spike to 6 — if real — is a second rebound, which weakens a two-point trend read. The composition also improved: this is the first pass where I could not find a single broken refusal arm. Every arm I probed fires correctly.

CONVERGENCE

Not met, on the half of the criterion that is not about counting.

Magnitude is declining, and I want to credit that plainly: the machinery is in the best condition of the series, the sabotage claim is true under adversarial test, and pass 17's live hole is closed. The criterion does not demand zero findings, closed known-opens, or freedom from nits, and I am not rejecting on any of those.

It fails on two grounds. First, the generator is unbroken: both load-bearing findings live inside the pass-17 repair, and finding 1 is the third consecutive appearance of one shape — fix the instance, skip the pattern — this time inside the commit whose entire subject is sweeping patterns, asserted six times over. Second, "the remainder converted to expiry-dated named work" is not satisfied: finding 3 is a pass-3 defect recorded as corrected while live on the release note and the explainer, and tracked nowhere. A finding falsely marked closed is worse than an open one, because nothing will resurface it.

COHERENCE

No. Three specific divergences: the repository says the horizon has one shared definition (six places) while carrying two; it says the 178/110/62% figure must not be quoted while quoting it as the headline of both reader-facing artifacts; and it says the pass-3 correction was completed while it was not. The engineering surfaces — guards, registry, gap records, self-counts — are coherent and correct. The divergence is concentrated in the narrative layer, which is precisely where this branch's own thesis says truth must be checkable.

VERDICT

reject. This is the strongest pass of the eighteen and I want that on the record: every refusal arm I probed works, the new behavioural suite survives adversarial sabotage exactly as claimed, and the mechanism pass 17 asked for was really built. But repair (b) claims a sweep it did not perform, repair (c) replaces one falsified sentence with another about the same subject in the same commit, and the new suite is structurally incapable of detecting the drift those repairs left behind — so the eleven-pass generator becomes twelve. Compounding it, a pass-3 finding sits recorded as closed while live on the release note that ships to users, on a surface no pass has ever reviewed. Magnitude is genuinely declining and the remaining defects are narrower than at any prior pass; what blocks acceptance is not their size but that they were again produced by the previous repair, and that one of them is a prior finding whose closure was asserted rather than made.
```
