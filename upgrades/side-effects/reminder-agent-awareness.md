# Side-effects review — reminder-agent-awareness

**Change:** add the dated check-in reminder (ACT-724 step 1, merged in #1630) to
the agent CLAUDE.md template, with a SEPARATE `PostUpdateMigrator` arm so
existing agents receive it, plus tests pinning both halves.

**Why:** #1630 shipped routes, a job, and 55 tests — and nothing in the agent
template. Per the Agent Awareness Standard, "an agent that doesn't know about a
capability effectively doesn't have it." No agent would ever set `checkInAt`, so
the reconciler would scan an empty set forever and report success doing it.

**Tier:** 1 — template text, one migration arm, tests. No runtime behaviour.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing. This adds documentation and one idempotent migration branch. No
predicate, no gate, no rejection path.

## 2. Under-block — what failure modes does this still miss?

- **The Agent Awareness Standard remains unenforced in general.** This change
  gates THIS capability; the next feature can still ship template-less and no
  test will notice. That is the real defect and it is bigger than this PR — the
  standard is prose with no structure behind it, which is precisely why I missed
  it while shipping a feature about not relying on memory. Recorded rather than
  quietly fixed for one case and forgotten.
- **Drifted CLAUDE.md files get an append, not a placement.** If an agent
  customised the section wording, the marker won't match and the subsection is
  appended near the block instead of at the intended point. Deliberate: a
  misplaced paragraph beats a permanently unaware agent.
- **The template text can still drift from the shipped routes.** Nothing
  cross-checks the documented curl against the real route path. A rename would
  leave the briefing confidently wrong.

## 3. Level-of-abstraction fit

Right layer, and the migration arm placement is the substantive decision.

The existing Commitments arm is guarded by
`if (!content.includes('**Commitments & Follow-Through**'))`. Adding the
subsection inside that branch would reach FRESH INSTALLS ONLY — every currently
running agent already has that section and never re-enters the branch. That is
the exact Migration Parity failure mode the standard names, and it looks
completely correct in a diff.

Hence a separate arm keyed on "section present AND subsection absent", with a
test asserting that separation rather than trusting it.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. No authority: documentation plus an idempotent
text patch. The migration decides only whether text is already present — a
`String.includes` check at a dev/update chokepoint, not a runtime judgment.

## 5. Interactions

- **The Commitments migration arm** — untouched; the new arm runs after it and
  is reachable in the state the old arm skips.
- **Shadow-capability slicing** — the subsection sits INSIDE the existing
  Commitments block rather than creating a new top-level marker, so the slicer's
  boundaries are unchanged.
- **`feature-delivery-completeness`** — passes (126 tests); this change adds
  awareness for a feature that suite already tracks.

## 6. External surfaces

- **The agent-facing CLAUDE.md gains one subsection.** That IS the point: it is
  the surface through which an agent discovers the capability.
- No route, config key, flag, env var, or runtime behaviour.
- The text states the honest scope — dark by default, at-least-once (not
  exactly-once), and that "structurally impossible to have a dated promise
  without a reminder" is NOT yet true. A briefing that oversells produces an
  agent confidently relying on something that isn't running.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified.** The template is a shipped source constant and the migration runs
per-machine against each machine's own CLAUDE.md, producing identical text
everywhere. No new state, no notice, no generated URL, nothing to strand on a
topic transfer.

## 8. Rollback cost

Revert. Agents that already received the subsection keep harmless extra
documentation; the idempotency check means a re-run after revert re-adds it
rather than duplicating.

## Second-pass review

**Not required** — no block/allow decision, no session lifecycle, no gate.

Self-review, the one thing I went looking for: **did I put the migration where it
would actually run?** I nearly appended to the Commitments arm, which would have
been invisible in review and would have reached zero existing agents. The test
`that arm is SEPARATE from the Commitments-section arm` exists specifically
because I caught myself about to do the wrong thing, and a comment saying "don't
do that" would not have survived the next edit.


## Addendum — the migration emitted a literal placeholder

CI rejected the first version, correctly.

The subsection's example commands carry the agent's port, which the surrounding
template literal interpolates. I authored the section inside a shell heredoc and
escaped the interpolation so the shell would not consume it — and the escape
survived into the TypeScript. A patched CLAUDE.md would therefore have contained
the literal placeholder text instead of a port number, making **every curl
example in the new section copy-paste-broken**, in the one document agents rely
on to know how to call things.

Caught by `tests/unit/PostUpdateMigrator-coordinationAwareness.test.ts`, which
asserts no literal placeholder survives into a patched file. That guard exists
because this has happened before; it earned its keep.

**The generalizable bit:** authoring template-literal content through a shell
heredoc puts two escaping regimes in series, and the second one is invisible in
the diff — the TypeScript looks correct in isolation. Worth writing such content
with a file-write tool rather than a heredoc when it contains interpolations.

Side effects of the fix: none beyond the corrected string. No test was weakened;
the existing guard is what caught it.
