# Integration Review — Iter 4 Final Round

**Spec:** `/Users/justin/Documents/Projects/instar/docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md`
**Reviewer angle:** integration with existing instar codebase
**Verdict:** **CONVERGED with conditions** — design fits existing infra cleanly enough to ship; three integration friction points need ordering discipline, but no new blocking issue surfaced.

## Per-component integration assessment

### 1. Ed25519 trailer signing in `commit-msg` hook

**Fits.** `.husky/pre-commit` runs `npm run lint` then `node scripts/instar-dev-precommit.js`. **No existing `commit-msg` hook** — slot is free. New hook lands in `.husky/commit-msg` + `scripts/commit-msg-trailer.js` next to `instar-dev-precommit.js`. The pre-commit (advisory) / commit-msg (authoritative) split matches spec's hook-lifecycle fix and does not interfere with `instar-dev-precommit.js` (file-scope artifact verification, not trailer logic). **Caveat:** the `MERGE_HEAD` skip in existing pre-commit (lines 42-44) is the precedent for hook-skip-on-merge — new commit-msg hook should mirror it, otherwise local merges fail trailer signing.

### 2. GH Ruleset auto-config

**Fits with friction.** Instar has **no existing GH App or installed-token infrastructure** that I can find — the existing `.github/workflows/` and CI checks rely on plain `GITHUB_TOKEN` provided by Actions. The Day -2 migration script will need a maintainer-supplied PAT with `admin:repo_hook` + `repo` scope to call `gh api repos/:owner/:repo/rulesets`. This is new permission territory for instar; it should be stored via the existing `SecretManager` (`src/core/SecretManager.ts`) / `SecretStore` rather than added to `Config.ts` to avoid leaking into git-synced config. The `INSTAR_VERIFY_CACHE` and `INSTAR_VERIFY_TUNNEL_URL` repo-variable updates use the same PAT — auto-rotation logic needs a place to live (suggest `src/core/GhRulesetManager.ts`, sibling to `GitSync.ts`).

### 3. `/gh-check/verify-nonce` endpoint

**Fits cleanly.** `src/server/routes.ts` is one giant `router.get/post` registration file (11,146 lines, 100+ routes). New endpoint slots in alongside `/commits/preflight`, `/commits/sign-trailer`, and `/worktrees/resolve`. **However:** the global `authMiddleware(options.config.authToken)` at `AgentServer.ts:254` enforces bearer-token auth on every route by default. The OIDC-only path for `/gh-check/verify-nonce` requires either (a) registering it BEFORE `app.use(authMiddleware)` and adding inline OIDC validation, or (b) extending `authMiddleware` to accept `Authorization: Bearer <oidc-jwt>` for specifically allowlisted paths. Option (a) is the cleaner pattern (`machineRoutes` at line 241 already shows the precedent — it's mounted before the auth middleware). The OIDC JWKS fetch + cache should reuse the `NonceStore` (`src/core/NonceStore.ts`) for idempotency.

### 4. Mandatory destructive-command shim — PATH/env handling in SessionManager

**Fits, but spec is wrong about delivery vector.** `SessionManager.spawnSession()` (line 504-594) does NOT spawn shells directly — it spawns `tmux new-session -d` with `-e KEY=VAL` flags for env injection (lines 545-563). **There is no `env:` parameter, no `PATH` manipulation, and no shell intermediary.** The spawned process is `claudePath claudeArgs` directly, which in turn spawns its own shells. To deliver the shim:

- **PATH prepend** must happen via `-e PATH=<shim-path>:$PATH` in the tmux flag block (~line 545). Cannot be omitted — Claude's child shells inherit tmux env.
- **BASH_ENV/ZDOTDIR** delivery via `-e` flags is straightforward.
- **GIT_EXEC_PATH** override via `-e` is fine.
- **fsnotify watcher per worktree** belongs in a new `src/monitoring/WorktreeFsWatcher.ts`, owned by `WorktreeManager`, not `SessionManager`.

The spec's "session-local `~/.instar-session-bin/`" is misleading: it should be **per-worktree under `.instar/worktrees/<wt>/.shim-bin/`**, both for cleanup hygiene (reaper-managed) and to avoid HOME-dir pollution.

### 5. `binding-history-log.jsonl` git-synced

**Conflicts with auto-commit cadence.** `GitSync.ts` line 86-99: `debounceMs` defaults to **30 seconds**. The spec says: "On commit-trailer signing, server appends. On daily git-sync, file is committed." These two cadences contradict. With the existing 30s debounce, every commit-trailer signing triggers a sync within 30s. At 100 commits/day across all topics, that's 100 git commits/day to `.instar/state/binding-history-log.jsonl` — exactly the "commit storm" AC-25 prohibits for `.session.lock`. **Fix needed:** either (a) write `binding-history-log.jsonl` to `.instar/local-state/` and explicitly stage-and-commit on a 24h timer outside `GitSync.queue()`, or (b) extend `GitSync` with a per-file debounce override (default 24h for this file). Recommend (a) — simpler, no `GitSync` API surface change. Side benefit: `local-state/` is already gitignored, so the explicit-commit path forces the maintainer to register `binding-history-log.jsonl` separately as a synced-file exception (one place, one time, auditable).

### 6. Day -2 migration script with TOFU PR

**Fits existing patterns.** `scripts/` already houses `analyze-release.js`, `pre-push-gate.js`, `setup-imessage-hardlink.sh` — pattern is "self-contained Node ESM script with `#!/usr/bin/env node` shebang invoked by maintainer." `scripts/migrate-incident-2026-04-17.mjs` slots in. The 4-eyes ruleset entry on `.github/workflows/worktree-trailer-sig-check.yml` paths is a clean GH-native primitive (PR review count requirement). **One missing piece:** the spec doesn't say where the side-effects artifact at `upgrades/side-effects/migrate-incident-2026-04-17.md` is generated — `instar-dev` skill normally generates these, but Day -2 ships BEFORE the new system is live, so the artifact must be hand-authored or generated by a dry-run flag on the script itself. Recommend the script writes the artifact as part of its own `--prepare-pr` mode.

### 7. fsnotify watcher per worktree — N watchers at scale

**Listens at scale, needs single-process model.** Linux inotify is cheap (~1KB/dir); 10 worktrees × ~500 dirs = 5,000 watches, far under default `max_user_watches` 524,288. **But:** spec implies one `fswatch`/`inotifywait` subprocess per worktree. Wasteful — `WorktreeMonitor.ts:18` already uses in-process `EventEmitter`. Use `chokidar` inside a single `WorktreeFsWatcher` service that adds/removes watch roots as worktrees come/go. One process, N roots, central debouncing.

## Top 3 integration friction points (concrete files)

1. **`SessionManager.spawnSession` shim delivery is wrong in the spec.** Fix at `/Users/justin/Documents/Projects/instar/src/core/SessionManager.ts:540-565`: the env vector is tmux `-e` flags, not shell PATH manipulation. Spec must be updated to call out tmux `-e PATH=...` injection or the shim never reaches the child shell.

2. **`GitSync` debounce vs binding-history-log cadence.** `/Users/justin/Documents/Projects/instar/src/core/GitSync.ts:99` (`debounceMs = 30_000`) will produce a per-commit storm if `binding-history-log.jsonl` is queued through `GitSync.queue()`. Path of least resistance: write to `.instar/local-state/`, register a separate 24h-timer commit job, and add an explicit exception to gitignore for that one file.

3. **`/gh-check/verify-nonce` auth bypass routing.** `/Users/justin/Documents/Projects/instar/src/server/AgentServer.ts:241,254` shows `machineRoutes` is mounted before the bearer-token middleware — this is the precedent for the OIDC-only endpoint. Spec should explicitly call out "mounted as `verifyNonceRoutes` before `authMiddleware`", otherwise integrators will land it inside the main `routes.ts` block and break GH Actions calls.

## Top 3 implementation order recommendations

1. **`WorktreeManager` + `commit-msg` hook + Ed25519 keypair generation FIRST (Day -1).** These are pure-local, no GH dependency. Get trailer signing working end-to-end against a local mirror before any GH ruleset goes live. This validates the hook-lifecycle fix (`$GIT_INDEX_FILE` honoring, `commit-msg` not `pre-commit`) on real commits.

2. **`/gh-check/verify-nonce` + `binding-history` SQLite + GH workflow SECOND (Day -1).** Ship the verify endpoint with OIDC validation, then the GH workflow YAML with baked-in pubkey. Test in `enforcement: evaluate` mode against a fork/test repo before touching the real ruleset.

3. **Mandatory destructive-command shim + fsnotify watcher THIRD (Day 0, after Days -1).** Highest user-friction component (intercepts `git clean`, `rm -rf`). Ship behind `INSTAR_PARALLEL_ISOLATION=warn` first; only flip to block after 48h zero-violations digest.

GH ruleset auto-config and Day -2 TOFU PR ride on (1) and (2) being green; they are the LAST step before flipping `evaluate → active`.

## New critical integration issues

**None blocking.** All friction points are addressable with spec amendments, not redesigns. The biggest spec gap is the SessionManager-shim delivery mechanism (#1 above) — silent failure mode if not fixed: shim ships but never intercepts anything because tmux-spawned Claude children inherit the original PATH.

**Watch item (non-blocking):** the spec assumes Claude's child-shell PATH inheritance from tmux works on every platform. Worth a one-line AC adding "AC-52a: spawned Claude session's first `bash -c 'echo $PATH'` shows shim path prepended" to catch tmux env-passing regressions.
