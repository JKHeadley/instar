# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- The /semantic/export-memory endpoint no longer overwrites MEMORY.md when SemanticMemory has 0 entities. Previously, an empty export would destroy manually-curated memory content. Now skips the write and returns existing file metadata with a skipped flag.
- MemoryExporter.write() guards against empty-entity overwrites at the class level.

## What to Tell Your User

- **Memory file protection**: "Your MEMORY.md is now safe from accidental overwrites. If the knowledge graph hasn't been populated yet, the export will leave your existing memory file untouched instead of replacing it with an empty template."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Empty-export guard | Automatic — no user action needed |
