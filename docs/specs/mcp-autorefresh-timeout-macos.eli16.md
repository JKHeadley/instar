# ELI16 — MCP Auto-Refresh Hook: macOS Timeout Portability Fix

**What is this about?** Instar installs a small helper script on every agent called
`mcp-health-autorefresh.sh`. Its job: at session start, quietly run `claude mcp list` to
see whether an important tool server (like Playwright, the browser tool) failed to
connect this session — and if an allowlisted one did, restart the session once so the
tool comes back. It's deliberately cautious: dark by default, allowlist-scoped, and
loop-guarded so it can never restart-loop a machine.

**What broke?** On Macs — which is where instar agents actually run in production — the
script was silently doing nothing at all. Ever. The line that runs the health check was
`timeout 45 claude mcp list`: it wraps the command in the standard `timeout` program so a
hung MCP probe can't stall forever. But macOS doesn't ship `timeout` — that's a GNU
coreutils tool, present on Linux and only on Macs where someone installed Homebrew
coreutils. On a Mac without it, "timeout: command not found" was swallowed by the
script's error redirection, the captured output was empty, and the script hit its
"no output → exit quietly" guard. Result: the auto-recovery feature was silently inert on
exactly the platform it was built for. No error, no log, nothing — which is why it went
unnoticed until a unit test that simulates the check failed on a coreutils-less Mac.

**Why did tests pass in CI?** CI runs on Linux, where `timeout` always exists. The unit
test that caught this (`PostUpdateMigrator-mcpAutorefresh.test.ts`) only fails on a Mac
without coreutils — like the production machines.

**What does the fix do?** It gives the script the same portable "timeout ladder" the
autonomous stop hook already uses for exactly this reason: try `timeout` first (Linux,
or Macs with coreutils), then `gtimeout` (Homebrew's name for it), then fall back to a
tiny Perl one-liner that forks the command, arms a 45-second alarm, and kills the whole
process group if it fires. Perl ships with macOS, so the ladder always has a rung on the
platforms we run on. The Perl rung uses the correct exit-status mapping (128+signal when
the child is killed by a signal — the same convention GNU timeout and every shell use),
so a killed probe is never mistaken for a clean result. If literally none of the three
runners exist, the script stays dark rather than run the probe unbounded — bounded
execution is a hard requirement, not a nice-to-have.

**How do existing agents get this?** Automatically. This script is a "built-in hook":
the updater (`PostUpdateMigrator.migrateHooks`) rewrites it fresh into
`.instar/hooks/instar/` on every update pass — always-overwrite, never
install-if-missing — so every deployed Mac gets the fixed script on its next instar
update, with no manual step. The unit suite verifies this migration-parity behavior.

**Is anything less safe now?** No. All the safety properties are untouched: dark by
default, explicit-false always wins, allowlist-scoped, the once-per-(session, failed-set)
hard loop-guard, and backgrounded start. The only change is that the health check now
actually runs on Macs — bounded, exactly as designed.
