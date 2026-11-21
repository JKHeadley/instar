# ELI16: messages between your machines say where they are going (SEC-147)

Your agent runs on several computers, and they talk to each other: who is in charge right now, handing the lead from one to another, sharing live updates. Each computer signs its messages, so the others know who sent them.

The signature says who sent a message, but not which computer it was for or what it was asking. So someone on your network who copied a message going to one computer could, within half a minute, send that same signed message to a third computer, even as a different request, such as "hand over the lead". The third computer would accept it.

Now every updated computer adds a second signature that also names the request and the computer it is meant for, and an updated computer checks it. Older computers simply ignore the extra signature and keep working, so nothing breaks while your computers update at different times.

Each computer keeps track of which of the others are already sending the new signature. When every computer reports that all the others send it, the agent asks you once whether to stop accepting the old kind. If an older computer is refused later, the agent tells you which one and lets you let it back in with one tap.
