# The feedback executor's sandboxed sessions can run shell commands again (plain-English overview)

Governing spec: `docs/specs/feedback-triage-and-execution.md` §4 (converged and approved). The executor builds each fix inside a sandbox that may write only to the attempt's own folders. This change moves one of those folders; it adds no permission.

## What was wrong

Measured live on the Mac Studio on 2026-10-19 with Claude Code 2.1.303: inside the executor's sandbox, every shell command the session ran exited with code 1, even `echo`. The command's own output was fine; the failure came from Claude Code's bookkeeping. After each command it writes a small "where am I" file into its sandbox temp folder. We tell Claude Code where that folder is (the attempt's temp directory), but Claude Code only accepts that setting when the path is short, about 30 bytes, because it also puts a socket there and socket paths have a hard length limit. Our path was 83 bytes, so Claude Code silently fell back to `/tmp/claude-<uid>`, a folder the sandbox does not allow, and the write failed. The sandbox's own self-test (the canary) would have stopped every fix attempt right there.

A second detail: on a Mac, `/tmp` is a link to `/private/tmp`. The sandbox matches real paths, so a short folder named `/tmp/...` was still refused; `/private/tmp/...` was accepted.

## What changes

The attempt's temp directory is now a short, real path under the system temp root (for example `/private/tmp/fb-3f9a1c2b7d`, 26 bytes) instead of a long one under the agent home. The sandbox allows exactly that one directory, as before; the shared temp folders around it stay refused (the canary checks that). Because that root is shared and the folder's name is predictable, the executor now creates the folder fresh and private every time, and refuses the attempt if something is already there that it does not own (a reviewer found that gap). Because it now lives outside the agent home, two housekeeping details follow: a crash leftover there is cleaned up by the executor's existing 14-day sweep, and on Linux, where `/tmp` is often a separate filesystem, removal falls back to deleting in place when a move into the trash folder is not possible.

Measured after the change, with the same probe: `git status` and `echo` exit 0, writes land inside the attempt's folder, and a write to `/tmp/feedback-canary-...` is still refused.

## What does not change

No new path becomes readable or writable. The sandbox policy, the canary probes, the approval floor and the operator's one tap are untouched.

## What you need to decide

Nothing.
