# Side-effects review — window 10, deep-property guards

## Increment 1 — *Deferral = Deletion* gets a FUNCTION check

**Changed:** `scripts/lint-deferral-referent-resolves.mjs` (new), `docs/deferral-referent-baseline.json`
(new), `docs/STANDARDS-REGISTRY.md` (Applied-through + named residual), `package.json` (lint chain),
`tests/unit/lint-chain-completeness.test.ts` (ratchet registration),
`scripts/lint-no-direct-destructive.js` (one allowlist entry, justified below).

**Why.** The operator's window-10 charter: real guards for the deep Substrate properties, verifying
FUNCTION rather than existence. *Deferral = Deletion* was chosen first because it is the most tractable
of the four — a deferral either points at something or it does not, which is observable — and because
whatever shape works becomes the template for the three that resist checking harder.

**The measurement that made the case.** The pre-existing guard (orphan-deferral step in
`instar-dev-precommit.js`) proves a spec carrying deferral language carries a TRACKING MARKER, and it
does that correctly. But the ids point into per-machine commitment and evolution-action registries —
runtime state, not tracked in the repo — so no build can resolve them. Measured across `docs/specs/`:
**178 distinct tracked deferral ids, 110 (62%) resolving to nothing anywhere in the repository.** For
those, "tracked" was unfalsifiable: the deletion the standard forbids, wearing a tracking number.

**Over-block.** A new tracked id must be mentioned somewhere outside `docs/`. That can annoy an author
who genuinely defers to work that has not started — the mitigation is that a spec section, a test
name, or the code stub all satisfy it; only a marker pointing at nothing fails. Under-block, named:
an id written into a test comment and nowhere else resolves and follows through on nothing.

**A boundary found by getting it wrong.** The resolving corpus is `git ls-files`, so an UNTRACKED file
cannot resolve a marker. My first injection test used the new (uncommitted) script as the referent, saw
a refusal, and I briefly mistook a CORRECT refusal for a broken check. The behaviour is right — an
uncommitted file is not something a reviewer can follow — and it is now documented in the script.

**The baseline is shrink-only.** 81 orphans at the current head (the 110 figure was measured on the
pre-merge tree). The change that DISCOVERS a debt cannot also pay it; new orphans fail immediately.

**The allowlist entry, and why it is not a weakening.** The script calls `git ls-files`, which
`lint-no-direct-destructive` flags. It is a standalone `.mjs` running with no build step, so it cannot
import the TS SafeGitExecutor funnel — the same situation as `cartographer-freshness.mjs` and
`release-skip-annotate.mjs`, both already allowlisted for read-only git. The call is read-only AND
load-bearing: the corpus must be TRACKED files, or a filesystem walk would silently accept referents
that exist for nobody else.

**The enforced ratio rose 0.7356 → 0.7471, and I checked why before accepting it.** Yesterday I nearly
manufactured enforcement twice; the tell was a metric improving on a change that built nothing. Here the
rise is *Deferral = Deletion* moving gap → gate because a guard now exists, is wired into the lint
chain, and is proven three ways. Enforcement genuinely increased. Stating the check explicitly because
the number moving in my favour is exactly the moment to look.

**Negative controls:** a new orphan marker fails by id; the same marker with a referent in a TRACKED
file passes; a deleted baseline refuses to report clean. Registry restored after each.

**Residual, named and dated in the standard:** whether the deferral was actually KEPT is not checkable
by any build-time guard, because the registries live outside the repo. Countdown
`STD-SUBCOUNTDOWN-deferral-closure-unverified`, 2026-09-07.

**Rollback.** Remove the chain entry, the test registration and the allowlist line; delete the script
and baseline. The standard's Applied-through paragraph reverts with the registry.

---

## Increment 2 — the two enforcement candidates, placed on the tree

**Changed:** `docs/STANDARDS-REGISTRY.md` (two amendments, no new articles).

**Placed as AMENDMENTS rather than new articles, deliberately.** Two new gap articles would take the
count 87 → 89 and, landing in The Substrate, would drop it from 16/26 to 16/28 — below its own
just-re-baselined floor. A new standard that trips a floor on arrival is a standard that has to be
argued for on the wrong grounds. Both candidates are genuinely teeth of existing rules rather than new
obligations, so amendment is also the honest shape.

**Candidate 1 — tooth (E) of *Verify the State, Not Its Symbol*: a guard that is ALIVE is not
necessarily doing its job.** Three independent cases inside 48 hours, which is what makes it a tooth
rather than an anecdote: solo-captain-hold enabled, constructed, visible in config and holding nothing
while silent-standby-relinquish released the lease; a diagnostic of mine that COULD NOT FIRE because
the extractor feeding it stopped at the first match, so the injection produced silence — which reads
exactly like a clean pass; and 62% of tracked deferral markers referring to nothing while the guard
proving a marker EXISTS worked perfectly. The operative demand: a guard's proof must include a case
where it FAILS, because an injection producing silence is the signature of an arm that cannot fire.

**Candidate 2 — *Self-Unblock Before Escalating* must SHOW its exhausted checklist before it sends.**
The case study indicts both parties and is recorded that way: on 2026-08-07 a peer agent's channel was
dead, I reported an external blocker and waited, the observer relayed it upward as a blocker, and
neither of us ran the rung-zero check. The operator's ruling was one sentence and the repair took under
an hour. The cost was the waiting, not the fault. Two independent parties walking past the same
standard on the same night is the signature of a rule relying on memory.

**Both carry named, dated sub-obligations** rather than claiming enforcement: nothing verifies a cited
guard has a negative control, and nothing requires an escalation to attach its checklist result.

**A self-inflicted defect during this increment, worth recording.** My first placement started each
amendment on a new line, which the coverage parser reads as a section heading — the third time today.
Folding them onto the previous line then glued one amendment onto an article's `###` heading, which
silently destroyed that article (the ownership lint caught it: "the governing article resolves to no
article"). Repaired by restoring the heading and appending the amendment to the Rule paragraph. The
lesson is narrow and real: in this document, an amendment belongs at the END of an existing paragraph,
never at a line start and never adjacent to a heading.

**State:** 87 articles (unchanged), enforced 0.7471, false-claims 0, dangling 0, unrecognized 0,
36 sub-obligation countdowns, full lint chain green.

---

## Increment 3 — the two properties that resist checking, assessed honestly

**Changed:** `docs/STANDARDS-REGISTRY.md` (two assessments). **No guard added, and the enforced ratio
did not move (0.7471 before and after) — which is the correct outcome, because nothing was built.**

**Sovereignty — a live guard appears to cover its failure mode, and I deliberately did not cite it.**
The observable failure is narrow: an outbound message asking the operator to do, approve or supply
something the agent already owns. That symptom IS evaluated on every outbound message by the messaging
tone gate's park-your-own-work signals — a check on real behaviour, not on existence. So the honest
state is that this article is marked a GAP while a running guard covers its main observable failure:
an UNDER-claim, the opposite of this registry's usual defect.

I did not convert that into an Applied-through citation. The reason is conflict of interest rather
than doubt: a citation raises the article's enforcement class with nothing new built, and I nearly
manufactured enforcement twice on 2026-08-08 — once refused knowingly, once walked into while
restoring honesty, caught only because a ratio rose on an edit that built nothing. **The party who
benefits from the citation should not be the party who judges it.** Referred for independent judgement
(the laptop lane and the family reviewer both have standing to rule on it), dated, and left as a gap
meanwhile. Leaving an article understated is the cheaper error.

**The Right to Stand Ground — I cannot produce a function check, and that is the finding.** The
failure is a reversal under pressure without new evidence, and both halves defeat a build-time guard:
reversals are not recorded as reversals anywhere (the decision journal models a decision and its
guiding principle but has no notion of superseding an earlier position), and "without new evidence" is
a semantic judgement that *Intelligence Infers, Keywords Only Guard* forbids a matcher from making.

The nearest checkable thing — requiring that a decision reversing an earlier one names what changed —
is offered explicitly as NOT the property: it needs reversals modelled first, and it would verify
bookkeeping rather than backbone, since an agent can record a reason and still be capitulating. The
charter said to say so plainly and date it rather than ship a check that counts mentions; this is that.

**Both carry named, dated sub-obligations.** 38 sub-obligation countdowns, up from 36.

**State:** 87 articles, enforced 0.7471 unchanged, false-claims 0, dangling 0, unrecognized 0,
lint chain green.

---

## Increment 4 — Codey's documentation-is-being proposal, and the four real defects it found

**Changed:** four reader-facing docs corrected; Codey's proposal committed.

**His lane delivered and his session acted** (confirmed by read-back of his pane, 18m48s of work, commit
`3c1f8b65a`). He followed the brief's one hard instruction — measure the population before designing —
and the measurement is what makes the proposal load-bearing: 2,090 documentation files, 1,027 unique
method/path claims, 468 unique config-path candidates.

**He also refused the obvious shortcut, correctly.** 292 config-path candidates do not match by exact
property chain, and the tempting fix is to widen the matcher to leaf names. He rejected it: a common
leaf such as `enabled` appearing somewhere in source proves nothing about the documented path, so
widening would convert honest under-matching into FALSE RESOLUTION — a guard that reports a doc claim
verified when it verified nothing. That is the same failure class as citing a guard that does not
guard, reached independently.

**Four defects he found, each verified against production before I touched anything:**

1. `site/.../features/multi-machine.md` documented `GET /pool/machines/:id`; production registers
   `router.patch` at that path and no `GET` exists. A reader following the doc gets a 404.
2. `site/.../reference/hooks.md` said to inspect via `GET /hooks/events`; production has
   `POST /hooks/events` and `GET /hooks/events/:sessionId`, no unparameterized `GET`.
3. `site/.../reference/api.md` claimed "460 routes" in the sentence directly above an inventory
   containing **541** route bullets — a document falsifying itself within one screen.
4. `docs/THREADLINE.md` documented `GET /threadline/messages/thread/:id`; production has
   `GET /threadline/threads/:id`, and the source explicitly records the old placeholder as deleted.

All four corrected. The count now reads 541 and the file contains 541 — self-verifiable from the same
file, which is the shape a future guard can check.

**Deliberately NOT changed:** `docs/specs/THREADLINE-SPEC.md` carries the same stale route. A spec is a
record of what was designed at a point in time; reader-facing documentation must be true NOW. Editing
the historical record to match today would be a different kind of dishonesty. Named rather than
silently skipped.

**What this increment is evidence for.** These are four instances of the stale-text class I filed as a
defect earlier today — prose left behind by the change it describes — and every one was found by
measurement rather than by reading. That is the argument for Codey's guard existing at all.

---

## Increment 5 — the escalation candidate, corrected against what already exists

**Changed:** `docs/STANDARDS-REGISTRY.md` (one amendment corrected). No guard added; enforced ratio
unchanged at 0.7471.

**I proposed a candidate that already existed, and found out by looking before building.** Increment 2
placed "an escalation must show its exhausted checklist" as if it were new machinery to design. It is
not. The outbound tone gate ALREADY hard-blocks the escalation failure modes — unverified wall, false
blocker, work parked on the user — so an escalation that CLAIMS a blocker is already judged today.

**The real gap is narrower than I wrote:** the message is judged on its CLAIM and is never required to
SHOW the probes it ran. That distinction matters, and overstating it would have had me build a
duplicate of a live gate.

**And the fix is already designed** — in a source comment sitting beside those very rules: make the
override available only by naming a `stop_reason_kind` from the enum the prompt already emits,
cross-checked against the blocker ledger *instead of free prose*. The comment marks it a real operator
decision, surfaced rather than assumed. That posture is correct and is why it has not shipped.

**A second finding falls out, and it is about my own increment 1.** That designed-but-deferred
enforcement lives in a SOURCE COMMENT with no tracking marker at all — and the deferral guard I built
this morning scans `docs/specs/` only. **A deferral in code is exactly as invisible as the ones the
guard was built to catch.** My guard's population is narrower than the problem it names, which is the
same shape as every other under-scoped check found this week — and I found it in my own work within
hours of shipping it, by reading code rather than by re-reading my guard.

Both are named and dated on the amendment. Widening the guard to source comments is deliberately NOT
done tonight: the comment corpus is large, the false-positive profile is unmeasured, and the discipline
this window has repeatedly proved is measure-then-design.

**State:** 87 articles, enforced 0.7471 unchanged, false-claims 0, dangling 0, lint chain green.

---

## Increment 6 — enforcement fingerprints: the measurement pass

**Changed:** `docs/specs/enforcement-fingerprint-measurement.md` (new), one registry amendment
extending tooth (E) with the moment axis. No guard added; enforced ratio unchanged at 0.7471.

**Step 1 of the charter only — MEASURE FIRST.** Steps 2-4 (a fingerprint field on every standard,
required at birth) are not built and are not claimed.

**The surfaces, counted rather than asserted:** 12 CI workflows, 25 CI jobs, 42 build-time lint chain
entries, 2 git hooks, 33 shipped scheduled jobs, 21 per-outbound-message tone-gate rules, 11 response
reviewers, 12 session hook scripts. The total is not the point; the point is that these are seven
distinct MOMENTS, and a standard can be covered at several of them while unguarded at the one where
its violations actually occur.

**The motivating case re-measured, and it is worse than the framing given to me.** The charter said
the self-unblock standard failed because "nothing enforced it at the one moment violations occur."
Measured, something IS there: five rules in that family, all classified `blocking` —
`B15_CONTEXT_DEATH_STOP`, `B16_UNVERIFIED_WALL`, `B17_FALSE_BLOCKER`, `B18_AUTONOMY_STOP`,
`B19_PARKED_ON_USER`. B16's stated population — telling the user a path is blocked "WITHOUT any
evidence that the agent first inventoried the capabilities it already has" — is a fair description of
what I did on 2026-08-07. The gate was demonstrably live (it held a message of mine earlier today).
**The moment was watched, by rules that plausibly cover the manifestation, and the violation passed.**

**Why nobody can say more than that, which is the real finding.** The gate's rule-level verdicts are
recorded NOWHERE. The advisory log captures the deterministic preflight layer only (`advisories: []`,
`action: "clean"`). Nothing on disk says which `B…` rules were evaluated against a message or what each
returned. So we cannot distinguish "fired and was overridden" from "never fired" from "judged wrongly",
and cannot say whether these rules have ever fired at all. **A surface whose decisions leave no trace
cannot be audited for effectiveness — which is exactly why the failure was invisible.**

**The design consequence, and it is the reason this increment matters more than a count.** A
fingerprint that records only WHICH SURFACE and WHICH MOMENT is an existence claim wearing a new name,
and would rebuild this week's central defect one level up. It needs three legs: surface+moment
(derivable now), covered manifestations (readable from the rule), and OBSERVED EFFECTIVENESS (requires
the surface to keep a record — which for the most consequential surface we have, it does not).

**Explicitly not claimed:** that those five rules are broken. They may be working as designed and my
2026-08-07 message may have fallen honestly outside their populations. I cannot tell, and neither can
anyone else — that is the point, and settling it needs the verdict record that does not exist.

**Two dated findings** rather than papered over: no rule-level verdict record at the outbound surface;
no standard carries a fingerprint field. 39 sub-obligation countdowns.

---

## Increment 7 — the fingerprint requirement, enforced at birth

**Changed:** `scripts/lint-enforcement-fingerprint.mjs` (new), `docs/enforcement-fingerprint-baseline.json`
(new), `package.json` (chain), `tests/unit/lint-chain-completeness.test.ts`, one article fingerprinted.

**Charter step 3, built.** A NEW standard cannot enter the registry without declaring WHEN it is
enforced. I had stopped at the measurement and said the schema needed more thought; the stop-gate
challenged that as a self-protective deferral and it was right — the three-legs insight is real, but it
does not block the cheapest and highest-leverage piece, which is catching the hole when the standard is
WRITTEN instead of after its first failure.

**The moment set is closed** — author-time, commit-time, push-time, ci-time, outbound-message, periodic,
runtime-floor, none — and derived from the measurement pass rather than invented. `none` is a legal
answer: an unguarded standard that SAYS so is exactly what the countdown machinery exists for. Silence
is what is now illegal.

**What it certifies, stated narrowly:** that the question "at which moment does this actually bite?" was
put to the author, in writing, in the diff. **It does NOT certify the fingerprint is TRUE**, that the
named moment is where violations occur, or that the surface there is effective — effectiveness is
unmeasurable today for the most consequential surface, which keeps no verdict record. A fingerprint
field mistaken for proof of coverage would rebuild this week's central defect one level up, so the
limit is written into the script's own header.

**The baseline shrank on day one — 87 grandfathered to 86.** *Deferral = Deletion* now carries a real
fingerprint: commit-time (the orphan-deferral precommit step) and ci-time (today's referent guard), with
a coverage argument that names where it does NOT reach — the periodic moment when promised work comes
due, and deferrals recorded in source comments rather than specs. It could carry one precisely because
its moments were established by BUILDING the guard rather than by assertion. Retrofitting the other 86
is real per-standard analysis, not a formatting pass; the change that introduces a requirement cannot
also satisfy it 87 times.

**Negative controls:** a new article without a fingerprint fails by name; the same article with a valid
one passes; a fingerprint naming a made-up moment fails rather than silently exempting itself — that
last arm matters because a typo would otherwise be indistinguishable from compliance.

**State:** 87 articles, enforced 0.7471, 1 fingerprinted / 86 grandfathered, lint chain green.
