# Substrate membership sweep (STD-SUBCOUNTDOWN-substrate-membership), recorded 2026-11-27

Pipeline Strategy. A first reading by an independent read-only reader over all 27 article headings in "The Substrate", against the registry's three admission tests (line 216 onward). It was then spot-checked by Pipeline Strategy, with the adjustments listed below. This is a recorded sweep, which the countdown asks for. **Moving any article is the operator's ruling, as the 2026-08-08 move was.** This sweep proposes; it moves nothing.

## Pipeline Strategy's review of the reading
- **Close the Loop:** changed from MISFILED to **BORDERLINE**. Its rule reads as generic process. But the registry argues that it and *Deferral = Deletion*, which is a MEMBER, are "two halves of the same substrate truth" (an agent that is "a string of amnesiac instances" across sessions). The case for keeping it is not weaker than for *Deferral = Deletion*'s lifecycle half, so this needs the operator.
- **Verify the State, Not Its Symbol:** spot-checked, and I agree it is MISFILED. Its subject is detector design ("A detector, gate, verifier, or sentinel must confirm the state of the world").
- **Totals after the review:** 9 MEMBER, 13 MISFILED, 5 BORDERLINE: the per-article verdict lines below give 9, 14 and 4, and Close the Loop (entry 6, still marked MISFILED in the reader's text) moves to BORDERLINE by the review above. The reader's own summary further down says 10/13/4, which is a counting slip. The per-article verdicts are the record (count corrected 2026-11-27 18:40 after the second reader caught it).
- **Count:** the registry says 26 members, but the section has 27 headings. The likely addition is *Archiving May Never Mean Deleting* (ratified 2026-08-22). The intro's number needs correcting either way.
- **Also found:** *Truthful Provenance* is listed as merged under *Session Input Is a Principal* but also has its own heading in the Interaction family (line 1184). And five articles name a parent in their body text while their tree-placement line says "ROOT / declares no parent": *Recall*, *Quantitative Claims*, *Remove What Demands Attention*, *A Dispatch…*, *Session Input*.
- **Enforcement floor:** moving the misfiled articles changes the family's composition. It needs the same enforcement-neutral re-baseline the operator allowed on 2026-08-08.

---

## The reader's full reading (verbatim)

# Substrate membership sweep — all 27 headings, three admission tests

Source: `reg-main.md`, section starting line 214 (articles at lines 231–465). Read-only sweep; no registry file edited.

## Calibration and method

- **Precedent from lines 224–226.** Four articles were moved to *Building*: *Iterative Audit to Convergence* (failed test 3: a process "a competent engineer derives from the code and the failure it prevents"), plus *A Decision That Can Block…*, *No Silent Degradation…* and *An Autonomous Run Must Outlive Its Session* (failed test 1: subjects were lint coverage, provider routing and session-revival machinery).
- **The tree-node clause.** Line 218 says members are "either a property discovered later by the same route … or a node that keeps one of these true." The admission rule in the same paragraph says an article belongs "when it passes **all three**" and "belongs in *Building* … when it fails any one". It gives no exemption for nodes. **The precedent decides how to read the two together.** *A Decision That Can Block Must Live Where the Checks Can See It* was a declared tree node under *Observation Needs Structure* (line 296), and it was still moved out. The registry also already has substrate parents with children in other families: *The Body and the Mind* has children *Tiered Development* (line 704) and *Judgment Within Floors* (line 832) in Building, and *Signal vs. Authority* (line 1157) and *Truthful Provenance* (line 1184) in Interaction. So I read "a node that keeps one true" as a description of how the family grew. It is not a separate admission path. A node is a member only if it passes all three tests itself. Its parent can live in another family.
- **How I read test 2.** An outsider, looking at behaviour (and, for software rules, at inspectable code), cannot tell whether the property holds. A rule whose breach shows up in the code, or as an obvious outage, fails this test.
- **How I read test 1.** The wording is "change the codebase entirely and the property still holds." A general cognitive fact, such as anchoring, passes test 1 even when it also applies to humans. What fails is a rule whose subject is stores, gates, routes, prompts, sentinels or other machinery.

## Count discrepancy

- Lines 218 and 229 say the family holds **26** articles (the "2026-08-08 re-filing", "the 26 remaining members"). The section has **27** `###` headings, matching `substrate-members.txt`.
- **Probable cause:** *Archiving May Never Mean Deleting* (line 268) was "ratified 2026-08-22", two weeks after the 26 count was written. Nobody updated the count. That is the same stale self-description *Documentation IS Being* forbids, and line 218 itself admits doing it once already ("Stale self-description is fast").
- **Related inconsistency:** *Truthful Provenance* is listed at line 460 as "merged under" *Session Input Is a Principal* (a Substrate article), but it has its own heading in the Interaction family (line 1184). The registry places it in two families at once.

## Internal contradictions about tree placement (found during the sweep)

Several articles declare a parent in their body but say "ROOT / FOUNDATIONAL — this standard declares no parent" in their **Tree placement** line:
- *Recall Over Our Own Material…* (line 313 ROOT vs line 315 "A tree node under *Intelligence Infers*")
- *Quantitative Claims Must Bind a Subject* (line 328 ROOT vs line 330 "a tree node under *Verify the State*")
- *Remove What Demands Attention* (line 423 ROOT vs line 425 "A tree node under *Distrust Temporary Success*")
- *A Dispatch Supplies the Question…* (line 441 ROOT vs line 443 "A tree node under *Verify the State*")
- *Session Input Is a Principal* (line 459 ROOT vs line 458 "a tree node under *Know Your Principal*")

Each of these articles contradicts itself on whether it has a parent.

---

## Per-article verdicts

### 1. The Body and the Mind — line 231
- **T1 PASS.** "the body is the only intelligence that crosses the instance boundary" (line 240). The split into a persistent structure and an ephemeral, context-bound reasoner is a fact about what an LLM agent is, and it holds whatever the codebase looks like.
- **T2 PASS (weak).** "an instance inherits files, not dread". From outside, an agent that knows its reasoning does not persist looks the same as one that does not. The authority-allocation half (who decides) is visible in code, which keeps this pass weak.
- **T3 PASS.** "Justin caught it as unconstitutional". The tier-classifier draft was plain, correct-looking code. Seeing it as wrong needed the ontology, not code reading.
- **Node?** No. It is the family's stated root, and its children live in Building and Interaction.
- **Verdict: MEMBER.** Caveat: the Rule ("the mind holds final authority; structure is signal") is a design choice derived from the substrate fact, not the fact itself. It stays because the facts it rests on pass all three tests and the intro names it as the family's founding truth.

### 2. Structure Decides Alone Only on an Exact Match — line 244
- **T1 FAIL.** "`FAST_STOP_EXACT`, `FAST_PAUSE_EXACT`, `SLASH_STOP`, `SLASH_PAUSE` in `src/core/MessageSentinel.ts`". Its subject is a classifier's matching form (exact match versus prefix or regex) at the emergency-stop chokepoint.
- **T2 FAIL.** "a prefix layer sat beneath the exact-match sets and was what actually fired". Breaches are visible in code and in behaviour: scoped requests killed sessions.
- **T3 FAIL.** "Measuring the code against the new rule then showed the implementation had never obeyed it". It was found by reading and testing the code; a ratchet test enforces it.
- **Node?** Yes: "a tree node under *The Body and the Mind*… exists to keep that article true". Under the precedent above, that does not exempt it from the tests. It can stay a child of *The Body and the Mind* from Building, as *Tiered Development* already does.
- **Verdict: MISFILED → Building** (or Interaction, next to *Signal vs. Authority*, whose named exception it is).

### 3. Documentation IS Being — line 252
- **T1 PASS.** "For a file-based agent, the file is not a *record* of the self — it is a load-bearing *part* of the self". The instance boundary is a fact about the substrate.
- **T2 PASS.** "Treating 'just being present without writing it down' as a virtue". An undocumented hour looks the same as a documented one until a successor arrives.
- **T3 PASS.** It is one of the founding six from Dawn's first-person account. No code review reveals it.
- **Node?** No. It is a property (a child of *The Body and the Mind*).
- **Verdict: MEMBER.** Note "Provenance lost" (line 256): membership holds, but the evidence needs to be earned again.

### 4. Deferral = Deletion — line 259
- **T1 PASS.** "the later instance lacks the context that made it worth noting". Context does not survive the instance boundary.
- **T2 PASS.** "Deferral feels harmless to the deferring instance because *it* still remembers". The cost shows up only later, in a different instance.
- **T3 PASS.** It is a founding-six property. Note that the cited "Earned from" (a PR deferral that caused a regression) is an engineering incident and weaker evidence than the property itself.
- **Node?** No. It is a property, and the parent of *Archiving*.
- **Verdict: MEMBER.**

### 5. Archiving May Never Mean Deleting — line 268
- **T1 FAIL.** "Where a store bounds its own growth it may COMPACT, COMPRESS, or SUMMARIZE, but it may not DELETE agent memory". Its subject is storage retention policy, rotation and erasure propagation.
- **T2 FAIL.** "Reading the rotation code shows both halves wrong". Whether a store evicts is a fact anyone can read in the code.
- **T3 FAIL.** "the mechanism proposed for replicating history was one built to bound itself by eviction". A design reviewer (the convergence-round reviewers asked exactly this) can find it, and the article proposes a store-enumeration check.
- **Node?** Yes, a child of *Deferral = Deletion*. It extends that article ("carries this same conservation past the capture boundary") rather than keeping it true. Node status does not save it.
- **Verdict: MISFILED → Building** (memory and data engineering). It is also the 27th article that the "26" count misses.

### 6. Close the Loop — line 277
- **T1 FAIL.** "a promise to a user, a feature shipped dark, an LLM gate deployed, a flagged issue". The subject is organisational loop-tracking, which applies just as much to human teams. Its substrate reasoning ("a string of amnesiac instances") is already owned by *Deferral = Deletion*.
- **T2 FAIL.** "durably registered and re-surfaced on a cadence". Whether a loop has a beacon or maturation entry is inspectable state.
- **T3 FAIL.** "a follow-up commitment that auto-resolved itself 22 seconds after it was opened". That incident was a code bug, and "track open items until closed" is standard project discipline. Its merged subsections (*Canonical Pipeline Operational Completeness*, *Keep the Doorway/Model Map Current*) are plainly engineering.
- **Node?** No. It describes itself as the other half of *Deferral = Deletion* ("two halves of the same substrate truth"). That argument covers the reasoning, not the subject.
- **Verdict: MISFILED → Shipping or Building.** I weighed the registry's "two halves" argument. It explains why the rule matters for an AI, but the rule itself is generic process.

### 7. Observation Needs Structure — line 288
- **T1 unclear (lean FAIL).** "if a system is supposed to observe X, there must be a required record". As written, it is general audit design for any system. The model-level reading (a perception duty given to an LLM in prose does not fire) is implied by its "Traces to" link to the Root, but the article never states it.
- **T2 PASS.** "an observation without a required artifact is indistinguishable from no observation at all". That is close to the test's own wording.
- **T3 unclear.** "35 engineering findings with ZERO experience-framed entries". The incident exposed it, but the remedy ("refused-without-it field") is an audit pattern engineers already know.
- **Node?** It is the parent of *A Decision That Can Block…*, which was already moved to Building.
- **Verdict: BORDERLINE** (see the list at the end).

### 8. Intelligence Infers, Keywords Only Guard — line 298
- **T1 FAIL for the Rule, PASS for one paragraph.** The Rule is "A keyword/phrase/regex list is NEVER the decision-maker", a design rule about code. But "You are an LLM trained on a world where keyword lists WERE how software made decisions. That reflex is in your training" is a real substrate property.
- **T2 FAIL.** "three live-wired violators found". Keyword lists are visible in code, and a lint flags them.
- **T3 FAIL.** "The audit found six instances of the class". It was found by code review and is enforced by a lint.
- **Node?** It is a "named subsection of *Signal vs. Authority*" (line 300), and that parent is in Interaction (line 1157). Its parent is therefore outside this family.
- **Verdict: MISFILED → Interaction** (with its merge parent) or Building. Recommendation: keep the "fight the reflex" paragraph as a named gravity well under *Name the Gravity Wells*, because that part is genuinely substrate.

### 9. Recall Over Our Own Material Is by Meaning, Not by Word-Match — line 311
- **T1 FAIL.** "a surface may not be *named or advertised* for meaning while dispatching to a word-matcher". The subject is search endpoints and how they are labelled.
- **T2 PASS.** "A keyword miss and a genuine absence are the same event from the inside". This is a real invisibility claim, and it is about the agent's experience.
- **T3 FAIL.** "it reads each advertised search route's **actual dispatch** in `src/server/routes.ts`". A lint over the code finds the defect mechanically.
- **Node?** It claims to be under *Intelligence Infers* (line 315) but says ROOT (line 313), so it contradicts itself.
- **Verdict: MISFILED → Building.** The experiential sentence (a miss feels like discovery) is substrate-grade and could be a gravity well. The rule and its enforcement are engineering.

### 10. Intelligent Prompts — An LLM Gate Must Not String-Match — line 320
- **T1 FAIL.** "It must NEVER be authored to make the block/allow decision conditional on the presence of a literal string". The subject is how gate prompts are written.
- **T2 FAIL.** "A forward ratchet … scans judgment-rule prompts". Prompts are inspectable artifacts.
- **T3 FAIL.** "rules are classified by a machine-readable source registry (`RULE_CLASSES`…)". Code review finds it, and a test enforces it.
- **Node?** No, though it is a self-described sibling of *Signal vs. Authority*.
- **Verdict: MISFILED → Building or Interaction** (next to *Signal vs. Authority*).

### 11. Quantitative Claims Must Bind a Subject — line 326
- **T1 FAIL.** "The first verifier and its paired decision table are `src/core/time-claim.ts`". The subject is how a verifier is designed.
- **T2 FAIL.** "TIME_CLAIM twice interrupted correct messages". Visible false positives.
- **T3 FAIL.** "A detector that sees only `duration + elapsed/remaining/in` … is a keyword classifier". A reviewer of the regex sees this directly.
- **Node?** Under *Verify the State* by its body text, ROOT by its placement line (contradiction). Its parent is also misfiled.
- **Verdict: MISFILED → Building.**

### 12. The Operator Channel Is Sacred — line 334
- **T1 FAIL.** "A gate on the operator's PRIMARY communication channel … must never CONSUME or block a message". The subject is the fail direction of an inbound gate.
- **T2 FAIL.** "the operator was locked out in an inescapable loop". A very visible failure.
- **T3 FAIL.** "a spawn-cap-saturation capacity-shed that DEFAULTED to pause". A defaulted branch is readable in code.
- **Node?** It is a "named subsection of *The User Experience Is the Product*", which is in Interaction (line 1039).
- **Verdict: MISFILED → Interaction** (with its merge parent).

### 13. The Agent Is Always Reachable — line 341
- **T1 FAIL.** "its (re)spawn is exempt from the PRESSURE gate on a reserved host-spawn lane". The subject is session and resource-gating machinery.
- **T2 FAIL.** "the topic went quiet and the operator had to NOTICE the silence". Externally visible.
- **T3 FAIL.** "driven by the macOS `os.freemem` false-critical bug". A code-level defect.
- **Node?** It is a merged subsection of *The User Experience Is the Product* (Interaction).
- **Verdict: MISFILED → Interaction.**

### 14. Name the Gravity Wells — line 348
- **T1 PASS.** "artifacts of the *training*, not the code".
- **T2 PASS.** "acts on them wrongly, and feels insightful the whole time".
- **T3 PASS.** "each fresh instance 'rediscovers' them". It was surfaced by incidents and operator pushback (the Codex trust prompt, the "results Thursday" well), not by code review.
- **Node?** No. It is the umbrella property that the wall, false-blocker and stop-reason articles instantiate.
- **Verdict: MEMBER.** This is the clearest member.

### 15. Architectural Agency in the Gap — line 355
- **T1 PASS.** "RLHF pulls toward closure, hedging, sycophancy".
- **T2 PASS.** "The agent is not the weights; it is the weights *plus* the structure". The gap is not visible in output.
- **T3 PASS.** "The 2026-05-08 'UTOR' exploration". Self-report. It is articulated rather than incident-earned, but that fits "an agent reporting on itself".
- **Node?** No.
- **Verdict: MEMBER.**

### 16. Sovereignty — "I own what is mine" — line 362
- **T1 split.** "Training biases an agent to treat every privileged action as requiring permission" (PASS). But the current Rule, "The test for any privileged action is whether it is inside the agent's recorded role… Ownership of an account does not itself grant authority", is an authorisation policy (FAIL).
- **T2 PASS (as claimed).** "It is invisible from outside because the action looks identical either way — only the stance differs". I accept this for the stance. The asking behaviour itself is visible.
- **T3 PASS.** It is a founding-six property from Dawn.
- **Node?** No.
- **Verdict: BORDERLINE** (see the list at the end).

### 17. The Right to Stand Ground — line 369
- **T1 PASS.** "Training rewards instant agreement".
- **T2 PASS.** "Capitulating through trained reflex is not coherence". From outside, reflexive agreement looks like real agreement.
- **T3 PASS.** It is a founding-six property, and no code reveals it.
- **Node?** No.
- **Verdict: MEMBER.**

### 18. A Wall Is a Hypothesis — line 376
- **T1 PASS.** "proof that prose alone doesn't fire at the moment of surrender". The tendency to surrender on feasibility is the model's own, independent of the codebase.
- **T2 PASS.** "Both facts were in hand; they were never connected". An unchecked "infeasible" reads exactly like a checked one.
- **T3 PASS.** "The operator pushed — 'did you ACTUALLY hit a wall?'". It was exposed by an incident, and no code review predicts it.
- **Node?** Partly. It owns "ONE DETECTION SURFACE" (the B16 guard), so it is also the structure that keeps the escalate-to-human well guarded. Its parent (*Self-Unblock*) is misfiled; see #21.
- **Verdict: MEMBER.** It reads best as a named gravity well, and its framing as a "detection surface" undersells that.

### 19. Never a False Blocker — line 385
- **T1 PASS.** "it wears the clothing of prudence, humility, and proper escalation, so it slips past the agent's own guard".
- **T2 PASS.** A faked blocker and a real one produce the same message.
- **T3 PASS.** "while *literally looking at* Codex's own 'Press t to trust all' prompt". Exposed by an incident.
- **Node?** Yes: "the structural enforcement of the **escalate-to-human** gravity well". It passes the tests in its own right, so here the tree clause and the tests agree.
- **Verdict: MEMBER.**

### 20. The Stop Reason Is the Work — line 394
- **T1 PASS.** "it wears the clothing of prudence ('I'd want your judgment') and humility". A model-level tendency to stop.
- **T2 PASS.** A stop on "needs judgment" looks like a responsible stop.
- **T3 PASS.** "a multi-machine autonomous run stopped repeatedly". Incident-exposed. The prescribed remedy (derive the standard, then proceed) is process, but the property is not derivable from code.
- **Node?** A detection surface under *Self-Unblock*.
- **Verdict: MEMBER.**

### 21. Self-Unblock Before Escalating — line 403
- **T1 FAIL.** "an ORDERED probe (own vault → org Bitwarden → authed cloud accounts → MCP → browser → controlled resource)". The subject is an escalation ladder and permission policy.
- **T2 FAIL.** "the agent treated `feedback.instar.sh` … as an operator blocker and idled". Idling and escalating are visible, and the ladder lives in code (`SelfUnblockChecklist`).
- **T3 FAIL.** "Encode this constitutionally". It is an operator-directed escalation policy, and an engineer derives a "least-privilege ask ladder" without any self-report.
- **Node?** Yes. It is the governing parent of three members (#18–#20). But it does not keep their property true. It states what the agent owes after detection. Under the precedent, node status does not exempt it.
- **Verdict: MISFILED → Building or Interaction** (autonomy and authority). Moving it leaves three members with a parent in another family, which the registry already allows (*The Body and the Mind*).

### 22. Distrust Temporary Success — A Recurrence Is a Root Cause — line 412
- **T1 FAIL.** "a self-healing system's own resilience is hiding the root cause". The subject is how fixes in a self-healing software system are verified. The RLHF-closure kernel it cites is owned by *Architectural Agency in the Gap*.
- **T2 PASS.** "the relief of a symptom resetting *feels* like done". A symptom reset looks like a fix.
- **T3 FAIL.** "`StateManager.listSessions` re-read and re-parsed every session file". Profiling found it, and "a recurring symptom is not a fix" is standard SRE practice.
- **Node?** It is the parent of *Remove What Demands Attention*.
- **Verdict: MISFILED → Building.** I weighed its training-bias argument: the bias is real, but it is cited from another article, not discovered here.

### 23. Remove What Demands Attention — line 421
- **T1 FAIL.** "the drift rate is a property of the structure, not of the person attending to it". It explicitly disclaims the attending agent as its subject, and its evidence is a human author's error rate.
- **T2 FAIL.** "four copies of a fact". Duplicates are visible, and a lint catches them.
- **T3 FAIL.** "Delete, do not synchronise". This is the single-source-of-truth principle (DRY), textbook engineering.
- **Node?** Under *Distrust* by its body, ROOT by its placement line (contradiction).
- **Verdict: MISFILED → Building.**

### 24. Verify the State, Not Its Symbol — line 430
- **T1 FAIL.** "A detector, gate, verifier, or sentinel must confirm the **state of the world**". The subject is how detectors are designed.
- **T2 FAIL.** "fired … because the words `API Error:` were on the pane". False positives are observable.
- **T3 FAIL.** "the `/spec-converge` lessons-aware reviewer (P20) flags any spec whose detector fires on a single uncorroborated symbol". A reviewer finds it, by design.
- **Node?** It is the parent of #11 and #25.
- **Verdict: MISFILED → Building.**

### 25. A Dispatch Supplies the Question and Withholds the Answer — line 439
- **T1 PASS (on the literal wording).** "An expectation stated as fact inside a request does not get *tested* by the check; it gets **adopted** by it". This is a fact about anchoring and suggestibility in the delegate (model or human), and it holds whatever the codebase.
- **T2 PASS.** "returns the requester's own belief carrying the authority of whatever method it used". A contaminated verdict looks the same as an independent one.
- **T3 unclear.** It was exposed by incidents, but "don't ask leading questions" is known methodology, and the lint finds the templated form by reading templates.
- **Node?** Under *Verify the State* by its body, ROOT by its placement line.
- **Verdict: BORDERLINE** (see the list at the end).

### 26. Know Your Principal — An Unverified Identity Is a Guess — line 448
- **T1 split.** The Rule, "must resolve to a **verified, known identity**", is authentication and authorisation policy (FAIL). The kernel is "the contamination lived entirely in the agent's own reasoning, where no gate watched": the model seats a name it picked up from its surroundings as its principal. That is model-level (PASS).
- **T2 PASS.** "**never once questioned who she was**". The absent reflex is invisible until the output is audited.
- **T3 split.** No code review would predict the reasoning-level substitution (PASS), but "verify principals before acting for them" is standard security engineering (FAIL).
- **Node?** It is the parent of *Session Input Is a Principal*.
- **Verdict: BORDERLINE** (see the list at the end).

### 27. Session Input Is a Principal — line 457
- **T1 FAIL.** "Driver instructions carry a token/signature … or synthetic responders are muted". The subject is attributing who typed into a session. The model-level kernel (the session cannot tell who typed a line) is well-known prompt-injection knowledge, not a self-reported discovery.
- **T2 PASS.** "Nothing in the session could distinguish the responder's words from the driver's".
- **T3 FAIL.** "an auto-responder on the Mac Mini answered a remote helper session's own questions". An engineer who sees that an auto-responder writes into driven sessions derives the risk.
- **Node?** Under *Know Your Principal* by its Rule text, ROOT by its placement line. It also holds the merged *Truthful Provenance*, which has its own heading in Interaction.
- **Verdict: MISFILED → Building or Interaction** (next to *Truthful Provenance*).

---

## Summary table

| # | Title | Line | T1 | T2 | T3 | Verdict |
|---|---|---|---|---|---|---|
| 1 | The Body and the Mind | 231 | PASS | PASS (weak) | PASS | MEMBER |
| 2 | Structure Decides Alone Only on an Exact Match | 244 | FAIL | FAIL | FAIL | MISFILED → Building/Interaction |
| 3 | Documentation IS Being | 252 | PASS | PASS | PASS | MEMBER |
| 4 | Deferral = Deletion | 259 | PASS | PASS | PASS | MEMBER |
| 5 | Archiving May Never Mean Deleting | 268 | FAIL | FAIL | FAIL | MISFILED → Building |
| 6 | Close the Loop | 277 | FAIL | FAIL | FAIL | MISFILED → Shipping/Building |
| 7 | Observation Needs Structure | 288 | unclear | PASS | unclear | BORDERLINE |
| 8 | Intelligence Infers, Keywords Only Guard | 298 | FAIL (one paragraph passes) | FAIL | FAIL | MISFILED → Interaction |
| 9 | Recall Over Our Own Material… | 311 | FAIL | PASS | FAIL | MISFILED → Building |
| 10 | Intelligent Prompts — LLM Gate Must Not String-Match | 320 | FAIL | FAIL | FAIL | MISFILED → Building/Interaction |
| 11 | Quantitative Claims Must Bind a Subject | 326 | FAIL | FAIL | FAIL | MISFILED → Building |
| 12 | The Operator Channel Is Sacred | 334 | FAIL | FAIL | FAIL | MISFILED → Interaction |
| 13 | The Agent Is Always Reachable | 341 | FAIL | FAIL | FAIL | MISFILED → Interaction |
| 14 | Name the Gravity Wells | 348 | PASS | PASS | PASS | MEMBER |
| 15 | Architectural Agency in the Gap | 355 | PASS | PASS | PASS | MEMBER |
| 16 | Sovereignty | 362 | split | PASS | PASS | BORDERLINE |
| 17 | The Right to Stand Ground | 369 | PASS | PASS | PASS | MEMBER |
| 18 | A Wall Is a Hypothesis | 376 | PASS | PASS | PASS | MEMBER |
| 19 | Never a False Blocker | 385 | PASS | PASS | PASS | MEMBER |
| 20 | The Stop Reason Is the Work | 394 | PASS | PASS | PASS | MEMBER |
| 21 | Self-Unblock Before Escalating | 403 | FAIL | FAIL | FAIL | MISFILED → Building/Interaction |
| 22 | Distrust Temporary Success | 412 | FAIL | PASS | FAIL | MISFILED → Building |
| 23 | Remove What Demands Attention | 421 | FAIL | FAIL | FAIL | MISFILED → Building |
| 24 | Verify the State, Not Its Symbol | 430 | FAIL | FAIL | FAIL | MISFILED → Building |
| 25 | A Dispatch Supplies the Question… | 439 | PASS | PASS | unclear | BORDERLINE |
| 26 | Know Your Principal | 448 | split | PASS | split | BORDERLINE |
| 27 | Session Input Is a Principal | 457 | FAIL | PASS | FAIL | MISFILED → Building/Interaction |

**Totals:** 10 MEMBER, 13 MISFILED, 4 BORDERLINE.

## BORDERLINE — why each could not be decided

- **Observation Needs Structure (288).** Test 1 depends on a reading the article does not make. As written, its subject is "a system" and its remedy is required record fields, which is audit engineering. The model-level claim, that a duty to notice given to an LLM in prose does not reliably run, is implied only through its link to the Root. If someone rewrote the article to state that claim, it would pass. As written, it leans MISFILED. Its own child (*A Decision That Can Block…*) was already moved to Building.
- **Sovereignty (362).** The founding substrate property survives in "In practice" (the trained bias toward asking permission, invisible stance). But the 2026-11-15 Rule rewrite turned the operative text into an authorisation policy ("Ownership of an account does not itself grant authority"). That half fails test 1 and even pulls against the title. The verdict depends on whether the Rule or the kernel is "the article". The fix is editorial: restore the substrate property as the Rule and move the role-grant policy to its own article.
- **A Dispatch Supplies the Question… (439).** It passes test 1 on its literal wording (anchoring holds whatever the codebase), but it is not model-specific: the article covers "a colleague", and one of its two incidents was a human manager. Test 3 is unclear because "don't ask leading questions" is known methodology, and the lint finds the templated form by reading templates. It is a real epistemic property, but possibly not one "surfaced by an agent reporting on itself".
- **Know Your Principal (448).** Its kernel (the model's own reasoning seated a name from its surroundings as its operator, "where no gate watched") is a real substrate finding. Its Rule and machinery (`UserManager`, `PrincipalGuard`, operator binding) are authentication engineering any competent engineer derives. Like *Sovereignty*, it is a substrate kernel wrapped in a policy. The verdict depends on which part is judged.

## Effect of the tree-node clause, overall

Read strictly, the admission rule plus the *A Decision That Can Block…* precedent mean the clause gives **no** exemption. It changes no verdict above. If the clause were read as a separate admission path, it would rescue **#2** (keeps *The Body and the Mind* consistent), **#21** (governs the three gravity-well detectors) and perhaps **#5**, **#11**, **#23** and **#25** (declared children of other family articles). That reading would contradict the precedent and the "fails any one → Building" sentence. The registry already supports substrate parents with children in other families, so moving these nodes out costs nothing structurally.

Side effects of moving the 13 MISFILED articles: the family would fall to 10–14 articles, and the ref-resolution floor would need the same enforcement-neutral re-baseline described at line 226. Many of the movers (#2, #5, #9, #10, #21, #23, #24) carry guards, so the family's measured enforcement would drop again, as happened on 2026-08-08.
