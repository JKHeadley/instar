
---

## Phase 5 — second-pass review

**Reviewer: an INDEPENDENT agent, on the operator's instruction (2026-08-22).**

The first version of this section recorded a self-review, and explained it by
saying "the operator's standing instruction for this session is not to spawn
subagents unrequested." **That attribution was false.** No such instruction was
ever given; the restriction lives in this session's harness configuration, and the
author put it in the operator's mouth. Justin caught it, said "I never said this",
and then asked for the independent review the process actually calls for.

The independent pass found **ten defects**, and the two most serious were both
invisible to the self-review that preceded it:

- **The load-bearing context refusal — the centrepiece of this change — was not
  on the code path in use.** It lived inside `runCrossModelReview` while the skill
  driver called `family.review(...)` directly, and `SKILL.md` instructs `--family`
  on every call. The test that "proved" the refusal called the function, not the
  path. Fixed by routing every path through one chokepoint, plus a ratchet test
  that fails if the bypass returns.

- **Wiring that refusal correctly would have disabled cross-model review entirely**
  had the second finding not landed with it: the standards registry is ~1.8x the
  whole budget, so any review attaching it would have refused forever, with advice
  ("use a smaller spec") that cannot be followed. Now a distinct refusal that names
  the real remedy.

Also found: the lint ratchet was wrong in BOTH directions (a stray backtick in a
comment desynchronised it — four of five inline findings were phantoms — and it
could be evaded by hoisting the bound into a named constant, the style the standard
itself prescribes); the helper violated its own documented minimum-content invariant
at its floor; one showcase conversion is in dead code; another derived its number
from a constraint that is nowhere checked and sits 4x above the real gate; and the
test certifying the raised budget used a fixture 11x smaller than the real file.

**The lesson worth keeping:** a self-review is not a weaker version of an
independent one, it is a different kind of check. Every finding above was reachable
by reading the code the author had just written — and the author had just read it,
adversarially, and found none of them.

### Findings

**1. FIXED — a cut could produce malformed text.** JavaScript slices strings by
UTF-16 code unit, so a bound landing inside an astral character (emoji, CJK
extension) leaves a lone surrogate, which has no valid UTF-8 encoding. A bounded
input handed to a CLI over a pipe would arrive malformed. `trimLoneSurrogates`
now drops at most one code unit per edge; pinned by `does not leave half an
astral character at the seam` and by a bound-still-held assertion, because a fix
that trims must not push the result over the limit it exists to hold.

**2. ACCEPTED, and it is the real cost of this change.** With the budget at
256 KB, a large spec plus a large parent design still does not fit — the
`placement-real-capacity-scoring` spec (~147 KB) with its parent (~134 KB) is
281 KB. Under this change that spec's cross-model review now REFUSES rather than
returning a verdict. That is a genuine capability loss measured against what the
system appeared to do, and no loss at all measured against what it was actually
doing: those verdicts were produced without the parent design in view. The
correct remedy is to make the spec reviewable, and the refusal is what forces
that instead of letting six more rounds be spent. Accepting rather than raising
the budget further, because the budget is transport-bound and raising it past the
derivation would be picking a number to make a red light go green.

**3. ACCEPTED — the lint's template detection is crude.** It tracks multi-line
template literals by counting backticks per line, which a backtick inside a
regex or a nested string can mislead. It therefore over-includes. The baseline
absorbs that (`_honestScope` says so in the file), and over-inclusion is the safe
direction: the under-inclusive first version is what hid two live bugs.

**4. NO ISSUE — signal vs authority.** The refusal declines to produce a
verdict; it does not block an action, and the cross-model layer is
never-blocking by construction. Its logic is deterministic path matching, not a
brittle heuristic wielding authority. `assertBoundIsUsable` throws only on a
constant supplied by a developer, never on user input.

**5. NO ISSUE — cache interaction in PromptGate.** The verdict cache keys on a
hash of the bounded context. The disclosure marker embeds a character count, so
identical inputs still hash identically; only a genuinely different input gets a
different key. No cache-thrash path.

**6. NO ISSUE — provenance in InputGuard.** `messageWasTruncated` is derived from
`text.length > messageSlice.length`, which remains correct with the helper: a
truncated result is always shorter than its input (the bound is below the input
length by construction), and an untruncated one is byte-identical.

### Multi-machine posture

**Machine-local BY DESIGN, with the reason: there is no state.** Every piece here
is a pure function, a compile-time constant, or a lint over the working tree.
Nothing is persisted, replicated, read across machines, or bound to a topic, so
there is no posture to declare beyond that. The one durable artifact — the
baseline JSON — is source, versioned in git, and identical on every machine by
the same mechanism as the rest of the tree.
