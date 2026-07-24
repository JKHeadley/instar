# Side-Effects Review — MCP Auto-Refresh Hook macOS Timeout Portability

**Version / slug:** `mcp-autorefresh-timeout-macos`
**Date:** `2026-07-18`
**Author:** Echo (autonomous, Tier-1 fix cycle, tracked ref CMT-896)
**Second-pass reviewer:** self-reviewed-final-diff (session-lifecycle adjacent — the hook can trigger a /sessions/refresh — second pass required; performed as a genuinely fresh re-read of this artifact against the final diff; see "Second-pass review" below)

## Summary of the change

`tests/unit/PostUpdateMigrator-mcpAutorefresh.test.ts` ("DEV agent auto-enables…") failed
deterministically on macOS while Linux CI was green. Root cause: the generated
`mcp-health-autorefresh.sh` (authored in
`src/core/PostUpdateMigrator.ts` → `getMcpHealthAutorefreshHook()`) ran its health probe
as `LIST=$(timeout 45 "$CLAUDE_BIN" mcp list 2>/dev/null || true)`. Bare `timeout` is GNU
coreutils — absent on coreutils-less Macs (this machine has neither `timeout` nor
`gtimeout` nor Homebrew). The command-not-found error was swallowed by `2>/dev/null || true`,
LIST stayed empty, and the script's `[ -n "$LIST" ] || exit 0` guard exited silently —
so the auto-restart-on-MCP-inaccessible feature was **silently inert in production on
macOS**, the platform instar agents actually run on. Same platform-gap family as the
autonomous stop hook's real-check runner fix (previous cycle).

Files modified (single source file):
- `src/core/PostUpdateMigrator.ts` — the generated hook's probe line becomes a portable
  bounded-runner LADDER mirroring the stop hook: `timeout` → `gtimeout` → perl-alarm
  fallback. The perl rung forks, `setpgrp` + group-KILL on a 45s alarm (exit 124), and
  maps child status with `exit(($?&127) ? 128+($?&127) : ($?>>8))` — GNU-timeout
  semantics, so a signal-killed probe is never mistaken for a clean exit. If NO bounded
  runner exists, the script stays dark (exit 0) — it never runs the probe unbounded.

## The eight questions

1. **Over-block** — None identified. On Linux (and Macs with coreutils) the first rung is
   byte-identical to the old behavior. On coreutils-less Macs the change strictly
   *enables* previously-dead functionality; it rejects nothing new. The no-runner-at-all
   case (no timeout, no gtimeout, no perl) exits 0 exactly as the script effectively did
   before — but now by explicit design with a comment, not by accident.
2. **Under-block** — The fix closes the silent-inert hole. Remaining, pre-existing and
   unchanged: a `claude mcp list` that exits 0 but prints garbage is still trusted as a
   listing (grep simply won't match); the 45s bound is unchanged. The perl rung's
   KILL-on-alarm is stricter than GNU `timeout`'s default TERM-then-KILL — acceptable
   here because the probe is read-only (`mcp list` mutates nothing worth a graceful
   shutdown). No issue identified.
3. **Level-of-abstraction fit** — Correct layer: the bounded-runner contract lives inside
   the generated script at the single probe callsite, exactly parallel to the stop hook's
   ladder (the established in-repo pattern for "bound a command portably"). A shared
   sourced library for the two ladders would be a bigger refactor of generated-script
   plumbing than this fix warrants and would couple two independently-shipped hooks;
   deliberately not done.
4. **Signal-vs-authority compliance** — Not a message-flow decision point; deterministic
   exit-status plumbing in an existing dark-by-default hook. The hook's authority shape
   is unchanged: dark default, explicit-false wins, allowlist scope, hard loop-guard
   (at most ONE refresh per (session, failed-set)). No brittle blocking heuristic added
   (`docs/signal-vs-authority.md` reviewed — this adds no gate). No issue identified.
5. **Interactions** — The ladder only changes HOW the probe is bounded, not what
   downstream sees: LIST parsing, allowlist matching, marker loop-guard, and the
   /sessions/refresh call are untouched. On machines with `timeout` (all of CI, most
   Linux) the executed bytes are the same as before, so zero interaction delta there.
   The perl rung's process-group KILL cannot touch the parent script (child is
   `setpgrp`'d into its own group). No double-fire: rungs are exclusive `elif`s.
6. **External surfaces** — None new. No network, config, API, or route changes. The
   generated file's content changes (comment + ladder), which the existing unit suite
   re-pins (`bash -n` syntax validity, safety-invariant greps, migration parity). Agents'
   observable behavior change: on coreutils-less Macs an allowlisted failed MCP can now
   actually trigger the (config-gated, loop-guarded) single session refresh — i.e. the
   feature works as its spec and config already documented.
7. **Multi-machine posture (Cross-Machine Coherence)** — Machine-local BY DESIGN: the
   hook runs at session start on the machine hosting the session, probing THAT machine's
   MCP registrations; its marker state (`.instar/state/mcp-autorefresh-marker.json`) is
   per-machine and must not replicate (another machine's MCP health is meaningless here).
   The fix makes behavior machine-uniform across the pool (a Mac and a Linux box now run
   the same probe contract). No user-facing notice, no durable cross-machine state, no
   URLs.
8. **Rollback cost** — Low. Single-file revert of one commit restores the prior generated
   script; the next migration pass always-overwrites the deployed copy back (same
   delivery path as the fix). No data migration, no state repair — the marker file format
   is unchanged. Reverting re-opens the silent-inert-on-macOS hole, so the back-out plan
   is revert-and-re-fix.

## Migration Parity (explicit)

`migrateHooks()` writes this hook with an unconditional `fs.writeFileSync` into
`.instar/hooks/instar/mcp-health-autorefresh.sh` on every migration run (always-overwrite,
never install-if-missing) — verified in code (src/core/PostUpdateMigrator.ts, the
migrateHooks try-block) and pinned by the passing test "migration parity: migrateHooks
always-overwrites the hook into hooks/instar/". Deployed Macs therefore receive the fixed
script automatically on their next instar update; no config or manual step.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure: n/a** (negative declaration).
  No new self-action is introduced: the diff's added `kill()` is the perl timeout rung
  reaping its OWN bounded child probe (process hygiene inside a one-shot session-start
  probe), not a controller emit. The hook's pre-existing self-triggered action (the
  single `/sessions/refresh`) is unchanged and remains hard-bounded by the
  once-per-(session, failed-set) marker loop-guard — it structurally cannot loop.
  Mirrors the machine-readable declaration in the instar-dev trace.

## Second-pass review (self-reviewed-final-diff)

Fresh re-read of the final `git diff` against this artifact:

- **Template-literal escaping audited character-by-character**: every shell `$` in the
  added block is escaped `\$` (TS template literal), including all perl variables
  (`\$t`, `\$p`, `\$SIG`, `\$?`); no bare `${` remains that TS would interpolate; the
  perl program contains no single quotes so the bash single-quoted `-e '…'` wrapping is
  sound. The generated output was syntax-checked via the suite's `bash -n` test (passes).
- **Live contract proof re-run** (this machine, no timeout/gtimeout): perl rung returns
  124 on a hung `sleep 30` with a 2s bound; passes through exit 3; maps SIGTERM death to
  143; captures stdout correctly. The dev-gate unit test exercises the full script path
  through the perl rung end-to-end (mock `claude` → probe → dead-port session resolution).
- **First-pass omission caught and fixed in this artifact**: the initial draft of Q2 did
  not name the KILL-vs-TERM strictness difference between the perl rung and GNU timeout's
  default; added with the read-only-probe justification.
- **Honest scope note**: this branch (off origin/main) does not contain the previous
  cycle's stop-hook fix — `tests/unit/autonomous-stop-hook-realcheck.test.ts` still shows
  that one known failure HERE (1 failed | 23 passed), which is the other PR's subject and
  resolves when both merge. All 14 targeted sibling/migrator files (139 tests) pass on
  this branch, including the previously-failing mcpAutorefresh suite (9/9).
- **Checked for other bare-`timeout` callsites in generated scripts** (grep for
  `timeout N` across `src/core/PostUpdateMigrator.ts`, `src/data/http-hook-templates.ts`,
  `src/scaffold/`, `src/templates/`, `templates/`, excluding curl's `--connect-timeout`/
  `--max-time` flags): the line fixed here was the ONLY bare coreutils-`timeout`
  invocation; no other generated script carries this defect class. Sweep converged clean
  in one re-pass. <!-- tracked: CMT-896 -->
- Conclusion: artifact accurate against the final diff; no unlisted side effects found.
  Reviewer concurs with shipping.
