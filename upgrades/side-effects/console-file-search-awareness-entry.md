# Side-effects: file search awareness moves to the awareness entry registry

The file search and image preview line was a function in PostUpdateMigrator.ts, used by generateClaudeMd in templates.ts and by a content-sniffed step in patchClaudeMdContent. Both files kept conflicting with other PRs, and the step once ran before the File Viewer section it sniffed for. The line is now src/data/awareness/file-search-and-preview.md, written into the "## Feature notes" section for new and existing agents by the registry (PR 3171). The function, its marker, the template use and the migration step are removed; this PR no longer touches PostUpdateMigrator.ts or templates.ts.

1. Over-block: none. No decision point.
2. Under-block: none new. The entry renders for every agent, which matches the old line (it was added whenever the File Viewer section existed, and new agents always have it).
3. Level-of-abstraction fit: the registry is the documented place for a feature's awareness text (src/data/awareness/README.md).
4. Signal vs authority: not applicable, documentation text only.
5. Interactions: the entry title is listed in the short capability list, which has a size budget; the budget test passes. The text now sits under Feature notes instead of inside the File Viewer bullets.
6. External surfaces: agent instruction text on update; wording is close to the old line.
7. Multi-machine posture: each machine renders its own instruction file on update, machine-local by design.
8. Rollback cost: delete the entry file; nothing else references it.

Follow-up commit: the entry now names the file list route; one whole-PR trace covers every changed file, so the decision record lists the entry file.
