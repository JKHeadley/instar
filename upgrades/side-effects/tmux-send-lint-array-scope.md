# Side-Effects Review — tmux send-keys guard matches the array, not the line

**Version / slug:** `tmux-send-lint-array-scope`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (CI-only lint script; no runtime path). The rule is unchanged; the check now reads the unit it always meant (the argv array) instead of a single line.`

## Summary of the change

`scripts/lint-no-unfunneled-tmux-literal-send.js` guards the `send-keys -l` argv ceiling (~16.2 KB).
The 2026-08-04 incident it exists to prevent: a ~40 KB prompt blew the ceiling, `LlmCircuitBreaker`
misclassified the opaque send error as a provider rate-limit and tripped 14 consecutive times while ten
LLM-backed components sat at 76-100% error rate.

The check required `send-keys` AND `'-l'` on the SAME LINE. Measured against the shipped check, with the
one-line form as a positive control firing in the same run:

| form | shipped |
|---|---|
| `["send-keys", "-l", p]` — POSITIVE CONTROL | exit 1 (caught) |
| the same array across 5 lines | **exit 0 — EVADES** |
| `const F = "-l"; ["send-keys", F, p]` | **exit 0 — EVADES** |
| `const C = "send-keys"; [C, "-l", p]` | **exit 0 — EVADES** |
| `["send-keys","-l",p] // buildLiteralSendArgs` | **exit 0 — EVADES** |

The unit of matching is now the bracket-matched ARRAY LITERAL, over comment-stripped, const-resolved
source. The rule, the exemption and the message are unchanged.

## Decision-point inventory

- `stripComments(src)` — ADD — quote-aware; replaces removed bytes with spaces so line numbers are exact.
- `collectStringConsts(code)` — ADD — per-file identifier → literal; conflicting bindings dropped.
- `arrayRegions(code)` — ADD — bracket-matched, string-aware, bounded at 4000 chars per region.
- `regionViolates(text, consts)` — ADD — resolves then applies the EXISTING two patterns.
- `scanSource(code)` — ADD — the composed scan, extracted so matching is testable.
- Direct-invocation guard — ADD — the scan runs only when invoked directly.
- The `EXEMPT` set, the two patterns, the violation message and exit codes — UNCHANGED.
- No runtime block/allow decision added or modified. CI-time only.

## 1. Over-block

The failure that matters: this lint blocks commits, and a check that flags correct code gets switched
off. Six controls, each with a test, all passing under BOTH old and new behaviour:

- `send-keys` WITHOUT `-l` is not flagged (only the literal form has the ceiling).
- A genuinely funnelled `buildLiteralSendArgs(...)` call is not flagged.
- **Two separate arrays are never joined** — an unrelated `["ls", "-l"]` cannot complete a send-keys
  array. This is the whole reason the unit is a bracket-matched region rather than a line window.
- A const bound to a different flag is not flagged.
- An example living entirely inside a comment is not flagged — which is what makes it safe to document
  the bad pattern, including in this file and the ELI16.
- An identifier bound twice to DIFFERENT values is unresolvable and never substituted.

Unbalanced brackets yield no region, so a syntax error elsewhere cannot become a false accusation.

**Verified against the real tree: exit 0 before AND after**, scanning 1,631 files. No new flags.

## 2. Under-block

Stated in the source, and it is a CORRECTION rather than a restatement. The old header claimed only
that "a wrapper that builds the argv array dynamically could still evade it" — true, but it understated
the gap, since none of the four measured evasions is dynamic or a wrapper. The header now names what was
actually missing and what genuinely remains:

- An argv array assembled at RUNTIME — `push()`, `concat()`, spread of a computed list, or a helper that
  returns the array. That is the original declared gap and it is the only one left.
- Closing it needs dataflow, not more patterns.

## 3. Level-of-abstraction fit

Same layer as the existing check — regex over source text, no AST, no type information, no new
dependency. Bracket matching is the minimum needed to read an array literal as one unit; going further
(a parser) would be a different check at a different layer.

## 4. Signal vs authority compliance

Unchanged. A CI guard, not a runtime authority. It pushes callers toward `buildLiteralSendArgs()`; the
funnel itself stays exempt.

## 5. Interactions

- `npm run lint` chain — membership verified explicitly (in the `lint` chain CI runs, not merely
  referenced by a standalone entry); full chain green.
- The direct-invocation guard changes import behaviour from "runs the src/ scan and may exit(1)" to
  "exports only". Nothing imported this module before, so no caller changes.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling, not an agent capability; the Agent Awareness Standard does not apply.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and correctly so — not an unexamined assumption.** A CI-time source scan with
no runtime surface: it reads files in one checkout and exits. No durable state, no user-facing notice, no
generated URL, no runtime decision — so nothing to replicate, nothing to merge on read, nothing that can
strand on a topic transfer. Every machine runs it over its own checkout of the same tracked source and
reaches the same verdict; determinism comes from the source tree, not from coordination. Resolution is
explicitly per-file, so it cannot depend on the rest of the checkout, let alone another machine.

## 8. Rollback cost

`git revert` of one script plus the added test file. No migration, no state, no deployed artifact.

## Conclusion

Ship. Four evasions closed on a guard with a real production incident behind it, six anti-over-block
controls added, the stated scope corrected rather than restated, and the import hazard removed.

## Evidence pointers

- `tests/unit/tmux-send-lint-array-scope.test.ts` — **18/18 green**.
- **Negative control: 6 of 18 fail** against the shipped line-oriented behaviour. The other 12 pass both
  ways — which is what makes them controls. Source restored byte-exact after the mutation (sha match,
  zero markers left).
- Reproduced by hand FIRST with a positive control firing in the same run; the control is what makes the
  four EVADES verdicts mean anything.
- Real-tree verdict: exit 0, 1,631 files scanned, before and after.
- Full `npm run lint` chain green.
- Tier **1** declared: risk floor 1, verified with a directional control (`SessionReaper.ts` → floor 2
  with its reason named). The size heuristic suggests 2 on added LOC alone; stated openly, since the tier
  I choose is the one that lets my own change through.
