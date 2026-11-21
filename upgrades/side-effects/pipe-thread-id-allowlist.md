# Side effects: the pipe-mode spawner refuses a non-canonical thread id (SEC-126)

In plain words: the quick pipe-mode reply path built tmux shell commands and the prompt file path from the peer-chosen thread id. It now refuses any thread id that does not match the canonical thread-id allowlist before building either.

Tier 1 (security fix, but narrow and fully undone by a revert). Size: 1 source file (+22 lines), 1 new test file (4 cases), 3 existing tests changed from made-up ids to canonical ones. Effort: no spec rounds, first commit attempt.

## The defect
`PipeSessionSpawner.spawn` interpolated `request.threadId` into `execSync` strings (`tmux has-session -t "=pipe-<id>"`, `tmux new-session ... -s "pipe-<id>"`) and into `prompt-<id>-<ts>.txt`. The relay path in `server.ts` passes `msg.threadId` from the peer envelope with no shape check. A trusted or autonomous peer could send `x";<command>;"` and run a command as the agent's user, outside the pipe session's read-only tool list. Confirmed by test: with the check disabled, the hostile id created a marker file.

## What changes for running agents
- New exported helper `isPipeSafeThreadId` (string and `THREAD_ID_RE` from `ThreadLog.ts`, the same allowlist the thread log and routes already use).
- `shouldUsePipeMode` returns `{ eligible: false }` for a non-canonical id; `spawn` returns `{ spawned: false }` before any shell string or file is built (checked twice because `spawn` is the place that builds them).

## Over-block
A peer whose thread ids are not canonical (for example the public relay bridge's `a2a-<uuid>`, or uppercase UUIDs) no longer gets pipe mode. Its message falls through to the existing listener/router path in `server.ts`, so nothing is dropped; only the fast path is skipped. Real ids are `crypto.randomUUID()` (lowercase), which pass.

## Under-block
Only the pipe spawner builds shell strings from the thread id; the second-pass review traced the listener and router path and found no other shell sink (sessions start through `execFileSync` with argv). It did find a separate, older weakness that this change does not touch: the same peer thread id reaches `MessageStore.saveThread` / `getThread` file paths (`threads/<id>.json`) unchecked, so `../` can read or write outside the store. That is a different sink with many callers and gets its own SEC number and change <!-- tracked: CMT-020 -->.

## Level of abstraction
Validating once at relay ingress would cover more consumers, but ingress currently feeds many paths that tolerate other shapes (synthetic `auto-` ids). Checking at the sink that builds the shell string is the guarantee that holds no matter which caller reaches it.

## Signal vs authority
A strict format check guarding a shell command, which is the case where a deterministic refusal is correct: it refuses only the unsafe fast path and falls back to the normal path, so it holds no authority over whether a message is answered.

## Interactions
`hasActiveSessionForThread` is unchanged. Metrics, the quota gate and force-mode refusal are unchanged; the new check runs first.

## External surfaces
None visible to users. A peer with a non-canonical id sees a slower reply.

## Multi-machine posture
Machine-local by design: each machine's spawner checks the id it is about to use.

## Rollback
Revert the commit.

## Second-pass review
**Reviewer:** independent general-purpose reviewer subagent (read-only), given the diff and the code, not this artifact's conclusions. It confirmed every interpolation in `PipeSessionSpawner.ts` sits after the new guard, that `THREAD_ID_RE` cannot be bypassed (anchored, no `m`/`u`/`i` flags, trailing newline fails), that the fallback path builds no shell strings from the thread id, and that the tests fail without the fix. It raised one concern: record the `MessageStore` file-path traversal above and track it. Done (CMT-020, reported to the Chief of Staff for numbering). With that recorded: concur. The test now also clears a leftover marker file before running, per the reviewer's note.
