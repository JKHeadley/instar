# A Link To The Exact App Message

When you choose Copy Link on an App message, opening that link should take you to that message rather than merely opening the chat. The server checks that you can still read the conversation and the selected message before returning its link. The link contains neither a password nor an access token, and sharing it gives another person no permission to read your chat.

The existing dashboard already highlights selected messages, but an old message may require repeated searches through older pages. This change lets the server find that exact stored message directly. Opening an existing link works even when the server cannot generate a new shareable address. It preserves both message and event identifiers used by older links.

You can read the selected message in its own continuous history window and use Back to latest to return. Your draft and attached files stay intact. Opening an older message does not mark newer messages you have not seen as read. If the message cannot be supplied by this computer right now, the page says so and offers another attempt; it does not claim the message was deleted everywhere. Sending a message, including asking the agent to stop, remains available even if loading history fails. The return to the latest messages happens separately; a failed read cannot block delivery.

This first implementation is for App conversations, whose message records already move through Instar’s existing replication. Exact Telegram and Slack links need further work to retain verified physical source identities across computers. Those findings remain owned alongside quoted replies, forwarding, editing and single-message deletion on the same open card. This App increment does not declare them finished or invent old source information.

The web change still needs its complete server checks and real navigation proof. The Apple app developer owns native menu adoption and release. A source pass or merged change does not establish that the installed server and actual app already support the feature; those checks remain separate before the card can close.
