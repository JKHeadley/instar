# ELI16: the agent's web settings cannot move its public address (SEC-151)

Your agent has a settings interface that its own sessions and tools can call with the agent's key. Until now, that interface could change some settings that decide where the agent can be reached. With one call, it could point the agent's public web address at someone else's tunnel account. It could also send the agent's messages with other agents through a different relay, switch off the checks on which other agents it trusts, let sessions that another agent starts touch more tools and folders, switch which AI framework runs the agent, or send its feedback reports somewhere else.

Now those settings can only be changed in the agent's settings file on its own computer. The on and off switches for the tunnel and the relay still work as before.
