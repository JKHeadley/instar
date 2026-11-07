# Side-Effects Review — GitHub private-backup setup recipe, the state folder pushed by the server; available after its live proof

**Tier 2 by risk** (credentials: a GitHub token is stored and used; the agent's state folder is pushed to an outside service; a config switch is written), with second-pass review. Spec: `docs/specs/recommended-services.md`, First recipes: GitHub ("a new private repo. `verify` proves the repo is private and reads back a push. Pushes are refused if the repo isn't private. For an existing agent with a public backup remote, that raises one attention item with the fix"). ELI16: `docs/specs/recommended-services-github-recipe.eli16.md`. Built dark, proven live on a throwaway agent, then the catalog row set to `setupRecipe: 'github-v1'` in the same PR (see Live proof).

**Size:** 5 source files (1 new), 5 test files (3 new); about 300 lines of source. **Effort:** no spec rounds (parent spec converged and approved); 1 commit attempt expected.

## Summary

- `githubBackup.ts` (new): `GitHubBackupSurface` (tokenOwner, repo, createPrivateRepo, pushState, remoteHead, localHead, currentRemote), `realGitHubBackupSurface(stateDir, gitConfig)` over GitHub's REST API (`/user`, `/repos/:full`, `POST /user/repos` with `private: true`) and the state repository through `GitStateManager` (init when needed, `setRemote` with a credential-free URL, commit) and `SafeGitExecutor` (push and `ls-remote` with a one-shot `credential.helper` that reads the token from the child's environment, `INSTAR_GITHUB_BACKUP_TOKEN`). `backupRepoName(agent)` = `instar-<agent>-state`; `parseGitHubRepo(url)`.
- `recipes.ts`: `github-v1`. `secretName: github_backup_token`. `verify`: token present (else fail, `absent` only when no remote is set either), token accepted by GitHub, repository found by the current remote or by the agent's name under the token's account, PRIVATE (a public one fails with an `attention` payload naming the fix), remote head equals local head; `unknown` whenever GitHub or the remote does not answer. `sync`: find or create the private repository, refuse anything public, push; names only in the result. `stop`: removes the token, calls `disableGitBackup` (the config switch older versions read), leaves the repository. `VerifyResult.attention`, `RecipeDeps.github`/`agentName`, `StopDeps.disableGitBackup`; `SetupRecipe.listsCopies` so only the secrets-copy recipe lists names on the confirm page.
- `recommendedServiceRoutes.ts`: `recordVerify` raises the attention item once per id (`attentionRaised` in setup state), cleared by a pass; deps `github`, `agentName`, `disableGitBackup`, `raiseAttention`; the daily refresh now also covers this recipe (a push a day).
- `routes.ts`: the real surface over `ctx.config.stateDir` and the `git` config block; `agentName` from the project name; `disableGitBackup` through `writeConfigAtomic` on `.instar/config.json`; `raiseAttention` through the Telegram attention queue (HIGH, category recommended-services).

## Decision-point inventory

- `github-v1.verify` — add — pass/fail/unknown for the GitHub row (proving agents only).
- `github-v1.sync` — add — refuses a push to a public repository (deterministic invariant).
- attention raise in `recordVerify` — add — once per id, cleared on a pass; raises only, never blocks.
- `disableGitBackup` — add — a config write on a confirmed no with switch-off.

## 1. Over-block

- A pre-existing remote that is not a GitHub URL (`parseGitHubRepo` null) makes verify fall back to the agent-named repository under the token's account, and sync creates that repository beside the person's own remote. Deliberate: the recipe only ever manages a GitHub repository it can see with the token. The person's `origin` is never rewritten: `pushState` sets origin only when the repository has none, and every push and `ls-remote` names the URL, not `origin` (second-pass finding 1; pinned by `tests/unit/recommended-services-github-surface.test.ts` against a real local repository). A foreign or SSH remote is left exactly as it was and named in no message.
- A fine-grained token without "Administration: write" cannot create the repository: sync answers "GitHub refused to create the private repository" and the session asks for the right kind of token. The brief names both token kinds.
- `verify` compares heads exactly; a push from another machine of the same agent to the same repository makes this machine's check say "behind" until its own daily push. One agent, one machine is today's shape; recorded.

## 2. Under-block

- `private: true` from GitHub is trusted; a repository inside an organisation with "internal" visibility reports `private: false` and is refused, which is the safe side.
- The state folder's ignore list (`config.json`, `secrets/`, `state/`, `logs/`) is what keeps secrets out of the push. This recipe relies on it and does not re-check the tree; a file a person adds to the state folder outside those paths goes to the repository. Pre-existing behaviour of git backup, recorded.
- The token stored by the key route is only checked by use; a token with scopes beyond what the brief asks (a classic token with everything) is accepted. The brief says what to ask for.
- `pushState` pushes `HEAD:main`; a repository created with a default branch other than `main` gets a `main` branch beside it. `auto_init: false` keeps a fresh repository empty, so this is only a concern for a pre-existing remote.
- The daily refresh pushes whatever the state folder holds; a failed push waits six hours (the Bitwarden backoff applies to every sync recipe) and three failures re-run the check, which asks the person if the token died.

## 3. Level-of-abstraction fit

The push is done by the server inside the recipe, not by the session, because the token must never be on a command line or in a remote URL the session could print; `GitStateManager` already owns init/remote/commit for the state folder, so the recipe uses it and adds only the credentialed push and `ls-remote` through `SafeGitExecutor`'s `-c` and `env` (both sanctioned there). The attention item reuses the existing attention queue rather than a new notice path.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over content. The refusal to push to a public repository is a hard invariant from the spec; the attention raise is a notice, not a gate. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Private or not" is GitHub's own boolean; the head comparison is exact.

## 5. Interactions

- **Shadowing:** `sync` checks privacy before any push, and `verify` checks it before comparing heads, so a public repository can neither be pushed to nor pass.
- **Double-fire:** `attentionRaised` makes the raise once per id across repeated failing checks and ticks; a pass clears it so a relapse is raised again. The raise is fire-and-forget off the verify path, so a slow attention queue never delays the check.
- **Races:** the daily refresh (`syncCopy`) and a session's `/sync` share `GitStateManager` on the same folder; both go through `SafeGitExecutor` sequentially in one process. A commit with nothing to commit is swallowed inside `pushState`.
- **Jev/Tailscale/Bitwarden:** `recipeDeps()` now passes `github` and `agentName` to every recipe; the others ignore them. `listsCopies` keeps the Bitwarden page as it was and removes the names list from the GitHub page.
- **Existing git backup:** an agent whose `git` config already carries a remote and `gitBackup.enabled` keeps syncing through `GitSyncManager` to its own `origin`, which this recipe never rewrites. When that origin is the same GitHub repository, both push the same branch (fast-forward, or a rejected non-fast-forward the next push resolves after the sync's pull); when it is a different remote, the two backups are independent. The daily push happens at most once a day.

## 6. External surfaces

- Available on every agent once this lands: the confirm page answers for `github-state-backup`, a yes opens a setup session, the key route stores `github_backup_token`. The e2e test pins availability and that the push stops at the missing yes.
- On a proving agent: a private repository is created under the token's account and the state folder pushed to it. Values go from this process to git over HTTPS with the token in the credential helper's environment.
- `GET /recommended-services/:id/confirm` for this row has no `copies` field (not a secrets copy).
- One attention item (HIGH) when a backup repository is public, with the exact settings path to fix it.
- A confirmed no with switch-off writes `gitBackup.enabled: false` into `.instar/config.json` atomically.
- **Operator surface (Mobile-Complete):** yes/no on the confirm page; the token through Secret Drop; the public-repository fix through the attention item's words; nothing API-only.

## 6b. Operator-surface quality

No dashboard markup changes in this change; the confirm page is unchanged for this row apart from the absent names list. The attention item leads with the fix ("Make it private in the repository's settings…") and names the repository, nothing else.

## 7. Multi-machine posture

- The stored token and the state repository are **per machine by design** (`machine-local-justification: physical-credential-locality`). The repository name is fixed from the agent's name so a second machine of the same agent finds the same repository; two machines pushing different states to one branch is the existing git-backup situation, which `GitSyncManager`'s pull-rebase handles for agents that enable it; this recipe's daily push alone would see "behind" on one of them. Recorded in §1.
- The choice and `shutdown: authorized` replicate through the existing ledger; a switch-off from another machine is obeyed here as for the other recipes.
- One voice: the attention item goes through the attention queue on the machine that found it; `tellOwner` as before.

## 8. Rollback cost

A revert removes the recipe, the surface and the attention plumbing; `listsCopies` reverts to "every sync recipe lists names", which only Bitwarden had. Repositories already created stay; tokens already stored stay in the vault under `github_backup_token` and are unused. Setup-state field `attentionRaised` is ignored by older code.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: the attention raise is one notice per failing check id, held by `attentionRaised` until a pass clears it; the daily push rides the existing bounded refresh (one try per 24 h, six hours after a failure, a single re-check after three). Not a self-triggered loop.

## Found problems, triaged

- The hourly `GitSyncManager` and this recipe's daily push both push the state branch; harmless today, but one owner of "the push" would be cleaner. → noted for the git-backup owner, no change here.


## Live proof (2026-11-07, throwaway `recsvc-bw-agent`, port 4461, built from this branch; real Telegram test group; Echo as the person)

| Step | Evidence |
|---|---|
| Ask in the group → agent explained benefit, what leaves, cost, account, and sent the confirm link | `group-80-github-answer-msg109.json` (msg 109, 23:43:17Z) |
| Yes with the PIN on the confirm page | `github-confirm-yes-response.json` (choice yes, origin person-asked, 23:43:53Z) |
| Setup topic opened; one Secret Drop link for the token, "never in chat" | msg 111, topic 110 (23:44:45Z) |
| Token submitted through the drop (values over stdin) | `github-drop-submit-response.json` (23:45:29Z) |
| Server created the private repository and pushed; check passed | GitHub API: `EchoOfDawn/instar-recsvc-bw-agent-state` private, created 23:45:50Z, pushed 23:47:08Z, head 8a38c8f5 == local HEAD, no `config.json`/`secrets/`/`state/` in the tree (`github-repo-check-api.txt`); `github-row-after-pass.json` (verify pass 23:47:13Z) |
| Agent told the person it works, in plain words | msg 113 (23:47:26Z) |
| Repository made public → check fails, push refused, ONE attention item (HIGH) | `github-verify-while-public.json`, `github-sync-while-public.json`, `github-attention-while-public.json`; a second failing check raised no second item; `pushed_at` unchanged |
| Private again → check passes | `github-verify-after-private-again.json` |
| No with switch-off on the confirm page | `github-confirm-no-switchoff-response.json` (shutdown authorized, 23:48:48Z); `github-setup-state-after-switch-off.json` (stopped 23:48:49Z); token gone from the vault; `gitBackup.enabled: false` written; repository still present and private (GitHub API) |
| Owner told, in plain words: the public-repository attention item (msg 114, attention topic, 23:48:16Z) and the switch-off notice (msg 115, lifeline topic, 23:48:56Z) | `group-80-after-switchoff.json`. The notice's first send was held (`destination-not-authorized`, logged as a degradation) and delivered seven seconds later by the origin service's recovery; the person saw one message. |

Found in the proof, triaged:
- The first push right after GitHub created the repository failed once; the setup session retried and it worked. Fixed here: `sync` retries the first push once, after 3 s, only for a repository it just created (`GITHUB_FIRST_PUSH_RETRY_MS`), pinned by a unit test.
- The agent server's restart (onto this build) stranded the running session's send credential, so its first reply was refused with "invalid origin token" until the session was respawned. Not this recipe's; filed as fb-96d3f7ef-6e0 (and fb-053f97c6-8f6 from the test agent's side).
- The test agent's setup-session brief was first left at the prompt (injection stuck, auto-recovered on attempt 1): the known bracketed-paste race, already a degradation, no new filing.

## Second-pass review

Independent read (reviewer subagent, 2026-11-07): token flow traced clean (header and child environment only; every git throw swallowed; audit line carries argv with the variable name, never the value); no path pushes to a public repository; attention raised once per id and cleared on a pass; `writeConfigAtomic` preserves secret-ref placeholders; helper quoting correct.

**Concern raised:** `pushState` unconditionally rewrote the state repository's `origin` (a foreign remote replaced; an SSH GitHub remote converted to credential-less HTTPS), contradicting §1 and §5. **Resolved:** origin is set only when none exists; push and `ls-remote` name the URL; §1/§5 corrected; a real-repository test pins it.

Notes carried: `GIT_TERMINAL_PROMPT=0` added to the child environment (a helper failure errors at once instead of waiting on the 30 s timeout). Recorded, no change: a pass clears the raise mark but does not close the attention item itself (the spec asks for one item; the person resolves it); the privacy notice for an existing public remote needs a stored token first (public repositories could be checked unauthenticated later); the legacy `gitBackup.enabled` switch is read at boot, so an in-process legacy auto-push continues until the next restart while this recipe's own pushes stop at once.
