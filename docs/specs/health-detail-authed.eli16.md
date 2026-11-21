# ELI16: the public health check stops describing the agent's problems in detail (SEC-130)

Every agent server has a "health check" address that anyone can open, even without signing in. Other machines, monitoring scripts and the agent's own helpers use it to ask one simple question: is this agent up and working?

Until now that public answer also included a written list of whatever had recently gone wrong, plus a breakdown of how the agent's AI helpers were doing. Those notes are written for the agent's owner, and they often name real things on the machine: folder paths that include the computer's user name, account names, conversation names, or a short summary of a file conflict. Anyone who knew the agent's public web address could read them.

Now the public answer only says whether the agent is fine or degraded, how long it has been running, and how many problems it has seen. The detailed notes and the AI-helper breakdown are only included when the caller signs in with the agent's own key, which is how the owner's dashboard, the agent's own health-check job and its other machines already ask. So nothing the owner sees changes, and the "degraded" signal itself still reaches everyone who checks.
