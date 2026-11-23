<!-- bump: patch -->
# Keep Confirmation Reminders And Their Answer Records Together

## What Changed

A reminder now carries a verified link to the particular owner reply it answers. After actual delivery and registration, the unanswered-message monitor can record that exact reply as answered while leaving other messages pending. Failed bookkeeping writes restore the last committed state, and a delivered response remains known if its original input must be admitted again.

## What to Tell Your User

If your answer needs a plain yes, I should send one accurate reminder and avoid a second confusing explanation. The message monitor should recognize that delivered reminder. Any other question in your message still needs its own answer.

## Summary of New Capabilities

Existing question APIs return the real questionDelivery receipt, settingsApplied:false and replySettlement.status. The replyAlreadyDelivered flag covers only an actual privately bound registered question response. Initial questions without that binding do not claim an owner turn is fulfilled. Owner checks and exact-yes consent are unchanged.

## Evidence

Focused unit, HTTP and lifecycle checks cover the exact reply binding, persisted state, failed writes, same-ID redelivery and stale monitor judgments. The initial real Telegram communication exercise is retained as a signed FAIL. A fresh complete small live matrix and normal exact-head verification remain required before release; this fragment does not claim a clean live result or deployment. Restart and transfer continuity is tracked in ACT-457.
