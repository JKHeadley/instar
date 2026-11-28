# Keeping the settings file private (ELI16)

Each agent has a settings file, config.json, and it can hold passwords and keys. The file should be readable only by the account that owns the agent. An earlier fix kept it private when the agent rewrote it. But if the file was already open to other users on the computer, from an older install or a hand edit, it stayed open. A brand-new file from the installer could also start out open.

Now the agent checks the file every time it loads its settings. If other users could read it, the agent closes it so only the owner can. The installer also creates the file private from the start. Nothing else changes, and if the file system won't allow the change, the agent simply keeps working as before.

How we checked it: tests now start from a settings file that other users can read, which is the case the first fix missed. They confirm that loading it closes it, that changing a setting keeps it closed, and that a file already private is left alone.
