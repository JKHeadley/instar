# Side-Effects Review — Keyword-gate authorial context

**Version / slug:** `keyword-gate-authorial-context`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `Euler`

## Summary of the change

The instar-dev orphan-deferral blocker now excludes only a reference list for
the shipped MigrationPerEntryAction closed enum. The matched inline-code value
must belong to that enum and share a line with another enum member. It does not
remove headings, quotations, callouts, indented text, fenced content, lone enum
values, unknown identifiers, or standalone inline-code words from inspection.
A new pure helper owns the parse, and refusal-first tests cover the live enum
regression plus genuine decision shapes. The broader failure class is recorded
as an unconfirmed registry entry. ACT-1519 owns its confirmation/refinement;
ACT-1520 owns enforcement at the relay boundary.

## Decision-point inventory

- `findOrphanDeferrals` — modified — skips one structurally qualified artifact
  reference before applying the unchanged negation/tracker/block policy.
- `isKnownInlineCodeEnumReference` — added — validates equal-backtick
  inline-code spans against the real closed enum and requires a same-line
  sibling member; it has no authority outside the existing caller.
- Orphan-deferral commit block — pass-through — patterns, nearby-tracker
  requirement, override, diagnostics, and exit behavior are unchanged.
- Defect-class registry — modified — names the broader cross-gate class as
  unconfirmed; it grants no runtime authority.

## 1. Over-block

Enum values shown alone, values rendered outside inline code, and unknown
identifier values still reach the existing blocker. This is intentional
conservatism: a lone `deferred-in-flight` may itself be an authorial
disposition. Historical quotations and fenced examples also still require a
tracker or the existing audited override.

The reported heading `## §8 — Out of scope (deliberate)` already passes current
main because none of the configured phrases matches it. A test pins that fact;
this change does not claim a heading fix that the current source cannot
reproduce.

## 2. Under-block

An author could place a genuine decision inside a line that also enumerates
multiple real migration outcomes. That is the remaining narrow ambiguity.
Lone enum values, unknown multi-segment identifiers, standalone
`` `deferred` ``, headings, blockquotes/callouts, indented prose, fenced blocks,
escaped backticks, and the same enum token in prose all remain blocked and are
refusal-tested.

The broader keyword-authority class is not closed here. ACT-1519 already tracks
the Signal-vs-Authority correction and class refinement. ACT-1520 is the
tracked enforcement gap: move outbound checks to the relay/send boundary, where
quoting, variables, aliases, and wrappers do not decide what gets inspected.

## 3. Level-of-abstraction fit

The helper answers a structured question at the structured boundary: “is this
match one member of the shipped closed enum being listed beside another
member?” It does not infer meaning from identifier shape or decide whether a
whole heading, quotation, code block, or paragraph is authorial. Two broader
implementations attempted those shortcuts; the required independent review
rejected them, and both designs were removed completely.

The other named gates are not forced through this helper. ACT-1519 owns moving
the outbound convergence regex out of blocking authority; recall has a
semantic-index design owned elsewhere; dangerous shell input needs
command-boundary enforcement.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This change adds no new blocking authority and does not promote a new keyword.
It narrows the evidence entering an existing blocker by validating an actual
closed enum reference. The existing blocker still uses literal language with commit authority,
so the broader constitutional concern is recorded honestly rather than called
closed: `brittle-keyword-authority`, unconfirmed, with `closure: gap` tied to
ACT-1520. ACT-1519 separately owns confirmation/refinement of the class.

## 4b. Judgment-point check

No new static heuristic chooses among competing live signals. The helper
validates already-structured input against the shipped closed enum, with a
source-parity test. It cannot turn a non-match into a block; it can only remove
the demonstrated enum-list false positive from an existing candidate list.

## 5. Interactions

- **Shadowing:** The identifier check runs before existing negation and nearby
  tracker checks only for that candidate. All other candidates follow the
  byte-identical path.
- **Double-fire:** None. The helper returns one boolean to the existing single
  scan.
- **Races:** None. Parsing is pure and local to one staged document.
- **Feedback loops:** Fewer invalid blocks should reduce override use. The
  override log and decision audit are otherwise unchanged.

## 6. External surfaces

Instar contributors can commit specs that reference the closed telemetry enum
as a list without an audited override. Real unfinished-work language still receives the
same blocking diagnostic. No APIs, user messages, persistent runtime state,
external services, timing assumptions, or operator-facing actions change.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Git-replicated source behavior. Every machine running the same source revision
gets the same pure classification; no machine-local state is added. The change
emits no user notice, holds no durable state, and generates no URLs.

## 8. Rollback cost

Pure code and registry rollback. Reverting the helper import and exclusion
restores the previous over-block immediately. No data migration or agent-state
repair is required.

## Conclusion

Clear to ship after the independent re-review. Two overly broad syntax
heuristics were rejected and removed; the final change binds only to the real
shipped enum, proves the nearby under-block boundaries, and records the larger
class without claiming to have solved unrelated gates.

## Second-pass review

**Reviewer:** Euler
**Independent read of the artifact: approved after three blocking passes.**
The first two designs exempted broad Markdown/identifier shapes and were
removed. The final pass verified closed-enum parity, lone/prose/status refusal,
and top-level, blockquoted, and list-nested fenced ranges. It also verified that
ACT-1519 owns class refinement and ACT-1520 owns relay-boundary enforcement.
There are no remaining blocking findings.

## Evidence pointers

- `tests/unit/instar-dev-precommit-deferrals.test.ts`
- `tests/unit/markdown-code-identifier.test.ts`
- `tests/unit/class-closure-registry.test.ts`
- Mutation proof: removing the identifier exclusion makes the enum test fail.
- `npx tsc --noEmit`
- `git diff --check`

## Class-Closure Declaration (display-only mirror)

`defectClass: brittle-keyword-authority`, `closure: gap`, `gapItem: ACT-1520`.
The class is new and unconfirmed; the current PR closes the reproduced enum
instance but does not claim that a local lexical exclusion ends the broader
raw-input and natural-language authority class. ACT-1519 owns class
confirmation/refinement; ACT-1520 owns the missing relay-boundary enforcement.
