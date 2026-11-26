# A machine that cannot serve a message says so: in plain words

**The problem.** When one of an agent's machines passes a message to another, the second machine says "got it"
first, and only then checks whether it can do anything with it. If it can't, for example it has no Telegram
connection, it just stops. The first machine believes the message was delivered, so nobody answers and nobody
knows. A freshly added second machine has no Telegram, so turning on multi-machine conversations for new agents
would lose messages this way. It also means switching the feature off with conversations open could lose them.

**What changes.** The second machine checks first. If it can't serve the message, it answers with a reply the
first machine already understands as "this is still yours", and it keeps no record of having received it. The
first machine then handles the message itself.

**Why reuse an old reply.** Machines on older versions already know what to do with it, so this helps as soon as
any one machine updates. A new kind of reply would need every machine updated first.

**What stays the same.** A machine that can serve a message behaves exactly as before. One-machine agents never
use this path. There is no setting to change and nothing new to learn.

**What this does not do.** The first machine may still try a machine that can't serve, costing one extra hop per
message. Teaching it not to is a separate piece of work, because that changes where live conversations go.
