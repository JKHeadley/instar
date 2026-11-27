# Durable unit process evidence

Unit shards receive bounded prefix and suffix capture. Other process steps use the existing tail. The additional capture retains up to 2 MiB of prefix and 64 KiB of suffix per stream. It is kept only for nonzero unit exits without named failed files. The archive is separate from failed checkout pruning and retains eight files in a private directory. Test output is written to a private file and only its location is logged.

The evidence path has no authority over outcomes, retry eligibility, or merges. An unavailable archive is logged and the original verdict is preserved. Rollback removes capture and retention wiring. Existing files remain private until cleaned through ordinary host maintenance.

## Second-pass review

**Reviewer:** independent second-pass reviewer (Claude Fable 5.2 helper for the Echo Chief of Staff session), not the author

Concur for head `90341431a072d6d923a71d7b72eed2a7812a8bd4`. I read the full diff and the surrounding code of the three files that flag this change as harness-changing (`src/localVerify/orchestrator.ts`, `src/localVerify/orchestratorSeams.ts`, `src/localVerify/unitProcessOutput.ts`) and the two test files. I did not rerun any tests; the full Local Verify run on this head is the test evidence.

- **No check is weakened.** No skip, loosened assertion, raised timeout, or non-blocking gate is introduced. The outcome is computed and the record is built before `cleanup()` runs, and the new transcript step sits inside `cleanup(failed)` in its own try/catch, so it cannot change a verdict, retry eligibility, or the merge decision. The modified orchestrator test keeps every earlier assertion and adds three.
- **It does what it says and nothing else.** Capture is requested only for the unit lane's main process, returned only on a nonzero exit or signal, and kept only on the existing "unit exit with no named failed file" branch of a failed run. Every other process step uses the unchanged output tail. The file is written with mode 0600 and exclusive create inside a directory that must be owner-only, and only its path is logged.
- **No newly silent failure.** A failed write logs `unit-transcript-write-failed` and a failed rotation logs `unit-transcript-retention-failed`; the existing in-checkout failure evidence is still written either way.

Non-blocking notes, none of which affects a verdict: the write-failure log line drops the error message; rotation is best-effort, so more than eight files can remain if deletion keeps failing or two runs rotate at once; the prefix is held as one buffer per received chunk, which costs extra memory when a process writes in very small chunks; every qualifying shard's transcript is kept, so one file can reach a few megabytes per shard.
