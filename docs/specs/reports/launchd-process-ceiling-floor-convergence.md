# Convergence Report — Launchd Process Ceiling

## ⚠ Cross-model review: codex-cli:gpt-5.5 — RAN every round (10/10)

A real GPT-tier external pass ran through the agent's own codex CLI on all ten rounds. The
⚠ above is not about the external pass, which is the clean state; it flags the verdict
below.

## Convergence verdict: **NOT CONVERGED — hit the 10-iteration cap**

The stated criterion is *no DESIGN-class findings for two consecutive rounds*. That was never
reached. Round 10 still produced two design-class findings (both fixed), and the skill's hard
cap fired.

Per `/spec-converge`, a cap-out requires human input before retry. **It is not a passing
grade and no convergence tag has been written.** What follows is the honest account of what
the ten rounds actually produced, so the decision can be made on evidence rather than on a
status word.

### What the cap actually caught here

The cap exists to surface *"this design is too confused to review."* That is **not** what
happened, and saying so is not special pleading — it is checkable against the reviewer's own
words:

- Rounds 3, 4, 5, 7, 8, 9 and 10 each closed with an explicit **"No serious architectural
  objection"**, and round 10 added *"the design is clear and appropriately narrows the belt's
  role. The main residual risk is not conceptual."*
- The verdict moved SERIOUS → MINOR after round 1 and stayed there, apart from round 5, where
  the "serious" label was applied to an internal contradiction (an acceptance criterion left
  stale by a round-4 design change), not to the design.
- Every round's findings were smaller than the last, and most were about the growing
  DOCUMENT rather than the change.

This is the failure mode `/spec-converge`'s own criterion documents: *"on a spec that appends
its own review history, the reviewable surface grows every round, and a diligent reviewer will
always find precision to add on a larger surface."* By round 8 the spec had grown past the
reviewer's input budget and began **truncating** — the review history was moved into this
report to fix that, which is the mitigation the criterion's own text implies.

### But the rounds were not wasted, and that is the honest counterweight

Ten rounds on a one-integer change looks disproportionate. It found six things that would
otherwise have shipped, four of which changed CODE, not prose:

1. **A false claim in the justification** (round 1) — "still catches the June runaway" was
   arithmetically wrong (~730-839 total against a 2048 ceiling). It had already been written
   into the commit message, the release notes, and the PR description.
2. **The plist is a symbol, not the state** (round 1) — a migrated machine keeps crashing
   under the old ceiling until it restarts, and nothing said so. This is the exact 2026-08-19
   incident. → `ProcessCeilingCheck` built.
3. **The check was silent on the worst case** (round 2) — a machine whose migration NEVER ran
   got no notice at all, and would have been told to "restart", which would not have helped.
   → `repair` state.
4. **A safe machine could restart into the unsafe state silently** (round 5) → `future-repair`
   state.
5. **A setup re-run would have clobbered an operator's raised ceiling** (round 7) — the
   migration was raise-only but `installAutoStart` REGENERATES the plist, so the "your change
   sticks" contract written in round 4 was false as implemented. → `preserveHigherProcessCeiling`.
6. **A machine-id collision could swallow a HIGH notice for a crashing machine** (round 10) —
   waved through in round 9 as "no worse than elsewhere", correctly rejected. → host
   fingerprint mixed into the dedupe key.

Findings 2-6 are failure modes of the fix itself. None came from the internal review or from
the author.

## ELI10 Overview

Every computer limits how many programs one user account can run at once. Instar sets that
limit deliberately, as a last-resort brake in case something of its own runs away. The number
chosen was 512 — reasonable if you count only instar's own helpers, but the operating system
counts *everything* the logged-in person runs: the desktop, the browser, the editor. An
ordinary Mac idles at 500-550. So the brake was already clamped before instar started
anything.

The result was not a caught runaway. It was an idle machine where commands were refused at
random for hours, and eventually the agent's own server died outright. A safety limit that
trips at rest protects nothing; it converts idle into an outage.

The fix raises the number to 2048 and corrects it on machines that already have instar, not
just new ones. What review added is the part that matters more: the corrected number only
takes effect after a restart, and until this change nothing told anyone that. On the machine
where this was found, the only reason it got restarted is that the agent asked a human by
hand. Two other machines would have had no such prompt. Now each machine notices its own
state and says one of three things: *needs a restart*, *needs looking at because a restart
won't help*, or *fine now, but a restart may lose that*.

## Original vs Converged

**Originally** this was a one-integer change plus a migration, justified partly by a claim
that turned out to be false, and it treated the corrected file on disk as if it were the
corrected machine.

**After review** the claim is withdrawn with the arithmetic shown; the belt is renamed for
what it actually does (a fork-exhaustion backstop, not a memory blast-radius control, and not
the thing that catches the June incident — the spawn cap owns that); and the change now reads
the *live* limit rather than trusting the file, reporting three distinct conditions with three
distinct actions. Both write paths — the migration and setup — are raise-only, so an
operator's own raise survives. Where the evidence is partial, the notice says so: an
unreadable plist yields "a restart **may** lose this", never a predicted drop. Where the
evidence is absent, nothing is claimed at all — but on macOS it is always logged, so a
reader that broke could not silently disable the whole check.

The known gap is stated rather than hidden: the check verifies the LIMIT, not the HEADROOM.
A machine at 1900 of 2048 reports fine. Measuring headroom needs to count processes, which
needs to spawn one — the exact thing that fails when the limit is exhausted — so a check built
that way would go quiet precisely when it mattered. That is registered as CMT-015 and made
blocking on any future change to this ceiling.

## Iteration Summary

| Round | Standards gate | Cross-model verdict | Design-class | Precision | Code changed |
|---|---|---|---|---|---|
| 1 | ran (2 flags) | SERIOUS ISSUES | 5 | 0 | — |
| 2 | ran (1 flag) | MINOR ISSUES | 4 | 1 | `ProcessCeilingCheck` + boot wiring |
| 3 | ran (0 flags) | MINOR ISSUES | 3 | 2 | `repair` state |
| 4 | — | MINOR ISSUES | 3 | 1 | — |
| 5 | — | SERIOUS ISSUES | 3 | 1 | `future-repair` state |
| 6 | — | MINOR ISSUES | 3 | 1 | — |
| 7 | — | MINOR ISSUES | 3 | 2 | `preserveHigherProcessCeiling`, `unknown` logging |
| 8 | — | MINOR ISSUES | 2 | 2 | notice wording |
| 9 | — | MINOR ISSUES | 3 | 2 | 7 plist-form tests |
| 10 | — | MINOR ISSUES | 2 | 2 | host fingerprint in dedupe key |

Standards-Conformance Gate reached **0 findings at round 3** and stayed there. The
cross-model pass ran successfully on all 10 rounds (`status: ok`, never degraded).

**Per-round model disclosure:** internal reviewer perspectives were carried by the authoring
session (opus) rather than by spawned subagents — this session runs under an operator
instruction not to spawn agents without a request. That is a real reduction in independence
versus the skill's design and is recorded here rather than glossed: the genuinely independent
reads in this convergence were the cross-model codex pass and the code-backed Standards
gate, both of which ran every applicable round and produced every finding listed above.

## Full Findings Catalog

Round-by-round findings and their resolutions are recorded in the spec's own history through
round 7 and summarised in "But the rounds were not wasted" above. In brief, by class:

**Design-class, resolved in code (6):** the false blast-radius claim; symbol-vs-state; the
missing `repair` state; the missing `future-repair` state; the setup clobber path; the
machine-id collision.

**Design-class, resolved in the document (11):** outbound collateral overstated; the operator
escape path had no contract; "clears every plausible desktop floor" unfounded; the belt
described in blast-radius language; acceptance criterion 9 contradicting the design; the
decision-point row stale at four states; plist-read failures blurred; `future-repair`
overclaiming certainty (twice, in text then in a table); the supported-host envelope unstated;
a superseded review-history line still reading as current.

**Precision-class (14):** naming (`FLOOR` overstating a measured bound), terminology density,
dedupe-by-action-not-cause, the "order of magnitude" arithmetic, and similar.

## What the reader has to decide

Two options, and the choice is genuinely open:

1. **Approve at the cap.** Accept the spec as it stands, on the evidence that the standards
   gate is clean, the external reviewer records no architectural objection, all six code-level
   findings are fixed, and the remaining findings are precision on a document that has already
   been trimmed once for length. The crash this fixes is live on two machines today.
2. **Require another convergence attempt.** The criterion says two clean rounds and that was
   not achieved. Retrying is legitimate — but on the evidence above the most likely outcome is
   two to three more rounds of document precision, while the machines stay unfixed.

The recommendation is (1), and the reason it is offered as a decision rather than taken
unilaterally is that the cap is exactly the point where the skill hands the judgement to a
human. No convergence tag will be written without that answer.

## Operator decision

**Approved at the cap by Justin (verified operator, topic 48000) on 2026-08-19**, after
being handed this report and the plain-English overview.

To be precise about what that approval is and is not: it is option (1) above — an informed
decision to ship on the evidence, made by the person the cap defers to. It is **not** a
retroactive claim that the two-clean-rounds criterion was met. It was not. This spec carries
`review-iterations: 10` and a verdict of NOT CONVERGED, and the `approved: true` tag records
an operator override of an unmet criterion rather than a passing grade.

That distinction is kept deliberately, because the alternative — quietly stamping
convergence because a human said yes — would make the criterion unfalsifiable, and a
criterion that can be satisfied by approval is not a criterion.
## Review history

**Round 1** — Standards-Conformance Gate: 2 possible-violations (*No Manual Work*;
*Verify the State, Not Its Symbol*), both on the same gap: the spec treated the on-disk
plist as progress while the live enforced limit could still be unsafe.
Cross-model (codex-cli:gpt-5.5): SERIOUS ISSUES, 5 findings.

Design-class findings and their resolutions:

1. **"Still caught by 2048" is arithmetically false.** ~230-289 spawns on a ~500-550 floor
   totals ~730-839, below 2048. → Claim WITHDRAWN in §1 with the arithmetic shown; the
   belt's scope restated honestly; the spawn cap named as the control that owns that class.
   Also corrected in the commit message, the release fragment, and the PR description,
   since the false claim had already been written into all three.
2. **2048 may be too high to bound the real blast radius (memory).** → Accepted and stated:
   at ~400MB per subprocess this belt cannot be an OOM control at any value that also
   clears the idle floor. Documented rather than papered over.
3. **A static ceiling ignores host variability.** → Install-time dynamic sizing considered
   and REJECTED with reasons (single sample of a varying quantity; unpredictable across the
   fleet; the quantity that matters is unobservable at decision time). Residual risk routed
   to the §3 runtime check.
4. **Delayed activation leaves the outage class alive.** → §3 added: read the EFFECTIVE
   `RLIMIT_NPROC` at boot and raise one deduped Attention item when a machine is still
   running the old ceiling. This is also the resolution of both conformance findings.
5. **Acceptance criteria never check the source of truth.** → Criteria 7-9 added, including
   verification against a process actually started by launchd under the plist.

**Round 2** — Standards-Conformance Gate: round-1 findings RESOLVED; 1 new
possible-violation (*Bounded Notification Surface* — a per-machine notice scales with
machine count). Cross-model (codex-cli:gpt-5.5): MINOR ISSUES, 5 findings (down from
SERIOUS ISSUES / 5).

Design-class findings and their resolutions:

1. **The boot check was too narrow.** It notified only on "plist fixed, process not
   restarted", and stayed SILENT on "plist never fixed" — a machine crashing on this exact
   bug with nobody told, and one where a restart would be wrong advice. → A second verdict
   state `repair` added, with its own dedupe key and its own text that explicitly says a
   restart will not fix it. Code + tests changed, not just the document.
2. **"Clears every plausible desktop floor" was unfounded.** → Claim WITHDRAWN. Restated as
   what is actually known (clears the ~500-550 floor OBSERVED on this fleet), with the
   heavy-developer-desktop case named as unproven, and the residual risk routed to the
   runtime reading rather than to an assertion.
3. **The belt is not job-local, and that cuts both ways.** → Stated explicitly: unrelated
   user workload consumes the same per-UID budget (instar can be starved by processes it
   does not own), and an instar runaway can cause collateral fork failures elsewhere. Also
   recorded WHY no better primitive is used: macOS has no per-job process-tree cap reachable
   from a launchd plist.
4. **Acceptance criterion 7 was operationally vague.** "Verified against a launchd-started
   process" without naming a harness would let the criterion be claimed without being met. →
   The honest coverage is now written out: verified against the OS report for the running
   process (a real launchd-descended value on an installed darwin host), NOT via a
   purpose-built temporary launchd job — which is macOS-only, installs a real user-level job
   as a test side effect, and cannot run on ubuntu CI. No claim is made that CI exercises
   the launchd job.

Precision findings addressed: the *Bounded Notification Surface* concern (the per-machine
notice's three bounds, and why a cross-machine summary was rejected — the machine most
likely to be affected is the one most likely to be down and omitted from it), and one-line
definitions for the local terms (`unified`, `machine-local`, one-voice gating, Attention
item) where they first affect behaviour.

**Round 3** — Standards-Conformance Gate: **0 findings** (the round-2 notification concern
resolved). Cross-model (codex-cli:gpt-5.5): MINOR ISSUES, 5 findings, explicitly recording
*"No serious architectural objection"*.

Design-class findings and their resolutions:

1. **The check verifies the LIMIT but not live HEADROOM** (raised twice, as findings 1 and
   2). The incident was 531 processes against 512; a machine at 1900 of 2048 is about to
   fail and this check reports `ok`. → Stated explicitly rather than hidden, WITH the reason
   it is not simply added: counting the UID's processes requires spawning one, which is the
   exact operation refused when the limit is exhausted — so a headroom check built that way
   returns nothing precisely when it matters and reassuring silence otherwise, which is
   worse than none because it would be believed. A non-forking count needs a native binding
   instar does not have; registered as CMT-015 rather than smuggled in.
2. **Plist parsing was underspecified for malformed / duplicate / partial / variant
   forms.** → Every form enumerated, along with the failure behaviour (no match ⇒ no
   rewrite; parsed-low-but-rewrote-nothing ⇒ error, never success). Records why a
   `plutil` parse-and-regenerate was REJECTED: it would normalise the whole file and
   silently discard an operator's hand-added keys, whereas a pattern that fails to match is
   a visible no-op. For a raise-only migration the surgical approach fails in the safe
   direction.
3. **Plist-read failure was blurred with "plist below floor".** → A second table enumerates
   every combination of readable/unreadable effective reading against readable/unreadable
   plist, with the reasoning for each verdict. *(SUPERSEDED IN ROUND 5: this round concluded
   that a demonstrably-safe machine with an unreadable plist stays `ok`. Round 5 overturned
   that — it now yields `future-repair`, because the restart that makes it unsafe is
   routine. The current behaviour is the §3 table, not this line.)*

Precision finding noted, not actioned: governance terminology occupies substantial space
relative to the mechanism. Kept as-is — the local standards are what a reviewer inside this
project checks the spec against, and the one-line definitions added in round 2 already serve
the external reader.

**Round 4** — Cross-model: MINOR ISSUES, 4 findings. Design-class: the outbound-collateral
claim overstated the coupling (instar's ceiling does not cap other apps — each inherits its
own; the shared quantity is the COUNT) → corrected; the operator escape path had no stated
contract → written out as four properties that make an operator's raise stick; the headroom
residual risk was "registered" with no owner or priority → both named.

**Round 5** — Cross-model: SERIOUS ISSUES, 4 findings, but the seriousness was internal
inconsistency rather than architecture. Design-class: a machine SAFE now with a bad plist
was reported as `ok`, so a routine restart would drop it into the unsafe state silently →
`future-repair` state added (code + tests), at NORMAL priority because nothing is broken
yet; the belt was still described in blast-radius language → renamed to what it is, a UID
fork-exhaustion backstop, with memory blast radius explicitly recorded as uncovered at this
layer; the plist-parsing rejection overstated its case → narrowed, with XML DOM targeted
replacement acknowledged as a legitimate alternative and the actual reasons for not using it
given; CMT-015 made blocking on any future ceiling change rather than merely registered.

**Round 6** — Cross-model: MINOR ISSUES, 4 findings. Design-class: acceptance criterion 9
CONTRADICTED the §3 verdict table (it still said "nothing when effective is at or above the
floor", written before `future-repair` existed) — an implementation could have passed
acceptance while omitting required behaviour → criterion 9 rewritten as the same table, row
for row; the decision-point row still described four states → corrected to five; the
operator escape path's absence from the notices was unexplained → stated as a deliberate
choice with its reason (plist surgery is the wrong first response for the readers who see
those notices); 2048's provisional status moved to the top of §1 rather than buried.

**Round 7** — Cross-model: MINOR ISSUES, 5 findings. Design-class: **a setup re-run would
have clobbered an operator's raised ceiling** — the migration was raise-only but
`installAutoStart` regenerates the plist, so the "your change sticks" contract written in
round 4 was false as implemented → `preserveHigherProcessCeiling` added (code + 6 tests),
acceptance criterion 1b added; `unknown` had no required observability, so a reader that
broke on darwin would disable the check fleet-wide while satisfying its no-item contract →
`unknown` on darwin is now always logged with its reason; the round-3 review-history entry
had been overturned by round 5 and still read as current → marked superseded, since the
review history is what a later reader relies on. Precision: "single input" imprecise for a
two-input cross-product; "an order of magnitude below 10666" is nearer a fifth.
