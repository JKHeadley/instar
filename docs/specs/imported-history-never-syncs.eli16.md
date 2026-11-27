# Imported history excluded from git sync — the plain version

Instar can bring a person's old Claude or ChatGPT chats into their agent. Those chats are saved in one folder on the person's computer (`.instar/imported-history/`).

Some agents keep their files in git and sync them to another place, for backup or to share between the person's machines. The list of things git sync must never carry did not include this new folder, and neither did the lists of files git should ignore.

This change adds the folder to all of those lists:

- Git sync's never-sync list, so the sync code refuses to carry anything inside it.
- The ignore file a new agent gets in its home folder, and the one inside its internal `.instar` folder.
- An update step that adds the same line to the ignore files existing agents already have. It runs on every update, adds the line only if it is missing, and never creates a file that was not there.

The folder's name now lives in one place that the importer and every list read from. If someone renames the folder later, the lists move with it. A test checks the real importer folder against the lists so a mismatch fails loudly.

Nothing changes for the person except that their imported chats stay on that computer.
