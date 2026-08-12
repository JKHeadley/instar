# Window 13 — the review series did NOT converge, and here is the honest shape of it

Every figure below was derived by command at the moment of writing. That sentence is not decoration: this
window caught three of its own published counts having gone stale between being measured and being quoted,
and the habit of re-deriving is the only reason most of its real findings surfaced at all.

## The endpoint that was asked for, and what actually happened

The charter asked for **an honest clean review pair** — two consecutive readings returning zero new
load-bearing findings — **and a merge**.

**The clean pair did not arrive.** Readings 48 through 53 returned 3, 3, 1, 2, 2, 1 new findings. There is
no consecutive zero, so there is no pair, and this document says so in its first section rather than its
last.

## But the raw count is the wrong instrument, and saying only "not converged" would mislead

Split by KIND, the same nine readings look completely different:

| pass | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 |
|------|----|----|----|----|----|----|----|----|----|
| DESIGN | 4 | 6 | 3 | 2 | 1 | **0** | **0** | **0** | **0** |
| PRECISION | 1 | 0 | 3 | 1 | 2 | 1 | 2 | 2 | 1 |

**Design findings ran to zero and stayed there for four consecutive readings.** What continues is
precision: claims that overstate what the code does, and matchers drawn slightly too wide. Those still
matter — a precision defect here can still be a leak — but "the design is wrong" and "this sentence
overstates what the check performs" are different classes, and the first class has been empty since
pass 50.

Pass 53's own first sentence: *"No fresh runtime bypass outside the already named rich-source
reduction/root was found in this pass."*

I would have reported "not converging" from the totals alone. That would have been accurate about the
number and wrong about the substance. The composition is only visible because the series was derived from
the archived verdicts rather than recalled.

**Both readings are stated here deliberately.** Reporting only the count is accurate and misleading;
reporting only the composition is flattering. Neither alone is the truth.

## The one root under the remaining findings

Every finding from pass 48 onward landed in the same place — the rich-message SOURCE reduction — and every
one was the same shape: the reduction counts bytes as content that Telegram treats as markup or does not
render. A formula's LaTeX source. A media id mentioned rather than embedded, then matched as a prefix. An
HTML tag inside a Markdown source. A tag whose quoted attribute contains an angle bracket.

The root is that the reduction **SUBTRACTS** known markup and treats the remainder as visible. That is an
open world, and an open world can only ever remove the shapes someone thought of.

**This file already made the opposite move once and it worked.** `CONTENT_RE` was subtractive until a
reviewer produced six code points it missed on the first attempt; inverting it to name what COUNTS closed
the class permanently. The same inversion is the structural fix here.

**It is deliberately NOT done in this window.** It changes refusal semantics on a path where a wrong answer
DESTROYS a real message, and this guard's own history records regex approximations of Telegram's parser
erring in both directions at passes 34, 35 and 36. It is recorded at the function that carries it, with a
pointer to the proven inversion, and it is the clear first item for the next window.

The prediction that patching instances would not converge was committed BEFORE pass 52 ran; pass 52
confirmed it, and pass 53 — asked to classify rather than accumulate — found no fresh bypass outside it.

## What shipped

- One door. **18** call sites behind it, **19** classified methods (6 reader-visible, 13 declared
  bodyless), and an unclassified method REFUSED at runtime rather than assumed safe.
- **51** tests on the door. Every behavioural test was run against the previous implementation first and
  confirmed to fail for the right reason; tests that only corrected fixtures are recorded as fixture
  corrections, not counted as proofs.
- **27** commits this window. **24** questions and **53** verdicts archived, contiguous, **0** empty.

## What this window found in its own instruments, which may outlast the guard

Five defects, none in the code under review, each found by checking rather than assuming:

1. **A comment describing a repair that was never made.** The door's header said it had stopped spreading
   `init`; the line below it still spread. The outcome was safe, so every test of the SENT bytes passed
   either way — visible only by counting READS, and nothing counted reads. It sat in the load-bearing
   paragraph of the load-bearing file for two full readings.
2. **A test that passed by virtue of who ran it.** The lifeline suite needed an agent CLI installed, so it
   was green locally and red in CI. The tempting repair was to skip it where the tool is absent; a suite
   that reports green by not running is indistinguishable from one that ran.
3. **A published claim that was false when written.** The proposal and the release note both said every
   open item was recorded in the source. Two of ten were not. Found by grepping the source for each item
   instead of trusting the summary.
4. **Three stale counts** across two pull-request descriptions and one artifact — each correct when
   written, each quoted afterwards. A measurement quoted later has become a claim.
5. **An archived verdict that was a zero-byte file**, which the archive guard counted as archived because
   it built its population from filenames. It reported the archive contiguous and complete over a hole, on
   every commit, for a day. The guard now checks contents.

Every one of those reads as finished. **The failure mode of this work is not missing effort — it is work
that looks complete**, which is why running the check beats re-reading it.

## What is honestly still open

Named at the functions that carry them, not only here:

- The subtractive reduction (the root above) — the structural next item.
- A structure proven to render nothing is still allowed: the walk cannot distinguish "understood, renders
  nothing" from "not understood", and both return the same state.
- A formula whose LaTeX renders no glyph still delivers; deciding it needs a renderer.
- Structured content is inspected only in its JSON-body representation.
- Body encoding is inferred from the JavaScript wrapper rather than from `Content-Type`.
- A self-hosted Bot API server is invisible to both the door and the boundary lint.
- Redirect crossing is classified once, from the initial URL.

**Against what, though.** `main` today has no such guard at all and seven files reaching the Bot API
directly with nothing inspecting them. Every item above is a case `main` does not catch either. The
comparison a reader should make is not "a perfect guard versus this one" but "nothing versus a guard whose
gaps are written where the next person meets them."
