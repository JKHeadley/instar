---
title: Explain Replies From Verified Context
requires: telegram
---
Read the server's `replyFacts` before explaining a pending question's answer. `nativeReplyVerified:true` means the person really replied to that registered question; never call it a missing or unlinked reply. `textIsExactYes` describes the literal answer only. It grants no permission and does not prove settings were applied. Keep the original incoming text intact.

A verified native numbered-only answer such as `1) yes`, or the quoted-current-question-plus-yes fixture, needs one registered reminder through the server-provided operation. It applies nothing. Do not substitute an ordinary acknowledgment or send an extra approval instruction or invented missing-reply explanation. If the question may have changed or expired, inspect its current status before sending a reminder. Never approve settings from nonexact prose.

A successful operation can return `questionDelivery:{kind:"registered",topicId,messageId}`, `settingsApplied:false` and `replyAlreadyDelivered:true`. That flag fulfills ONLY this registered approval question's relay requirement, even when `replySettlement.status` is `pending`; it never means unrelated work in the incoming message is complete. Do not send the approval question again. A delivered question without the verified claimed owner-turn binding keeps `replyAlreadyDelivered:false`: its receipt does not fulfill the ordinary response workflow or settle an input through this seam.

Assess independent questions or work before treating a reminder as the sole response. For “1) yes. Also, what is 2 + 2?”, send one registered reminder AND answer 4 through the ordinary response path, without repeating approval instructions. Answer or track longer independent work through the existing follow-through workflow. Continue unrelated authorized work and later progress updates normally.

Monitor bookkeeping is distinct from delivery. `replySettlement.status:recorded` means the exact obligation was persisted; `pending` means actual proof awaits reconciliation after ordinary storage-write progress. `unbound`, `not-required` and `unavailable` do not claim a new exact write. Do not send a broad topic-wide acknowledgment to compensate for a bookkeeping failure: it could clear unrelated inputs. Do not resend a registered question or reclaim a handle merely because persistence is pending. Quiet transport recording, refusal and unknown acceptance are not positive platform delivery.

An uncertain send or a question that stopped being active has no completed-relay claim. Inspect the reported status; never invent delivery, approval or a missing native reply. The existing verified-owner exact-yes protocol alone applies settings. Neither reply facts nor a delivery receipt authorizes a change, certifies every task finished, or proves restart/transfer continuity.
