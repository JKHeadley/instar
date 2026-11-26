# The agent cannot type a password into a command line anymore (ELI16)

When the agent runs a shell command, the whole command line is visible to every other program on the computer for as long as it runs, and some monitoring tools save copies of it. If a session pastes a real token straight into a command, like a GitHub key in front of a test run, that key can be read from the list of running programs. That happened once already.

The agent's built-in safety check for shell commands now refuses any command that carries a literal token, API key or bot token. It tells the session the safe way to do it: read the secret inside the command, so the shell fills it in and it never appears in the command line. Writing a file that contains a fake test token is still fine through the file-writing tool.
