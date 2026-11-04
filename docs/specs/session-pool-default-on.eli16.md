# Default-on for new multi-machine agents, step 1: in plain words

**What we want.** A person who adds a second machine to their agent should get conversations that work
across both, without configuring anything.

**Why we can't just flip a switch.** Checking the code showed four things:

- New agents have no way to earn their way up the stages. The only check that does it needs the source
  code, which a normal install doesn't have.
- The first stage was described as watch-only, but it really routes conversations.
- On a normal install, a second machine can't yet serve those conversations: it has no Telegram
  connection, follow-up messages can't reach it, and it forgets who owns what after a restart. Turning
  routing on today would lose messages.
- If the main machine dies and the pair has no git remote, the backup never takes over. This is a bug.

**What this step does.** It changes no routing and no settings. It adds a report any agent can read:
for each other machine, can it be reached, is its clock right, does it have room, can it hear
Telegram, and so on. Each answer is ok, failing or unknown, in plain words. The agent keeps an hourly
log of it. When you pair machines with no git remote, you're told plainly that automatic takeover
doesn't work yet.

**What stays the same.** A one-machine agent sees nothing new. Agents already paired keep working
exactly as they do.

**What comes next.** Step 2 turns routing on at pairing, after fixing the gaps this report shows. Step 3
adds moves on request and takeover. Step 4 adds automatic rebalancing. Each step has to pass measured
tests on real test machines first.
