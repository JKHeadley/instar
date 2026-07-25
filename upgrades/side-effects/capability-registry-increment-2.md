# Side-effects review: capability registry Increment 2

- Adds read-only dark routes and an in-memory receiver construction; no peer transport or heartbeat emitter.
- Disabled and enabled-unobserved responses are intentionally distinct.
- Existing-agent awareness is appended by migrateClaudeMd with a content marker.
- No routing consumer or admission authority is introduced; rollback removes the unreferenced surface and migration block.
