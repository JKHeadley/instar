# Side effects: account choice in Create my agent (spec §A)

## Change
- `src/install/accounts.ts`: `discoverAccounts` lists signed-in Claude/Codex config folders (the default, plus folders from this machine's Instar agents' pools), identity only.
- `src/install/accountChoice.ts`: the new install state `do-account-choice` (between door-install and door-sign-in). It pauses with `awaiting.accounts`, takes `answers.account` ({use}|{new}), and falls back to today's behaviour when resumed without an answer.
- `src/install/accountEnroll.ts`: a new account gets the next free folder `~/.instar/accounts/<agent>/<door>-<n>` (0700). Sign-in runs with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` set to a non-default chosen folder. After agent-init, the account is registered in the new agent's pool through `SubscriptionAccountEmailRegistrar` (insert-if-absent, `borrowed`/`machineId` extra fields).
- `install.ts`: the answers-file `account` field and its validation; the handlers.

## Who is affected
People creating an agent with `instar install --answers`, which the Mac app uses, on a machine with one or more signed-in accounts. With no account found, or no answer from an older app, nothing changes.

## Rollback
Revert. Agents already created with a chosen folder keep their pool entry, which works as any pool account does.

## Review (independent, two rounds)
Round 1 objected:
- discovery missed the machine-bound pool store;
- the pool drops rawExtra, so the borrowed and machine fields were lost;
- the sign-in env leaked into later steps;
- a stray `.claude.json` counted as signed in;
- three smaller points.

All are fixed:
- discovery reads the authority store and skips another machine's store;
- a borrowed source is recorded in `state/account-sources.json` (0600, atomic);
- the env is scoped to door-sign-in and restored;
- signed in means a credentials file or a keychain item (existence only);
- a stale pick with nothing left is refused, and the folder name is validated.

Round 2 concurred.

Known follow-ups:
- the handler doesn't pass this machine's id, so only the legacy fallback guards a git-shared pool, and paths missing on this Mac are dropped by the sign-in check;
- nothing reads `account-sources.json` yet; the Mac's "shared with" label comes from discovery at choice time.

## Merge with main after #3316 landed (2026-11-18)

#3316 (the AI the person picked wins) added a `door` check to `answersFileProblem` in the same place this PR added the `account` check; both are kept, in that order. #3316 decides which AI (`chosenDoor`); this PR's account choice runs after it for that AI, so the two compose. Typecheck clean; install-flow, install-account-choice and install-accounts 65/65.
