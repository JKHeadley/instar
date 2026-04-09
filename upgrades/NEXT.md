# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The GET /context endpoint now includes the `contextDir` path in its response, making it possible for agents to verify that the server is looking in the same directory where their context files live. This helps diagnose the "0 bytes for all segments" issue that occurs when there's a path mismatch between the server's configured state directory and where hooks/sessions create context files.

Response format changed from an array of segments to `{ contextDir: string, segments: [...] }`.

## What to Tell Your User

- **Better context diagnostics**: "If your context segments ever show as empty despite files being on disk, the context endpoint now shows the exact directory path the server is checking. This makes it easy to spot path mismatches."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Context directory path in response | GET /context now returns contextDir alongside segments |
