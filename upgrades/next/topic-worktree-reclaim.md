# Old conversation copies: stale "in use" notes stop piling up, and the safe cleanup is measured

<!-- bump: patch -->

## What Changed

- **"In use" notes are cleaned up.** A conversation's note is cleared when the conversation ends. At start, notes are cleared for conversations that are no longer running and have nothing open in that copy.
- **The cleaner sees links across both folders of copies.** It also no longer treats work merged into another branch as finished, and a failed removal no longer crashes its pass.
- **Copied library folders are marked.** A later cleaner can then tell them apart from real work.
- **A new measurement, on development agents only.** It reports in the disk report how many old conversation copies are provably safe to remove, and how much space that would free. Each verdict is double-checked. Nothing is removed yet.

## What to Tell Your User

- **Cleaning up old conversation copies**: "I now measure exactly how much space old conversation copies take and how much is safe to free. Removing them comes next, once the numbers show it's worth it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Topic-worktree reclaim measurement | the disk report's topic-worktree line; `monitoring.diskSteward.topicWorktreeMeasure` (dev agents) |
