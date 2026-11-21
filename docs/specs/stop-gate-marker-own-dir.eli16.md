# ELI16: the stop-gate keeps its one-time note in the agent's own folder (SEC-131)

When the agent is about to stop while one of its pull requests is ready to merge, a small built-in check blocks the stop once and reminds the agent. To remember that it has already reminded the agent, it leaves a tiny note file behind, so it never blocks twice for the same change.

Until now that note went into the computer's shared temporary folder. On a machine with several user accounts, everyone can write in that folder, so another person could create a file with the same name first (and the reminder would never show), or create a shortcut with that name that points at one of the agent owner's own files, so that writing the note would overwrite that file.

Now the note lives inside the agent's own folder, where only the agent's account can write. It is created only if nothing with that name exists yet, and it is never written through a shortcut. If the note cannot be created for any reason, the check simply lets the agent stop, so the agent can never get stuck being blocked over and over. On single-user Macs nothing visible changes.
