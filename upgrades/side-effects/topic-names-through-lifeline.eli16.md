# New topics show their real names on the dashboard

When you create a topic in the agent's Telegram group, Telegram announces it with a small "topic created" note that carries the topic's name, and nothing else: no message text. On most of your machines the agent does not read Telegram directly. A small helper process (the lifeline) reads Telegram and hands each message to the agent's server. That helper threw away anything without text, so the "topic created" note, and with it the name, never reached the server. The dashboard then showed those conversations as "Conversation name unavailable", which is what you would have seen for several topics created today.

Now the helper passes the name on whenever it sees one: from the "topic created" or "topic renamed" note, and also from ordinary messages, because Telegram attaches the topic's creation note to each message in a topic. So the topics created today will get their names the next time anyone writes in them, and new topics get their names straight away.

Only the helper itself (which proves who it is with a secret) can set a name this way, so nothing else running on the machine can change what your topics are called.
