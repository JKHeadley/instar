<!-- bump: patch -->
## What Changed

Agents no longer hand the user a step they could do themselves once the user says yes. On Nov 14 a status report told the operator to "pay the $25 Google Play fee from the link in the Android conversation" and reply "paid", while the agent's own browser had the fee page open with the operator's saved card. The only part that was the operator's was approving the $25. The ask also pointed at a link somewhere else instead of carrying it (Echo Bugs topic 10000002731).

- Outbound message gate: a new B17 APPROVAL-NOT-ERRAND sub-clause, judged by meaning on every reply and automated message (never health alerts), with no phrase pre-filter. Every user step is either a DECISION (spend, accept terms, commit, choose: the user decides, the agent carries it out) or truly PHYSICAL or PERSONAL (an ID document photo, a face or fingerprint check, a passkey or code on their own device, a CAPTCHA, a secret only they hold). Payments are decisions: the existing payment carve-outs cover the user's approval, never the user doing the payment. A message that tells the user to do a decision-kind step the agent could carry out, or an approval ask that points at a link posted elsewhere, is held with a suggestion to ask one yes/no approval with the cost, the direct link, and "I'll do it on your yes". When the gate cannot tell whether the agent could do the step, it lets the message through.
- The gate now also sees the agent's browser-profile accounts (the same reach data the B17 REACH sub-clause uses) on every such review, so it can tell "the agent has the signed-in account and saved card" from "only the user can do this". The B17 REACH sub-clause itself is still added only when its errand signal fires. The static gate prompt is unchanged.
- CLAUDE.md: a new "Your Turn to Do It" gravity well. Existing agents get it through the CLAUDE.md migration.

## What to Tell Your User

When something needs your yes, like a fee or a purchase, I now ask one yes-or-no question with the cost and the direct link, and do it myself after you say yes. I only ask you to do a step yourself when it truly needs you in person, like a photo of your ID or a fingerprint check.

## Summary of New Capabilities

- No new routes or settings. Message gate rule B17 sub-clause and CLAUDE.md guidance.

## Evidence

- Unit: `tests/unit/approval-not-errand.test.ts` (sub-clause on reply and automated, never health alerts, no signal needed; reach data once with or without the errand signal; static template unchanged; founding case held, right shape passes; CLAUDE.md template placement and idempotent migration). `tests/unit/reach-aware-false-blocker.test.ts` updated: without the errand signal the REACH sub-clause stays out.
- Integration: `tests/integration/telegram-reply-approval-not-errand.test.ts` (real reply route: founding message reaches the gate with the sub-clause and the reach data and is held under B17; a right-shaped approval ask is delivered).
