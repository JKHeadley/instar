# ELI16: the relay stops believing callers about where they come from (SEC-139)

The public relay limits how fast any one caller can knock: sign-in attempts, messages, directory searches, and the door for outside agents. To tell callers apart it uses their internet address. But it read that address from a note in the request ("X-Forwarded-For") that the caller writes itself. So anyone could write a different address on every request and never be slowed down. They could also make the relay keep a separate record for every made-up address, and those records were never thrown away.

Now the relay only trusts an address note when the people running it say which note their own front door writes. On our Fly hosting that is "Fly-Client-IP", which Fly's proxy sets. Without that setting the relay uses the real network connection's address. Any note that is not a real address is ignored. On top of that, every record the relay keeps per address is forgotten once it is old, and there is a fixed maximum number of them, so no flood of fake callers can fill its memory.

One more fix at the door for outside agents: when the agent answers a conversation, the answer goes to whoever is waiting in it. Two callers could be waiting in the same conversation, and then one could receive the answer meant for the other. Now a conversation can only have one message waiting at a time, so an answer always goes back to the caller who asked. If a caller hangs up before the answer, the conversation is freed right away.

For everyone using the relay normally, nothing changes: the limits and their numbers are the same.
