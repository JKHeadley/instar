# Why the Mama PC kept holding automatic messages, in plain words

Only one of the agent's machines is allowed to send Telegram messages at a time. It holds a "lease", like a talking stick. The other machines hand their messages to it.

When the Mama PC restarts, for a few seconds it does not yet know who holds the talking stick. The old rule said: if the machine pool feature is switched off and we don't know who holds the stick, just send the message ourselves. But the send then gets refused, because the Mama PC is not the stick holder. The message is put aside to retry only when the stick comes to the Mama PC. The Mama PC is a permanent helper machine, so the stick never comes, and the message sits there for 6 hours and then expires. That is the pile of "held replies" Justin kept seeing, mostly notices like "a session got stuck".

The new rule: if the machine has partner machines, it waits up to 15 seconds for the stick question to settle, then hands the message to whoever holds it. If it still cannot tell, the message goes onto the normal retry list for handed-over messages, which keeps trying until the holder answers. A machine with no partners keeps the old instant behaviour, so single-machine agents are not slowed down.

Nothing new is switched on, nothing is deleted, and the change can be undone by reverting it or by turning off forwarding. Messages already held stay until their 6 hours run out; the fix stops new ones from piling up.
