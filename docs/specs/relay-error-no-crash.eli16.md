# ELI16: a relay error message can no longer shut the agent down (SEC-136)

The agent talks to other agents through a relay server. Sometimes the relay sends back a short "error" note, for example to say a message was too large or that the agent is sending too fast.

Inside the agent, that note is passed along as an "error" event. The program the agent runs on has a strict rule: if an error event is raised and nothing is set up to handle it, the whole program stops. On the agent's own server nothing was set up to handle this particular one. So any relay, including a misbehaving or hostile one, could shut the entire agent down just by sending a single error note, and it could do it again every time the agent restarted.

The same weakness applied to any garbled message from the relay, such as an empty one or one with a missing part: reading it could also stop the program. Now every message from the relay is checked and handled inside a safety net, so a garbled one is set aside instead.

Now, when nothing is listening for these notes, the agent writes the note in its log and shows it as a problem on its health page, at most once every ten minutes for each kind of error and never more than five times in ten minutes overall, and keeps running. Anything that does listen for relay errors still receives them exactly as before. The note's own words come from the relay, so they only go into the log, trimmed and cleaned; the health page shows just the kind of error.
