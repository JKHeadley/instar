# ELI16: the dashboard file editor leaves the agent's own machinery alone (SEC-173)

The dashboard has a file editor, so the owner can fix a note or a document from their phone. Some files are off limits to it, because changing them would change what programs the agent runs. Anyone who got hold of the dashboard sign-in should never be able to make the agent run something new.

That off-limits list had a gap. Two more kinds of file now sit behind it: the folder where the agent keeps the history of its own files, and any file marked as a program that can be run. You can still open and read all of them. You just cannot save changes to them from the editor, and nobody had a reason to.

What you will notice: almost certainly nothing. If you ever open one of these files in the dashboard editor, it shows as read-only, and trying to save it gives a short message saying scripts cannot be edited there. To change one on purpose, ask the agent, which makes the change on the machine itself and records it.
