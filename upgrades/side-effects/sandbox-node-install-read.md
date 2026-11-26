# Side-Effects Review — feedback executor sandbox can read a Node install under home

**Version / slug:** `sandbox-node-install-read`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, about 35 lines in `src/feedback-factory/execute/executePolicy.ts` plus tests; a revert fully undoes it. Fixes fb-c238c6c9-f0d. The executor sandbox read-denies the whole home and re-allows only the attempt's own trees. A Node runtime installed under home (nvm, fnm, volta; the M5 verifier at `~/.nvm/versions/node/v24.15.0`) is therefore unreadable: bash's PATH lookup cannot stat it and reports `node: command not found`, though exec by full path works (seen on the M5: `ls` of the binary gives "Operation not permitted"). `tests/integration/feedback-execute-dns-sandbox.test.ts` failed on the M5 every run (isolation rerun too) and failed three PRs' verifies (#2912, #2933, #2927); the hub parked the M5 as a verify peer. The same block would stop the real executor running `node`/`npm` on such a machine.

New `nodeInstallReadAllows()` returns the running Node's install root (the parent of its `bin/`, else the binary's directory), in both lexical and real-path spellings, only when it is inside home and is not, and does not contain, home, the agent home, the publish clone or a credential path, and is not inside the agent home or the publish clone. `buildSandboxRuntimeSettings` adds it to `filesystem.allowRead` and its `etc/npmrc` to `filesystem.denyRead`; `buildClaudeSandboxSettings` spreads the same filesystem block, so the worker session gets it. New optional `ConfinementPaths.nodeExecPath` (default `process.execPath`) for tests. Effort: one review round plus one hardening pass from the second-pass review.

## Decision-point inventory

- Sandbox `filesystem.allowRead` for executor commands and the worker session — modify — adds one read-only root when Node lives under home. No blocking decision is added or removed.

## 1. Over-block

None added. The change only removes an over-block: Node installs under home were unreadable.

## 2. Under-block

- Only the Node that runs the server is re-allowed. If PATH inside the sandbox names a different Node under home (another nvm version first on PATH), that one stays unreadable. The executor passes PATH through and the server normally runs the PATH Node, so this matches the M5 case; not covered for mismatched setups.
- Other tools installed under home (for example a `~/.local/bin` git or a pnpm home) stay unreadable, as before.
- A Node install root can hold a global npm config (`<root>/etc/npmrc`), which can carry a registry token; a confined attempt could copy it into its diff and so into a PR even with no network. Closed: when a root is re-allowed, its `etc/npmrc` is added to `denyRead` (the more specific deny wins, proved in a real sandbox by the integration test). Package-level config under `lib/node_modules/*` stays readable, as it already is for a system install.
- A Node install inside a credential folder such as `~/.config/nvm` IS re-allowed (only that install root, not the rest of `~/.config`). That is the intended behaviour for XDG nvm; the rest of the credential folder stays denied.

## 3. Level-of-abstraction fit

Right layer. The policy builder already owns which paths the sandbox may read and already computes home, agent home and credential denies. The fix adds one input there instead of special-casing the test or the runner.

## 4. Signal vs authority compliance

Not a decision point with blocking authority. It widens a confinement allowlist by one read-only, guarded path. Every existing authority (denies, write allowlist, network allowlist, canary probes) is unchanged.

## 4b. Judgment-point check

No new heuristic at a competing-signals point. The install-root rule is a fixed path computation.

## 5. Interactions

- Confinement canary: its must-fail probes read home, sibling worktrees, credential paths and the system temp; none of those is inside a Node install root, and the guards refuse a root that contains any of them. Unchanged.
- sandbox-runtime precedence: allowRead wins inside a denied region, which is what makes the re-allow work and what the guards are written against.
- Worker settings: `buildClaudeSandboxSettings` copies `runtime.filesystem`, so its Bash sandbox gets the same allow. File tools (Read/Edit permission rules) are not widened.

## 6. External surfaces

None for users. Verifies on machines with Node under home stop failing this file. No route, config key, file format or message changes.

## 7. Multi-machine posture

Machine-local by design: computed per machine from that machine's own Node path at spawn. Machines with a system Node get byte-identical settings to before.

## 8. Rollback cost

Revert the commit. No state, migration or config.

## Conclusion

Fixes the cause of the M5-only failure and the matching real-executor break on nvm machines, with the home, agent home, publish clone and credential paths still closed. Proved on a real macOS sandbox by a both-sides integration test, and checked on the M5 by hand before the change (full-path exec works, PATH lookup fails).

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent, 2026-11-07 (given the diff, asked to break the guards)

Independent reviewer, given the diff and asked to break the guards. Concur. No ordinary input re-opens home, the agent home, the publish clone, sibling worktrees or a credential path (checked `~/bin`, `~/node`, `~/.local/bin`, `~/.instar/bin`, `/` as home, trailing slashes, `..`, both spellings of `/var` and `/tmp`); a differently-capitalised agent home on case-insensitive APFS is the only fail-open and is far-fetched. Two items, both acted on: the global `etc/npmrc` exposure (now denied, with a sandbox test), and the publish-clone guard was never isolated (now a case with the clone outside the agent home). Its own test runs did not finish in its window.

## Evidence pointers

- `tests/unit/feedback-factory/execute-units.test.ts`: nvm root allowed and reaches runtime and worker settings; system path, `~/bin`, a root holding the agent home or `~/Library`, roots inside the agent home or publish clone refused; no-`bin` layout; symlinked install returns both spellings.
- `tests/integration/feedback-execute-dns-sandbox.test.ts`: real sandbox, temporary home with `.nvm/.../bin/node`, PATH naming only it: found when re-allowed, `command not found` when not.
- M5 by hand, 2026-11-07 17:43 PST, main 00dcaf5: the original test fails with `/bin/bash: node: command not found`; inside the sandbox `ls -l` of the binary gives "Operation not permitted", and `<full path> -e ...` prints dns-ready.
- M5 with this change, 2026-11-07 18:25 PST (same checkout, files copied): `feedback-execute-dns-sandbox.test.ts` 2 of 2 pass (the original DNS case and the new nvm case, including the `etc/npmrc` deny); `execute-units.test.ts` 59 of 59 pass. Before the change the original case failed there with `node: command not found`.
