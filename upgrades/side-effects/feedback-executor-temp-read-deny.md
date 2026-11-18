# Side effects: confined feedback sessions cannot read the shared temp (SEC-098)

## What changes for running agents
- Agents with the feedback executor on: the next tick runs a fresh full-gate canary (`CANARY_VERSION` v5 -> v6) before any fix attempt. A sandbox that leaks shared-temp reads now fails the canary and latches the executor, which is the intended fail-closed outcome.
- Confined commands lose read access to `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp` and the real `os.tmpdir()`, except the attempt's own `/private/tmp/fb-<id>`. `TMPDIR` and `CLAUDE_CODE_TMPDIR` already point at that directory, so tools that use the temp dir keep working. Before the 2026-10-25 change (0db23c96c) `/tmp` was already read-denied with the attempt temp under it, and its commit records that reads were unaffected; this restores that read rule.
- Agents with the executor off: no change.

## Signal vs authority
The sandbox profile is the authority; the canary is the proof it holds. Nothing here is a heuristic.

## Linux
On Linux, sandbox-runtime turns a read-denied directory into an empty writable tmpfs inside the sandbox. A write to `/tmp/...` then exits 0 but stays in that private mount. The runner's `bash-write-system-temp` probe is therefore judged by its host effect on Linux, and by refusal plus effect on macOS. The host-side `write-system-temp` effect check is unchanged on both.

## Rollback
Revert the commit. No stored data changes. The canary stamp returns to v5 and re-runs once.

## Not covered here
Whether a confined attempt actually read anything from the shared temp while this was open is not established here (the attempt transcripts are the place to check). Treat credentials left in throwaway configs under `/private/tmp` as exposed to any confined attempt that ran since 2026-10-25.

**Reviewer:** independent second-pass subagent (fresh context, read-only). It concurred on macOS: reads are closed on both the runner and the session-worker paths, the attempt temp is a real path, there is no regression, and the probes are judged and cleaned up correctly. It objected that on Linux the write probe would false-latch on a correct sandbox. That is fixed above, with a test.
