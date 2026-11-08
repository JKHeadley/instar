# Telegram test groups through the browser broker, in plain words

To prove a Telegram feature really works, Echo spins up a throwaway agent and needs a fresh Telegram group for it: a forum group with a test bot as admin and Justin as the one human in it. Bots cannot make groups, so the group has to be made by Justin's own Telegram account.

Justin's signed-in Telegram web page now belongs to one careful component, the broker. It only lets other parts of Instar do two things with it: read what is on screen and send a signed message. Everything else, like copying the profile or clicking around in it, is refused on purpose. That is good for safety, but it means nobody can make a test group any more without asking Justin to do it by hand, and making him do chores is exactly what we try to avoid. Two live tests are stuck because of this.

**What this adds.** Three very narrow actions on the broker: "make a test group", "list my test groups" and "delete a test group". Making one only works if the name starts with "Instar test - ", only with a bot on an approved list, and it checks afterwards that the group has exactly two members (Justin and that bot) and that the bot has only the three rights it needs for topics. If any step fails, the half-made group is deleted again.

**How it knows which groups are its own.** Every group name ends with a short code like [itg-k3m9q2x7ab]. Half of that code is a signature made with a secret key only Echo holds for this, so nobody else (not another agent, not a group someone names by hand) can produce a code that checks out. Delete only works on a group Justin's account created, that is still a forum group, and whose name carries a code that checks out. Because the proof lives in the group's own name, losing the activity log breaks nothing: listing reads the real account.

**What keeps it safe.** Making groups is off until a setting names the approved bots, and that setting expires within 30 days. No secret keys from Telegram ever come back out. There is a cap of 5 test groups at a time and 10 per day, and if Telegram says "slow down" it waits. Every action is written to a log with who asked for it. It never jumps ahead of Justin's replies: while a reply is waiting, its reservation is kept alive, and test-group work is only started when nothing else is queued.

**What you need to decide.** Nothing. Echo approves this under the standing rule. The live test uses the spare test bot and deletes its group afterwards.
