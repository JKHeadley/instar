# Convergence Report — The spec-review link rule moves to the owner delivery point

**Spec:** [docs/specs/spec-review-link-at-delivery.md](docs/specs/spec-review-link-at-delivery.md)
**Slug:** `spec-review-link-at-delivery`
**Converged at:** 2026-11-28, at the Tier 2 round cap (6 of 6). This is Tier 2 because the change narrows a blocking hook check and puts a new route under the outbound gate.
**Iterations:** 6
**Final-round design findings:** 5. One came from the internal reviewer: the capture ceiling named a bound the gate does not have. Four came from the cross-model pass: the override chain started only on B27; left-out rules were still accepted as citations; capture needed explicit enrollment and a fixed limit; and email graduation must not substitute a migration setting. All five were fixed after the round and are listed under Left behind. None reopens the direction.

## Cross-model review: codex-cli:gpt-6.2-astra

A GPT-tier pass ran through the agent's Codex CLI in all six rounds, each returning a result. Gemini is not installed on the M5 Pro, where the pass ran.

## ELI10 Overview

A check makes sure that when the agent asks its owner to review a design document, it includes a link the owner can open. The check sat in the wrong place: just before a command runs, where it could not see who the message was for. So it also blocked the agent's own internal messages, which nobody reads on a phone.

The check moves to the server, at the one place messages to the owner already pass. Internal messages never pass there. There it becomes a gentle reminder rather than a block. The agent can add the link, or send anyway with a written reason, and that choice is recorded so the reminder can be tuned. Email to the owner gets the same check. It starts on development agents only and has to earn its way to everyone.

## Original vs Converged

- **The rule's authority.** Round 1 rendered the rule only when the keyword tests fired, and let a link's mere presence suppress it. The converged rule is rendered on every eligible reply. The keyword tests are hints, and only the model decides whether a link opens the spec.
- **Who is eligible.** Eligibility started as "reply kind, can react". It became an explicit opt-in by the routes that carry a session's own reply, so attention items, the post-update notice and the publisher are out.
- **Overrides cannot skip other rules.** The gate cites one rule per verdict, so overriding B27 could have skipped B25 or any other rule. The converged design re-reviews in a chain, leaving out each acknowledged rule from both the prompt and the accepted citations, until a review passes, holds or falls back.
- **Rollout.** Round 1 was fleet-wide in one release. The converged design uses two development-agent switches, one for the rule and one for owner email. Check 8 is removed on every agent, by the Chief of Staff's decision after convergence.
- **Owner email.** These problems surfaced and were fixed:
  - timeout and duplicate risk;
  - which metadata keys a session may send;
  - the email lost its conversation context;
  - revision credit crossed channels;
  - a duplicate-message hold on "email me that".
- **Evidence.** The converged evidence is:
  - graded nudges;
  - passes recorded where the keywords hit;
  - a one-in-ten pass sample;
  - unjudged passes kept apart;
  - text captured per call on enrolled agents only, with a fixed ceiling.

  Graduation is a two-reading judgment with tripwires, not a score.

## Experience fit

- **Source:** the Chief of Staff's assignment and direction (messages `a2863d38`, `1883e501`, 2026-11-28), quoted in the spec. Agent review verdicts were blocked, and the file-body workaround was worse.
- **Ordinary journey:**
  - **Agent to agent:** a session sends a verdict to another session in any shape and is never blocked for a missing link, on a development agent.
  - **Owner without a link:** a session handing the owner a spec with no link gets one nudge naming the publishing script. It adds the link, or overrides with a reason.
  - **The operator:** sees nothing new.
- **Contrasting cases:**
  - an approval ask that also lacks the constitution check still ends in B25's hold;
  - a fleet agent has no link reminder until graduation (the Chief of Staff's chosen trade-off);
  - a link on another machine or an outside host is judged by how the message presents it.
- **Evidence limits:**
  - the replay is one development agent's month;
  - owner email is not proved live, because the only owner inbox is the real operator's;
  - direct-to-provider sends are CMT-073.
- **Disposition:** delivers the request on development agents now, and to the fleet only on evidence.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | codex; internal (all lenses); constitution check | 16 | detector as hints; any readable link; dev-gated; B25 relation; email under its own rules; private replay; evidence of misses |
| 2 | codex; internal | 9 | rewrite: eligibility separate from facts; email metadata and timeout; topic-keyed revision memory; fleet keeps check 8 |
| 3 | codex; internal | 8 | route opt-in; override re-review; two switches; document lookup; recall over warranted handoffs; rollback before and after deletion |
| 4 | codex; internal | 7 | override chain memory; stray citations; email duplicate check; evidence capture and retention; forward-collected email evidence |
| 5 | codex; internal | 4 | separate capture ceiling; chain over every acknowledged rule; recall over the gradable population; budget drops kept apart |
| 6 | codex; internal | 5 | fixed after the round (see Left behind) |

Standards-Conformance Gate, every round, three runs on the Studio (not degraded):

- **Round 1:** 7, 8 and 7 flags.
- **Round 2:** 10, 8 and 10 flags.
- **Round 3:** 10, 8 and 8 flags.
- **Round 4:** 10, 8 and 8 flags.
- **Round 5:** 8, 9 and 10 flags.
- **Round 6:** 8, 11 and 12 flags.

The check reads the first 24,000 characters. From round 5 the spec ran longer. The Testing section was moved last, so only part of the test list fell outside what the check read.

Internal review: one claude-opus-5-5 agent covered all six lenses, re-asked each round. From round 4 it read a frozen copy of the text. In round 3 it read an in-between version, and its round-2 items were re-checked in round 4.

## Proportion

Tier 2. It adds two switches and no new state beyond per-call capture on enrolled agents, and it is reversible by flag. Six rounds were used against a cap of six.

⚠ The cap was reached while the last round still made new discoveries. It is reported as converged at the cap, not as a clean pass. The rule 7 independent review reads the final diff before the test slot.

## Left behind

**Fixed after round 6, not re-reviewed in a round:**

- **Fixed capture ceiling:** 20,000 characters, replacing a "judge's input bound" that does not exist. Rows that are cut, withheld or redacted are ungradable.
- **Explicit enrollment for capture:** `toneGate.specReviewLinks.captureBodies`.
- **The override chain** opens on any advisory acknowledgment from a review that rendered B27, not only on B27. Left-out rules are dropped from both the prompt and the accepted citations, and are recorded on the decision. Tests cover the reverse order and a repeated citation.
- **Email graduation** needs the replay's hold rate accepted under the intended fleet dispositions. A migration setting is not a substitute.
- **Document titles** (from the round-6 constitution check): first fixed as "read as the actual recipient". At build this was narrowed further: no title is read or rendered at all, only owner-level existence (yes, no, unknown). So no title can leak, and the recipient-access machinery is not needed inside the outbound check.

**Amended at build** (each narrows, none widens):
- the chain names left-out rules in an ALREADY ACKNOWLEDGED section, and the call refuses their citations. The hashed static prompt template is not edited;
- no document titles in B27's facts;
- the detector's wording test matches "approve" (the hook's old pattern only matched the bare stem). It is a hint only.

**Repeated by the constitution check, recorded rather than iterated:**

- **Signal vs. Authority** against **A Dark Feature Guards Nothing**: these pulled in opposite directions on whether the fleet keeps check 8. **Decided after convergence by the Chief of Staff** (2026-11-28 05:35 PT, message `4a516a3b`): remove check 8 everywhere now. The fleet barely uses the reminder, since spec-converge is for the instar-developing agent only, while the misfires block real agent work. The spec was amended to match: the hook guard, its parity test and its decision row are gone, and section 5 states the trade-off.
- **No Silent Degradation to Brittle Fallback:** the gate's existing degraded and fail-open paths, governed by the operator's `toneGate.failClosedOnExhaustion`. Unchanged here, and kept apart in evidence.
- **Verify the State, Not Its Symbol** (links are not fetched): accepted. Own-host documents and views are looked up locally. Other links are judged by how the message presents them, under-fire.
- **Judgment Within Floors** (thresholds): numbers are tripwires that need a written reason to cross, inside a two-reading judgment.
- **Live-User-Channel Proof Before Done** (email): stated evidence limit. No owner inbox exists except the real operator's.
- **A Decision That Can Block Must Live Where the Checks Can See It / Remove What Demands Attention:** the hook's python guard mirrors the switch resolver until the fleet-on release deletes both. A parity test pins them.
- **Two-week minimum:** kept. The criterion is a judgment, and the minimum covers weekly patterns.

**Pre-existing, outside this change:** a retry after a lost email response can send twice, because each request mints a new id. This change adds the timeout override for the latency it introduces. A caller-stable idempotency key is CMT-074.

## Full Findings Catalog

Every round's raw output is in the session working folder (`sral/`): `r1-codex.json` to `r6-codex.json`, `conf1-*.json` to `conf6-*.json`, and the frozen texts `spec-r3.md` to `spec-r6.md`.

- **Security / adversarial:**
  - an override skipping other rules (rounds 1, 3, 5, 6);
  - which metadata keys a session can reach (2, 4);
  - titles leaking past their share (6);
  - private text in a public PR (1).
- **Integration:**
  - the email timeout and duplicate sends (1);
  - revision memory and conversation context (1, 3);
  - the duplicate check (4);
  - document replication (3);
  - the hook guard (3).
- **Decision-completeness:** email kind, B25 order, link forms, switches (rounds 1 to 3).
- **Lessons-aware:**
  - one rule per verdict, revision memory and fail-open paths in the foundation (rounds 1, 2, 3);
  - the evidence store's limits and retention (4, 5, 6).

## Convergence verdict

Converged at the round cap (6 of 6). No safety, security or data-loss finding is left open. Every bypass found was closed structurally, and the change only ever turns a block into a nudge, on development agents first. The spec is the agent's to approve under Approval Only Where Required. It touches neither `docs/STANDARDS-REGISTRY.md` nor `.github/CODEOWNERS`.
