# Telegram should say when a message is really delivered

A message to the Scaling conversation showed “Delivered” even though Instar was still trying to route it. The conversation pointed to a machine that was offline, and the message eventually expired from the queue. We recovered it and Scaling answered it later.

The earliest acknowledgement now says that Instar received the message. If the delivery queue takes custody, it can say the message is waiting. If it runs out of time or attempts, the notice says the message expired without a confirmed handoff. Where Instar can match a journaled delivery to the exact input in the active session’s transcript, it can say the session received it. Those notices do not count as a reply to any message in the conversation, so an unanswered question stays open.
