# Convergence Report — Telegram-button approval

**Spec:** [docs/specs/telegram-button-approval.md](../telegram-button-approval.md)
**Slug:** `telegram-button-approval`
**Converged at:** 2026-10-19 (documentation part; see "Basis for the tag")
**Iterations:** 12
**Final-round design findings on the tagged content:** 0 (every round-12 design finding was on the class-map
test, which is split out to `docs/specs/telegram-callback-class-map.md` and is not tagged)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in rounds 2–12 through the agent's codex CLI. Round 1's pass degraded
(`error`): the main checkout's built reviewer module was stale and resolved the retired `gpt-5.5`, which the
ChatGPT-account Codex refuses; from round 2 the reviewer ran from a fresh build of `origin/main`, resolving
`gpt-6-astra`. Gemini was not authenticated on this machine (`gemini-not-authed`). The Anthropic clean-door
second read (`claude-code:claude-fable-5`, not cross-family) ran in every round. The six internal reviewers
ran each round on `claude-opus-5-5` via `claude -p` (this session could not spawn subagents). The
Standards-Conformance Gate ran every round (1–3 signal-only flags each; the recurring flag, *Canonical Pipeline
Operational Completeness* on the human per-PR floor, was refuted by several reviewers as a floor claim and is
kept in the spec as an operator question).

## Basis for the tag

The repository's convergence standard is the 80/20 one (operator, 2026-08-19): stop when findings stop changing
the build, not after N clean rounds. Measured against that:
- Twelve rounds. Design-class findings narrowed from architecture (rounds 1–3: forgery paths, the threat
  model, what to build at all) to the mechanics of one unit test (rounds 10–12: how the class-map test
  discovers sites).
- The analysis sections — the head-on answer, the S/R/P classes, the existing-tap exceptions, the volume
  options and recommendation, the hand-offs — were stable from round 8 apart from the addition and rejection of
  option (d) in rounds 9–10, which changed no build.
- The one unstable component, the class-map test, is removed to its own spec. It is not load-bearing for this
  build, which ships no code for the classification rule; the rule binds through lessons-index L15 and spec
  review until that test lands.
- What this spec now ships is documentation only: the L15 paragraph, two dated supersession notes, the hand-off
  items, and the analysis. Rounds 10–12 raised no design finding against any of those.

The split was decided by the coordinating session (desk level). The class-map spec carries the rounds-11–12
findings applied but unreviewed, and goes through `/spec-converge` separately.

## ELI10 Overview

The operator asked whether he could approve things with a Telegram button instead of typing a dashboard PIN,
and said he cannot be the bottleneck for ~300 feedback fixes. Today neither the PIN nor a button is a real
lock: the agent can read the PIN, can fake a button press, and anyone holding the agent's API key can make the
agent do anything — and the PIN itself is exchanged for that key. So a button would lose nothing today; but
once the PIN moves onto the operator's phone as a passkey, a button can never match it, because Telegram
cannot prove whose hand pressed it. Buttons may therefore only ever approve things that are safe even if faked
(stop, hold, decline).

What ships is documentation: the rule, written into the reviewers' lessons index; two dated notes on older
specs whose "the agent can never approve this" promises are weaker than they read; and tracked hand-offs,
including a live PIN leak (ACT-113). On volume, no change of venue helps; a proposed evidence card was examined
and rejected because its honesty promise cannot be kept. The standing structural answer is a second trusted
reviewer — and, measured on the live repository, GitHub today requires no review at all for a feedback-derived
pull request, with no path-scoped way to require one only for feedback PRs; closing that is the operator's
decision.

## Original vs Converged

- **Originally:** build a Telegram tap gate for "re-grant" approvals and harden the callback route with a
  Telegram check. **Now:** no tap gate — the only re-grant candidate needs no human (ACT-118), and checking a
  callback with Telegram proves a press happened, not who pressed.
- **Originally:** "the PIN and a tap are equivalent; both stop an outsider with the API token." **Now:** neither
  stops that outsider — the token can spawn a session that does anything (G11), and the PIN is exchanged for
  the token. Approvals on this host are intent records, not boundaries.
- **Originally:** fix the PIN leak in this build. **Now:** ACT-113, its own urgent spec; route detail kept out
  of this public document until fixed.
- **Originally:** link buttons on the action list; later an evidence card per PR. **Now:** both dropped — links
  already exist; the card's "every line verified" promise cannot be enforced because the diff is written by the
  untrusted session and the reproduction verdict rests on output the session's test prints.
- **Originally:** a class-map test as part of this spec. **Now:** split to `telegram-callback-class-map.md`.
- **Added:** the volume analysis (options (a)–(g)), the rung-floor vs *Canonical Pipeline* collision as an
  operator question, G11, G12, the measured GitHub ruleset facts, and seven tracked hand-offs.

## Iteration Summary

| Round | Reviewers raising DESIGN findings | DESIGN bullets | Main spec changes |
|---|---|---|---|
| 1 | all six internal | ~40 | lifeline-secret forgery path; revoke ≠ R; R has no consumer; maturation, migration gaps |
| 2 | five internal + codex | ~35 | answer-first callback check dropped; existing taps classified; Bearer PIN leak found (G3) |
| 3 | all | ~34 | leak fix moved to ACT-113; Bounded Blast Radius miscitation; buttons scoped |
| 4 | five internal + codex | ~19 | buttons dropped; build reduced to an instruction section |
| 5 | five internal + codex | ~12 | T1 reason corrected; operator-session token; instruction wording |
| 6 | all except scalability | ~16 | G11 (token = full control); instruction change moved to sibling; L15 carrier |
| 7 | all | ~15 | class map + test; burn-alert buttons (G12, ACT-119); options (e)/(f); supersession notes |
| 8 | all | ~13 | site-keyed map; prompt-gate always-approve (ACT-120); per-PR floor wording |
| 9 | all | ~37 | evidence card (d) added, judged, rejected; constitution wording narrowed |
| 10 | six internal + codex | ~9 | prompt-gate is P (exception); annotation-based site test; rotation revokes token |
| 11 | six internal + codex | ~16 | class-map test only: dispatch entry points, parser-based rule, Slack, event-bound exceptions |
| 12 | six internal + codex | ~15 | class-map test only: `unwired` redefined, every branch counts, Slack discovery, `none` class |

Rounds 11–12 were desk-approved extra rounds under the 80/20 standard. Every design finding in rounds 10–12 was
on the class-map test; none touched the content now tagged.

## Full Findings Catalog

Per-round reviewer outputs are retained in the session's scratchpad (`r1`–`r12`); the substantive findings and
their resolutions are summarised above and in the spec's own sections (the ground-truth items G1–G12 and the
hand-offs ACT-113, 115–120 record where each finding landed). Findings carried into the split spec: the
class-map discovery rules (annotations, parser walk, listed entry points, Slack `action_id`,
`CallbackRegistry.register`), the `unwired` definition, event-bound exceptions, and the removed "daily job"
attention claim.

## Convergence verdict

Converged for the documentation part at iteration 12 on the 80/20 basis stated above: no design finding
against the tagged content since round 8 apart from the self-contained (d) episode; the only still-changing
component separated into its own spec. Ready for operator review and approval.
