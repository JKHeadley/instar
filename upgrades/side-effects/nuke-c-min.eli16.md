# "Remove instar from this project" stops touching your files

`instar nuke --here` removes Instar from a project folder. Until now it also tried to put some shared files (like CLAUDE.md, .gitignore and the .claude folder) back the way they were in Git, by overwriting them. If you had edited those files yourself, your edits could be lost. That was a real bug report.

Now it simply leaves those files exactly as they are and removes only Instar's own `.instar` folder. Before you confirm, and again at the end, it lists the files it kept and says they may still mention Instar, and that your agent can look through them with you and suggest what to remove.

The other change is in `instar nuke <name>`, which deletes a whole agent. Before deleting, it used to commit everything in the agent's folder and upload it as a backup. That could upload things that should never leave the machine, such as secrets. Now it uploads only what was already committed, warns you first that anything uncommitted will not be in the backup, and reports honestly whether the upload worked.

Neither change makes nuke stop or delete anything new. Both only take powers away.

What needs deciding: nothing; the Chief of Staff approved the design.
