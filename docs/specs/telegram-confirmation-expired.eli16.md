# When Telegram stops confirming a send

If Telegram has not confirmed a send within 30 minutes of a connection failure, the delivery check says the confirmation window expired and delivery is still unverified. Sending again could create a duplicate. If a receipt tied to that send becomes available later, the check shows the confirmed result.

A connection can close while Telegram is sending back its answer. At that point the sender knows the request went out, but has no message ID to check. For the next 30 minutes the delivery check says the outcome is unknown. After that, it explains that confirmation expired. The same result is available from another machine when it asks the machine that sent the message.

A missing entry in the topic is insufficient evidence that the message failed. The expiry result keeps the original send closed to retries. If a trustworthy receipt later identifies the exact message, the delivery check uses it. If Telegram confirmed some parts of a multi-part message, the existing result continues to show which parts arrived. The sender sees the new wording when checking the operation.
