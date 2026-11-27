# Convergence Report — Design work runs on the frontier model and is reviewed before the operator is asked to approve it

**Spec:** [docs/specs/frontier-design-review-standard.md](../frontier-design-review-standard.md)
**Slug:** `frontier-design-review-standard`
**Converged at:** 2026-11-17T22:00:00Z (at the round ceiling)
**Iterations:** 6
**Final-round design findings:** 4, all low or medium, fixed after the round (see the verdict)

---

## Cross-model review: codex-cli:gpt-6-astra

A real GPT pass ran through this agent's Codex CLI in all six rounds and once more on the final text. Two further things to know before approving:

- **Gemini 4 Argon also reviewed every round, but by hand.** The review script reads the Gemini CLI on this machine as not signed in, so I called Gemini 4 Argon directly with the script's own reviewer instructions and the full spec. Its results are in this report; they are not in the `cross-model-review` field, which only records passes the script ran.
- **The frontier "second read" ran on Claude Opus 5.5, not Fable 5.2.** This machine's config sets that reviewer's model to Opus 5.5 (`clean-door-anthropic-review: claude-code:claude-opus-5-5`). It is a same-family read and does not count as outside review. The spec's own design fixes this for the future: in recording mode the second read always asks for the design model.

**Per-round models.** The drafting session and all six internal reviewers in every round ran on Claude Fable 5.2 (`claude-fable-5-2`), as subagents of the drafting session. Outside: GPT-6 Astra (script), Gemini 4 Argon (hand-run), Claude Opus 5.5 (second read).

## ELI10 Overview

On November 9 Justin set a rule: the strongest models design and review, cheaper models build. On November 17 a plan reached him written by the building model in four minutes with no review, because the rule was a note in the agent's memory and nothing in the system applied it. This spec makes the rule automatic for every Instar agent.

It does three things. When a session is started to write a plan, it launches on the design model named in the model registry. Any plan can go through the review loop that today only covers Instar's own changes, and one command runs every reviewer the agent has and records what each concluded. And when an agent asks its operator to approve a plan, the request must carry one line, written by the system from those records, saying which models wrote it, which reviewed it and what each found. A request without that line, or whose design changed after its review, is held until the agent runs the review.

The main tradeoff is how much to enforce. The spec holds a request only when there is no review record for the design as it stands. It does not hold a request because a reviewer found problems, or because the strongest model was unavailable; it prints those facts first in the line and leaves the decision to the operator. It also covers less than "all design work": it routes sessions started on the same machine with a written brief, and catches everything else when approval is asked.

## Original vs Converged

- **Originally** the design reused a quota guard from a feature built in June. **After review** it does not. Why: that guard refuses everything while its parent feature is switched off, which it is everywhere, so the whole standard would have silently done nothing. Seven of nine reviewers found this in round 1.
- **Originally** a review record was matched to a request by the design's name. **After review** the request carries a reference to one exact record, the record is tied to a fingerprint of the reviewed text, and the server re-reads the file when the request goes out. Why: by name, an agent could review version A and ask approval for a rewritten version B, or review a stub.
- **Originally** the line said "Drafted by X" and "the last round changed nothing", taken from the agent's own statements. **After review** it prints each reviewer's own verdict as the review code recorded it, and for authorship says only "on record as written in sessions running X". Why: the first wording could read as an endorsement the records did not support, and the records cannot show who wrote a file first, only that a session wrote to it. This took four rounds to get right.
- **Originally** an agent with one provider, or without the strongest model, could not clear a hold. **After review** its own model's read counts, with the line saying what was missing. Why: an update must never leave an existing agent unable to ask its operator anything.
- **Originally** any reviewer tool signed in on the machine would be sent the design. **After review** only providers the agent already works through are used. Why: a signed-in tool is not the operator's choice to send that agent's plans there. The constitution check flagged this in the last round and I took the safer default.
- **Cut during review**, because each drew repeated findings without adding much: a new on/off setting (none now), the agent's self-reported review notes, routing for sessions sent to another machine and for scheduled jobs, a probe to test model access, and a relaunch when a launch is refused.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings (raw) | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------------|--------------------|-----------------------|
| 1 | all six internal, GPT, Gemini, second read | 57 | 19 | Full rewrite: governor dropped, ledger redesigned, reference added, setting removed |
| 2 | all six internal, GPT, Gemini, second read | 47 | 20 | Full rewrite with cuts: notes route, remote and job routing; verdicts in rows; server as only writer |
| 3 | security, scalability, adversarial, integration, decision-completeness, lessons, GPT, second read | 18 | 31 | Probe removed; first-author evidence narrowed; reference fixed-length; durable and transient reasons |
| 4 | security, scalability, adversarial, integration, decision-completeness, lessons, GPT, second read | 16 | 18 | Relaunch removed; positive plan evidence; "written by" lists models on record; idempotent run reports |
| 5 | security, scalability, adversarial, integration, lessons, GPT, second read | 15 | 20 | History keyed by path; server-stamped account; write record wording; fingerprint covers frontmatter |
| 6 | adversarial (1, low), integration (1, low), GPT (2) | 4 | 21 | Fixed after the round: account binding, one enablement rule, line taken from the route, outside reviewers narrowed |

Standards-Conformance Gate, one line per round:
- Round 1: ran (5 flags).
- Round 2: ran (2 flags).
- Round 3: ran (2 flags).
- Round 4: ran (3 flags).
- Round 5: ran (3 flags).
- Round 6: ran (2 flags).
- Final text: ran 2026-11-17T21:59:01Z, 100 standards checked, 3 flags (listed under "Left behind").

Externals ran in every round; none was delta-skipped, because the body changed each time.

Decision-Completeness, final round: 13 frontloaded decisions, 0 cheap-to-change tags, 0 contested then cleared.

## Full Findings Catalog

Raw counts include the same problem reported by several reviewers. Grouped findings and their resolutions follow.

### Round 1

- **Quota governor unusable** (security, scalability, adversarial, integration, decision-completeness, lessons, second read, Gemini, gate): it refuses `disabled` while its feature is off, needs a live-session lease, reads one account, and its limits were never evidenced. Resolved: not reused.
- **No way to clear the hold for a single-provider or no-frontier agent** (adversarial, integration, decision-completeness, lessons, GPT, Gemini). Resolved: the agent's own model's pass counts, recorded and printed.
- **Record written by a process with no state, slug or round; two writers on one file** (security, scalability, integration). Resolved: the review command reports to the server, which is the only writer.
- **Record matched by name, not by text; a typed line could pass** (adversarial, lessons, decision-completeness, second read, gate). Resolved: exact reference and fingerprint.
- **Private designs sent to outside providers by default** (security). Resolved in round 6 after two reversals; see "Original vs Converged".
- **New setting's multi-machine posture mislabelled** (integration). Resolved: no setting.
- Also: hand-off could loop; the line claimed convergence nothing recorded; the classifier ran before cheap checks; token-ledger lag; the 2.0 constitution counterpart had no route; round caps were a forced stop; "ten days of live use" for the existing hold was wrong (two days). All resolved.

### Round 2

- **Remote spawns cannot carry the new field** (integration). Resolved: cut from this version.
- **A design-lane launch would be respawned by the topic-profile orchestrator** (integration). Resolved: the launch records its expectation.
- **Rows held no verdict; the agent's notes could mislead** (adversarial, second read, GPT, security). Resolved: notes cut; verdicts recorded and printed.
- **A single hand-picked reviewer could make a record** (adversarial). Resolved: recording only in the all-reviewers mode.
- **Drafter taken from the session that submitted the review** (adversarial). Resolved over rounds 3 to 5.
- **Rounds counted by document version** (Gemini, gate, second read, adversarial). Resolved: counted by review runs.
- Also: path handling, backup claim, on/off posture, rollback claim, append-only wording, prefix collisions, Gemini lane, graduation waiting on rare cases. All resolved.

### Round 3

- **Model-access probe** (scalability, gate, second read, integration, decision-completeness, lessons): inline, unbounded, no per-account helper. Resolved: removed.
- **First-author evidence** (seven reviewers): stored events carry a path, not the tool's input; the session's requested model is unset for default launches. Narrowed, then replaced in round 4.
- **Verdict values and counts misstated** (adversarial, integration). Resolved: real values, no counts.
- **A run stopped by the secret scan, or failing for transient reasons, cleared the hold** (adversarial). Resolved.
- Also: reference identity, sixth-round checkpoint lacked "continue", spool accepting a refused write, path rule deadlock, constitution pairing order. All resolved.

### Round 4

- **First-author claim not supportable** (security, scalability, adversarial, integration, lessons, GPT). Resolved: the claim was cut; the line lists models of sessions on record as writing to the file.
- **Relaunch on a refused launch cannot be built** (scalability, integration, GPT, gate): a spawn returns before the provider is called. Resolved: removed; the lane needs a recorded successful call.
- Also: run reports not idempotent; session directory unbound; module reasons unmapped; false claims about the reply scripts; lens counts read as quotas. All resolved.

### Round 5

- **File creation time is not stable under the agent's own tools** (scalability, integration, adversarial; measured on this spec's file). Resolved: history keyed by path.
- **The review command cannot name its account, so routing would never fire on a multi-account agent** (integration, lessons, GPT). Resolved: the server stamps it from its own session record.
- Also: write entries per write; leftover spooled reports; empty token; inconclusive preflight; frontmatter excluded from the fingerprint; over-promise on launch refusals. All resolved.
- Decision-completeness: clean. Gemini: clean. Lessons: "at the 80/20 bar".

### Round 6

- GPT (2): account evidence must be bound to the reviewer call's login; the same-door reviewer's enablement was stated three ways. Both fixed after the round.
- Adversarial (1, low): a rendered document could show a stale line from frontmatter. Fixed: renderings take the line from the route.
- Integration (1, low): the durable and transient split of one reason is a module change and was written as existing behaviour. Fixed: stated as a change.
- Gate (2): mixed briefs rely on awareness (left as is); designs sent to every signed-in provider (fixed: only providers the agent already works through).
- Security, scalability, decision-completeness, lessons, Gemini: no design findings. Second read: no design findings, "does not need another round".

### Check on the final text

One GPT pass and the constitution check, after the round-6 fixes. GPT raised two further small points (a torn last line could swallow the next record; an existing reviewer-model override conflicted with "always ask for the design model") and one ordering note for the build stages. All three were fixed. Those last edits were read by no reviewer.

## Proportion

Tier 2 (spec only, about 10,700 words; it touches routing, the outbound gate, a constitution article and the fleet update path). Six rounds used of a six-round ceiling. ⚠ The spec is five times the size of the hold it extends (2,100 words). The lessons reviewer's judgment in round 6 was "large but not padded; nothing further worth cutting".

## Left behind

Accepted at the ceiling, with the reason:

- **Mixed design-and-build briefs run on the building model** (constitution check, every round from 4; flagged as Structure beats Willpower and No Manual Work). Review and revision are still enforced by the hold and hand-off. Only the first draft's model is left to the agent's awareness text. Measured as a standing line in the weekly maturation review.
- **A request passes when no reviewer on the machine can be reached** (constitution check on the final text, Verify the State). Deliberate: it is the single-provider floor. The line opens by saying no reviewer could be reached and why.
- **One fallback to the default model** (constitution check, Judgment Within Floors). A second frontier model is a registry change, not a per-call choice.
- **The spawn classifier** (second read, four rounds: use declared kind only). Kept: an undeclared design brief is the incident's shape, and "design work picks its own model" was approved. Its latency and agreement are graduation measures.
- **The classifier sees only the brief, not the conversation** (constitution check, round 5). The brief is what the session will act on.

Precision, not iterated on:

- No glossary for local terms (door, lane, rung, dark, graduation).
- The design resembles a build-provenance attestation checked by a required status check (SLSA, in-toto); not named in the spec.
- "Reviewed N times" also counts a re-run after a wording-only edit.
- A design saved over an old file's path inherits its history (stated in the spec).
- A plan upgrade is noticed only at the next review run.
- Write records age out within hours on a busy agent; the line then says there is no record.
- The stored account id can drift from the login a session really runs on; the cost is one refused launch, already stated.
- Four module reasons are not named in the mapping; they fall under the stated rule.

For the operator, outside this spec's approval: `FABLE-MODEL-ESCALATION-SPEC.md` carries `status: draft` beside `approved: true`.

## Convergence Verdict

Converged at the round ceiling, round 6. This was not a quiet round: it had four design findings, all low or medium, from three of nine reviewers, and six reviewers had none. Those four were fixed after the round, and the fixes were checked by one GPT pass and the constitution check, which led to three more small fixes that no reviewer has read. No safety, security or data-loss finding is left open: the one data-disclosure flag was resolved by taking the safer default, and that choice is listed for the operator in the plain-English overview as something he can reverse. Five items are left behind with reasons. The spec is ready for the operator's review and approval.
