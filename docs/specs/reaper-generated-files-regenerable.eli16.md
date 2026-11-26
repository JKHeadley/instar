# Letting the cleanup recognise files the build makes

## What is going on

When the agent works on its own code, it often makes a separate working copy of the project, so different jobs don't step on each other. Each copy is about a gigabyte. On the Mac Studio there are 444 of them, about 174 GB, and roughly 86 new ones a day.

A cleanup tool is meant to remove old copies whose work is already saved and merged. It is careful on purpose: if a copy holds any file it doesn't recognise, it keeps the copy, because that file might be someone's unsaved work. That caution is right. But today it keeps almost everything. Of 278 copies it checked, it would remove only one.

The reason: most copies hold a few files that the project's own build and checking tools write automatically. Examples are a copy of the rules document, little helper scripts for git hooks, and some summary files. Nobody types into these, and the next build writes them again. The cleanup doesn't recognise them, so it treats each one as possible work and keeps the copy. 151 copies are held back only by files like these.

## What changes

The cleanup learns a short, fixed list of the files the build and checking tools write, and treats them two ways.

- **When the file can be proven to be a copy of something kept elsewhere, it is simply rebuildable.** One file qualifies: the rules copy, which must match the version of the rules document saved in git, byte for byte. It does in 240 of 245 copies.
- **Everything else on the list is saved to an archive before a copy is removed, and the archived copy is checked byte for byte.** That covers the git helper scripts, the summary files and the small audit logs that record risky operations. Right before a copy would be removed, every archived file is checked once more. If one changed or a program started working in that copy, it stays. Because every byte is kept, nothing is lost even if someone did type into one of those files. The archive is small: about 1.6 MB per copy, against about 1 GB freed per copy.

A copy whose only extra files are on that list no longer counts as having unsaved work.

## Safeguards

- Anything not on the list still counts as work, and the copy stays. If an archive copy doesn't match, the copy stays too.
- Archiving never pushes the disk below the safety level the disk steward already guards; if it would, the copy stays. Nothing is ever deleted from the archive.
- The cleanup still only reports what it would remove. Actually removing copies is a separate decision. The Chief of Staff makes it after seeing the new numbers.
- Log folders are not on the list and stay protected.

## What needs deciding

Nothing now. Turning on real removal comes later, with numbers.
