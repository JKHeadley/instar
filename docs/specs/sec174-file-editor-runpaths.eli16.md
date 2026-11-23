# ELI16: the dashboard file editor leaves alone the files your computer runs (SEC-174)

The dashboard has a file editor so the owner can fix a note or a document from their phone. Some files are off limits to it, because changing them changes what programs the agent runs. Nobody who got hold of the dashboard sign-in should be able to make the agent run something new.

The last fix covered files marked as programs. This one covers a few more that get run even though they are not marked that way. These are the agent's development copies of its own code, the small starter file that launches the agent when the computer starts, and the files that tell the package installer which commands to run.

What you will notice: almost certainly nothing. These files still open in the editor so you can read them. They show as read-only, and trying to save one gives a short message saying it cannot be edited there. To change one on purpose, ask the agent, which makes the change on the machine itself.
