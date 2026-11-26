# Retained Claude Executable — Plain-English Overview

> The one-line version: every Claude Code session now starts from its own saved copy of the Claude program, so a Claude update can no longer pull the program out from under a running session and slowly eat the Mac's kernel memory until it crashes.

## The problem in one breath

Claude Code is installed with npm, and every update replaces the program file in place. A session that was already running keeps using the old file, which now has no name on disk any more (it is "unlinked"). On macOS the security layer keeps asking the kernel "what is the path of this program?", that question fails for an unlinked file, and each failure leaks about one kilobyte of kernel memory that is never given back. On this Mac Studio seven such sessions leaked about 163 MB per hour, and the machine had already crashed once on 6 October when that kernel pool reached 20 GB. Killing the session does not return the memory. Only never getting into that state helps.

## What already exists

- **The session spawner** — the part of the agent that starts a Claude Code session in a tmux window. It already resolves which program file to run (from `sessions.claudePath` or the per-framework binary map) through one shared resolver.
- **The reaper and the watchdogs** — they decide when a session is idle or stuck. They are unchanged; they never touch program files.
- **The post-update migrator** — the piece that patches every existing agent's config and CLAUDE.md when a new instar version lands, so new behaviour reaches old agents.
- **Claude Code itself** — a single self-contained program file that runs fine from any location (the native installer already lays it down under a per-version directory; the npm installer does not).

## What this adds

At the moment a Claude Code session is about to start, the agent now looks at the real program file behind the configured path, reads its version, and copies it once into `<agent state>/claude-bin/<version>/claude`. The session is started from that copy. When Claude Code updates, the npm file changes but the saved copy keeps its name on disk, so the running session's program stays linked and the kernel never starts failing that path question. The next session after the update gets a fresh copy under the new version's directory. Old version directories are removed only once nothing is running from them any more.

- A status route, `GET /sessions/claude-binary`, tells you which copy sessions launch from, whether the last launch fell back to the original path (and why), what versions are kept, and what the last clean-up did. A `POST …/prune` runs one clean-up pass.
- An off switch, `sessions.retainedClaudeBinary.enabled: false`, puts things back exactly as before. The migrator writes the explicit `{ enabled: true }` block into existing configs so the switch is visible, never overwriting an operator's value.
- The agent's CLAUDE.md gets one bullet so it knows the route and the off switch, and can answer "why is kernel memory growing?" by reading instead of guessing.

## The new pieces

- **ClaudeBinaryRetainer** — resolves the real file and version, copies once per version, hands back the path to launch. It may never replace a saved copy in place (that would recreate the exact problem), so a new version always goes into a new directory. It may never stop a session from starting: on any failure it returns the original path, logs loudly, and records the reason in the status route. It only retains files that are plainly a Claude Code program; a shell wrapper script is launched as-is because a script is read by its interpreter and cannot cause this leak.
- **The prune pass** — runs at most hourly in the background and removes a saved version only when it is not the current one, has not been used for six hours, and no live process maps it (checked with `lsof`, or `/proc` on Linux). "Cannot tell" means keep.

## The safeguards

**Prevents the leak from coming back through the fix itself.** The saved copy is published with an atomic link that fails if the file already exists, never with a rename that would replace it. A same-version file of a different size goes into a size-suffixed sibling directory. Prune refuses to delete anything a live process maps and treats an unanswerable check as "in use".

**Prevents the fix from ever blocking a session.** Every failure path (disk full, unreadable file, permission error, unknown layout) falls back to launching the configured path, with a loud error line and a `lastError` on the status route. The leak is a slow failure; a session that cannot start is an immediate one, so the fallback direction is deliberate.

**Prevents the clean-up from ever acting across machines.** The prune action is registered as machine-local: each machine only ever removes copies under its own state directory, judged by its own live processes, and the next session start re-creates whatever it needs.

**Prevents surprises for other frameworks and tests.** Only `claude-code` launches are touched; codex, gemini, pi and grok pass through unchanged. The copy lives under the agent's gitignored state directory, so test agents in temporary directories clean up after themselves.

## What ships when

One PR, including the test-suite adjustments that keep the full suite green (under the test runner the feature defaults off so the many tests that pin a configured claude path stay the same on every machine; its own tests switch it on explicitly; the CLAUDE.md parity test tracks the new section). Sessions started before this lands still map their old unlinked program; they only move onto a saved copy when they are restarted (the desk schedules those restarts at safe points; this change never restarts anything by itself).

## What you actually need to decide

Nothing beyond the merge: the feature is on by default with a config off switch, and the live check on this Mac Studio showed a session launched from the saved copy keeping a linked executable through a simulated in-place update.
