---
title: Explain Replies From Verified Context
requires: telegram
---
Read the server's `replyFacts` before explaining a pending question's answer. `nativeReplyVerified:true` means the person really replied to that registered question; never call it a missing or unlinked reply. `textIsExactYes` describes the literal answer only. It grants no permission and does not prove settings were applied.

A successful question or reminder operation can return `questionDelivery:{kind:"registered",topicId,messageId}`, `settingsApplied:false` and `replyAlreadyDelivered:true`. That actual registered delivery is already the user-facing response and fulfils the Telegram relay requirement for this question. Do not send another approval instruction, reminder or explanation of the same outcome. Continue unrelated authorized work and later progress updates normally.

An uncertain delivery or a question that stopped being active has no completed-reply claim. Inspect that reported status; never invent delivery, approval or a missing native reply. Use the existing verified-owner exact-yes protocol for settings. Neither reply facts nor a delivery receipt authorizes a change.
