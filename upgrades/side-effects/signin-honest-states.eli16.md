# The accounts screen says "needs you" only when it does

**What this is.** Instar's accounts screens, on the dashboard and on the phone, show each account on each machine and count the sign-ins that need the operator. That count was wrong in two directions, and this change fixes both.

**Saying "needs you" too often.** Any account marked as needing sign-in counted, even if nothing had confirmed the login was dead, or if the blocker was something the agent owns, such as a missing browser profile. The operator saw a warning with nothing only they could do. Now those show their own wording, "sign-in not confirmed; still checking" or "automatic repair can't start yet", and a line says there is nothing to do yet. They still have a Sign in button, so nothing is hidden, but they don't add to the count on Home. A device-limit stop still counts, because which accounts live on a machine is the operator's call.

**Saying "needs you" too rarely.** A machine's slot could hold the wrong account's login and still read as active, so the screen looked fine. On the Laptop this lasted ten days for one account. A wrong login can correct itself soon after it appears, so it now shows as waiting for the first day. After that it counts as needs-you, with a Sign in button for that exact account and machine. A login that is gone from the machine always counts. The phone says "another account" instead of showing the other account's address.

**What did not change.** No repair starts on its own because of this. Nothing about repair approval, the safety checks on sign-in pages, or how repairs are admitted changed. This is what the screens say, and a revert fully undoes it.

**What is still open.** Stuck wrong logins still wait for someone to tap Sign in, because no automatic repair exists for them yet. An account stuck in "still checking" no longer counts on Home, so it could sit there quietly. The line on the Accounts page is what keeps it visible.
