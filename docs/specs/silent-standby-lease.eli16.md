# Silent-standby lease — explain it like I'm 16

Imagine two computers (a laptop and a Mac mini) that are supposed to act like ONE
assistant. Only one of them is allowed to be "in charge" at a time — the one in
charge answers your texts. They decide who's in charge with a thing called a
"lease": a numbered permission slip that says "I'm the boss right now, this is
slip #105." Whoever holds the highest-numbered slip is the boss, and the other
machine is supposed to just watch and agree.

We were trying to get the laptop to hand a live conversation over to the mini
("move this to the Mac Mini"). It kept failing, and we chased the reason down
through several layers. The last two layers are what this change fixes.

**Bug #4 — the mini couldn't find its own ID card.** Every machine signs its
messages with a private key, like a signature on a letter so the other machine
knows it's really them. The code that loads that key only looked for a file named
`signing-key.pem`. But the mini's key was saved years-ago-style under an older
name, `signing-private.pem`. So when the mini tried to start the part of itself
that watches the lease, it couldn't find the key, threw an error, and quietly gave
up on the whole "watch the lease" system. That's why the mini never knew who the
boss was — it never even turned that system on. The fix: if the new-name file
isn't there, also check the old-name file before giving up. (The texting part of
the mini already did this; the lease part had been missed.)

**Bug #5 — both machines kept fighting to be boss.** Here's the subtle one. The
rule was "whoever holds the lease is the boss," and EVERY machine, on startup,
would grab a lease for itself before it had a chance to hear from the other one.
Normally there's a shared notebook (backed by git) where they take turns writing
"I'm #105, now I'm #106" so they can't both claim the same number. But the mini
didn't have that shared notebook — it used a private notepad only it could see. So
the laptop wrote "#105, #106, #107" in its notepad, the mini wrote "#105, #106" in
ITS notepad, and because the mini's own number (106) looked higher than the
laptop's incoming message it happened to see (105), the mini said "nah, you're
behind me, I'm the boss" — and rejected the laptop. Two bosses. Nobody hands off.

The fix is a clean idea: the mini is configured as a "silent standby" — it never
answers texts on its own (`telegramPolling: false`). A machine that never serves
should never try to BE the boss. So now a silent standby simply doesn't grab a
lease at all. It only watches. Its notepad stays blank (number 0), so the laptop's
slip always wins, the mini agrees the laptop is boss, and when the laptop says
"here, take this conversation," the mini trusts it and accepts. One boss, clean
handoff.

In short: teach the mini to find its ID card under either name, and tell the quiet
backup machine to stop trying to crown itself. Those two together let the laptop
actually move a live chat onto the mini.
