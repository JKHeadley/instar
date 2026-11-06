# The Accounts screen shows a notice only when it matters

**What this is.** At the top of the Accounts screen, on the phone and on the dashboard, there was always a summary line. Most of the time it said something routine, like "SageMind - Adriana is nearly out; others have room." That isn't news: the rows below already show each account's percentage, and with room elsewhere nothing changes for the person. It could also be wrong. In Justin's screenshot two accounts were at 100%, but the line named one and called it "nearly out". Justin asked for a spot that shows critical account notices, and only when they are useful and important.

**What it does now.** The spot is empty, and hidden, unless one of these is true:
- A machine has no signed-in account and a sign-in would fix it. Nothing can run there. The notice has a Sign in button for that account.
- Accounts need signing in. On the phone that is the "Needs signing in" section that was already there. On the dashboard it is the "Needs you" card.
- Every account, or every account of one kind (a Claude session can only use Claude accounts), is at 90% or more. The notice says "used up" when they are all at 100%, says how many, and says when the first one has room again.
- This machine's own account list can't be read.

Each notice has "Ask the agent about this". When a reading is missing for an account that is signed in, no "out of room" conclusion is drawn, because that account may have room. When some machines didn't answer, the notice says it covers only the machines that answered.

**Where the rule lives.** The server works out the notices for the phone. The dashboard works them out in its own page code with the same rules, because it reads the raw account list. Tests pin both.

**What did not change.** Nothing here signs in, swaps, or stops anything. This only changes what the screens say. App builds already on phones still show the old one-line headline field. It now says "N of M accounts have room." instead of naming one account. A revert fully undoes the change.
