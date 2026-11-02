<!-- internal-only -->

## What Changed

- New maintainer scripts in `scripts/locked-proof/` for the locked-Mac proof run (P12 crash tests and P15 Stop tests in `docs/specs/desktop-locked-screen.md`). Nothing runs against any Mac unless called with `--execute`; none of it ships as runtime behaviour.
  - `driver.mjs`: the case table (27 P12 cases, 11 P15 cases), `expected` prints the expected-results table to commit before any run, `calibrate` measures the typing pace with one normal unlock, `run` drives each case through the real viewer page and records evidence plus a verdict to `results.jsonl`. The agent types the throwaway test user's password itself through the remote-desktop path, reading it once from its vault into memory; it is never printed, logged, written to results or put on a command line. The person is asked only for what software cannot do (local unlocks, a user switch, a login).
  - `create-proof-user.sh`: generates the throwaway password, stores it in the vault first (`locked_proof_user_password`, plus Bitwarden), creates the standard user `instarproof` by answering `sysadminctl`'s prompt through a pseudo-terminal (`pty-feed.py`), clears the user's account policies so macOS does not force a password change at first login, and checks the password authenticates.
  - `stage-proof-agents.sh`, `configure-proof-agent.mjs`: install the `-lockedproof` test build in the user's own prefix and set up two proof agents (auto-update off, no start-on-login job, remote desktop on, locked access left off).
  - `reset-attempts.py`: resets the helper's attempt counter between batches under the helper's own lock, refused while a relock duty is open; every reset is logged.
  - `remove-proof-user.sh`: tears the user down.

## Evidence

- Unit tests (no real user, lock screen or desktop helper is touched): case table coverage and selection; password shape and use of the random source; attempt reset refusal on an open duty; proof-target check; the runner against a fake Mac both passing and failing (Mac left unlocked) and never putting the password in evidence; every verdict reason; the user-creation script against stand-in commands (vault before user creation, password only via the prompt, policies cleared, verified, never printed); `pty-feed.py` both ways; `reset-attempts.py` both ways; dry runs do nothing.
