# Keeping a message's delivery attempts for actual sends

A queued Telegram reply can currently use up its delivery attempts without making a single call to Telegram. The server records that it intends to send, then asks the credential owner for short-lived permission to start the request. If that permission is unavailable, or expires before it can be used, the refusal still counts against the message's transport budget. A prolonged local problem can therefore leave the reply abandoned despite never having sent it.

This repair changes the accounting at that boundary. The part of the server that actually calls the network records private evidence when it stopped before that call. The message store uses that evidence to return just that attempt's transport budget. It retains the original message, its recorded author, the intended dispatch and the local failure in the audit trail. It does not return a credential-capacity credit or grant permission to send.

Recovery still waits between tries and stops at the original deadline. A restart does not reset those limits. If the server crashes before saving the evidence, delivery stays uncertain; the repair does not guess that the message was unsent. Likewise, a timeout or error after calling Telegram cannot use this accounting change to authorize a duplicate send.

Operators and agents should continue inspecting the original message rather than manually reposting it. This repair addresses local capacity refusals. It does not claim that every held message will arrive or that messages with unknown Telegram acceptance are resolved. The release must pass unit, HTTP, production-restart and full-suite checks before activation.
