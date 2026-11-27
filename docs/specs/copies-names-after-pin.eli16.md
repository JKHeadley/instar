# ELI16: the Bitwarden yes-or-no page shows secret names only after your PIN (SEC-129)

When the agent offers to keep a backup copy of its passwords and keys in your Bitwarden vault, it sends you a page where you say yes or no. That page explains what would happen, including which of the agent's stored secrets would be copied. It only ever shows their names, such as "dashboard PIN", never the secrets themselves.

The problem was that the page loads its details before you have typed anything, and anyone who knew the agent's web address could load the same details. So a stranger could learn the names of every secret the agent keeps, which tells them what accounts and services the agent uses and what to try to steal.

Now the page first says only how many secrets would be copied. If you want to see their names before you decide, you type your PIN in the same box you already use to answer, and tap "Show their names". The agent checks the PIN with the same protections as the yes and no buttons (including the limit on wrong guesses), then shows the list. Asking for the names does not count as an answer and does not change anything, so you can still say yes or no afterwards.
