# The one-time local link, explained simply

Your agent's dashboard is locked with a PIN. If you sit at the agent's computer and type the PIN wrong too often, the dashboard stops letting that computer try for a few minutes. The problem is that the dashboard can't tell you apart from any other program on the same computer. Another user account on that computer, or a restricted helper the agent runs, could use up those tries and lock you out.

This change adds one command: `instar dashboard open`. Usually you won't run it yourself: you ask your agent, and it opens the dashboard on the computer's screen for you. It can also be run at the agent's computer and it opens the dashboard in your browser through a link that works once. The link can only be made by your own account on that computer, and it expires after 15 minutes. Browsers opened through the link share their own allowance of PIN tries, which other user accounts and restricted helpers on the computer can't use up (if it ever runs out, you are simply back to today's rules). A browser you've already unlocked in before keeps working exactly as it does now.

Repeated clicks never lock you out: a new link simply replaces the oldest unused one. You still type your PIN. The link doesn't let anyone skip the PIN or do anything else in the dashboard. It just keeps a route open for the person sitting at the computer. A link made before the agent restarts stops working after the restart; you just ask for a new one.

Two safety details:

- The command proves itself to your agent with a private key only your account can read, and your agent has to prove itself back before the command trusts the answer. So a different program sitting on the dashboard's address can't hand you a fake link. The link uses the computer's exact internal address, so there is only one place it can go.
- The link's secret never shows up in the list of running programs, in backups, or in the files the dashboard can show.

Over SSH, the command prints the link for you to open on your own machine. The Mac app's "Open dashboard" button comes later, with the next Mac app build.

This is the first small part of the approved identity work. Later parts use the same link for resetting a forgotten PIN and for adding a security key.
