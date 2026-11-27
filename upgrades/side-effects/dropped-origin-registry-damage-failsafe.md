# Side effects: dropped-origin registry fails safe on a damaged file (fb-26f128ae-7fa)

## Summary
Tier 1. 2 source files (`src/core/RollbackUnmerge.ts`, one field in `src/server/routes.ts`), 2 test files; about 200 source LOC, about 170 test LOC. No spec review rounds (narrow bug fix found by the round-7 review of PR #2851). Effort in line with size.

## What changed
`DroppedOriginRegistry.load()` now classifies the file as healthy (absent, or valid version 1 with every entry well formed) or damaged (read error, unparseable JSON, not an object, `dropped` not a list, unknown version, or any entry that had to be filtered out). On damage it keeps the recoverable entries (valid entries of a parsed doc, or `{...}` fragments that parse and carry `store`/`origin` from unparseable text), copies the bytes aside to `dropped-origins.json.damaged-<sha256-12>` (copy, exclusive create, idempotent by content; original left in place), reports one DegradationReporter event, and records `health()`. While damaged, `add()` applies the exclusion in memory and throws `DroppedOriginRegistryDamagedError` without writing; `remove()` throws without changing anything. `GET /state/quarantine` adds `droppedOriginsHealth`.

## Why
Round-7 review of PR #2851 (finding 2b): after a corrupt load the next add/remove persisted a partial list, permanently erasing other drops and making the next restart read a healthy file. One registry feeds about nine stores (`server.ts` wiring). The review warned against ignoring other machines' entries, since that hides revocations; this change keeps every recoverable entry whatever origin it names.

## Review
1. Over-block: a file that a future version writes with `version: 2` is treated as damaged and mutation refused on this version. That is the correct direction (an older build must not rewrite a newer list). Entries with an empty `store`/`origin` string are now malformed; this code never writes those.
2. Under-block: exclusions that cannot be recovered from the damaged bytes are not applied until repair; that is unavoidable from the data and is reported. Readers are not told the set is incomplete beyond `health()` and the degradation; making each consumer direction-aware (finding 2a) is a design question for the #2851 spec, not this bug.
3. Level: the registry is the single owner of the file, so the guard sits at the only writer.
4. Signal vs authority: the refusal is not a judgment gate; it is a deterministic refusal to overwrite data that failed to parse, i.e. a storage-integrity invariant. The degradation is signal-only.
5. Interactions: `RollbackUnmerge.unmergeOrigin` calls `add()` first, so on a damaged registry it now throws before moving streams (the exclusion is still live in memory); `reMerge` throws before restoring anything. No production route calls either today (substrate ships dark). `droppedOrigins()`/`isDropped()` readers are unchanged in shape.
6. External surfaces: one optional JSON field on an authenticated agent route; one degradation report when damage is detected.
7. Multi-machine: machine-local by design (each machine un-merges its own copy of peers' data, spec §11); this change keeps entries naming every origin.
8. Rollback: revert. The only new file is the aside copy, which is inert.

## 6b. Operator-surface quality
Not an operator surface: an agent-facing route field and a degradation report.
