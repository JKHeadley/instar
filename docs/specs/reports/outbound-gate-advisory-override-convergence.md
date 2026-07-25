# Convergence Report — Outbound gate advisory override

## ⚠ Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview (RAN — with an honest caveat below)

Both non-Claude families reviewed this spec, repeatedly and for real, through the
agent's own CLI logins. `codex-cli:gpt-5.5` returned a verdict on **every one of
33 rounds**. `gemini-cli:gemini-3.1-pro-preview` returned on 25 of 33 and timed
out on the rest, recorded per round rather than glossed. Three of gemini's
verdicts were **CLEAN**.

**The caveat that matters, stated up front: this review did NOT reach a
zero-finding round.** `codex-cli` never once returned CLEAN across 33 rounds. The
strict convergence criterion — a full round producing no material findings — was
not met, and **no `review-convergence` tag has been written**. What follows is the
evidence for a judgement the operator makes, not a pass the agent awarded itself.

**A second caveat about the internal reviewers.** The six internal perspectives
(security, scalability, adversarial, integration, decision-completeness,
lessons-aware) ran **sequentially on the authoring session**, not as six
independent parallel agents, because of a standing instruction not to spawn
sub-agents unasked. That is weaker than the process intends — an author checking
their own work from six angles shares the author's blind spots. The two external
families and the code-backed standards gate are the genuinely independent checks,
and they did the heavy lifting: essentially every structural change below came
from them.

**A third, discovered during the review: the Standards-Conformance Gate is
non-deterministic.** Run four times on an identical document it returned 0, 1, 1
and 2 findings, once flagging a missing migration path immediately after one was
added. It is an LLM check with real variance, and it was used accordingly from
round 22 on — a finding acted on when it recurred, not because a single run
produced it. Treating a noisy signal as authoritative is precisely the failure
this spec is about.

## ELI10 Overview

Every message the agent sends the operator passes a final check: a model reads
the draft and decides whether it goes out. Today that check has the last word —
when it refuses, the message dies and the operator never learns it existed.

Two problems. The obvious one: the check is sometimes wrong, and a wrong refusal
is indistinguishable from the agent having nothing to say. The load-bearing one:
a hard refusal leaves **nothing to observe**, so the system that records these
decisions for later grading has recorded ~1,400 of them and graded exactly zero
right or wrong. The data the whole grading effort depends on cannot exist while
the check is a wall.

This spec turns the check's verdict into a **nudge**. When it objects, the
message comes back to the agent, which either rewrites it or sends it anyway with
a written reason. Every such override becomes a recorded disagreement — the
message, the check's objection, the agent's rebuttal — which is exactly the
material a stronger model can grade later, unhurried, in bulk.

One thing stays absolute: if a message contains a credential this machine
actually holds, it is refused with no override. Not anything *shaped* like a
credential — that distinction took three separate narrowings to get right.

## Original vs Converged

**The wall shrank three times, and each time for the same reason.** v1 refused
anything matching a credential *pattern*. But `your api key is not configured
yet` matches those patterns, and so does a sentence explaining what a GitHub
token looks like. Under v1 those messages would have been refused permanently,
unappealably, and the operator would have seen silence. The final wall is one
thing: an exact match against a credential this install holds.

**A safety brake that could only tighten.** The design had: if the agent
overrides a rule too often without evidence it was right, that rule reverts to
absolute. Sensible — except the evidence system that clears the brake does not
exist yet, so it could only ratchet closed, quietly walling everything back up
while appearing to work.

**Six times, in six different places, the design created a stop nobody could
answer** — the exact thing it exists to remove. Each was fixed as it was found,
which guaranteed a seventh. It is now a written rule with the sender-policy
exception stated explicitly.

**Roughly a third of what was designed survived, and the deletions were the best
rounds.** An elaborate scheme for matching credentials without holding them in
memory protected a door that was already open — the process holds several
credentials in plaintext regardless. A queue for holding messages during a
reviewer outage turned out to be a workflow engine reinvented under another name.
A separate reason store turned out to be a second model for one fact. All three
were deleted.

**The operator's own contribution changed the shape of the thing.** Mid-review he
pointed out that the record being collected omitted the conversation the model
was actually shown — keeping only how *many* recent messages there were. Without
it, a later judge would systematically side with the check on exactly the cases
worth catching. That gap cannot be backfilled, so it now ships in the same
change.

## Iteration Summary

| Round | Standards gate | codex-cli:gpt-5.5 | gemini-cli | Material findings | Headline |
|---|---|---|---|---|---|
| 1 | ran (2 violations) | heavy findings | degraded (timeout) | 25 | v1→v2 structural |
| 2 | 1 possible-violation | MINOR (5) | MINOR (4) | 15 | pattern arm tiered |
| 3 | 0 | MINOR (5) | **CLEAN** | 6 | operator's capture finding |
| 4 | 0 | **SERIOUS** (5) | MINOR (3) | 8 | cap fails closed |
| 5 | 0 | MINOR (4) | degraded (timeout) | 4 | dual anchors |
| 6 | 0 | **SERIOUS** (5) | MINOR (3) | 8 | phased table |
| 7 | 1 possible-violation | MINOR (4) | not returned | 5 | url-cred → nudge |
| 8 | 0 | **SERIOUS** (5) | MINOR | 5 | two-PR sequencing |
| 9 | 0 | MINOR (5) | degraded (timeout) | 6 | + structural gate defect found by hand |
| 10 | 0 | **SERIOUS** (4) | MINOR | 4 | **10-round cap reached — not clean** |
| 11 | 1 → 0 after fix | MINOR (4) | degraded (timeout) | 5 | wall narrowed to possession |
| 12 | 1 → 0 after fix | MINOR (5) | MINOR | 5 | stage matrix |
| 13 | 0 | MINOR (5) | **CLEAN** | 5 | B23 observe-only at Stage 0 |
| 14 | 0 | **SERIOUS** (4) | degraded | 4 | hold only where recourse |
| 15 | 0 | MINOR (4) | degraded (timeout) | 4 | + consistency sweep (4th instance) |
| 16 | 0 | **SERIOUS** (5) | MINOR | 5 | fingerprint index DELETED |
| 17 | 2 possible-violations | **SERIOUS** (4) | MINOR | 6 | degraded-floor carve-out retired |
| 18 | 0 | **SERIOUS** (5) | pending | 5 | all five were drift |
| 19 | 0 | MINOR (4) | **CLEAN** | 4 | + hand-check found 3 more |
| 20 | 1 → 0 after fix | MINOR (4) | **CLEAN** | 5 | standards tension resolved |
| 21 | 0 | MINOR (4) | degraded | 3 | sender-class policy |
| 22 | 0/1/1/2 (variance measured) | **SERIOUS** (4) | MINOR | 4 | write-ahead record |
| 23 | 0 | **SERIOUS** (4) | **SERIOUS** (complexity) | 4 | + hand-check found 3 |
| 24 | 0 | **SERIOUS** (4) | MINOR | 4 | B23 rule corrected |
| 25 | 0 | **SERIOUS** (5) | **SERIOUS** (complexity) | 5 | deferral queue DELETED |
| 26 | 0 | **SERIOUS** (4) | degraded | 4 | all four were drift |
| 27 | 0/1 (variance) | **SERIOUS** (5) | MINOR | 4 | reason-store fail-closed |
| 28 | 0 | **SERIOUS** (4) | MINOR | 4 | partition derived from table |
| 29 | 0/1/1 (variance) | MINOR (5) | MINOR | 5 | **first round with no contradictions** |
| 30 | 0 | **SERIOUS** (4) | MINOR | 4 | event log; index → config-only |
| 31 | 0 | MINOR (4) | pending | 4 | all four drift; all four *removed* design |
| 32 | 0 | **SERIOUS** (3) | MINOR | 3 | all three drift; one schema, one enum |
| 33 | 0 | MINOR (4) | MINOR | 4 | two drift, two precision — **cycle stopped here** |

*(Standards-gate counts from round 22 on are multi-run: the gate's measured
variance is reported rather than a single sample.)*

## Full Findings Catalog

**182 numbered findings** across 33 rounds are recorded in full, with resolution
and attribution, in the spec's own change logs (§§12–46) — one section per round.
That placement is deliberate: they are the record of *why* each decision is what
it is, and several rounds **reversed** an earlier answer, which a summary would
flatten. The generated implementation contract strips them so an implementer
cannot follow a retired design by accident.

Ten that changed the design most:

| # | Finding | Outcome |
|---|---|---|
| 26 | The pattern arm held unappealable authority on brittle signals — raised independently by the standards gate, codex, and the internal security pass | Wall tiered, then narrowed to possession only (#87) |
| 41 | **Operator finding:** the record omits the conversation the model was shown | Judgeable-record completeness contract; ships in the same change |
| 47 | The verification cap made the spec's own "not security-bearing" claim false | Fail-closed cap; later deleted with the whole scheme |
| 55 | A public key prefix could flood the cap and hold messages containing no credential | Dual anchors; later deleted with the scheme |
| 98 | Stage 0's terminal B23 recreated the pattern the spec removes | Observe-only until recourse exists |
| 111 | The custom matcher protected a property that was already false | Fingerprint index deleted; replaced by substring matching |
| 138 | The override bargain could be silently broken — authority granted, evidence lost | Write-ahead record, later an event log |
| 155 | Hold-and-re-review was a workflow engine under another name | Queue deleted; the agent retries |
| 175 | The corpus could record an override as delivered when nothing left the machine | Explicit `authorized` / `sent` / `egress-refused` / `send-failed` states |
| 177 | The in-process index still expanded blast radius | PR-A indexes only already-resident config credentials — zero added plaintext residency |

## Convergence verdict

**Did not formally converge.** Thirty-one rounds; the strict criterion (a round
with zero material findings) was never met, and the `review-convergence` tag has
deliberately **not** been written.

What the evidence shows instead, stated plainly so the operator can weigh it:

- **The design is settled.** No reviewer has proposed a different design since
  round 22. Round 29 was the first round in which neither external reviewer found
  a contradiction or objected to the design; round 31's four findings were all
  drift introduced by round 30's fold.
- **The residual findings are of one kind.** Late rounds find (a) inconsistencies
  created by the previous fold, and (b) refinements — "state the threshold you
  already implied". Both are real; neither says the design is wrong.
- **The document, not the design, is what fails to converge.** A 2,700-line spec
  cannot be kept self-consistent by care — 31 rounds of care did not do it. Two
  structural answers are now required deliverables: a **spec lint** that fails the
  build when any decision or test assertion contradicts the normative table, and
  a **generated implementation contract** that strips the review history an
  implementer could otherwise follow by accident.
- **One standards-gate finding recurs and is unresolved by design.** *No Silent
  Degradation to Brittle Fallback* fires on roughly two runs in three, because
  the degraded fallback can still deliver via a recorded override. The opposing
  standard (*Signal vs. Authority*) fires if it cannot. The tension is documented
  with the operator's existing fail-closed lever named; it is a genuine conflict
  between two standards, not an unfixed defect.

**Why the cycle stopped at 33 rather than at zero findings.** Rounds 31, 32 and
33 produced *only* two things: inconsistencies introduced by the immediately
preceding fold, and precision adds ("state the threshold you already implied").
Each fold of a 2,700-line document reliably creates about three new
inconsistencies elsewhere in it. That is not a design converging slowly; it is a
document too large to keep consistent by hand, and 33 rounds is fairly
conclusive evidence. The answer is the spec lint and the generated contract —
both now required deliverables — not a 34th hand-folded round.

**What the operator is being asked to decide:** whether 33 rounds of review, a
settled design, and two structural anti-drift guarantees are sufficient to
proceed to implementation — knowing that one reviewer'sresidual findings are precise
consistency work rather than a clean bill of health. Approving is a real
decision. Declining and asking for further rounds is equally reasonable, and the
loop can continue.


---

## Addendum — 2026-07-25: the diagnosis in this report was incomplete

This report attributed the failure to converge to **document size and accumulated
history**. A test run today says that is at most half the story.

**What was tested.** The spec was reduced to a strict implementation contract —
2,765 lines to 290, history and rationale removed — and reviewed independently.

**Result 1: the size hypothesis is unproven, and the evidence I first cited for it
was wrong.** `gemini-cli` timed out on the 290-line contract exactly as it had on
the full spec. A single timeout at 2,032 lines had earlier been offered as
evidence that size was the blocker; the same timeout at 290 lines shows it is the
reviewer, not the length. That inference should not have been drawn from one
failure.

**Result 2: the design has real open findings, not just document problems.**
`codex-cli:gpt-5.5` returned **SERIOUS ISSUES** on the short contract, and the
substantive ones are not about readability:

| Finding | Why it matters |
|---|---|
| **Hand-rolled credential-shape detection** | Gitleaks, TruffleHog, detect-secrets and Semgrep rule packs exist. The spec never justifies preferring its own pattern set over an established detector with suppression/override semantics. |
| **The live credential index is the highest-risk element** | Normalized plaintext secret material held in-process for matching, with no stated memory lifetime, zeroization, or crash/log exclusion. The reviewer asks whether matching could use handles, an isolated helper, or streaming comparison instead. |
| **Relay double-check is fragile** | Composing machine checks A's credentials, adapter checks B's — the failure mode is each side believing the other checked. Needs telemetry proving both scopes ran, or recording which was unavailable. |
| **"No open questions" is not credible** | Stage 3 depends on ACT-1198, Slack parity is deferred, several limits are in-scope-but-unhandled. |

**Corrected conclusion.** The document was genuinely hard to review, and fixing
that was worth doing — but it was masking substantive design questions rather
than being the whole problem. Anyone deciding on this spec should weigh the
credential-index and hand-rolled-detection findings above, which no amount of
document restructuring addresses.

**Also learned about the tooling used for this test:** the strict contract
*dropped the spec's normative outcome table*, and the reviewer's first finding was
"normative behavior is missing." The 290-line artifact was therefore not
sufficient to build from. A capture-ratio warning now flags that (8/66 sections,
12%). Findings 2-6 above stand regardless — they concern content that *was*
present.


## Reviewer-availability caveat (2026-07-25)

**The gemini-cli arm has been failing since round 35.** It returned
`status: degraded, reason: timeout` on every subsequent attempt, including a
control test against a ~6KB document — so this is a broken reviewer, not a
size limit. Logged as a framework issue.

Consequence for reading any round after 35: **there was no second family.**
Findings from those rounds come from `codex-cli:gpt-5.5` alone. Where this report
says "both families independently", that claim applies only to rounds 34-35 and
earlier, and was checked before being written.
