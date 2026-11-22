# A join test no longer installs a real auto-start service on the machine running it

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`tests/unit/join-missing-dir.test.ts` runs the real `joinMesh` against a temporary `--dir`. `joinMesh` step 6 calls `installAutoStart` from `src/commands/setup.ts`, which writes the joined home's auto-start into the real user home: `~/Library/LaunchAgents/ai.instar.home.plist` on macOS, `~/.config/systemd/user/instar-home.service` on Linux. The test then deletes its temporary folder, so the service fails on every restart from then on. Found on 2026-11-21 on the Laptop (a LaunchAgent written 2026-11-16, KeepAlive, failing with exit 78) and on the Mama PC (a systemd unit, Restart=always, failing every 10 seconds with CHDIR). Feedback fb-2ecf9c2b-055.

The test now replaces only `installAutoStart` with a stand-in that returns false, and asserts the join reached that step through the stand-in. Every other step of the join stays real. No product code changes.

## Evidence

- `npx vitest run tests/unit/join-missing-dir.test.ts tests/unit/join-persist-after-verify.test.ts`: 4 passed. The new assertion shows `installAutoStart` was called with the test's temporary dir, so the step is reached and goes only to the stand-in.
- After the run on the Studio, `~/Library/LaunchAgents` holds no `ai.instar.home` entry and `launchctl list` shows none.
- The two leftovers found in the wild were disabled and their files moved to backup folders (Laptop: `~/Library/LaunchAgents.disabled-test-leftovers-20261121/`; Mama PC: `~/.config/systemd/user/disabled-test-leftovers-20261121/`). The real `ai.instar.echo` and `instar-echo` services are unchanged and still running.
