# Side-Effects Review — Real-Check Runner macOS Signal-Death Portability Fix

**Version / slug:** `realcheck-utf8-macos-portability`
**Date:** `2026-07-18`
**Author:** Echo (autonomous, Tier-1 fix cycle)
**Second-pass reviewer:** self-reviewed-final-diff (session-lifecycle-adjacent → second pass required; performed as a genuinely fresh re-read of this artifact against the final diff — see "Second-pass review" below)

## Summary of the change

`tests/unit/autonomous-stop-hook-realcheck.test.ts` ("invalid-UTF-8 capture … → next
payload still builds") failed deterministically on macOS (Node 24) while Linux CI was
green. Instrumented reproduction showed the hook did not emit broken JSON — it emitted the
**allow-exit** message: the failing verification command was scored as a PASS. Root cause:
the perl timeout-ladder rung (used when GNU `timeout`/`gtimeout` are absent — i.e. on
macOS, where instar agents actually run) ended with `exit($?>>8)`. When the child command
is killed by a **signal** — routinely SIGPIPE, because the source byte-cap
(`head -c $RC_CAPTURE_BYTES`) closes the pipe while the command still writes — `$?`'s low
byte holds the signal and the high byte is 0, so `$?>>8` == 0 == PASS. GNU `timeout` maps
the same death to 128+signal (141), which is why Linux CI never saw it. This was a
cardinal-invariant violation (a verification failure mode allowed a premature exit), not
just a test-portability nit.

Files modified (single file):
- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`
  1. Perl runner exit mapping: `exit($?>>8)` → `exit(($?&127) ? 128+($?&127) : ($?>>8))`
     — signal-death now reports 128+signal, byte-identical to GNU `timeout` and shell
     semantics. Timeout (124), spawn-fail (127), and normal exits are untouched.
  2. UTF-8 scrub fallback (same §5.3 chain, step 1b): macOS iconv `-c` emits the
     correctly-scrubbed prefix but exits non-zero on a truncated trailing multibyte char;
     the old `iconv … || tr -cd …` therefore ran BOTH commands and concatenated their
     outputs (text duplication hazard for mixed ASCII/multibyte captures). The fallback
     now keys on "iconv produced no output from non-empty input", never on exit code.
  3. Comments documenting both portability behaviors. The PINNED ORDER
     (sanitize → UTF-8 scrub → leak-scrub → clamp) is semantically unchanged.

No test was weakened; the shipped hook was fixed.

## The eight questions

1. **Over-block** — By design this change *adds* blocking: a check command killed by a
   signal (SIGPIPE from the byte cap, OOM-kill, external kill) now scores FAIL →
   keep-working instead of PASS → exit. That is the cardinal invariant's required
   direction ("any failure mode routes to keep-working"), not an over-block. A
   genuinely-passing check is unaffected: a command that completes successfully exits 0
   on its own before the wrapper reads status, and `($?&127)==0` preserves the old
   mapping exactly. Edge considered: a check whose *last* action prints past the 65,536-
   byte capture cap and would then have exited 0 — its SIGPIPE death now blocks the exit.
   That command never got to its exit-0, so its success was never observable; treating an
   unobservable success as non-pass is the fail-safe reading the invariant mandates (and
   is identical to today's Linux/GNU-timeout behavior, so it introduces no new stringency
   anywhere CI runs). No issue identified.
2. **Under-block** — The fix closes the known signal-death→PASS hole. Remaining misses
   are pre-existing and unchanged: a check that *itself* swallows failures (e.g.
   `cmd || true`) still reports 0; the destructive-pattern pre-block remains a
   pattern-list, not a sandbox. Nothing in this change widens them. The `cut -c` clamp
   can still re-split a multibyte char after the UTF-8 scrub on both platforms (GNU and
   BSD `cut -c` are byte-oriented in the C locale); this is tolerated today because `jq
   --arg` replaces invalid bytes with U+FFFD on both platforms (verified live on macOS in
   this cycle; Linux CI green proves the same), so the JSON payload remains valid. Left
   as-is deliberately to keep this fix minimal; the scrub step guarantees jq receives at
   most one truncated tail, never arbitrary garbage.
3. **Level-of-abstraction fit** — Correct layer. The exit-status contract belongs to the
   timeout-ladder rung itself: each rung must present the same observable contract
   (0=pass, 124=timeout, 127=spawn-fail, non-zero=fail, 128+n=signal). Fixing the perl
   rung to match GNU timeout keeps the ladder's consumers (the outcome switch at
   §"Outcome") rung-agnostic. The iconv fallback fix likewise stays inside step 1b of the
   pinned chain. No higher-layer gate should own POSIX status-word decoding.
4. **Signal-vs-authority compliance** — This is not a message-flow decision point; it is
   deterministic exit-status plumbing inside an existing gate. The authority structure is
   unchanged: the real-check outcome still only *holds* completion (keep-working block);
   the only path to exit remains judge-MET + check-PASS. Per `docs/signal-vs-authority.md`
   there is no brittle blocking heuristic added — POSIX status decoding is exact, not
   heuristic. No issue identified.
5. **Interactions** — The 124 (ALRM handler exits directly) and 127 (exec-fail) paths are
   untouched and cannot collide with the new mapping (the handler exits before `waitpid`
   status is consulted; exec-fail is a normal exit). The P19 breaker consumes
   outcome=fail rows identically regardless of exit code value. The audit row
   (`logs/autonomous-realcheck.jsonl`) now records e.g. exitCode 141 where macOS
   previously recorded 0 — consumers treat exitCode as opaque display data. No
   double-fire, no shadowing, no race with adjacent cleanup. No issue identified.
6. **External surfaces** — None new. No network, no config keys, no API change, no
   template/migration surface: the hook ships inside the `autonomous` skill and
   `installBuiltinSkills()`/`PostUpdateMigrator` handling for it is unchanged (the file
   is delivered by the existing skill-content migration path; this edit rides the next
   release exactly like any prior hook edit — verified that
   `PostUpdateMigrator-autonomousStopHook.test.ts` passes). Timing dependence is
   *reduced*: the outcome no longer depends on whether the platform's runner happens to
   be GNU timeout or perl.
7. **Multi-machine posture (Cross-Machine Coherence)** — Machine-local BY DESIGN. The
   stop hook runs inside the one session process on the machine hosting the autonomous
   run; its verdict never replicates and needs no merged read. The fix makes the
   *behavior contract* machine-uniform (a run that fails its check on a Mac now blocks
   exactly as it would on Linux), which improves cross-machine coherence of the
   autonomous-run guarantee without any replication path. No user-facing notice is
   emitted by this change (the block guidance text is unchanged), so one-voice gating is
   unaffected; no durable state or URLs are created.
8. **Rollback cost** — Low. Single-file, two-expression revert (`git revert` of one
   commit); no data migration, no agent state repair, no config. Reverting restores the
   macOS signal-death→PASS hole, so the rollback itself would be a safety regression —
   the back-out plan is revert-and-re-fix, not revert-and-stay.

## Second-pass review (self-reviewed-final-diff)

Fresh re-read of the final `git diff` against this artifact, hunting for anything the
first pass papered over:

- **Verified the arithmetic**: `($?&127)` extracts the termination signal; for SIGPIPE
  (13) the new expression exits 141, matching `bash`'s `$?` and GNU timeout. For a normal
  exit N, `$?&127`==0 and the expression reduces to the old `$?>>8` — byte-identical
  legacy behavior. Perl's `exit()` takes the value mod 256; 128+127=255 is in range, no
  wrap hazard.
- **Checked the ALRM race honestly**: if the alarm fires during `waitpid`, the handler
  `exit 124`s immediately — the new mapping is never reached; timeout classification is
  preserved. If the child dies from the handler's KILL in a lost race, 128+9=137 → FAIL →
  keep-working — safe direction.
- **Flagged and resolved one first-pass omission**: the first draft of Q1 did not
  consider the "command succeeds but is killed printing its final output" case; added it
  explicitly — the conclusion (fail-safe, matches existing Linux behavior) holds.
- **iconv fallback re-check**: the new `[[ -z "$rc_utf8" && -n "$rc_san" ]]` guard means
  an all-invalid-bytes capture (iconv emits nothing) still gets the C-locale printable
  filter (yielding empty — acceptable, valid), and a non-empty scrub is never
  double-appended. `|| true` keeps `set -e`-adjacent safety (the hook runs without
  `set -e`, but the guard costs nothing). Confirmed no OTHER `iconv … ||` callsites exist
  in the hook (grep: this is the only one).
- **Scope check**: diff touches exactly one shipped file plus the three ceremony
  artifacts; no test files modified — the failing test was fixed by fixing the hook, as
  required. The pinned-order comment block remains accurate (order unchanged; step 1b
  made exit-code-portable, step semantics identical).
- Conclusion: artifact is accurate against the final diff; no unlisted side effects
  found. Reviewer concurs with shipping.
