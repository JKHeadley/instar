# Side-Effects Review — Cartographer streaming ls-tree

**Version / slug:** `cartographer-streaming-ls-tree`  
**Date:** `2026-07-11`  
**Author:** `instar-codey`  
**Second-pass reviewer:** `framework_guard_review`

## Summary

The cartographer detect module replaces its buffered `git ls-tree` read with a guarded streaming child process and incremental NUL parser. `runDetect` is now asynchronous so both the default worker and the in-process rollback can await subprocess completion. No scaffold writer, index storage, heap ordering, writer ownership, or rollout setting changes.

## Decision-point inventory

- Git completion — modify — the map is accepted only on clean exit with a fully terminated NUL stream.
- Git failure — pass-through — every failure shape still becomes `detect-git-error` and feeds the existing breaker.
- `gitMaxBuffer` — pass-through — accepted and plumbed for config compatibility, intentionally ignored by the streaming reader.

## Over-block / under-block

Malformed output with an unterminated last record now refuses rather than accepting an ambiguous tail. Valid empty-tree output remains successful. The parser's carry can grow to one Git path record; the unavoidable output map remains O(tree entries) because downstream status comparison requires it, but there is no second whole-output string or split array.

## Level of abstraction

`SafeGitExecutor.readStream` extends the existing guarded Git funnel so classification, source-tree protection, environment scrubbing, and audit behavior are preserved. Incremental record parsing remains in `cartographerDetect`, the owner of ls-tree semantics. The worker boundary remains unchanged and default-on.

## Signal vs authority

No new authority is introduced. Git failure remains a named refusal signal consumed by the existing sweep breaker; partial data never reaches candidate selection.

## Judgment-point check

No new static heuristic at a competing-signals decision point. Child-process success is an enumerable protocol invariant: clean zero exit, no signal, and complete NUL framing.

## Interactions

- Ordering and shape: real-fixture parity freezes the same insertion order and OIDs as the former buffered parser.
- Backpressure/memory: every stdout chunk is synchronously reduced into complete records; only the current record carry remains between chunks. Stderr capture is capped at 8 KiB.
- Failure atomicity: the local map is returned only after `close` reports exit code zero and no signal. Mid-stream SIGKILL, non-zero exit, spawn error, and malformed tail reject it.
- Lifetime: the read-only stream retains the former 30-second subprocess bound and kills on expiry. On worker timeout, the parent requests cooperative child teardown, retains the reported child PID as a fallback, and force-terminates after a 250 ms grace bound.
- Configuration: `gitMaxBuffer` remains accepted at `ConfigDefaults`, server plumbing, engine config, and `DetectInput`; removing it would be a needless compatibility break.
- Scope: #1073 items 1 (scaffold writer) and 2 (SQLite/sharding) are untouched and remain open.

## External surfaces

The exported `runDetect` helper now returns a Promise; all repository call sites are updated. Runtime output, snapshot schema, candidate ordering, and persistent state are unchanged. No operator action or external API is added. Timing improves for large Git trees because stdout is reduced as it arrives.

## Operator-surface quality

No operator surface — not applicable.

## Multi-machine posture

Machine-local by design: each machine compares its own checked-out Git tree inside its own detect worker. It emits no user-facing notice, holds no new durable state, strands no topic state, and generates no URL. Existing snapshot behavior is unchanged.

## Rollback

Pure code rollback. No persistent schema or state migration is involved. Reverting restores the explicit 64 MiB buffered floor and its refusal-on-overflow behavior.

## Conclusion

The transport upgrade is contained to #1073 item 3 and preserves the existing authority, writer, worker, ordering, and configuration contracts. Independent review found the first draft had lost the buffered executor's subprocess timeout and could orphan Git when a worker was terminated; the shared timeout and explicit two-level reap protocol now close that gap.

## Second-pass review

**Reviewer:** `framework_guard_review`  
**Independent read:** concur. The revised stream retains bounded subprocess lifetime in both in-process and worker modes; the real-worker reap proof and funnel/stream suites are green.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: n/a` — one bounded kill attempt is tied to a single detect-worker timeout; this adds no autonomous retry, respawn, notification, or recurring control loop.

## Evidence

- Unit: chunk-edge NUL, a Unicode record split across four chunks, real-tree parity, empty tree, output beyond a one-byte legacy setting, mid-stream SIGKILL refusal, and hung-stream timeout.
- Funnel: read-only streaming succeeds; destructive use is rejected before spawn.
- Dist worker: forced timeout against a fake hung Git process proves the pass refuses and the reported OS PID is no longer alive.
- Existing detect refusal, bounded heap, routes, config, and dist-worker suites remain green.
