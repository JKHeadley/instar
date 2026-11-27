# Takeover with no shared lease medium: in plain words

**What this is about.** An agent on two machines needs exactly one of them answering at a time. They agree
through a "lease": a signed note saying who is in charge, renewed every so often. If the machine in charge
dies, the other should take the note and carry on.

**What goes wrong today.** On a pair with no git remote, that doesn't happen. A test on real servers
showed the backup never took over in 20 minutes. There are three reasons. The backup writes the note, tries to
push it somewhere that doesn't exist, and then reads its own note back as if someone else had won. Even
past that, whoever survives can't renew, because renewing needs another machine to confirm it, and the only
other machine is dead. So it drops the lease every 90 seconds, grabs it again, and repeats. A machine that
lost its network does the same.

**What changes.** Three small things. The backup understands that with no remote, its local write is the
write. Whoever holds the note keeps it without confirmation, as long as nobody is named as the preferred
machine, and only a newer note ends that. And a machine coming back from a restart asks the others before
taking back its old note.

**What this does not fix yet.** Holding the note isn't the same as answering. A backup also has to start
listening to Telegram and start the scheduled jobs. Both are needed before this goes on for anyone.

**The trade-off.** With two machines and nothing else to ask, a dead partner and a broken link look the same.
So if the link breaks, both machines may think they are in charge until it comes back, and then the newer
note wins. If both still have internet, messages may arrive unpredictably during that time. The alternative
is that the agent goes silent when its partner really dies, which defeats the point. Anyone who prefers the
old rule can name a preferred machine.

**What stays the same.** All of this sits behind an existing switch that is off by default, so nothing
changes for anyone yet. One-machine agents are untouched. The switch only goes on for new pairs after a
real power-off test and a real link-cut test pass.

**If it goes wrong.** Turning the switch off puts the old behaviour back straight away.
