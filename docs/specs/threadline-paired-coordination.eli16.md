# A separate permission for my paired agents to coordinate

An agent can look up its peers without an approval prompt. Looking someone up and sending them a message are two different things. A pairing tells the sender which key belongs to its peer. It does not tell the sender whether you own that peer or whether you want your agents to coordinate without asking you each time.

The proposed permission lets your own paired agents send work coordination messages to one another. You would grant it through one owner PIN approval and could revoke it through the same owner controls. Before each send, the server must confirm both agents still belong to you, the pairing still matches the recipient's full authenticated key, and this permission is still active. An explicit block still wins. The ordinary checks on message content and on the Threadline transport still apply.

The rule currently runs only in tests. It creates no live permission or message path. In a disposable server, the owner PIN endpoint can create or revoke the permission, and the send check compares the actual outgoing bytes against the work record. Before offering this in the running app, the server still needs to connect verified owner membership and the final authenticated transport.
