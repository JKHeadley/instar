---
title: "A spec or design approval request must carry its constitution check result"
slug: spec-approval-constitution-check
author: echo
parent-principle: "Constitutional Traceability — No Unconstitutional Work"
eli16-overview: docs/specs/spec-approval-constitution-check.eli16.md
origin: "Echo Bugs topic 10000002750 (2026-11-15). Incident: topic 142440, about 03:35 UTC, a design spec was sent to Justin for approval before the built-in constitution check had run on it. Justin: 'The constitution's whole purpose is that everything built on Instar is aligned with it and that it's fundamentally a part of every design process so that we stay aligned always.'"
tier: 1
lessons-engaged:
  - "Constitutional Traceability (the fit judgment must have run before the operator is asked to approve)"
  - "Structure beats Willpower (the check ran only when the author remembered /spec-converge; now the approval request itself is gated)"
  - "Self-Hosting (the Standards-Conformance Gate's result is now consumed at the approval surface, not only inside one skill)"
  - "Signal vs. Authority (the ledger is the signal; an LLM judge holds the authority)"
  - "Intelligent Prompts — An LLM Gate Must Not String-Match (no phrase pre-filter; judged by meaning)"
  - "Agent Proposes, Operator Approves (the operator's job stays one approval; the hold's way through is the agent's own step)"
  - "No Silent Degradation to Brittle Fallback (an unreadable ledger is shown to the judge as unavailable, never as empty; an unavailable card judge is logged)"
  - "Cross-Machine Coherence (posture declared below)"
  - "Occam's Razor (one rule in the existing outbound gate plus one small judge on the Work Board write path; no new service)"
---

# A spec or design approval request must carry its constitution check result

## Problem

Instar has a built-in constitution check: `POST /spec/conformance-check` scores a spec against every standard in `docs/STANDARDS-REGISTRY.md` and returns the standards at risk. It runs automatically, but only inside `/spec-converge`, at the start of each review round. A spec that is brainstormed and reviewed by hand never passes through that skill, so the check never runs, and nothing stops the agent from asking the operator to approve it. That happened on 2026-11-15 in topic 142440.

Echo's own mitigations at the time (a Fable launcher that always attaches both constitution books, a memory note, feedback fb-66fff70e-2d5) depend on remembering. The missing piece is structural: the place where the operator is asked to approve must know whether the check ran.

## Where approval requests reach the operator

Traced in the source:

1. **Messages.** Every agent message to the operator on every channel (Telegram, Slack, the app, WhatsApp, iMessage) passes `checkOutboundMessage` in `src/server/routes.ts`, which runs the LLM outbound gate (`MessagingToneGate`). This is where the incident's request went.
2. **Work Board cards.** An agent-written card (`POST /work-board/cards`), an agent edit, or a `waiting-on` question to the owner asks for the owner's tap. A card about a spec under an approval policy is a spec approval request.
3. **Approval-as-data** (`POST /approvals`) records a decision after the operator made it. It is not a request surface, so it is not gated.
4. **`/spec-converge` output** ends in a convergence report the operator reads before setting `approved: true`; that report already records the check per round. Its delivery to the operator is a message, covered by (1).

## Design

### The signal: a ledger of check results

`POST /spec/conformance-check` now records each run in `state/spec-constitution-checks.json` (`src/core/specConstitutionCheckLedger.ts`): slug (frontmatter `slug:`, else the file name, else a label from the first heading, so an unnamed design still gets a record), title, time, standards checked, degraded flag, at-risk count, the at-risk standard names, and a 16-hex fingerprint of the checked text (which revision was checked). Latest result per slug. Writes are atomic and best-effort. Two size floors, both evidenced and neither an age cut: the file keeps the newest 500 slugs (it is rewritten on every check), and a review sees the newest 25 records (the section rides every outbound review, so its size is paid on every message; 25 compact lines are about 5KB). The cut is never silent: the judge is told how many older records were left out, and that a claimed check which may be among them is not a ground to fire, so no verdict rests on data it was not shown. Each line carries its `checkedAt`, so the judge sees age itself.

`GET /spec/constitution-checks` answers with this machine's records only (it never fans out).

### The authority: rule B25 in the outbound gate

A new rule `B25_SPEC_APPROVAL_UNCHECKED` is rendered on every outbound review except health alerts, with the ledger's recent records as bounded, untrusted data inside a per-call boundary. There is no phrase pre-filter. The LLM fires when (1) the text asks the operator to approve, sign off on or green-light a spec, design, architecture or build plan, and (2) the text does not report the check result (that it ran and what it found), or claims a result that no record matches. It passes non-approval texts, approvals of other things (payments, merges of finished code, purchases, pairing), texts that report a result with a matching record, an honest "the check could not run, because ...", and asks to approve a change to the constitution itself (that has its own process). Under-fire bias applies to whether the text is a spec/design approval ask; once it clearly is and carries no result, the rule fires.

Disposition: `blocking`, and listed in `ADVISORY_MIGRATION_EXEMPT_RULES`. The operator asked that the check be part of every design process; an acknowledgeable nudge would let the same judgment that skipped the check wave the request through. The way through is always the agent's own and cheap: run the check, fold in what it flags, send again with one line giving the result. The operator is never asked to do anything.

When the records cannot be read the judge is told "unavailable" (never an empty list), and judges only whether the text reports a result.

### The Work Board judge

`registerWorkBoardRoutes` takes an optional `specApprovalJudge`. For agent and scoped-session writes (create, `edited`, `waiting-on`), the route sends the fields a person reads to decide (title, need, recommendation, question, options, done items) to `judgeSpecApprovalAsk`: one fast LLM call with the same rule text and records. A fire returns 422 `spec-approval-unchecked` with the issue and the way through; nothing is written. A person's own card is never judged. If the judge cannot answer on the fast tier it tries the balanced tier; if both fail, the write is held with a retryable 503 `spec-approval-judge-unavailable` and logged by name. Nothing is lost: the agent writes the card again a minute later. An agent with no LLM provider configured at all (a standing state, not an outage) is not refused every card write: the write goes through and is logged as `spec-approval-judge-no-provider`. (The first draft let the card through on an outage; the built-in check flagged that against *No Silent Degradation*, and it was changed.)

### Agent awareness

One new entry, `src/data/awareness/spec-approval-constitution-check.md`, tells every agent to run the check before asking and to carry the result line. It reaches existing agents on update with no migration (awareness registry).

## Constitution alignment (checked before building)

- **Constitutional Traceability (parent).** The operator's approval is where traceability is exercised; asking for it before the fit has been judged inverts the order. This change makes the judgment's result a precondition of the ask. No constitution text changes, so *One Constitution, Two Books Aligned* needs no counterpart change: this is an implementation of existing standards in both books.
- **Structure beats Willpower.** The check existed but ran only when the author entered `/spec-converge`. The gate now sits at the approval surface every path goes through.
- **Self-Hosting.** The Standards-Conformance Gate's result is consumed at runtime by the outbound gate and the Work Board, not only by a skill.
- **Signal vs. Authority.** The ledger and the records are signals with no blocking power of their own; the LLM judge, which reads the full text in context, holds the authority.
- **Intelligent Prompts — An LLM Gate Must Not String-Match.** No keyword list decides whether a text is an approval ask; the rule is classified `signal-driven` in `RULE_CLASSES`.
- **Agent Proposes, Operator Approves.** The operator still sees one approval; the request now carries the evidence they need to decide.
- **No Silent Degradation.** A corrupt ledger is rendered to the judge as unavailable, never as an empty list (a missing file is a real empty list). The card judge tries a second model tier, then holds with a retryable, named 503.
- **The Operator Channel Is Sacred.** Concerns inbound operator messages; this gate is outbound and agent-resolvable. The outbound gate's existing availability behaviour (tiered delivery on the operator's own channel when the judge is down) is unchanged.
- **1.x Standards Registry check (the built-in check, run on this spec).** First run, 2026-11-15 09:16 UTC, 98 standards: 4 at risk. *An Instar Agent Is Always a Multi-Machine Entity* (the ledger was machine-local): changed to proxied-on-read. *Judgment Within Floors* (a 30-day cut and a 200-slug cap): the age cut is gone; the two remaining sizes are evidenced floors stated above. *Verify the State, Not Its Symbol* (a record is not bound to the spec revision): each record now carries the checked text's fingerprint; the remaining limit is under Under-block. *No Silent Degradation* (the card judge failed open): it now tries a second tier, then holds. Parent fit: `fit`. Second run, 09:21 UTC: 3 at risk. *Judgment Within Floors* and *Never Silently Cut the Data a Decision Depends On* (the 25-record prompt floor): the cut is now disclosed in the prompt with its count, and a claim that may sit in the cut part is no ground to fire, so the floor limits only how much fabrication-catching reaches very old checks, never a hold. The 500-slug storage floor stays: the busiest agent has 148 checked slugs in total. *Verify the State, Not Its Symbol* (earlier-revision results): accepted as a stated residual (Under-block), because the request carries no spec text to compare at the approval surface; the fingerprint is recorded for audit and the awareness note tells the agent to re-run after changes. Third run, 09:23 UTC: 3 at risk, two of them the same residual from two sides (*Verify the State* and *Structure beats Willpower*: a result from an earlier revision passes, and re-checking after an edit rests on the awareness note). The count stopped falling, so review stops here (80/20 convergence) with that residual stated: binding the request to the revision needs the spec text at the approval surface, which a chat message or a card does not carry. *Judgment Within Floors* still names the two size floors; they stand as stated, with the prompt cut disclosed in-band.

## Multi-machine posture

Proxied-on-read. Each machine records the checks its own server ran and answers `GET /spec/constitution-checks` with them. The reviewing server merges its own records with every online peer's answer through `SpecCheckPeerCache`: the merge never waits on the network (a review uses the last answers and, when they are over a minute old, starts one background refresh), the newest record per slug wins across machines, and peer records are cleaned as untrusted data and tagged with their machine. A peer that does not answer is absent until the next refresh. Holds and nudges go only to the sending agent, so there is no operator-facing notice to gate for one voice. Nothing strands on a topic transfer: the records are per machine and read from all of them.

## Over-block and under-block

- Over-block: a text that mentions approving a design in passing could be judged an ask; the under-fire bias and the PASS list cover the known shapes. A check run on a peer less than a minute before the request (the merge has not refreshed yet), or on a peer that is offline: the agent re-sends a minute later or re-runs the check here. All are cleared by the agent alone.
- Under-block: when the outbound gate's LLM is unavailable and the operator-tier delivery path applies, the message is delivered unjudged, as for every other rule. A request carrying the result of an earlier revision passes if that revision's record exists: the request does not carry the spec text, so the fingerprint is recorded for audit but cannot be compared at the approval surface. The awareness note tells the agent to re-run the check after changing the spec. A spec approval requested by a person other than the agent (outside instar) is out of reach by nature.

## Rollback

Revert the PR. The ledger file is inert without the code that reads it. No migration, no config.

## Tests

Unit (`tests/unit/spec-approval-constitution-check.test.ts`), integration through the real reply route (`tests/integration/telegram-reply-spec-approval-check.test.ts`), the Work Board route suite and the conformance-check route suite.
