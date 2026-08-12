# External review pass 28 — reviewer's verbatim final answer — **REJECT, load-bearing 6**

**Four of the six are mine, from the commit under review.** Pass 27 split 2 repair-induced / 5 pre-existing;
pass 28 splits **4 / 2** — and every one of the four is the same shape: *a sentence written about a repair
that is wider than the repair.* That shape has now produced findings in passes 26, 27 and 28 consecutively,
in three different repairs, by three different mechanisms — a regex that shifted, an annotation that does
not parse, and a count that was grepped instead of run.

Two things it establishes that are worth as much as the findings. **The coverage measurement reproduced
exactly** — 90 arms, 23 covered, every per-guard row matching, re-derived by the reviewer's own independent
count: *"the first time in this series that the branch can honestly say how much of its own guard surface
is tested."* And it corrected this prompt: the suite is **60** tests across three files, not the 57 my
commit body claimed and my prompt inherited.

Run against `c888b9497`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 28 — `echo/window10-deep-property-guards` @ `c888b9497`

## FINDINGS

**CRITICAL — class empty.**

**1. SEVERITY: major (load-bearing) — REPAIR-INDUCED claim over a PRE-EXISTING gap. There is a THIRD door. `POST /telegram/topics` takes an agent-supplied message body, validates only type and length, and hands it straight to `sendToTopic` — while three artifacts now assert "both".**

Proven by probe server, all three doors in one run: the reply route refused (400, 0 sends); post-update refused (400, 0 sends); **`POST /telegram/topics` with a lone zero-width space returned 201 `{"messageSent":true}` and called `sendToTopic` once.** It is 145 lines ABOVE the reply route the guard has sat on since pass 9, in the same file, with the same sink. Its outcome is strictly worse than the incident that motivated the guard: it **creates a new forum topic** and posts an invisible first message into it.

The claim is false in a SHIPPED artifact (`upgrades/` is in `package.json` `files`; `docs/` is not) — the engineering log, the explainer twice, and the commit body all say "both". This is the branch's named shape `GAP-fix-restates-the-claim` reproducing inside the repair for the previous instance of it: pass 27 falsified "at the point of sending"; the correction replaced one over-claim with a narrower over-claim, authored without enumerating the routes.

**2. SEVERITY: major (load-bearing) — REPAIR-INDUCED. The `[SUPERSEDED …]` annotation written to arm the claim arm is in a form the annotation parser cannot read, so the retired wording was never enrolled — and the guard reports clean over its re-introduction.**

Pass 27 diagnosed the arming step as willpower. The repair performed the willpower step and got the form wrong. The parser wants the mark then the quote IMMEDIATELY; the new annotation puts eleven words of prose between the em-dash and the quote.

Proven by injection, with the form as the control: as committed, `claimsDerived` is **4** and the retired wording re-added unannotated is **clean, not refused**; the same annotation rewritten into the house form gives **5** and the injection **refuses**. The conforming form is used correctly three times in the same file.

**3. SEVERITY: major (load-bearing) — REPAIR-INDUCED. The commit that lands a measurement about its own honesty states a test count no run produces — twice in committed artifacts, and a third, different one in the commit body.**

The production script and the shipped log both say "90 and 54"; the commit body says "57 tests". Re-derived: the behavioural file is **50**; all three window-11 files together are **60**. The behavioural file is byte-identical to the previous commit and **the commit touched no test file at all**. 54 is reproducible only as a grep artifact, not a run — the same class of defect the file exists to record, one field away from the number it exists to record it about.

**4. SEVERITY: major (load-bearing) — REPAIR-INDUCED. The new parser comment claims the authority writes retired triples "as a raw fraction" and that "the header uses both". Both halves are false, and a retirement written in the notation the authority actually adopted enrols nothing.**

The authority holds exactly two retired triples, both percent-form. Its "raw fraction" is the LIVE figure, written as two word-separated elements — because that header says the percentage is gone on purpose. That is the notation the next retirement will use, and the parser requires a three-element SLASH triple.

Proven by injection: a percent-free slash triple enrols (6 → 9) — the property the repair claims. **The authority's own raw-fraction form enrols nothing (6).** Pass 26 justified widening by citing exactly the "raw fraction" language; pass 27 corrected the mechanism and left the rationale intact. The gap the rationale names has never been closed — a differently-shaped gap was closed and labelled as it.

**5. SEVERITY: major (load-bearing) — PRE-EXISTING, not previously reported. The sub-obligation countdown arm is gated on a trigger PHRASE, so a countdown in an article that does not contain that phrase escapes expiry, horizon AND uniqueness. One such declaration is live in the constitution right now, and the clean line counts 47 where the document declares 48.**

The gate is the outer condition; every date check lives inside it. Well-formed declarations in the registry: **48**. Countdowns the guard collects: **47**. The missing one is in an article that never writes the literal trigger phrase.

Proven by injection, each with a control on a gated article: expired date → **clean, still prints "47 … all unexpired"** (control: refused); `9999-12-31`, **the pass-17 exploit** → **clean** (control: refused); duplicate tracked id, pass 11's finding → **clean**. **Three arms defeated by one gate** — the alive-but-inert shape, in the guard built to make a documented-only label expire.

**6. SEVERITY: major (load-bearing) — PRE-EXISTING. The fingerprint guard's first-match extractor does not merely hide a second declaration; it defeats the unknown-moment arm — the third instance of the founding shape, untouched by the commit titled "sweep the founding shape" and recorded nowhere.**

Proven with a positional control: a SECOND fingerprint declaration naming an unknown moment is **clean**; the identical declaration in the FIRST position is refused with the guard's own message about what an unvalidated moment costs. Two sibling guards now carry a comment saying the shape was found live in three guards and swept; the third carries nothing — no fix, no annotation, no dated owed entry, while the commit headline reads "THE FOUNDING SHAPE, SWEPT AT LAST."

**7. SEVERITY: major — NOT counted load-bearing. Pass 27's third named prescription was silently dropped, and the FIGURE arm's declared population contradicts its own stated criterion.**

Pass 27 closed by prescribing that the surface list be extended to the gap registry and `src/`. Both lists are **byte-identical** to the previous commit. Nothing implements it, argues against it, or dates it — while a DIFFERENT item got a full `## OWED` section with a date.

Independently: the arm justifies its population by a shipping criterion, and `package.json` `files` is the authority on shipping. It excludes `docs/` and includes `dist` — so **the watched explainer does not ship, and the unwatched constitution ships verbatim to every install** as the packaged asset. That is the exact surface on which pass 26 found a superseded figure republished as live fact.

**8. SEVERITY: major — NOT counted (over-refusal, not a missed refusal). The alternation's latent false-enrolment class is live and unrecorded.** A single slash-form date in the authority header takes `figuresDerived` 6 → 9 and produces **11 refusals** across both reader-facing surfaces, including against the explainer's own title.

**9–14. SEVERITY: minor.** The whole `Cc` category renders as nothing and is SENT (probed: bell, null, escape, next-line, and braille blank) — the module names three categories and Unicode's other non-printing one is omitted. The entire MEASURED section is committed **twice**, back to back, the copies differing in one sentence. Pass 27's findings 11, 12 and 13 are unrepaired and unrecorded. Two new refusal arms shipped with zero tests, and the refusal message string is now duplicated verbatim at both doors — in the file whose sibling module exists because a duplicated predicate drifted.

**NITS.** The account guard opens "Twenty external review passes" while its own ARM 3 prints 27. The explainer's test-case description matches no committed file. The coverage figure is grafted into increment 50's paragraph, and the OWED section is filed above the increment it postdates — the log has no increment-58 entry.

## REGRESSION-CHECK

**(a) Figure parser — PARTIAL.** All three claimed properties hold simultaneously, each proven by input with a control. What it newly over-matches: any slash-form date in the header → 11 false refusals. What it still under-matches: the authority's own adopted notation (finding 4).

**(b) Second door — PARTIAL (NEW-DEFECT on the sweep).** The post-update guard works, verified by execution. The sweep for a third path found one immediately (finding 1). **Deferring the chokepoint move is HONEST** — the reasoning is specific, the item is dated, and it is filed under `## OWED` rather than implied. The claim made alongside it is still broader than the code, in three places.

**(c) Founding-shape sweep — PARTIAL.** Both repaired arms verified by injection with positional controls, and both messages fire. The fingerprint site is **not** a defensible scoping: it defeats the unknown-moment arm under a control, and it is the one instance of the three with no repair, no annotation and no dated owed record — inside the commit that claims the sweep.

**(d) Landed measurement — CLEAN.** Re-ran the script in an isolated clone: `{"total":90,"covered":23,"ratio":0.2556}` and **every per-guard row matches the published table exactly**, including the 0/4. The denominator independently re-derived by my own count. No error outcomes, so it is not inflated by broken mutations. **This is the strongest artifact in the delta.**

**(e) Surviving clause — CLEAN on the text, NEW-DEFECT on the arming.** The false sentence is gone and the annotation is detailed and honest; it just does not arm the guard (finding 2). Sweeping the derived matchers across every tracked file outside the archive returns **0** unannotated survivors.

**(f) Gap-registry figure — CLEAN.** Corrected with a dated note. I walked EVERY JSON string value against the full forbidden population: 19 raw hits, all benign — digests, correction narration, and the pass-27 note explaining the figure. No other retired figure asserted as fact.

## FRESH-ATTACK-REPORT

**Enumerate the sinks, not the guard's call sites.** Pass 27 asked what else calls the sink and found one route. I inverted it: which HTTP routes accept a body field that REACHES Telegram? Seven, three taking a message body. Then one probe server, same payload, **all three in one run** — so the answer is a table rather than a claim. **New probe: enumerate the sink's callers as an HTTP surface and fire at every one in a single harness.**

**Count the population two ways and diff the counts.** For each guard I counted its subject with a raw regex over the document and compared with the number the guard prints. 48 declared, 47 collected. **One off by one is a whole excluded member** — and chasing it produced finding 5, an entire gate nobody had noticed, defeating three arms including the pass-17 exploit. **New probe: treat any discrepancy between a raw count and the guard's printed count as an unenumerated member.**

**Test the annotation convention, not the annotated text.** Everyone checked whether the false sentence was gone. I asked whether the annotation written to replace it PARSES — then proved causation by rewriting it into the house form and watching the population go 4 → 5 and the injection flip to refused. **New probe: when a repair arms a derived population by writing a record, re-derive the population and check the record is IN it.**

**Ask what notation the authority will actually use next.** The repair proves a percent-free slash triple enrols. The authority says the next retirement will be a raw fraction. Both forms that source would actually produce enrol nothing. **New probe: write the next entry in the format the SOURCE says it will use, not the format the parser was tuned for.**

**Resolve "reader-facing" against `package.json` `files`.** The surface list is justified by a shipping argument; the manifest is the authority on shipping. The watched explainer does not ship; the unwatched constitution does. **New probe: check a "reader-facing" declaration against the packaging manifest.**

**Re-run the landed measurement instead of reading it.** Ninety mutations, ~13 minutes, isolated clone. It reproduced to the digit. **That is worth as much as any finding here.**

**What answered correctly.** Both repaired first-match arms under positional controls. The post-update door. All six registry guards clean. Every registry figure re-derived and exact. The claim arm across the whole tracked tree: zero unannotated survivors. **The mechanism is sound and the measurement is now real; the defects are in the sentences written about them, and in one gate nobody had read.**

## MAGNITUDE-METRIC

**Load-bearing: 6.** Repair-induced: **4** (1, 2, 3, 4). Pre-existing: **2** (5, 6). Findings 7 and 8 deliberately not counted though both are major — 7 is a dropped prescription with no false assertion attached; 8 is an over-refusal, and the rule covers only a guard that cannot refuse what it claims to refuse.

## TRAJECTORY

`… 2 1 4 7` → **6**.

**The fresh-eyes question is still finding things, and the pre-existing population shows no sign of depletion — but the composition has flipped.** Pass 27 split 2/5; mine splits 4/2. That is not the pre-existing population running dry; it is getting HARDER — my two required counting a guard's subject two ways and applying a positional control to an arm nobody had classified as an extractor. Twenty-seven readings walked past both.

The repair-induced count DOUBLED, and every one of the four is a sentence about a repair that is wider than the repair.

One structural signal: the branch's founding shape is now confirmed in **four** places, not three. Two were repaired this commit; the third was left unrecorded; the fourth is the same defect wearing a different mechanism, and nobody had looked for it.

## CONVERGENCE

**NOT achieved.** Magnitude: 4 → 7 → 6 across the three readings that asked the fresh question — not a declining stream but a second population being enumerated for the third time. The cross-pass evidence now runs the other way: the accept at pass 25 was falsified on identical bytes, and the two readings since found 7 and 6. Remainder: four of six are live false statements in committed artifacts, two in a shipped package, and two of the three residues this commit chose not to fix are recorded nowhere. **The chokepoint move shows the branch knows how to do this correctly — a named OWED section, a reason, a date. Two items beside it got nothing.**

## COHERENCE

**The machinery is again better than its account of it — but the gap has moved from figures to enumerations.**

Every arm I fired with a real input fired correctly except the two that read a gated subset, and the coverage instrument reproduced to the digit — the first time in this series the branch can honestly say how much of its own guard surface is tested. That is genuine and hard-won and deserves to be said first.

The divergences: a shipped artifact says invisible messages are refused at both routes taking a message body, and there are three. A committed script states a test count no run produces, in the commit whose thesis is that a measurement must be re-derived rather than believed. A guard's comment states its authority uses a notation it does not use, for a parser that cannot read the notation it says it will use. A guard prints "47 … all unexpired" over a document declaring 48, with one deadline unwatched today. And the correction convention that exists so a retired wording can never return was exercised this commit and did not take.

**The account of the SHAPES is still the most honest engineering record I have read. The account of the STATE has improved in exactly the place it was measured — and is unchanged everywhere it was merely asserted.**

## VERDICT

**reject.** Six load-bearing findings — four introduced by the repair under review, two older than it. The repair's headline artifact is genuinely excellent: the coverage measurement reproduces exactly, per-guard row for per-guard row, and the two swept extractors hold under positional controls. But the same commit ships a third unguarded Telegram door beneath a shipped sentence saying there are two; writes a `[SUPERSEDED]` annotation in a form its own parser cannot read, so the wording it retired can be re-committed silently; states a test count no run produces, in the artifact about not doing that; and certifies a parser against a notation its authority does not use. Older than all of that: an entire trigger-phrase gate that voids the sub-obligation arm's expiry, horizon and uniqueness checks — with one live declaration sitting behind it and the pass-17 exploit working today — and a fourth instance of the branch's founding first-match shape that defeats the fingerprint guard's only field check, left unswept and unrecorded inside the commit titled "sweep the founding shape". The right next step is not another prose repair: it is to derive every guard's population from the document instead of from a phrase, to enumerate the Telegram sinks as an HTTP surface once and guard them at the chokepoint, and to make the account guard's arming step mechanical — because the one thing this commit proves beyond doubt is that a correction which depends on the corrector remembering a format is a correction that does not hold.
```
