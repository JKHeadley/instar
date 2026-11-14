# Reopening the app no longer drops a slow machine's items

The dashboard's home page gathers "what needs you" from every one of the agent's machines. If one machine is slow to answer, the page keeps showing that machine's items from the last complete answer for up to two minutes, instead of dropping them or saying part of the page could not be checked. That memory only lived inside the open page, though. Reloading the page, or reopening the iPhone app (which reloads it), wiped it. If a machine happened to be slow at that moment, its items vanished from the list.

Now the last complete answer is also kept in the browser's session storage, which survives a reload of the same tab. After a reload, the page uses it under the same two-minute rule. If the browser does not allow storage, or it is full, the page behaves exactly as before. Nothing new is shown, and nothing older than two minutes is used.
