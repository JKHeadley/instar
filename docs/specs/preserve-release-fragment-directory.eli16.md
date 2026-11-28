# Keep pending release notes in their folder

Each pull request that changes the product or its release tools can add a small note about the change. The release job combines those notes into a numbered guide and clears the used notes. When it clears the last note, Git stops seeing the pending folder. It can then mistake that folder for one that moved, and put a later pull request's note beside the numbered guides. The next release looks in the pending folder, so it misses the misplaced note.

This change keeps a tiny tracked file in that folder. The release-note reader ignores it, so a folder with only the marker produces no release notes. The publish job checks that the marker is still present after cleanup. The repository check also points out a missing marker or an unexpected note beside the numbered guides. Maintainers can see the path and fix the change before it merges.
