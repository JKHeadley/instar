# ELI16: messages between your machines say where they are going (SEC-147)

Your agent runs on several computers, and they talk to each other: who is in charge right now, handing the lead from one to another, sharing live updates. Each computer signs its messages, so the others know who sent them.

The signature says who sent a message, but not which computer it was for or what it was asking. So someone on your network who copied a message from one computer to another could, within half a minute, send that same signed message to a third computer, even to a different request, such as "hand over the lead". The third computer would accept it.

Now every updated computer signs a second line that also names the request and the computer it is meant for, and an updated computer checks that line. Your computers don't all update at the same moment, so older ones keep working: they still get the old signature. But once a computer has seen the new signature from another, it refuses that other's messages without it, so a copied message stripped of the new line doesn't work either. When every computer is updated, the agent offers to turn off the old kind entirely.
