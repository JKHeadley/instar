# Keeping the "last applied version" record honest: plain-English overview

## What this is

Every Instar agent keeps a small note saying which version its auto-updater last applied. That note is called `lastAppliedVersion`. It was only written at one spot: the moment the updater's own apply step finished cleanly. If an update landed any other way, for example the agent was stopped partway through after the new files were already in place, the note was never touched. The agent would then run the new version while the note kept naming an old one, and nothing ever corrected it. One agent in the field was running 1.3.1387 with a note that still said 1.3.1364.

## What already existed

- The updater checks for new versions on a timer. When nothing newer exists, it clears any waiting update and moves on.
- A loop breaker compares the note with the newest version, so an agent does not reinstall the same release forever.
- A health check reads the note to decide whether a difference between the running version and the files on disk is an expected "restart pending" or a real problem.

## What is new

- On a timer check that finds nothing newer, if the running version is newer than the note, the note moves up to the running version. It only ever moves forward. A note that has never been set stays empty, because empty means "never applied".
- The install step always fetches the newest release. If a newer one landed while an update was waiting, the note now records what was really installed instead of the older target, and the restart aims at that version.
- Separately, the docs gain two short sections about the classes that manage paired phones and their permissions. Those classes shipped without docs, which pushed the Docs Coverage score under its floor for every pull request. The text is the same as open PR #2666, so whichever lands first leaves the other with nothing to add.

## Safeguards

- Forward only: a note that is already ahead of the running version is left alone.
- A version string that cannot be read is never treated as newer.
- The version comparison is the same one the update checker already uses, so the two agree on what counts as newer.
- An in-place install, where the installer still reports the old version, records the target as before, so the loop breaker keeps working.
- No install, restart or notification is added. The restart target only changes in the case where a newer build really was installed.

## What a reader needs to decide

Nothing needs a decision. A plain revert undoes the change, and any note it already corrected stays correct. It does not explain which restart path on the affected Linux agent skipped the write; the note now repairs itself whichever path that was.
