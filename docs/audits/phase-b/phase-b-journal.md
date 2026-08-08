
---

## 2026-08-05T04:05:10Z — Window 7 opening block

**Examined:** window-6 handoff, manager review, ALIGNMENT-PLAN-ROOT + LEVEL1, Phase A verdict ledger +
interim synthesis, `guardManifest.ts`, `lint-guard-manifest.js`, both machines' memory, Codey's
routing + feature metrics on both instances.

**Built:** the Phase B remediation tree (7 branches, ~20 nodes); the B0.1 spec + ELI16; two Codex
execution lanes on the laptop (census — landed; denominator reconciliation — running). Four commits.

**Decided:** B0.1 is a PROPAGATION, not new machinery — `GuardManifestEntry` is already a
declare-or-fail register enforced by a lint that bites, missing only the obligation that matters.
Chose a discriminated union so the partial state ("two of three") is *unrepresentable* rather than
merely discouraged.

### WHAT SURPRISED ME

1. **⭐ The conformance gate caught me committing the SAME defect four times in a row, on the same
   field, each time believing I had fixed it.** ≥12 chars → closed set → any string → git-blame author
   → PIN. Every revision made the symbol harder to fake; none made it true, because each was still
   something I could type. **I could not see it from inside at any round.** This is the single best
   piece of evidence I have produced for why guard verification must be external — I was actively,
   consciously trying to fix a presence-vs-truth bug and reproduced it four times while doing so.

2. **`guardStatus()` is a convention, not a contract.** 26 implementations, each an ad-hoc shape.
   I expected a shared interface. There is none — which is exactly why the obligation can be added at
   the manifest rather than at 26 call sites.

3. **4 of 80, not 20 of 90.** Measured purely on self-service counter surface, the verifiable
   population is far smaller than Phase A's headline. Different question, much starker answer. The
   `partial` class (7) is the real finding — `sessionReaper` reports `reapsLastHour` with no
   `looked` counter, so its zero is indistinguishable from a reaper that never evaluated anything.

4. **My own control symbol was invalid, and I over-concluded from it.** I used `wouldDeny` as the
   "this must exist" control, got 0, and inferred *wrong tree*. `wouldDeny` is an API response field
   read from a route — never verified to be a source identifier. The tree WAS wrong, but I was right
   for the wrong reason, and I said so before continuing. **A control is only a control if I have
   independent on-disk evidence for the symbol.** Corrected control: `CrashLoopPauser` (named in
   CLAUDE.md, must exist in any current tree).

5. **The laptop's entire repo situation was broken and invisible.** Every checkout pointed at
   `JKHeadley/instar-echo` — a repository that does not resolve — and `origin/main` there dated to
   **2026-05-19**. I dispatched an execution lane at a **2026-06-11 / v0.28.64** tree before catching
   it. A census from that lane would have described a codebase that no longer exists.

6. **A health readout kept reporting a fault that was already fixed.** Codey's `/health` said
   PromptGate "failing 90.7%" from a 6-hour window; the last hour was clean and every error predated
   the repair. Now tree node B0.3 — an instrument that cannot distinguish "broken now" from "was
   broken" causes exactly the wrong escalation.

**Substrate-lane accounting:** the laptop repo repair (~35 min) was unplanned substrate. Named here
rather than absorbed silently. It was worth it — every future execution lane needs current source on
the machine that has the memory — but it is substrate, not plan work, and it counts against the ~1/3
budget.

---

## 2026-08-05T04:23:33Z — the design arc, and the window's real product

**Examined:** `GuardRegistry.ts` (the registration contract), `guardPostureView.ts` (the
classification logic), both agents' live `/guards`, the adversarial reviewer's five findings.

**Built:** B0.1 through THREE design generations, two killed by review. Branch
`echo/guard-effectiveness-observability` pushed, 11 commits.

### The arc

| version | idea | killed by |
|---|---|---|
| v1 | manifest DECLARATION of counter paths | adversarial review — **MATERIALLY-FLAWED**; borrow an unrelated existing counter |
| v2 | registry OWNERSHIP (self-registered getter) | conformance gate — a getter is a function; it reduced a lie to *reviewable*, not impossible |
| v3 | **split the trust** — caller owns `looked`, guard owns only its verdict | current; yields `didAct ≤ wouldAct ≤ looked` as a mechanical invariant |

### WHAT SURPRISED ME

1. **⭐ Seven successive "fixes", each still a symbol I controlled, each declared structural.** 12
   chars → closed set → any string → git-blame author → PIN → registered getter → a prose "must never".
   **I was consciously fixing a presence-vs-truth bug and reproduced it six more times while doing so.**
   Banked to memory as `i-call-a-symbol-bedrock-seven-times-running`. The exit was never a stronger
   validator — it was **changing who produces the value**.

2. **⭐ The conformance gate reported CLEAN at round 8 on a design an adversarial reader then killed
   with five grounded findings.** Not a defect in the gate — it measures conformance to standards, not
   soundness of mechanism. But I was **one message from reporting gate-clean to the operator as design
   validation**, and I had already asked him to approve it. Withdrawn within ~12 minutes of the review
   landing.

3. **The tree's first structural error was found by review, not by planning.** B0.5 (harness) is a
   PREREQUISITE of B0.1, not a follow-on: a counter proves instrumentation, only a staged violation
   proves honesty. Shipping the schema first would give 72 guards reporting numbers nobody can trust —
   worse than today, because they would carry unearned rigour.

4. **I lost a reviewer's output by letting it only speak.** The two lanes told to WRITE FILES delivered;
   the one that merely reported lost everything when its pane died. Recovered from the codex rollout
   only by luck. **Every dispatched lane must write to a file — the final message is not a deliverable.**

5. **`NOT_A_GUARD` (81) is LARGER than `GUARD_MANIFEST` (72).** I sized the migration at 72 for
   hours. The exempt list is bigger than the guarded list — and it is where `CrashLoopPauser` hid.

**Substrate accounting:** laptop repo repair ~35 min. Everything else mapped to B0.1/B0.2/B0.5.
Well inside the ~1/3 budget.

---

## 2026-08-05T04:38:31Z — three generations, three hostile verdicts, and the number that ends the ambiguity

**Examined:** the v3 adversarial re-review (16KB, grounded file:line throughout), the chokepoint survey
(per-guard invocation tracing, controls passed), the real standards-enforcement auditor.

**Built:** v3 corrected on four counts; 21 commits pushed and remote-verified.

### The decisive number
**28 of 72** guards can adopt v3 today — TICK-LOOP 19 + FUNNEL 9. The other 44 are EVENT-DRIVEN (16)
or SELF-DRIVEN (26): no caller exists to count their invocations. **So B0.1 was never a schema change.**
A schema applies to 72 entries; this needs 44 guards invoked differently than they are.

### WHAT SURPRISED ME

1. **⭐ I published a false claim and the reviewer caught it, not me.** I reported "9 of 9 invariant
   holds — meaningful evidence the approach works." The reviewer read the source: `admits` is not a
   general looked-count; **enforcing denials increment `denies` without touching it**. The relation
   holds only because that governor is currently observe-heavy. **The arithmetic was right and my
   conclusion about what it demonstrated was wrong** — and it was already committed AND already sent
   to the operator. Corrected in place with the correction left visible.

2. **⭐ The gaming did not die, it MOVED — into the shape this spec exists to kill.** v1's attack was
   inflation (borrow a positive counter). v3 kills that. v3's cheapest attack is **deflation**: report
   `wouldAct = 0` forever. The invariant holds (0 ≤ 0 ≤ looked), the row is consistent, the guard is
   useless — **and it is indistinguishable from a diligent guard in a quiet world.** That is the
   ambiguous zero, reappearing inside my own solution to the ambiguous zero.

3. **"Observability — you can't tune what you can't see" has NO resolvable guard.** The standard
   requiring visibility is itself unenforced, and it is the parent standard of this entire build item.

4. **The constitution contains a FALSE CLAIM.** "Cross-Store Coherence Is an Invariant" asserts a
   scheduled daily audit that walks a list; no such guard resolves. Same shape as CrashLoopPauser, one
   level up. The ratchet floor is `false-claims<=1` — set at the current value, so it is grandfathered.

5. **⭐ A keyword pass got the COUNT exactly right and the MEMBERSHIP mostly wrong.** My pre-pass
   returned 16 gaps — matching the authoritative total precisely — with **only 10 of 16 correct**. Had
   I reported the number without checking membership, the match would have read as corroboration.
   **A matching total validates nothing.** Third keyword failure of this audit.

6. **A dead draft sentence survived a rejection.** v3 removed the self-reported fallback; a sentence
   describing that fallback's "provenance field" survived in the status section. **That is how a
   rejected compromise creeps back** — not by being re-argued, but by being left in prose.

**Substrate accounting:** unchanged (~35 min laptop repo repair). Everything since mapped to
B0.1 / B0.2 / B0.5 / the coverage audit.

---

## 2026-08-05T04:57:32Z — pre-management-pass consolidation

**State:** 29 commits pushed + remote-verified, tree clean, 4 Codex lanes completed (all wrote files).
Status view published for the read.

**Delivered:** the Phase B tree (+ dependency re-analysis + 2 self-caught tree errors); B0.1 through
three design generations; B0.5 (harness) spec + ELI16, gate-clean after 5 rounds; B1.2's two-sided
verdict; the authoritative standards-coverage audit; ACT-1755 filed for the SELF-DRIVEN 26.

**Two operator decisions outstanding:** the 28-of-72 fork, and the three-rung amendment.

### WHAT SURPRISED ME (this block)

1. **⭐ The harness nearly became a liar, and an outside reader caught it.** Staging `writeAdmission`
   and observing a refusal would have recorded "writeAdmission catches" — but in dry-run
   `guardStoreWrite` returns `legacy` and falls through to the OLD standby guard. **A structurally
   inert guard would have been certified as working, by the instrument built to detect exactly that.**
   Attribution (`attributedTo`) is now required. This is the phase's signature defect — a passing
   condition narrower than what it certifies — appearing inside the fix for it.

2. **The gate refused my explanation and demanded a tracked commitment**, and the action registry then
   refused the filing without a follow-through choice. **Two independent structural gates, in series,
   both refusing a deferral I had written in good prose.** That is Close the Loop working exactly as
   designed, against me, twice in one minute.

3. **Every remaining tree remedy is a hypothesis.** Two of ~20 nodes have now been shown to prescribe
   fixes this project has since disproved (B1.4's closed-set) or to be mis-ordered (B0.1 vs B0.5). Both
   were found by cheap checks, not by planning. **Killing a bad node costs minutes; discovering it
   during implementation costs a session** — so validating node premises is the highest-leverage
   remaining work.

**Method note that paid off repeatedly tonight:** every lane was told to WRITE A FILE because the one
lane that merely reported lost everything. Four lanes since, four artifacts, zero losses.

---

## 2026-08-05T05:04:53Z — the synthesis, and the window's actual product

**33 commits.** Two operator decisions outstanding (the 28-of-72 fork; the three-rung amendment).

### ⭐ THE FINDING THAT REFRAMES THE PHASE

Setting every defect found tonight side by side, **they are one defect, seven times**: the passing
condition is narrower than what the result certifies.

12-char reason · raw `length>20` reason · `missing` on a standby · three-rung `effective` ·
borrowed counter paths · `enforcedRatio` counting ref-resolution · `/health` reporting a 6h window
as "now".

**Across four unrelated surfaces** — verification, alerting, classification, reporting. A defect
appearing independently in four places is not a series of mistakes; **it is the default failure mode of
how checks get built here**, because measuring the easy proxy is always cheaper than measuring the claim.

**Consequence for the tree: the remedy is a STANDARD plus a propagation, not seven patches.** All seven
would have been caught at authoring time by one question — *what input passes this check while failing
the claim?* — the B-case that already exists, eleven-fold, in one ratchet.

### The reframing I did not expect to reach

**The problem was never that Instar lacks guards.** A guard's passing condition is written by the same
person, in the same sitting, under the same assumptions as the guard — so **the check inherits the
author's blind spot by construction.**

Everything that worked tonight worked by breaking that coupling: an adversarial reader who did not write
the design; a control I had to run against my own search; a B-case asking what passes-while-failing.
**Not more care — a different producer.**

That is the identical conclusion the B0.1 seven-attempt arc reached, arrived at from a completely
different direction (the finding set rather than the design). **Two independent paths to the same
conclusion is the strongest evidence I have that it is correct.**

### Node-premise validation results
- B4.1, B4.2: **stale** — self-resolved, never fixed by anyone. New failure mode named: a node built
  from transient state manufactures work that does not exist.
- B2.1: **CONFIRMED LIVE** with a named second instance (`COHERENCE_MANIFEST_EXCLUSIONS`, weaker than
  the check that already failed us).
- Near-miss: nearly filed "the laptop's scheduler is dead" — it is correctly idle (Mini holds the
  lease). The control was checking whether it was *supposed* to run.

**4 of ~20 nodes wrong within hours of writing the tree.** Validating premises costs minutes; discovering
a bad node during implementation costs a session.
