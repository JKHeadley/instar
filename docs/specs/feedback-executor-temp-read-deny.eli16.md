# The feedback fixer can no longer read the shared temp folder (ELI16)

When the agent fixes a bug from outside feedback, it does the work in a locked box: the session that writes the fix can only see its own copy of the code and its own scratch folder. Its scratch folder lives inside the computer's shared temp folder, because the path has to be short.

The lock had a gap. To let the session use its own scratch folder, the rules stopped protecting the whole shared temp folder around it, for reading. The session could not write there, but it could read everything other programs had left in it: test agents' settings files with live bot tokens and passwords, and other Claude sessions' notes.

Now reading the shared temp folder is blocked again, and only the session's own scratch folder is opened back up. The safety test that runs before every fix now plants a secret file in the shared temp folder and fails if the session can read it.
