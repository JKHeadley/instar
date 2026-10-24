# Plain-English overview: the skip ratchet looks for its parser in the right place

## What this changes, in one sentence

A maintainer agent's own test-running verifier was quietly marking **every**
pull request as "needs the operator to approve this", for a reason that had
nothing to do with the pull request. This change fixes where it looks for one
tool it needs, so that flag goes back to meaning what it says.

## The thing that already exists

Instar can run its own full test suite against a pull request on the maintainer
agent's machine, instead of relying on a cloud service. That is "local verify".
When a run finishes, it also *classifies* the pull request, answering four
questions:

- Does it change the test harness itself? (`harnessChanging`)
- Does it touch a protected path?
- Does it add skipped tests?
- Does it delete tests?

A "yes" to any of those routes the merge to the operator for a human approval,
which is correct: a change that can alter how the tests themselves run should
not be able to wave itself through.

One of those four checks — the skip/delete ratchet — reads each changed test
file and counts the tests in it. To do that honestly it parses the file with the
real TypeScript parser rather than guessing with text matching, because a test
can be skipped in a dozen different spellings and a comment that merely mentions
`it.skip` must not count.

## What was broken

The TypeScript parser is a *development* dependency of Instar. It is present in
a source checkout, and absent from an ordinary install.

The verifier process loads this code from the agent's **shadow install** — a
plain production install with no development dependencies. So when the ratchet
asked for the parser "next to me", it was not there, and the request failed with
`Cannot find module 'typescript'`.

The classifier wraps all four checks in a single safety net: if anything cannot
be read, call the pull request harness-changing and let a human look. That net
did its job. But the thing it could not read was its own parser, not anything
about the pull request — so the net fired on *every* pull request containing a
test file change, and the resulting flag said "this touches test infrastructure"
when nothing of the sort was true.

The scope is the part worth sitting with. The parser is requested **before**
the ratchet looks at any file, so it failed on every run — not only on pull
requests containing a test file. Measured on this machine: all 31 runs that got
as far as classifying failed this way, and all 20 records ever written carry
`harnessChanging: true`, with not one `false`. The autonomous merge path this
verifier exists to provide has therefore never once worked here, and the reason
the flag gave was always this bug.

That is not the same as saying every approval was pointless. Four of those
twenty pull requests also tripped the protected-path check, which keeps working
correctly even when the parser is missing — those genuinely needed a human look.
The claim is about the reason the flag gave, not about whether a review was
warranted.

The immediate cost was a clean, fully green pull request (#2318, a fix for an
unrelated session bug) waiting for a human approval overnight, with no reason in
the record, because the flag the record stores is a bare true/false with no
explanation attached.

## What is new

The parser is now looked for in the **repository being verified** first, and
only then next to this code. The repository under verification always has its
dependencies installed — the test suite had just finished running in it — so the
parser is there. If neither place has it, the request still fails and the old
safety net still fires, which is the right behaviour when the check genuinely
cannot run.

The verifier also hands the run directory in through a small injectable seam, so
a test can prove the run directory is what gets asked, rather than this being an
unverified claim in a comment.

## The safeguards, in plain terms

- **Nothing gets looser.** A pull request that genuinely changes the test harness
  is still flagged, by exactly the same rules. This only removes a flag that was
  being raised for the wrong reason.
- **The safe direction is kept.** If the parser cannot be found anywhere, the
  classifier still routes the pull request to the operator. The fix removes a
  false alarm; it does not remove the alarm.
- **A broken copy cannot shadow a working one.** If the repository's own copy is
  present but unloadable, the lookup falls through to the second location rather
  than failing.
- **Each repository gets its own parser.** The result is remembered per
  directory, so two runs from different checkouts cannot end up sharing one.

## Why the existing tests could not catch this

The verifier's unit tests run inside a source checkout, where the development
dependencies *are* installed — so the old lookup succeeded there and the happy
path asserted `harnessChanging: false` quite truthfully. The bug existed only on
the path nobody tested: the production shadow install.

That is why the new tests assert the lookup **order** and the **wiring**, not the
classifier's final answer. A test that only checked the answer would pass before
and after the fix and prove nothing.

## What you actually need to decide

Nothing about behaviour — this removes a false flag and changes no rule.

The one thing worth knowing: this change edits `src/localVerify/**`, which is
itself on the harness-changing list. So this pull request will correctly ask for
one operator approval, for a genuine reason this time.
