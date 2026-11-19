# Convergence Report — iMessage: an SMS that claims to be a contact is not that contact

**Spec:** [docs/specs/identity-security-piece1eb-imessage-sms.md](../identity-security-piece1eb-imessage-sms.md)
**Slug:** `identity-security-piece1eb-imessage-sms`
**Iterations:** 2 (round 2 was a delta check). It was first drafted as section 6 of piece 1b's round 1.
**Final-round design findings:** 0 internal. The cross-model items left are scope rulings recorded in the spec.

---

## ELI10 Overview

The agent can read the owner's Messages app and answer the owner's contacts. A real iMessage is tied to the sender's Apple account. An ordinary text message (SMS) is not, so anyone can send a text that shows a contact's number. Until now, the agent treated such a text as that contact.

Now only real iMessages count. A text that claims to be from a contact is left alone: no session, no reply, and its words and pictures don't reach the agent's conversations. The owner still has it in Messages, and gets a daily count of how many were set aside.

## Original vs Converged

- **Originally:** set SMS rows aside, put their text in a Needs-you item, and let the owner turn the rule off.
- **Piece 1b round 1** found that the Needs-you item is readable by sessions. This spec keeps the words out of it.
- **This spec's round 1** produced these changes:
  - **Constitution check (5 flags):** the blanket opt-out was replaced, and the rollout was stated.
  - **Internal review (4 design):** set the row aside before the reply window opens; never copy its attachments; hide its text on the history route; drop the SMS list, which had no owner-bound way to write it and gave SMS-only contacts nothing, since replies go only as iMessage.
- **The delta converged.** Its build notes were applied: an exact count through one trailing refresh, the local day, an updating item, and wording.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | constitution (5 flags), combined security+adversarial+integration (4), Astra (8, mostly scope) | 4 + 8 | ~12 | set-aside point, attachments, history redaction, SMS list dropped |
| 2 | none (delta converged) | 0 | 5 | build notes only |

## Full Findings Catalog

All answers are in the build state folder: `reviews/p1b-r1`, `reviews/p1eb-r1`.

## Left behind

- An owner-accepted per-number SMS list, written from the owner's own device (piece 4).
- Delivering a set-aside text's words somewhere only the owner can read (piece 4).
- A real SMS from a phone, as a dated daytime check.

## Convergence Verdict

Converged at round 2 (80/20). The spec carries `approved: true` under the approved umbrella and Justin's standing guidance. No constitution text changes.
