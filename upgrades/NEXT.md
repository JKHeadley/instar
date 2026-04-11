# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

- Fixed GET /context sometimes reporting 0 bytes for segments that clearly had content on disk. The previous code ran fs.existsSync followed by a separate fs.statSync — if the second call silently failed, the response claimed the segment existed but had zero size. The listing now uses a single atomic fs.statSync, so the exists flag and sizeBytes always come from the same read and always agree.
- GET /context responses now include an absolute filePath for every segment and a statError field whenever the filesystem raises a non-ENOENT error. If an agent sees an unexpected zero-byte segment, it can now copy the absolute path straight into ls and see exactly what Instar was checking, instead of guessing whether the server's context directory matches the hooks.

## What to Tell Your User

- **Your context is visible again**: "If you ever asked me what segments I had loaded and I said they were all empty even though you could see the files on disk, that was a real bug — I couldn't tell the difference between 'the file isn't there' and 'I hit an error trying to read it.' I can now, and I'll tell you exactly which path I'm looking at if something still seems off."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Self-diagnose context path mismatches | GET /context — each segment now includes an absolute filePath and an optional statError |
| Trust consistent size reporting | GET /context — exists and sizeBytes come from the same stat call, no race window |
