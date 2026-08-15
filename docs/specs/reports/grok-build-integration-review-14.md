# Convergence round 19 — six reviewers, ~25 findings, and a freeze that actually held

The first round where the freeze was established BEFORE launch (snapshot + sha256,
re-verified during the round) rather than asserted and then broken. Every finding
below is against one document; the hash was identical at the start, midway and end.

## The mechanism, now unmistakable

Rounds 14-19 each found most defects inside the previous round's fixes. Round 19
makes the shape explicit, because **two round-18 fixes carry a comment that
states the failure class correctly and then commits it in the code directly
below**:

- The budget admission "fails CLOSED when the lock cannot be taken" — with a
  comment recording the measurement that motivated it. The branch is unreachable:
  `lockHeld` is set inside a callback the lock helper invokes unconditionally.
  Three reviewers independently reproduced the ORIGINAL over-admission against
  the fixed version (12 concurrent admissions with a foreign lock held: 12
  admitted, 8 reservations persisted, 4 lost).
- The metered-key scrub test, whose comment says the method "needs no knowledge
  of which sites exist" — while a hardcoded filename IS that knowledge. 4-of-4 in
  that file, 4-of-5 repo-wide.

A third: round 18 moved the drift canary's list to a shared constant so omission
would be impossible; that constant carries the same subset-permitting annotation
whose permissiveness was the original defect. The problem moved one indirection
up and was reported as closed.

**Naming a failure class confers no protection against it.** What caught all
three was someone re-running the measurement against the fixed version — not the
reasoning, not the comment, not the test written alongside.

## DESIGN findings fixed

1. **Fail-closed admission was dead code.** Acquisition now crosses the boundary
   as a parameter. Lock contention gets its own verdict rather than rendering as
   `daily-budget-exhausted 0 runs / 0 tokens`, which is the wrong-diagnosis class
   round 18 named while leaving this instance.
2. **The reservation leak, structurally.** Round 18 released per-return and
   missed the outer catch; 24 systematic throws reproduced the exact signature.
   One `finally` now covers every exit, including exits nobody has written yet.
3. **A fifth spawn site kept the metered key** — the crash-doctor pane,
   Bash-capable, 30-minute lifetime, permissions bypassed. Strictly more exposed
   than the 10-minute triage pane round 17 protected. Two further spawn sites
   scrub nothing at all. The verifying test now walks `src/` per-site: a total
   cannot answer a membership question, and a reviewer proved the old one passes
   if you merely relocate a scrub.
4. **Shadow membership was drawn from the global map**, so a codex-only agent's
   identity file named grok and pi — a dark-ship break — and a grok agent was
   told to rely on a Codex Stop hook it lacks. Membership is now requested ∪
   configured ∪ ALREADY-EVIDENCED-IN-THE-FILE. The third term is load-bearing:
   the first draft fixed the dark-ship half and immediately reintroduced the
   round-18 clobber. Both directions are independently controlled.
5. **The hookless label still enumerated**, defaulting to "Codex CLI" — so the
   frameworks the widened predicate newly admitted were addressed as Codex. Now
   keyed on a map defaulting to the raw id: unlabelled is possible, MISlabelled
   is not.
6. **The weekly wall read as a generic crash.** The adapter types pool
   exhaustion as a QuotaError; the reviewer discarded the type and re-derived a
   class by string-matching. Both wordings grok actually emits round-tripped to
   `error`. Nothing marked the family terminal, so the next review retried into
   the same wall, each attempt costing a slot. Now type-first.
7. **Pre-spawn refusals burned ceiling slots.** An exemption existed for
   host-load sheds ("spawned no child, burned zero tokens"); every auth refusal
   has that property and had none. Measured: 25 refusals → `24 runs / 0 tokens`,
   family closed having spent nothing. The exposure window is the last ~2 minutes
   of every session, because the call gate uses a 60s margin and detection uses
   zero. The exemption is now a property, not a boolean.
8. **The deferral gate did nothing in CI.** `--staged` returns empty after a
   fresh checkout, so it printed `clean — 0 marker(s)` and exited 0 —
   byte-identical to a real pass, in the one place local hooks cannot reach. Now
   falls back to the merge-base diff, and an inspected-nothing run reports as
   such rather than as clean.
9. **The gate could be satisfied by TYPING.** A reviewer passed it with an
   invented `**CMT-999999** — "…"` blockquote while the registry returns "not
   found". Marker ids are now checked against a generated, checked-in carrier
   ledger; existence is machine-decidable, coverage remains a reviewer duty.
10. **Table↔marker symmetry is now enforced**, after drifting both directions two
    rounds running. Built in-round specifically because filing it as owed is the
    pattern that kept this class alive for ten instances — and it flagged a real
    asymmetry on its first run.

## Spec corrections

- **The confinement section described the opposite of what ships.** Round 18
  concluded "no fix is claimed here, deliberately"; the code then shipped eight
  `--deny` rules and the spec never said so. Now recorded with its measurement
  table.
- **`--deny` values are unvalidated** — `--deny BogusRuleXyz` leaks a canary that
  `--deny Read` blocks, no error either way. My round-18 bound inherits the exact
  drift I condemned the old flag for. Stated rather than papered over.
- **`--sandbox` fails closed** on an unknown profile, which `--deny` does not.
  Named as the categorical alternative NOT yet taken, with its cost.
- **The bound no flag of ours reaches:** under full production argv grok executes
  `x_keyword_search` against live X — verified with a nonsense-query control. It
  is model-native and server-side, announced in the session handshake, and never
  reaches the permission layer. A spec review makes live network calls carrying
  our text. Recorded nowhere before this round.
- **Invariant 5 claimed six surfaces and enumerated four** — omitting precisely
  the two that change behaviour on agents that never touched grok. Now all six.

## Process failure recorded

I edited the shared canonical tree — explicitly out of bounds. A Telegram send
resets the working directory to the agent home, which is a lesson already
recorded from earlier the same night, and I ran a sequence of edits without
re-checking. Three landed in an older copy of the source. Reverted by hand (that
tree is not version-controlled), verified absent, and confirmed no other file
there has a recent mtime. The failure was completely silent: edits applied,
assertions passed, the path existed. An unrelated command printing the working
directory is what exposed it.

## Round verdict

~25 DESIGN findings. **The convergence counter restarts.** Nineteen rounds, no
zero-DESIGN round. Stated plainly in the iteration log: this is not converging on
its own, and that judgment belongs to the operator rather than to another five
rounds of the same loop.
