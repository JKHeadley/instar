# Side-Effects Review — CI tmux apt mirror failover

**Version / slug:** `ci-tmux-mirror-failover`
**Date:** `2026-11-11`
**Author:** Echo
**Second-pass reviewer:** fresh native Opus 5.5 independent reviewer — CONCUR as a candidate, real hosted proof pending.

## Summary of the change

### ELI16

 Before our CI tests run, a setup script builds a fixed version of tmux (3.6a), and to do that it first asks Ubuntu's package manager, apt, for the list of available packages. GitHub's Linux runners know about more than one Ubuntu download server: a primary Azure copy and some backups, listed in a file called `/etc/apt/apt-mirrors.txt`. When a file download stalls, apt is supposed to move on to the next server. But apt first uses up all of its retries on the same server before moving on. Our script told apt to retry twice and wait 20 seconds each time, and the script only allows apt 180 seconds in total. On PR 3078 requests to the Azure mirror stalled. apt waited 20 seconds for each of four index files, then started over on the same server, and the 180 seconds ran out before it ever tried a backup. Every test job failed before a single test ran, and a rerun failed the same way. The fix tells apt not to retry on the same server and to give up on a stalled download after 15 seconds, for both plain and secure downloads, so configured backup servers can be tried within the same 180-second limit. Nothing about which servers apt trusts, which signing keys it checks, or the tmux version and its checksum changes. A hosted CI rerun is still required to show this works against the real servers.

The change is in `.github/scripts/setup-ci-tmux.sh` only. It replaces `-o Acquire::Retries=2 -o Acquire::http::Timeout=20` on `apt-get update` with a shared option list `Acquire::Retries=0`, `Acquire::http::Timeout=15`, `Acquire::https::Timeout=15`, and passes the same list to `apt-get install`. It is a reversible, Tier 1, CI-only change.

## Decision-point inventory

- GitHub runner tmux setup for the unit matrix, integration and E2E jobs: changed (apt acquire options only).
- Test selection, test commands, lifecycle assertions, merge authority: unchanged.

## 1. Over-block

With no per-URI retry, one brief network blip on a file means apt moves to the next configured mirror instead of retrying the same one. If the blip hits the last mirror in the list, that file fails where two retries might have saved it, and the setup step goes red. The job fails explicitly and can be rerun; it does not skip tests. The same is true if a healthy mirror takes more than 15 seconds to start answering. If every mirror stalls, update may finish with warnings and stale or missing lists, with the explicit failure surfacing at install instead.

## 2. Under-block

None added. apt still verifies every repository signature with the image's existing keys. No source is rewritten, no mirror is added, no `--allow-unauthenticated`, no TLS or check skip. The tmux tarball checksum and `tmux -V` check are unchanged.

## 3. Level-of-abstraction fit

The failure is in runner preparation, and the fix is in the script that prepares the runner, using apt's own documented options. It matches what GitHub's runner image itself sets for hosted x64 (Retries 1, Timeout 15) and goes one step further on retries so failover fits our 180-second bound.

## 4. Signal vs authority compliance

The setup step cannot green a PR. Required GitHub checks and Local Verify still decide merge.

## 5. Interactions

`-o` options on the command line override the image's `/etc/apt/apt.conf.d/zz-retries`. The install command previously inherited the image's values; it now uses the same explicit list as update. Runners that already have every build dependency skip apt entirely, as before.

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
- PENDING: a hosted GitHub CI run where unit, integration and E2E all reach and pass their suites. Local checks cannot prove real mirror failover; this change does not claim all tests or live delivery are fixed.

## Second-pass review

Fresh native Opus 5.5 independent reviewer concurred as a candidate after reading the script diff, notes, three actual failure logs and workflow callers; it independently ran bash syntax validation, not Vitest or hosted CI. The root independently ran the three existing targeted unit tests. The reviewer disclosed that it did not fetch the runner-image source; root verified that primary source separately. The failover mechanism remains an inference until observed on a stalled mirror. Acceptance requires every hosted unit shard plus integration and E2E to reach and pass their suites on the final combined tree. If the mirror is healthy, a green run proves no regression rather than exercised failover. No main first-contact review cap or gate authority was reset.
