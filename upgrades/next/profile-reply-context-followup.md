<!-- bump: patch -->
# Explain A Reply From Verified Facts

## What Changed

Question context now distinguishes a verified native reply from whether its wording is an exact yes. A successful question or reminder API also returns its actual delivered-message receipt and says that this operation has already supplied the user-facing reply. This helps agents avoid repeating approval instructions or falsely blaming a missing reply link.

## What to Tell Your User

When your answer needs a plain yes, the follow-up should explain that accurately. The reminder already sent in the conversation is the reply; I should not add another confusing explanation.

## Summary of New Capabilities

The existing question APIs add questionDelivery, settingsApplied:false and replyAlreadyDelivered:true only after verified delivery and active registration. Existing request bodies, owner checks and exact-yes consent stay unchanged.

## Evidence

Focused unit, HTTP and lifecycle regression checks passed, as did typecheck and a scoped independent review. A fresh controlled Telegram exercise remains required. The original false explanation remains preserved as DF-0010. No clean live outcome, complete verification or deployment is claimed by this draft fragment before that evidence is attached.
