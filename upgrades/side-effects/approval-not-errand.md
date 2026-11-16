# Side-Effects Review — an approval handed over as a chore (B17 APPROVAL-NOT-ERRAND)

**Version / slug:** `approval-not-errand`
**Date:** `2026-11-14`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Echo Bugs topic 10000002731 (reported 2026-11-14 11:20 PST): a status report told the operator to "pay the $25 Google Play fee from the link in the Android conversation" and reply "paid". The agent's browser already had the fee page open, signed in to the operator's account with the saved card; the only operator-owned part was approving the spend. The ask also pointed at a link posted elsewhere. The static B17 and B21 carve-outs ("legal / billing / payment authorization") read "payment" as human-only, so the gate passed it. Root cause upstream: a "Justin pays" label in an earlier brief carried forward unchecked.

- `src/core/MessagingToneGate.ts` — new exported `B17_APPROVAL_NOT_ERRAND_SUBCLAUSE` (decision vs physical/personal; payments are decisions; the payment carve-outs cover the approval, not the doing; the direct-link condition; PASS cases; capability-uncertainty default; under-fire bias). `renderApprovalNotErrand()` adds it as a dynamic section to every review except `health-alert`, with NO phrase pre-filter (operator direction for this class: judge by meaning, never string-match). It renders the agent-reach DATA (without the REACH sub-clause) when the errand-gated reach section did not already render it, so reach appears once per prompt. `renderAgentReach()` gains a `withReachSubclause` flag (default true, existing call unchanged). The pinned static template `TONE_GATE_PROMPT_TEMPLATE` is byte-identical.
- `src/server/routes.ts` — the outbound review path now builds `agentReach` for every non-health-alert review (was: only when the errand signal fired on a reply). The errand signal itself is unchanged. Fail-open as before.
- `src/scaffold/templates.ts` — `APPROVAL_NOT_CHORE_TRAP` gravity well ("Your Turn to Do It"), placed after "Someone Else's Work".
- `src/core/PostUpdateMigrator.ts` `patchClaudeMdContent` — inserts it into legacy CLAUDE.md files after the "Someone Else's Work" trap (else appends); content-sniffed by marker, idempotent. Reference-layout agents get it through the canonical rebuild from `generateClaudeMd()`.
- Tests: `tests/unit/approval-not-errand.test.ts` (new), `tests/integration/telegram-reply-approval-not-errand.test.ts` (new), `tests/unit/reach-aware-false-blocker.test.ts` (one test updated: reach data now renders without the errand signal, the REACH sub-clause still does not).

Part (c) of the fix direction (every ask carries its direct link) is the PR 3097 CLAUDE.md standard; this change adds the gate-side check of it for approval asks (the "link posted somewhere else" condition) and repeats it in the new trap text. It does not touch PR 3097's files.

Tier 1 (wording and checking change a revert fully undoes). Size: 4 source files, 3 test files, about 120 lines of source. One review round; first commit attempt.

## Decision-point inventory

- `MessagingToneGate B17_FALSE_BLOCKER` — modify — adds a meaning-judged sub-clause to the LLM judge for outbound replies and automated messages.
- Agent-reach context — modify (wider input) — DATA only, now supplied on more reviews.
- CLAUDE.md trap — guidance text, no decision surface.

---

## 1. Over-block

The sub-clause could hold a message that asks the operator to do a step the agent genuinely cannot do but which the gate reads as agent-doable — for example a payment where the card is not saved, or a sign-up that needs the operator's phone. Mitigated by: condition (2) requires the agent's means to be SHOWN (message, recent conversation or reach data); the explicit PHYSICAL / PERSONAL list; the CAPABILITY-UNCERTAINTY DEFAULT and UNDER-FIRE BIAS (unsure → pass); PASS when the operator asked to do it themselves. B17 is a BLOCKING rule exempt from the advisory migration (`ADVISORY_MIGRATION_EXEMPT_RULES`), so a hold is a hard 422 the agent cannot acknowledge away: an over-fire costs a rewrite, and a message that genuinely must go out as written would be stuck. That is why condition (2) requires the agent's means to be SHOWN — a step merely being on a web page does not count (tightened after the second-pass review) — and why the safe rewrite the suggestion names (one yes/no approval, the cost, the link, "I'll do it on your yes") always passes. Reach data being present on every review could make the judge more willing to fire the existing static B17 on other asks; the reach lines are labelled DATA and last-asserted, and the REACH sub-clause (the rule that interprets reach for look/check errands) is still errand-gated.

## 2. Under-block

The gate sees only text plus reach data: if the agent's means are not visible in either (e.g. the page is open in a profile not listed, or the conversation context window does not include the earlier "I have it open"), the judge passes by the uncertainty default. A Haiku-class judge may miss the shape in a long multi-topic status report. The upstream cause (an old "user pays" label copied forward) is addressed only by guidance (the CLAUDE.md trap), not structurally; the outbound gate is the structural backstop for its effect. Messages sent by paths that bypass the tone gate (none for operator replies on the standard routes) are not covered.

## 3. Level-of-abstraction fit

Right layer: the outbound gate is the single authority that already judges "hands the user agent-doable work" (B17/B21); this extends B17 in place rather than adding a parallel check. It rides the same dynamic-section slot as the REACH and UNOWNED-HANDOFF sub-clauses, so the benchmark-pinned static template is unchanged.

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed).

No brittle logic gains authority: there is no regex or phrase list at all; the whole judgment is the LLM's, by meaning, with an under-fire bias.

## 4b. Judgment-point check

No new static heuristic. The only code decision is which kinds get the section (all except health-alert), a scoping choice, not a judgment of content.

## 5. Interactions

- B17 static carve-outs for payment/billing authorization: the sub-clause explicitly narrows them to the approval (same override pattern as the REACH sub-clause narrowing the access-grant carve-out). B21's payment carve-out is narrowed the same way by explicit reference; B21 is still the rule for multi-step procedures, and citation precedence (B15 > B16 > B17 > B18 > B21) is unchanged.
- STANDING-AUTHORIZATION sub-clause: if a grant already covers the spend, re-asking is that sub-clause's domain; the new one only concerns handing over the doing, so they do not conflict (a message could be held by either; both cite B17).
- REACH sub-clause: when the errand signal fires, the reach section renders once with the REACH sub-clause, and the new section renders without a second copy of the reach data (tested).
- B19 PARKED-ON-USER: its carve-out "GENUINE USER DECISION ... spend" still passes a real decision question; the new sub-clause also passes a pure approval ask, so no conflict.
- Prompt size: about 450 tokens more per non-health-alert review, plus the reach lines (bounded by agent-reach's account cap). Response budget (200 tokens) unchanged.
- `buildAgentReach` now runs on every non-health-alert review: it lists browser profiles from the registry (a small local file read); fail-open on error.

## 6. External surfaces

Outbound operator messages that hand over an approval-kind step may now be held with a hard 422 under B17 (not overridable; the agent rewrites). No change to what other agents or users receive except better-shaped asks. The benchmark-pinned static template hash is unchanged, so the benchmark-divergence detector stays valid. Agent-installed files: CLAUDE.md gets one paragraph on update.

## 6b. Operator-surface quality

No operator UI. The operator-visible effect: asks arrive as one yes/no approval with the cost and direct link, and the agent does the step after the yes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: prompt text and CLAUDE.md are installed per machine by each machine's own update. The reach data is machine-local by nature (each machine's own browser profiles), which is correct: the question is whether THIS agent, on this machine, can do the step.

## 8. Rollback cost

A revert restores the old gate prompt and reach scoping immediately on server restart. The CLAUDE.md paragraph would remain on agents that received it (harmless guidance).

## Conclusion

Extends the existing B17 authority to the "approval handed over as a chore" shape, judged by meaning with no phrase filter, under-fire biased, static template unchanged. Safe to ship.

## Second-pass review (if required)

Independent subagent reviewer, 2026-11-14: Concern raised. (1) B17 is blocking and exempt from the advisory migration, so §1's "advisory the agent can acknowledge" was wrong; (2) condition (2)'s "or the step is plainly on a web page the agent drives" made the means count as shown for almost any sign-up or form, contradicting the uncertainty default. Checked fine: rendering (reach once, health alerts excluded, REACH sub-clause still errand-gated, static template unchanged), interactions with STANDING-AUTHORIZATION / UNOWNED-HANDOFF / B19 / B21, migration idempotency, signal-vs-authority compliance. Non-blocking notes: B18's operator-only-residual list still names "a legal/billing/payment action" (left as is: a stop that reduces the run to a payment APPROVAL is still a legitimate residual; the new sub-clause governs how that ask is worded, not whether the run may stop on it); reach data on every prompt is not separately measured; one registry file read per review.

Fixes applied: the "plainly on a web page" alternative was removed and replaced with "a step merely being on a web page is NOT enough: the means must be shown" (asserted in the unit test); §1 corrected to say a B17 hold is hard. Re-check below.

Re-check (same reviewer): concern raised on two leftover "plain" wordings (the PASS case "not shown and not plain" in the prompt, "or plain" in §1) and §6 still calling the hold advisory. All three fixed: the PASS case now reads "the agent's means to do it are not shown", §1 and §6 corrected. Otherwise concurred, including the B18 answer.

Concur with the review

## Evidence pointers

- `tests/unit/approval-not-errand.test.ts`
- `tests/integration/telegram-reply-approval-not-errand.test.ts`
- `tests/unit/reach-aware-false-blocker.test.ts`, `tests/unit/someone-elses-work-gravity-well.test.ts`, `tests/unit/benchmarkDivergenceRegistry.test.ts` — still green.

## Class-Closure Declaration (display-only mirror)

The class is "an operator ask that hands over agent-doable work"; the gate side now covers its approval/payment form, which the static carve-outs had exempted. The producing side (a stale "user pays" label) is covered by guidance only; stated in §2.
