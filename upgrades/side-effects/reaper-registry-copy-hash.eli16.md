# The worktree cleaner can finally recognise a generated file it was told to ignore

The worktree cleaner (the "reaper") only removes an old work folder when nothing in it could be someone's work. Yesterday we taught it that one generated file, a copy of the standards registry, is safe to throw away if it is exactly the committed version. It proves that by comparing fingerprints.

The way it took the fingerprint used a git command that a safety guard blocks inside these folders. The guard said no every time, the proof quietly failed, and the cleaner kept every folder that had that file. On the Studio that was the only reason 45 folders (about 16 GB) were being kept.

The fix computes the same fingerprint directly, without the blocked command. Anything that is not an exact copy is still treated as work. A new test reproduces the real situation (it failed before the fix and passes after).

Nothing is deleted by this change on its own: the cleaner on the Studio is still in report-only mode.

What needs deciding: nothing.
