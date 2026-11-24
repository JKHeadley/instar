# Know When The Agent Is Working In Your Chat

An open chat should tell you when the agent is working on a reply. Today, the server can tell that a session exists, but a session can stay open while doing nothing. Showing that as working would be misleading.

This change will use small observations from the tool running the agent. It will connect those observations to the exact conversation and current session. The web chat will show the result, and the server will provide the same information for the other apps to adopt. It will not show private prompts, tools or files as part of that signal.

The signal needs to be honest when information is missing. A computer that cannot be reached, an older tool that does not report events, or a server that just restarted cannot tell us whether work is happening. Those cases must remain uncertain. A helper finishing must not make the main agent appear finished. An old session must not change what the replacement session shows.

The first supported version would use activity events from a managed Codex connection. We verified that a real isolated Codex terminal can report the start and end of the same turn through that connection. The managed launch and browser still need to be verified together before the indicator can ship. Other launch types and providers will leave it hidden until their evidence can be verified.

This does not change what messages the browser saves on disk. It does not send, stop or restart anything. Your draft and selected files must stay in place when the indicator changes. The connection line can say Updating while messages catch up, independently of whether the agent is working.

The next acceptance check is a real browser connected through the production server path: observe the correct chat changing, an unrelated chat staying unchanged, completion clearing correctly, and missing evidence staying uncertain. This draft is not approved, implemented or shipped yet.
