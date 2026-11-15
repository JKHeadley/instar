# Side-Effects Review — CI tmux apt mirror failover

**Version / slug:** `ci-tmux-mirror-failover`
**Date:** `2026-11-11` (candidate); restored on a fresh branch from main `44b2357ab5` (1.3.1785) on `2026-11-15`
**Author:** Echo
**Second-pass reviewer:** not required by the trigger list (no messaging, session-lifecycle, gate or sentinel decision). Independent native Opus reads were done anyway: the Nov 11 candidate review, and a fresh read of this restored patch (recorded below). Real hosted setup proof on the final head is pending.

## Summary of the change

### ELI16

 Before our CI tests run, a setup script builds a fixed version of tmux (3.6a), and to do that it first asks Ubuntu's package manager, apt, for the list of available packages. GitHub's Linux runners know about more than one Ubuntu download server: a primary Azure copy and some backups, listed in a file called `/etc/apt/apt-mirrors.txt`. When a file download stalls, apt is supposed to move on to the next server. But apt first uses up all of its retries on the same server before moving on. Our script told apt to retry twice and wait 20 seconds each time, and the script only allows apt 180 seconds in total. On PR 3078 requests to the Azure mirror stalled. apt waited 20 seconds for each of four index files, then started over on the same server, and the 180 seconds ran out before it ever tried a backup. Every test job failed before a single test ran, and a rerun failed the same way. The fix tells apt not to retry on the same server and to give up on a stalled download after 15 seconds, for both plain and secure downloads, so configured backup servers can be tried within the same 180-second limit. Nothing about which servers apt trusts, which signing keys it checks, or the tmux version and its checksum changes. A hosted CI rerun is still required to show this works against the real servers.

The change is in `.github/scripts/setup-ci-tmux.sh` only. It replaces `-o Acquire::Retries=2 -o Acquire::http::Timeout=20` on `apt-get update` with a shared option list `Acquire::Retries=0`, `Acquire::http::Timeout=15`, `Acquire::https::Timeout=15`, and passes the same list to `apt-get install`. It is a reversible, Tier 1, CI-only change. The script is byte-identical to commit 210e8af53d (sha256 `001453245e2721980d4230528bef1df810544b9aa8a4bb525a58d4a53d3e780f`); main's script had not changed since that commit's base, so the hunk applied as is.

## Decision-point inventory

- GitHub runner tmux setup for the unit matrix, integration and E2E jobs: changed (apt acquire options only).
- Test selection, test commands, lifecycle assertions, merge authority: unchanged.

## 1. Over-block

With no per-URI retry, one brief network blip on a file means apt moves to the next configured mirror instead of retrying the same one. If the blip hits the last mirror in the list, that file fails where two retries might have saved it, and the setup step goes red. The job fails explicitly and can be rerun; it does not skip tests. The same is true if a healthy mirror takes more than 15 seconds to start answering. `apt-get install` used to inherit the image's retry setting (Retries 1) and now uses 0 too, so one blip while downloading a `.deb` from the last mirror now fails install.

The 180-second budget is not guaranteed to be enough. In the baseline apt asked for the four InRelease files one after another on the same host. If a stall behaves the same way with these settings, each stalled mirror can cost about 4 × 15 s = 60 s before apt moves on, so a stall covering about three mirrors can still hit the 180 s bound (exit 124), as before. Whether apt fails over per file or per host is not verified here. If every configured mirror stalls but apt still finishes within the bound (roughly two or fewer mirrors in total), update may finish with warnings and stale or missing lists, with the explicit failure surfacing at install. `Acquire::http(s)::Timeout` is a connect/no-data timeout, not a cap on a whole download: a mirror that keeps sending bytes slowly is stopped only by the 180 s wrapper.

## 2. Under-block

None added. apt still verifies every repository signature with the image's existing keys. No source is rewritten, no mirror is added, no `--allow-unauthenticated`, no TLS or check skip. The tmux tarball checksum and `tmux -V` check are unchanged.

## 3. Level-of-abstraction fit

The failure is in runner preparation, and the fix is in the script that prepares the runner, using apt's own documented options. It matches what GitHub's runner image itself sets for hosted x64 (Retries 1, Timeout 15) and goes one step further on retries so failover has a chance to fit our 180-second bound.

## 4. Signal vs authority compliance

The setup step cannot green a PR. Merge protection is unchanged: live main requires `instar/local-verify` and applicable code-owner review; Actions jobs are advisory. The evidence requested below for this CI candidate is distinct from the repository merge rules.

## 5. Interactions

`-o` options on the command line override the image's `/etc/apt/apt.conf.d/zz-retries`. The install command previously inherited the image's values (Retries 1 per the runner-image source; the image file name and values were not re-checked on Nov 15); it now uses the same explicit list as update. Runners that already have every build dependency skip apt entirely, as before.

## 6. External surfaces

No change to job names, branch protection, release package, or any installed agent's files or behavior. No template, migration or awareness change is needed.

## 7. Multi-machine posture

GitHub-hosted jobs only. Studio, Mini, M5 and Local Verify slots are unaffected.

## 8. Rollback cost

Revert the one script hunk. No state or data.

## Verification

- Baseline (actual): PR 3078, run 43055208211, attempts 1 and 2. Unit, integration and E2E logs show `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist`, then `Ign` on `azure.archive.ubuntu.com` noble, noble-updates, noble-backports and noble-security InRelease exactly 20 seconds apart, the same four repeating, then `Process completed with exit code 124`. No test assertion ran.
- Primary source: https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt.sh — explains that retries target the current URI before mirror selection advances.
- Local (actual): `bash -n .github/scripts/setup-ci-tmux.sh` passes; `npx vitest run tests/unit/ci-tmux-toolchain.test.ts` passes.
- Earlier candidate on hosted runners (actual, Nov 11, merge `8dea8260d` of 210e8af53d into an older main): in both retained unit node-22 logs "Ensure tmux" read `/etc/apt/apt-mirrors.txt`, printed `tmux 3.6a` 29 s and 34 s after the step began, and showed zero `Ign:` or `Err:` lines. One log then passed 1199 files / 15971 tests; the other passed setup and later had 1 failing test, `tests/integration/passkey-browser-fixture.test.ts` (Chrome passkey fixture, triaged then as fb-00804d94-3c7), which this script does not touch. The mirror was healthy, so this is no-regression evidence only, not exercised failover.
- Restored branch (actual, local): script sha256 equals 210e8af53d's; `bash -n` passes; `tests/unit/ci-tmux-toolchain.test.ts` (workflow wiring: every real-process lane runs this script before its tests) passes.
- PENDING: hosted "Ensure tmux" evidence on this PR's final head (normal push-triggered Actions), and the required `instar/local-verify` passing all three tiers. Advisory hosted test failures after setup are reported and triaged with their source; they are not hidden and no floor or gate is lowered. Local checks cannot prove real mirror failover; this change does not claim all tests or live delivery are fixed.

## Second-pass review

Nov 11 candidate: a fresh native Opus 5.5 independent reviewer concurred as a candidate after reading the script diff, notes, three actual failure logs and workflow callers; it ran bash syntax validation, not Vitest or hosted CI. It disclosed that it did not fetch the runner-image source; root verified that primary source separately. The failover mechanism remains an inference until observed on a stalled mirror. If the mirror is healthy, a green setup proves no regression rather than exercised failover.

Restored patch (Nov 15): a fresh native Opus 5.5 reviewer in a separate CLI context (model `claude-opus-5-5`, session `f6ebd3d4-4d0b-4409-84a9-f1b28c063875`, success, 11 turns) returned `VERDICT: CONCUR` on the script. It confirmed the script is byte-identical to 210e8af53d, both apt commands get the option list, no workflow, test or gate file changed, the three `ci.yml` callers, and the old-log facts (29–34 s, zero `Ign:`/`Err:`, the one unrelated passkey failure). It raised four fragment findings: the 180 s budget arithmetic (medium), Timeout being a no-data timeout (low), install losing its inherited retry (low), and this paragraph's missing record (low). All four are corrected in this file; the same reviewer session re-read the result and returned `VERDICT: CONCUR` (2 turns), with two optional wording points that were also applied. It did not check run 43055208211's logs, the runner-image source, or apt's per-file failover order, and it ran no tests. Raw result is kept privately with the author's evidence.

## History and scope of this restore

PR 3080 carried this hunk on a branch stacked on the documentation PR 3081. When 3081 merged (2026-11-12 21:08:42Z) its branch was deleted and GitHub closed 3080 automatically, unmerged; it was not rejected. This branch starts fresh from current main and carries only the script hunk and these two fragments, none of the stacked documentation commits. Merge rules on main are unchanged: the required status is `instar/local-verify`, and the pull-request rule requires code-owner review only for CODEOWNERS paths (none touched here). Actions jobs are advisory.
