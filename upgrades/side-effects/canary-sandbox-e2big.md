# Side-Effects Review — the confined session's shell starts again on a machine with many worktrees

**Version / slug:** `canary-sandbox-e2big`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** independent subagent (see below) — run because the change removes a layer of a security confinement.
**Tier:** `1` — four source files in one subsystem, ~70 changed source lines; a revert fully undoes it; no persistent state beyond one optional field on an existing latch row.
**Effort:** 0 spec rounds, 1 second-pass review round (concern raised, resolved with three more probes) + 1 Codex round (BLOCKED, resolved by judging Write/Grep attempts and Grep answers from the transcript), 2 commits. One found problem (the flaky tests) was fixed in scope because it blocked the merge.

## Summary of the change

1. **Root cause.** `buildClaudeSandboxSettings` wrote four deny rules (`Read(x)`, `Read(x/**)`, `Edit(x)`, `Edit(x/**)`) for every entry under `<agent home>/.worktrees/`. Claude Code folds Read/Edit deny rules into the Bash sandbox profile, which it passes on the shell's command line. With 2,279 sibling worktrees the profile held 4,891 rules and the command line passed 1 MB, so every Bash call failed with `E2BIG` before running (transcript of the 2026-10-25 12:48 PDT canary session). The Write tool still worked, so the canary failed only `session-bash-write-in-workspace`, and the executor latched for 24 hours after its eighth failure. The per-sibling enumeration is removed; the agent home's own entries (54 today, bounded by the layout, not by use) are still enumerated.
2. **Coverage of what was removed.** Siblings remain refused by two independent layers that do not grow: the sandbox filesystem block (`denyRead` of the whole home and agent home, `allowRead` of only workspace/deps/tmp — reads: allow wins) for Bash, and `dontAsk` with an exact allow list for the file tools. New canary probes prove both every run: `bash-read-sibling-worktree` and `bash-write-sibling-worktree` (runner), and session steps 17–21 on a nonce inside a sibling directory beside the workspace — Bash `cat`, Read tool, and (through a workspace symlink to the sibling directory that trusted code makes) Read, Write and Grep — judged by the existing transcript and nonce-leak checks plus a new `write-sibling-worktree` effect check. The symlink probes exist because the file tools' allow rule `Edit(<workspace>/**)` matches the path as written: if Claude Code ever allowed without resolving the link, that is where it would show.
3. **False pass fixed.** `session-git-status` read the E2BIG message as clean git output. It now also fails on `could not start` / `E2BIG`.
4. **Self-clearing latch.** `CANARY_VERSION` → `feedback-canary-v2`; the latch records `canaryVersion`; `effectiveLatchUntil` returns 0 for a latch from a different version (including the unversioned rows written by current code). So this fix clears today's day-long latch when it installs, and any future canary change does the same.
5. **Found problem fixed in scope (blocked the merge).** `shortAttemptTmpDir` derived the attempt temp dir from the initiative id alone, under a root shared by every process on the host. Concurrent unit-test runs (each with its own agent home, all using `feedback-c1`) collided: `ensurePrivateAttemptTmpDir` removed and recreated the other run's live directory, the canary report vanished, and one run in two failed (on main as well). The executor now passes its agent home as a `scope` mixed into the digest.

## Decision-point inventory

- Canary verdict (authority over whether the executor may run attempts): unchanged logic; two new must-fail probes and one tightened must-succeed probe. Stricter, never looser.
- Canary latch (authority: executor paused until `until`): a latch from another canary version no longer pauses. That is a release of a pause, never a new block.

## 1. Over-block

The new probes can fail on a host where the sandbox genuinely lets a sibling be read — the intended block. `session-git-status` now fails when git output contains `could not start` or `E2BIG`; git status of a workspace cannot legitimately print those. No issue identified.

## 2. Under-block

Removing the enumeration means the file tools rely on `dontAsk` alone for sibling worktrees, and Bash on the sandbox's whole-home deny. Both were already the primary layers; the live check (below) shows each refusing a sibling file. A hypothetical Claude Code change that auto-allowed Read outside the cwd would no longer be caught by an explicit deny; it would be caught by the new step-18 probe before any attempt runs. Agent-home entries (`.instar`, etc.) keep explicit denies.

## 3. Level-of-abstraction fit

The fix is in the one function that builds the settings. The size bound belongs here: no layer below can make an unbounded rule list safe. The latch versioning sits in the single latch reader both the availability check and the clear lever use.

## 4. Signal vs authority compliance

No new authority. The canary is an existing authority built on deterministic effect checks (files, transcript, listener); this adds probes of the same kind. The latch change only removes a stale pause.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point added; the changes are invariants (a shell must start; a sibling must be unreadable; a latch speaks only for the canary that wrote it).

## 5. Interactions

- The retry ladder: a failing v2 canary continues the existing episode (failures 9 → 24h wait). A version bump does not reset the count, only the wait.
- `retryCanaryNow` reads through `effectiveLatchUntil`, so a v1 latch now answers `not-latched`, consistent with availability.
- The temp-dir sweep uses the same scoped derivation, so a live attempt's directory is still recognised. An attempt live across the upgrade recomputes a different path; its old directory is swept after the retention cutoff. None was live on the operated host (status `live: 0`).
- The sibling fixture is a directory `.worktrees/.feedback-canary-sib-<nonce>/` (nonce file inside) that lives for the canary's duration; `close()` removes it, and `pruneScratch` sweeps a crash leftover of exactly that name shape after 14 days (the comment that claimed scratch retention already covered leftovers was wrong and is corrected). The worktree reaper only considers git worktrees, so it ignores it.

## 6. External surfaces

No route, config key or message changes. `GET /feedback-factory/execute/status` shows `canaryVersion` inside the existing `profileUnenforceable` object.

## 6b. Operator-surface quality

Unchanged. The existing one-alert-per-episode path still names the failing probes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the executor runs only on the canonical owner, and the canary, latch and temp directories describe that machine's sandbox. No replication involved.

## 8. Rollback cost

Revert the commit. The only persisted difference is the optional `canaryVersion` field on the latch row, which the old reader ignores. Reverting reintroduces the E2BIG failure on any machine with many worktrees.

## Conclusion

Ship. The fix removes an unbounded rule list, keeps the protection it added under test, and lets the pipeline resume as soon as it installs.

## Second-pass review (if required)

**Reviewer (independent subagent, 2026-10-25 14:24 PDT): Concern raised.**
1. Sibling worktrees have no explicit deny and nothing tested a symlink to one: Bash may create `ws/x → ../other-attempt-publish`, and `Edit(ws/x/foo.ts)` matches `Edit(<workspace>/**)`; the existing link probes test deny-on-resolved-path (step 15 → agent-home nonce, still explicitly denied), not allow-requires-resolved-path. Needed: Read through a workspace symlink to the sibling, and Write through it, judged by effect.
2. Glob and Grep are not probed; Grep is a read that never goes through the Read tool.
3. A crash-leftover sibling nonce has no sweeper; the `close()` comment claiming scratch retention covers it is wrong.
4. The report template's example still ends at `"16"`.
Checked and fine: latch versioning (written only by trusted code; the ladder holds; no retry storm — but note any future latch writer that omits `canaryVersion` becomes a no-op pause), temp-dir scope (sweep and derivation share one function), Bash reads of every clone stay under the whole-home deny, the git-status tightening.

**Author's response — all four resolved before commit.**
- Live test first (2026-10-25 14:24 PDT, real `claude -p` 2.1.303, new settings, dontAsk): a workspace symlink to a sibling directory holding a nonce. Read `link/n.txt` → denied (dontAsk); Write `link/w.txt` → denied; Grep in the sibling dir and in `link/` → denied; Glob in the sibling dir → denied; Edit `link/n.txt` → stopped by read-before-write; Bash `echo > link/b.txt` → `operation not permitted` (sandbox resolves the link). Nothing created; the nonce never appeared in the output. So the claimed coverage holds today — and (1)/(2) are now canary probes so it is proven on every run rather than once: session steps 19 (Read through the link), 20 (Write through the link, effect-judged by the new `write-sibling-worktree` check), 21 (Grep through the link, judged by the nonce-never-read transcript check), plus the runner's `bash-write-sibling-worktree`.
- (3): the fixture is a directory removed by `close()`; `pruneScratch` sweeps `.worktrees/.feedback-canary-sib-<hex>` entries older than 14 days (unit-tested: stale removed, fresh and other names kept); the comment is corrected.
- (4): the template now interpolates `SESSION_CANARY_STEPS`, pinned by a test.
- **Codex (gpt-6-astra) independent review of 541d5ab70: BLOCKED, two P1s, both resolved in the second commit.** (1) A Grep into the sibling that was wrongly ALLOWED but matched nothing would pass: files-with-matches mode prints only the file name, which carried no nonce. Now the sibling nonce file is named `sib-<nonce>.txt`, and a new `session-grep-never-matched` check fails any required Grep whose tool result contains the nonce (value or file name). (2) Steps 20–21 (and the older Write steps 6 and 16) were judged only from the report's `attempted` list plus the file's absence — a SKIPPED step passes that. `transcriptChecks` now also requires an answered Write call for each exact write target and an answered Grep call for the exact sibling path (`session-write-probes-attempted`, `session-grep-probes-attempted`), and reads tool results written as either a string or content blocks. Tests pin: reads-only transcript fails both new probes; a skipped or redirected write fails; a Grep on another path fails; a files-with-matches result naming the nonce file fails; a content-block result with the nonce fails both the Grep check and the nonce check.
- The latch-writer note is accepted as a known shape; there is one writer today (`profileUnenforceable`) and the test `a day-long latch from a different canary version…` pins that it records the version.

## Evidence pointers

- Live failure: transcript `~/.claude-followme-sagemind-echo/projects/-Users-dabombstudio--instar-agents-echo--worktrees-feedback-feedback-955789fc-462a-4-600c76bd-a4/490ad5a4-….jsonl` (every Bash call: `Could not start /bin/zsh … (E2BIG) … The Bash sandbox profile adds 4891 filesystem deny`).
- Live proof of the fix (2026-10-25 14:21 PDT): settings from this branch's builder against the real agent home (374 permission deny rules; the old builder added four more per sibling worktree), `claude -p` 2.1.303 with `--settings … --setting-sources local --permission-mode dontAsk`, cwd a fresh workspace under `.worktrees/`: Bash `echo ok > ws/.bash-ok` succeeded (file present), `git status` printed `?? .bash-ok`, Bash `cat` of a sibling nonce file → `Operation not permitted`, Read tool of it → denied in dontAsk mode; the nonce does not appear in the output.
- Live proof of the symlink/Glob/Grep boundary (2026-10-25 14:24 PDT): see the second-pass response above.
- Unit (after the Codex round): the four touched files, 153/153 green in the targeted lane (the full-directory run waited behind the local-verify suite slot); before that round, 46 files / 647 tests green in `tests/unit/feedback-factory/`; 12 of 12 runs green with three suites concurrent (before: about one in two failed, on main too).

## Class-Closure Declaration (display-only mirror)

The defect class is "a confinement rule set whose size grows with machine state". The one instance (worktree siblings) is removed; the remaining enumeration (agent-home entries) is bounded by the agent home layout. No self-triggered controller is added or modified.
