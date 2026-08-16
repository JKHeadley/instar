# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- Fixed dashboard apiFetch to properly pass method, headers, and body options to fetch. Feature toggles and autonomy profile changes now persist instead of silently failing as GET requests.
- Fixed degradation-digest job gate and skill to read from the correct file path (.instar/degradations.json instead of .instar/state/degradation-events.json). The job can now actually run.
- Fixed MemoryExporter to not overwrite existing MEMORY.md when SemanticMemory has 0 entities.

## What to Tell Your User

- **Dashboard feature toggles work now**: "Feature toggles and autonomy profile changes in the dashboard now actually save. Previously they appeared to toggle but silently reverted."
- **Degradation monitoring active**: "The degradation digest job can now run properly. It was blocked by a wrong file path since it was created."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Working dashboard toggles | Toggle features in the dashboard Features tab |
| Degradation digest job | Automatic — runs every 4 hours when degradation events exist |
