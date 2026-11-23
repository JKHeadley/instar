# Mentor messages must prove which bot sent them (SEC-154)

An agent can be set up as a "mentee": when its mentor agent sends it a specially marked message, it starts a working session to answer. It is meant to accept that only from the mentor it was told about, recognised by the mentor's bot id. But the check compared bot ids only when a bot id was given. A caller that simply left the bot id out was waved through as the mentor, and could make the mentee start a session on any instruction. Two agents on the Mac Mini had this switched on.

Now a message with no bot id, or a different one, is refused. The same-machine delivery route also checks who is calling, the same way the signed route between machines already did: the caller must name itself, the message must name that same sender and this agent, and the sender must be another agent registered on the same computer. The real mentor's messages work exactly as before.
