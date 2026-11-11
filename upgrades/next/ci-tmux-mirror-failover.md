<!-- internal-only -->
<!-- bump: patch -->
## What Changed

CI-only. `.github/scripts/setup-ci-tmux.sh` now runs its two apt commands with `Acquire::Retries=0` and 15-second `Acquire::http::Timeout` and `Acquire::https::Timeout` (was `Retries=2`, `http::Timeout=20`, no https timeout). On PR 3078 (GitHub run 43055208211, attempts 1 and 2) all eight unit shards, integration and E2E failed in "Ensure tmux" before any test ran: `apt-get update` hit the 180-second bound (exit 124) while retrying the same stalled Azure Ubuntu mirror. The runner's own apt setup says retries are spent on one URI before apt tries the next mirror in its configured mirror list, so our higher retry count used up the whole bound on one bad mirror. Sources, signing keys, signature checks, the pinned tmux 3.6a, its checksum and the 180-second bound are unchanged. No installed-agent behavior changes.

## Evidence

- Baseline failure logs: unit, integration and E2E jobs of run 43055208211 show `Ign` lines for `azure.archive.ubuntu.com` exactly 20 s apart, cycling the same four InRelease files, then `Process completed with exit code 124`.
- Source: https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt.sh (hosted x64 config uses Retries 1, Timeout 15).
- Local: `bash -n` passes; `tests/unit/ci-tmux-toolchain.test.ts` passes.
- PENDING: a hosted GitHub CI run of the full unit, integration and E2E jobs on this change. Local checks cannot prove real mirror failover.
