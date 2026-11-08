# Retried replies no longer wait forever for a sleeping machine

When a Telegram reply cannot go out the first time, the server retries it. Before each retry it asks all the agent's machines for the conversation's history, so it does not send an answer the conversation has moved past.

If one machine is asleep, that question never gets a full answer. The server treated that as "hold", every time, until the reply expired hours later, with a dashboard record but no message to the person. On 2026-11-07 a morning status to the operator stuck this way because the Laptop was off, while other conversations in the same chat worked.

Now the wait for a machine that cannot answer ends 15 minutes after the reply was written. The reply then goes out at the next retry, usually about 24 minutes after it was written. If any machine that did answer shows a newer message, the reply is still retired, as before. If the history read fails completely, or the page is full, it still holds.

The cost: a reply might go out when a newer message exists only on the sleeping machine. This changes an earlier choice to wait rather than guess, made after a reply landed 28 minutes late over the operator's own answer. That case still retires the reply, because the answer is visible on a machine that can respond. Only a newer message held solely by the unreachable machine is missed. Also, if two replies are queued in one topic, the older one going out still retires the newer one, with no notice; that rule already existed, and it can now happen here.
