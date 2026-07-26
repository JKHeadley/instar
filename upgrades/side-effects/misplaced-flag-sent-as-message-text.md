# Side-Effects Review — a flag after the topic id was sent to the user as message text

**Version / slug:** `misplaced-flag-sent-as-message-text`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 (reduced independence, disclosed)`

## Summary of the change

`telegram-reply.sh` parses flags in a loop that BREAKS at the first non-flag argument —
the topic id. Everything after that becomes the message via `MSG="$*"`. So
`telegram-reply.sh 29723 --tone-ack B15 --tone-reason "why"` did two wrong things at once,
both silently: it sent the literal text `--tone-ack B15 --tone-reason why` to the user, and
the tone-advisory override never reached the server.

**Measured, not hypothesised.** The pre-fix template is captured verbatim as a fixture
(SHA `a2cf0215…`, the same SHA registered in the migrator's shipped-SHA allowlist) and the
test suite runs it against a stub of `/telegram/reply/:topicId`: it returns exit 0, the
received `text` contains `--tone-ack`, and `metadata.toneAdvisoryAck` is `undefined`.

**The consequence was a corrupted measurement.** On 2026-07-26 the swallowed flags meant a
tone-gate advisory was re-reviewed as an ordinary send whose text now began with option
noise. The resulting verdict looked absurd, I read it as a malfunction, and graded a
**correct** check `wrong` in the decision-quality data. That record is durable and is not
retracted by this change — see §2.

**The root cause is not the script.** The tone-reaction flags were documented NOWHERE
agent-facing: not in the script's own usage header (which documents `--format` and
`--stdin-base64`), not in the CLAUDE.md template. The template documents `metadata.*` — the
HTTP shape — while simultaneously mandating "ALWAYS the relay script, never a hand-rolled
curl". The bridge between the two did not exist, so the invocation had to be invented. The
script then accepted the invention without complaint. A capability shipped without
instructions, plus a tool silent on the only usage an uninstructed caller would try.

Three parts, because it took three to close the chain: the guard (refuses), the script's
usage header, and the CLAUDE.md template (documents the correct form).

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `--*` argument after the topic id → refuse | `invariant` | Deterministic glob on an argument. No judgment, no model, no competing signals. Symmetric with the pre-existing `-*` refusal before the topic id. |
| stdin path exempt | `invariant` | Structural, not a rule: `$#` is 0 when the message comes from stdin, so the loop has nothing to inspect. |
| CLAUDE.md content-sniff marker | `invariant` | String presence test. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

An argument-form message whose own token is exactly `--something`. For example
`telegram-reply.sh 29723 the flag --tone-ack means X` is now refused, where before it sent.

This is deliberate and I think correct, but it is a real narrowing and worth stating
plainly rather than waving away:

- The refusal is **loud, immediate, and actionable** — it prints the corrected ordering and
  names the escape hatch. The failure mode it replaces was silent and unrecoverable.
- The escape hatch is **the documented primary path**: stdin (`cat <<'EOF' | …`). Every
  multi-line message already uses it, and stdin is untouched by this check.
- The alternative — matching only the eight known flag names — would have let a TYPO'd
  flag (`--tone-akc`) through silently. That is the realistic mistake, and the whole point
  is to stop flag-shaped tokens being swallowed. Matching the shape, not the list, is what
  makes the guard useful rather than decorative.

## 2. Under-block

**What failure modes does this still miss?**

- **The false grade from 2026-07-26 is not retracted.** This stops the cause; it does not
  undo the effect. Whether a mistaken grade can be corrected at all — and whether a
  supersede erases the evidence the mistake was made, which would be the opposite defect —
  is an open question deliberately NOT answered here. Recorded rather than quietly folded in.
- **A single-token message that is exactly a flag, passed as an argument, is now refused
  rather than sent.** Correct behaviour, but it is a refusal, not a rescue.
- **Only this script is fixed.** `slack-reply.sh` and `whatsapp-reply.sh` share the
  parse-then-break shape. They do not carry tone-reaction flags today, so the same mistake
  has less to swallow — but the shape is the same. Named here rather than silently
  extended: widening the change to two more shipped scripts, each needing its own
  shipped-SHA registration, belongs in its own review.
- **Documentation coverage generally.** This fixes one undocumented capability. Nothing
  here establishes that others are documented.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, and at three layers on purpose, because the defect had three links:

1. **The script** — the only place a misplaced flag can be caught before it becomes text.
2. **The script's usage header** — where someone reading the tool learns the ordering.
3. **The CLAUDE.md template** — where the agent that is *mandated* to use the script learns
   that these flags exist at all. Fixing only the script would have left the root cause
   (undocumented capability) fully intact; the next agent would guess again, get a refusal
   instead of a silent mis-send, and still not know the right form.

Rejected: making the parser accept flags in either position. It looks friendlier and is
worse — `MSG="$*"` means the parser cannot distinguish "a flag I should apply" from "a word
of the message" without guessing, and a guess here silently rewrites what the user reads.
Refusing is the only honest option.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

It holds blocking authority (the send is refused) on a deterministic glob over an
argument — no model, no heuristic, no network, no threshold. It cannot drift or degrade,
and it fails in the safe direction: it withholds a send rather than delivering a
misleading one.

It is also strictly *less* authority than it appears: it blocks nothing the caller cannot
immediately re-issue correctly, and the message text itself is never inspected — only
argument tokens.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. The guard is a `case` glob. Notably it *removes* an
implicit judgment: the old code silently decided that a flag-shaped token was message
content, which is precisely the kind of unexamined call this standard exists to surface.

## 5. Interactions

- **stdin is structurally unaffected** — `$#` is 0 there, so the loop body never runs. This
  is asserted by test, because "the primary path still works" is the claim most worth
  checking.
- **Correct-order invocations are unchanged** — asserted end-to-end: message body clean,
  `metadata.toneAdvisoryAck` and `toneAdvisoryAckReason` both present.
- **Pre-existing `Unknown flag` behaviour before the topic id is untouched** — asserted.
- **Migration parity for the SCRIPT**: the pre-change SHA `a2cf0215…` is registered in
  `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`. Without that entry the SHA-history migrator leaves
  the swallowing version in place with a `.new` beside it and every deployed agent keeps
  mis-sending — the failure mode the entry above it in that list was added to prevent.
- **Migration parity for the DOCS — the trap.** The tone-advisory CLAUDE.md block is
  content-sniffed on `'Most checks are NUDGES you may override'`, a marker this change does
  NOT alter. Appending guidance to that constant would therefore reach new installs ONLY;
  every deployed agent short-circuits. Hence a second, independently-sniffed block. A test
  simulates an agent that already carries the old section and proves it still receives the
  new part — and I verified that test FAILS when the second block is disabled, so it cannot
  become decorative.
- **No route, config key, persisted state, or schema change.**

## 6. External surfaces

One user-visible change, and it is a removal of a bad one: a misplaced flag no longer
appears in the user's chat as literal option text. Nothing else about delivery changes.

## 6b. Operator-surface quality

The refusal prints what was run, what the correct ordering is, and how to send the token
literally if it really is message text. An error that only said "bad arguments" would have
reproduced the original problem — a caller with no way to learn the right form — one level
up.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no new state.** A shell-script argument guard plus
two documentation blocks. No new field, file, route, or surface; nothing to replicate and
no `machine-local-justification` marker applicable. The script is deployed per machine by
the existing SHA-history migrator, which is the established path and unchanged here.

## 8. Rollback cost

Low and total: revert one commit. The guard disappears, the docs revert, and the
shipped-SHA entry becomes a harmless extra allowlist member (never remove old SHAs — they
remain valid migration sources). No data, no migration, no state to unwind.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned — a
standing instruction in this session prohibits it unless the operator requests it. The
review lenses were applied by the author. That is **reduced independence**, recorded as
such rather than presented as a concurring second pass.

What author-applied review caught and changed:

1. **The first version fixed only the script.** That would have left the actual root cause
   untouched: the flags are documented nowhere, so the next agent guesses again — it would
   just get a refusal instead of a silent mis-send. Verified the absence repo-wide before
   claiming it (the flags appear only in the script itself, an old upgrade guide, and the
   migrator). Docs are now part of the change, not a follow-up.
2. **The CLAUDE.md content-sniff trap was nearly walked into.** Appending to the existing
   constant looked sufficient and would have shipped a doc fix that reached new installs
   only — the exact "works for new agents only" shape the Migration Parity Standard names as
   a broken feature. Caught by asking who actually *receives* the edit.
3. **The guard was nearly scoped to the eight known flag names**, which reads as more
   precise and is weaker: a typo'd flag — the realistic mistake — would still be swallowed
   silently. Widened to the shape, with the over-block cost stated in §1 rather than hidden.
4. **The negative case was run, not assumed.** I disabled the second migration block and
   confirmed the load-bearing test fails, because a migration-parity test that passes
   whether or not the migration exists is worse than none.
5. **The sibling scripts were checked and deliberately left alone** (§2) rather than swept
   in for tidiness — each needs its own shipped-SHA registration and review.
