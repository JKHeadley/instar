# Sharing turns on when a new agent pairs its second machine, in plain words

An agent can live on more than one machine. Today, when a new agent adds a second machine, that machine just sits there. Conversations keep running on the first one, because sharing is switched off unless someone turns on a handful of separate settings by hand.

This change turns sharing on at the moment of the first pairing, and only then. The first machine decides, before it records the new one. It says yes only if this really is the agent's first extra machine, nobody has already made any choice about sharing, and paid routing is not in use. If paid routing is on, the pairing still works but sharing stays off, and the report says why, because sharing would quietly stop paid routing.

Both machines then write the same short list of settings, and the first machine restarts so it picks them up. The Telegram bot token travels inside the pairing itself, sealed so only the new machine can open it, so that machine can answer on the real channel from its first start. No other secret moves.

Sharing begins at a careful level: a new conversation can start on either machine, and nothing already running moves. To get there, the machine needs a signed record saying the pair looks healthy, held steady for ten minutes. That record lasts a day and is renewed while things stay healthy, so if the second machine disappears, sharing steps back down by itself. When it steps down, no new conversation starts on the second machine, but one already there keeps going until it ends, so nothing is stranded or run in two places.

An agent with one machine sees no change, and a test proves it. Agents that already exist see no change either, because nothing happens at update time. Echo's own machines are not touched. To turn it off, one setting does it, and that setting takes effect immediately.
