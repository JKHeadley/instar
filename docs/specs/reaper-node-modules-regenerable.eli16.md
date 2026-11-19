# Letting the cleanup recognise a rebuildable library folder

## What is going on

The agent makes working copies of its own code to work on several things at once. Some of those copies carry their own full install of the project's libraries, the `node_modules` folder, about 0.7 GB each. On the Mac Studio, 62 copies have one, and about 13 new ones a day.

The cleanup tool is careful on purpose. It keeps any copy with its own library folder, because someone might have changed a file inside it by hand. That caution is right, but it also means those copies are never cleaned up.

We measured that two library folders installed from the same list of library versions (the lockfile) hold the same file contents, apart from about 15 small files that are compiled on the machine during install. Their timestamps differ, so timestamps prove nothing. The contents are what match.

## What changes

- **A reference copy per lockfile.** For each distinct lockfile, the cleanup builds one reference install in a scratch folder, offline from the local download cache. It records a fingerprint of every file, then throws the reference away. That takes about half a minute, once per lockfile. No package's own setup code runs while it does.
- **A file-by-file check.** A copy's library folder counts as rebuildable only when every file is present and matches the reference fingerprint exactly. The one exception is the files that packages build or download for themselves when installed.
- **Those built files are saved first.** They are kept in a shared archive where each distinct file is stored once, so a 40 MB program that is the same in every copy takes 40 MB in total, not 40 MB per copy. Each is checked byte for byte before anything is removed. Nothing can be lost.
- **A last look just before removal.** Every file in the library folder is checked again for changes, and any change keeps the copy.
- **Anything else keeps the copy.** That means a changed file, a missing reference, a missing file, a different kind of install, or too little free disk to save the built files.

All the checking runs in the cleanup's background program, never in the agent's main server.

## Safeguards

- If the reference can't be built offline, every copy that uses that lockfile stays. It is retried the next day.
- Libraries that don't come from the public library registry with a fixed fingerprint either keep the copy, or have all their files saved to the archive.
- Other working copies that point at a library folder are found first, wherever git knows they are, and checked again right before removal. A folder something points at is never removed.
- The check compares file contents, not names or dates.
- Actual removal stays switched off until the Chief of Staff turns it on, after seeing how many copies and how much space this would free.

## What needs deciding

Nothing now. The design comes to the Chief of Staff for approval before it is built.
