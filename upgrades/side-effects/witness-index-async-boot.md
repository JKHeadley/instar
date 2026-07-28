# Side-Effects Review — Witness index async boot

## Summary

Moves replicated witness-index rebuild and parity off the boot-critical path. The server listens first; the reader then scans one fixed chunk per event-loop turn. The index remains untrusted until the complete candidate and independent latest-per-origin parity fold agree.

## Safety and interactions

- Before/during rebuild, witness lookup uses the legacy authoritative scan.
- A candidate map is local and never served half-built.
- Durable local or peer appends increment a generation; a changed generation prevents publication and schedules a fresh pass.
- Parity mismatch or rebuild error leaves the index untrusted and logs/falls back as before.
- The synchronous rebuild method remains available for explicit tooling/tests, but production boot wiring uses only the post-listen cooperative method.
- Fixed 64 KiB reads bound each event-loop slice independently of total journal size.

## Regression surface

The shipped regression was a roughly 50 MB peer evolution-action journal causing two synchronous boot scans before listen, exceeding the supervisor window and crash-looping. The new large-journal test pins zero constructor reads and prompt initialization. Existing unit, integration, and e2e index tests now await readiness explicitly where they assert indexed O(1) behavior.

## Rollback

Reverting restores synchronous constructor rebuild and therefore restores the boot wedge. There is no persisted schema or data migration in this fix.

## Class-Closure Declaration

This closes the synchronous-derived-cache-build-on-boot class structurally: constructors do no bulk journal work, serving begins before optimization warmup, chunked work yields, and publication is parity- plus generation-gated.
