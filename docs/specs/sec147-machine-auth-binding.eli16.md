# ELI16: messages between your machines say where they are going (SEC-147)

Your agent runs on several computers, and they talk to each other: who is in charge right now, handing the lead from one to another, sharing live updates. Each computer signs its messages, so the others know who sent them.

The signature says who sent a message, but not which computer it was for or what it was asking. So someone on your network who copied a message going to one computer could, within half a minute, send that same signed message to a third computer, even as a different request, such as "hand over the lead". The third computer would accept it.

The fix adds a second signature that also names the request and the computer it is meant for. It arrives in three updates, spaced out so every computer has time to catch up. First, computers learn to check the second signature when it is there. Next, they start sending it. Older computers ignore it and keep working. Last, they stop accepting messages without it, which closes the gap for good.

You don't need to do anything. The one exception is a computer kept on a very old version. Once the last update arrives, its messages are refused, and the agent tells you which computer it is. You can let it back in for a while with one tap, until it is updated.

The first update, which comes before the others, only teaches your computers to check the second signature. None of them send it yet, so nothing you see changes.
