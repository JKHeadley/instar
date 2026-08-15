# Side-Effects Review — topic-creation guard resolves the method name

**Version / slug:** `topic-creation-lint-resolution`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (CI-only lint script; no runtime path). The rule is unchanged; the check now resolves one level of naming before applying the rules it already had.`

## Summary of the change

`scripts/lint-no-unfunneled-topic-creation.js` enforces the **Bounded Notification Surface** standard —
the last-resort budget on automatically-created forum topics, added after the THIRD topic-spam incident
(2026-06-05). All three of its patterns required `createForumTopic` as a string LITERAL adjacent to the
seam, so a resolved name walked past a safety floor.

Measured against the shipped lint, with a positive control (the bare literal) firing in the same run:

| form | shipped |
|---|---|
| `apiCall("createForumTopic", …)` — POSITIVE CONTROL | exit 1 (caught) |
| `const M = "createForumTopic"; apiCall(M, …)` | **exit 0 — EVADES** |
| `apiCall("createForum" + "Topic", …)` | **exit 0 — EVADES** |
| `const M = "createForumTopic"; { method: M }` | **exit 0 — EVADES** |

The method name is now RESOLVED before the existing patterns are applied. The patterns are byte-identical;
only what they can see changed.

## Decision-point inventory

- `foldAdjacentLiterals(text)` — ADD — folds `'a' + 'b'` only; never folds across an identifier.
- `collectStringConsts(lines)` — ADD — per-file identifier → string-literal map; an identifier bound twice
  to DIFFERENT values is dropped as unresolvable.
- `resolveLine(line, consts)` — ADD — substitutes ONLY at the two seam positions (`apiCall(` and `method:`).
- `scanFile(normalized, content)` — ADD — extracted so the matching behaviour is testable without the CLI.
- Direct-invocation guard — ADD — the scan runs only when the script is invoked directly.
- `PATTERNS`, `ALLOWLIST`, `SCAN_DIRS`, `EXTENSIONS`, the violation message and exit codes — UNCHANGED.
- No runtime block/allow decision added or modified. CI-time only.

## 1. Over-block

The failure that matters. This lint blocks commits, and a check that flags correct code gets switched
off — which would cost more than the hole it closes. Six controls, each with a test, all passing under
BOTH the old and new behaviour:

- **A const bound to a different method** (`"sendMessage"`) is not flagged.
- **An identifier that never reaches a seam** is not flagged — holding the value is not calling with it.
- **An identifier bound twice to different values** is unresolvable and never substituted. Ambiguity
  fails toward NOT flagging, because a guess that fails someone's build is the expensive direction.
- **A concatenation involving an identifier** (`"createForum" + suffix`) is left unresolved. Folding it
  would mean inventing text the source does not contain.
- **A longer name starting with the method** (`createForumTopicIconStickers`) is not flagged — the
  existing quote-delimited patterns already bound this, and resolution preserves it.
- **Substitution is seam-local, not global** — an unrelated `logger.debug(M)` is untouched.

Resolution is per-file by construction: one file's names cannot affect another's.

**Verified against the real tree: exit 0 before AND after.** No new flags on existing code.

## 2. Under-block

Stated in the source rather than implied:

- **Cross-module names** — a method name imported from another file is not followed.
- **Runtime-built names** — from a variable, a function call, or a template literal.
- **Anything needing dataflow** to resolve.

Guessing at those would over-match.

**One residual I want named rather than absorbed:** the lint does not strip comments, so a comment
containing the literal form is flagged. That is PRE-EXISTING behaviour (it is why this script is on its
own allowlist), and this change neither fixes nor worsens it — resolution runs on the same lines the
patterns already ran on. I am not changing it here because loosening a flood guard to be tidier is the
wrong direction, and doing it unrequested is the unrequested-tightening mistake in reverse.

## 3. Level-of-abstraction fit

Same layer as the existing check — line-oriented regex over raw source, no AST, no type information, no
new dependency. The resolution map is the minimum needed to answer "what method name is at this seam?"
without climbing to a parser.

## 4. Signal vs authority compliance

Unchanged. A CI guard, not a runtime authority. It pushes callers toward the budgeted funnel; the
allowlist still exempts the funnel itself, the lifeline's fixed-cardinality system topic, and the
setup-wizard doc string.

## 5. Interactions

- `npm run lint` chain — membership verified explicitly (the script is in the `lint` chain CI runs, not
  merely referenced by a standalone entry); full chain exit 0 across 57 steps.
- The direct-invocation guard changes import behaviour from "runs the repo scan and may exit(1)" to
  "exports only". Nothing imported this module before, so no caller changes.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling, not an agent capability; the Agent Awareness Standard does not apply.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and it is the correct posture — not an unexamined assumption.** This is a
CI-time source scan with no runtime surface: it reads files in one checkout and exits. It holds no
durable state, emits no user-facing notice, generates no URL, and makes no runtime decision, so there
is nothing to replicate, nothing to merge on read, and nothing that could strand on a topic transfer.

Every machine that runs the lint runs it over its own checkout of the same tracked source and reaches
the same verdict — determinism comes from the source tree, not from coordination. Resolution is
explicitly per-file, so it cannot even depend on the rest of the checkout, let alone another machine.

Worth stating because the audit that added this question found ~20 features shipped machine-blind: the
thing that makes THIS one genuinely local is that its input is version-controlled and its output is an
exit code, not that I could not think of a cross-machine concern.

## 8. Rollback cost

`git revert` of one script plus the added test file. No migration, no state, no deployed artifact.

## Conclusion

Ship. Three evasions closed on a safety floor, six anti-over-block controls added, real tree verified
clean in both directions, and the import hazard that blocked testing it removed.

## Evidence pointers

- `tests/unit/topic-creation-lint-resolution.test.ts` — **18/18 green**.
- **Negative control: 5 of 18 fail** against the shipped matching behaviour (local const, concatenation,
  `method:` const, let/var bindings, const-declared-after-use). The other 13 pass both ways — which is
  what makes them controls. Source restored byte-exact after the mutation (sha match, 0 markers left).
- Reproduced by hand FIRST with a positive control firing in the same run; the control is what makes the
  three EVADES verdicts mean anything.
- Real-tree verdict: `node scripts/lint-no-unfunneled-topic-creation.js` → exit 0, before and after.
- Full `npm run lint` chain green, 57 steps.
- Tier **1** declared: risk floor 1 (no safety-invariant path match — verified with two directional
  controls, `SessionReaper.ts` → floor 2 with its reason named, `devClaimCheck.ts` → floor 1). The size
  heuristic suggests 2 on added LOC alone; stated openly rather than left silent, since the tier I chose
  is the one that lets the change through.
