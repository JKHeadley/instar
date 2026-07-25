# Side-effects review: capability registry Increment 2

- Adds read-only dark routes and an in-memory receiver construction; no peer transport or heartbeat emitter.
- Disabled and enabled-unobserved responses are intentionally distinct.
- Existing-agent awareness is appended by migrateClaudeMd with a content marker.
- No routing consumer or admission authority is introduced; rollback removes the unreferenced surface and migration block.
- The read route now renders receiver-derived classified rows (including status/failure evidence) and the health route exposes observed/never-observed counts with `advisory: true`; it no longer fabricates an empty response.
- The omitted config key resolves through `resolveDevAgentGate`; the exact dark response is `503 {code: "capability-registry-dark"}`.
- Proof: route integration covers dark, dev-agent omitted, truthful-empty, ingested-row, and health measurement cases; `scripts/check-capability-registry-read-model.mjs` is the FD-17 ratchet and fails on an authority consumer.
- Follow-up review correction: local reads prefer the durable self-projection (then doorway sources); peer-map snapshots are only the test fallback.
