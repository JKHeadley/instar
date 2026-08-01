# Side-Effects Review — YAML inline comments in frontmatter values

**Version / slug:** `safeyaml-inline-comments`
**Date:** `2026-08-01`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`src/core/SafeYaml.ts` did not strip YAML inline comments, so `approved: true  # operator
preapproval, topic 11960` parsed as the STRING `"true  # operator preapproval, topic 11960"`
rather than the boolean `true`. Every consumer testing `data.approved === true` therefore
concluded the spec was NOT approved — on a file that visibly reads `approved: true`. This
adds one helper, `stripInlineComment`, applied at the two sites where a scalar is
interpreted: `parseInlineValue` (`key: value  # note`) and the block-sequence item path
(`- item  # note`). Files touched: `src/core/SafeYaml.ts` (+39 LOC incl. its explanatory
comment) and a new `tests/unit/SafeYaml-inline-comments.test.ts` (13 cases).

## Decision-point inventory

The parser itself makes no policy decision — it produces the values that decision points
read. It is upstream of three consumers, all pass-through here:

- `StageTransitionValidator` (`data.approved !== true` → `APPROVED_FLAG_MISSING`) — pass-through — receives a boolean where it previously received a string; its own logic is unchanged.
- `PlanDocParser` — pass-through — no approval surface; reads plan frontmatter.
- `ProjectRoundRunner` — pass-through — reads convergence/round frontmatter.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change removes characters from a value, it never rejects a document. The
equivalent risk is *over-stripping*: silently truncating a value that legitimately contains
`#`. Two concrete shapes were identified and are explicitly preserved:

- `url: http://host/page#section` — a `#` with no preceding whitespace is part of the value. Truncating here would corrupt a URL to `http://host/page` with no error.
- `title: "sharp # sign"` and `title: 'sharp # sign'` — a `#` inside quotes is content.

Both are covered by tests that pass before AND after the change (regression guards).

---

## 2. Under-block

**What failure modes does this still miss?**

- **Escaped quotes inside quoted scalars.** `desc: 'it''s # not a comment'` — the scanner treats the doubled `''` as close-then-open and would mis-track quote state. The pre-existing `parseScalar` does no escape processing either (it slices the outer quotes verbatim), so this is a pre-existing limitation of the narrow schema, not a new one. No spec in the tree uses escaped quotes in frontmatter.
- **A `#` preceded by a tab inside an otherwise unquoted value** is treated as a comment start (`/\s/` matches tab). That matches YAML.
- **Multi-line block scalars (`|`, `>`)** are untouched: comments are not stripped from block-scalar bodies. That is correct — inside a block scalar, `#` is literal content.

---

## 3. Level-of-abstraction fit

Correct layer. This is a **primitive** (a parser producing values), not a detector and not
an authority. The alternative placements are both worse: fixing it in
`StageTransitionValidator` would patch one consumer and leave `PlanDocParser` and
`ProjectRoundRunner` mis-parsing the same files, and fixing it at each call site would be
the "fixing one instance of a class is not fixing the class" anti-pattern. The fix belongs
where the value is produced, which is why both scalar-producing sites in the parser are
patched rather than only the one that surfaced the bug.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The parser holds no blocking authority. It returns `Record<string, unknown>` and every
caller wraps it in its own schema validator. The change makes an existing authority
(`StageTransitionValidator`) receive *correct input*; it does not add, move, or weaken any
authority. Notably it does not make the gate more permissive in spirit — the gate's rule
("frontmatter must carry `approved: true`") is unchanged, and a spec without an approval
flag is still refused exactly as before.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no competing live
signals here: "where does a YAML comment begin?" is an **enumerable invariant** fixed by the
YAML specification (a `#` at value-start or preceded by whitespace, outside quotes), not a
judgement call that varies with context. It is named directly in the helper's doc comment.

---

## 5. Interactions

- **Shadowing:** `stripInlineComment` runs FIRST in `parseInlineValue`, before the tag (`!`), anchor (`&`/`*`), flow-sequence (`[...]`) and flow-map (`{...}`) checks. This ordering is deliberate and was verified: a trailing comment after a flow sequence (`tags: [a, b]  # note`) would otherwise fail the `endsWith(']')` test and be mis-parsed as a plain string. It cannot shadow the security rejections — a value that *starts* with `!`, `&` or `*` is unaffected by comment-stripping, so tags and anchors are still rejected.
- **Double-fire:** none. The helper is pure, has no side effects, and is called exactly once per scalar.
- **Races:** none. Pure function, no shared or persistent state.
- **Feedback loops:** none. Parsing does not feed back into any system that parses.

---

## 6. External surfaces

- **Other agents on the same machine:** no. Parsing is per-process and in-memory.
- **Install base:** yes, but only in the corrective direction — nine specs on `main` (of 522 carrying an `approved:` line) currently mis-parse and will begin parsing correctly. No spec can be depending on its approval flag being silently ignored.
- **External systems:** none.
- **Persistent state:** none written. The parser reads files and returns values; it never writes.
- **Timing / runtime conditions:** none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or touched.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/secret
form is touched by this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, and the reason is that there is no state to place: this is a
pure function over a string, evaluated independently on whichever machine happens to read
the file. The *inputs* (spec files) are already replicated by git, so every machine parses
identical bytes and — after this change — reaches identical values. Before the change every
machine also agreed, on the wrong answer; the change makes them agree on the right one.

Explicitly: it emits **no** user-facing notices (no one-voice gating needed), holds **no**
durable state (nothing to strand on topic transfer), and generates **no** URLs (nothing to
survive a machine boundary).

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. The change is one file plus one test file.
- **Data migration:** none. No persistent state is written or migrated.
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility:** during a rollback window the nine affected specs would return to reading as unapproved — i.e. back to today's behaviour. No new regression is introduced by rolling back.

Honest total: pure code change, revert-and-patch, no cleanup.

## Conclusion

The review changed the shape of the fix twice. First, the initial patch touched only
`parseInlineValue`; the level-of-abstraction question surfaced that block-sequence items
carry the identical defect, so the second call site was added and tested. Second, the
over-block question forced the conservative rule to be stated precisely — an early sketch
stripped from the first `#` unconditionally, which would have silently truncated
`http://host/page#section`. That is now the explicitly-tested boundary.

The one residual limitation is escaped quotes inside quoted scalars (§2), which is
pre-existing in `parseScalar` and unreached by any spec in the tree. Flagged, not fixed —
widening escape handling is a larger change to the narrow-schema trade-off and does not
belong in a Tier-1 fix.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required — Tier 1 (39 LOC, one file, no decision-point surface, no
persistent state, revert-and-patch rollback).

---

## Evidence pointers

- `tests/unit/SafeYaml-inline-comments.test.ts` — 13 cases; 8 fail against the pre-change parser, 5 (the conservative guards) pass both before and after. Falsification run: source reverted via `git stash`, suite re-run, 8 failed / 5 passed confirmed.
- Downstream consumers re-run green: `StageTransitionValidator` (53), `ProjectRoundRunner` (27), `PlanDocParser` (9), `ProjectAutoAdvancePoller` (10), `convergence-gate-consistency` (23), `projects-advance-mergebase-wiring` (5), `spec-review-publish` (11) — 138 passed, 0 failed.
- `npx tsc --noEmit` — clean.
- End-to-end on the real blocked file: `docs/specs/audit-convergence-enforcement.md` now yields `approved: true` (boolean) with `approved-by` and `approved-date` intact, so it passes the approved-flag gate it previously failed.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in ordinary source
(`src/core/SafeYaml.ts`), not in an LLM prompt, hook, config, skill, or standards text, and
the change adds no self-triggered controller (no loop, monitor, sentinel, reaper, scheduler,
or recovery path — the helper is a pure string function with no scheduling surface).
