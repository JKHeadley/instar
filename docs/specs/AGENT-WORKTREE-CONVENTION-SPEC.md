---
title: Agent Worktree Convention
status: approved
approved: true
approver: justin
approved-at: "2026-05-17T22:35:00Z"
review-convergence: "2026-05-17T22:48:00Z"
review-iterations: 4
review-completed-at: "2026-05-17T22:48:00Z"
review-report: "docs/specs/reports/agent-worktree-convention-convergence.md"
created: 2026-05-17
owner: echo
companion-eli16: AGENT-WORKTREE-CONVENTION-ELI16.md
eli16-overview: AGENT-WORKTREE-CONVENTION-ELI16.md
---

# Agent Worktree Convention

## Problem

When an instar agent's Claude Code session creates a git worktree inside
the **shared instar checkout** at `/Users/justin/Documents/Projects/instar/`,
the macOS sandbox can revoke filesystem access to that worktree
**mid-session** with no in-session recovery path. Every read or write
(`cat`, `node fs`, `Read` tool, `git`) returns `Operation not permitted`.
This is not a TCC/Full Disk Access issue — `python3` and `node` are blocked
in the same way. The sandbox boundary is enforced by Claude Code itself:
the agent's *primary working directory* is `~/.instar/agents/<agent>/`,
and anything outside it is subject to revocation when sandbox state shifts
(sub-agent invocation, hook execution, MCP tool, settings refresh).

Observed today (2026-05-17, topic 9984): in-flight implementation work was
stranded with the worktree at `/Users/justin/Documents/Projects/instar/.instar/worktrees/...`.
Recovered by relocating to `~/.instar/agents/echo/.worktrees/...` —
pattern confirmed across multiple sessions. Prior occurrences in the audit
trail (`feedback_worktree_in_agent_home.md`) show this is **recurring**,
not a one-off.

## Goal

Make "worktrees live inside the agent's own home directory, never inside
the shared instar checkout" a **first-class convention** that:

1. Applies to every existing and future instar agent on any machine.
2. Is enforced by tooling with structural validation, not memorised
   discipline.
3. Doesn't break any current workflow, manual or automated.
4. Doesn't change how the shared instar repo is used by humans or non-agent
   tooling.
5. Has its own audit trail and detector so violations are observable.

## Non-goals

- Removing pre-existing worktrees from the shared checkout. They keep
  working for non-sandbox callers; only agents are affected.
- Replacing the existing parallel-dev `worktree register-keypair`
  subcommand. We extend the same group.
- Enforcing the convention against the **bare** instar repo via a
  server-side hook. The bare repo has many other consumers.
- **Backing up or syncing the `.worktrees/` directory.** Worktrees are
  per-machine ephemera. The agent state directory (`.instar/`) is what
  syncs and backs up. `.worktrees/` is excluded from both via
  `.gitignore` and via BackupManager's `stateDir` scoping.
- Intercepting raw `git worktree add` calls.
- **Threat model boundary:** an attacker who already has the agent's
  uid (full local execution as the user) can rewrite
  `~/.instar/config.json`, plant files in `~/.instar/agents/`, or
  replace any agent binary. The spec defends against *prompt-injection-
  driven* misbehavior of agents acting within their normal trust
  boundary, not against post-compromise rooting of the user account.

## Design

### Layer 1 — `instar worktree create` CLI subcommand

A new `instar worktree create <branch> [--slug X] [--no-share-node-modules]`
subcommand under the existing `worktree` command group in `src/cli.ts`.
Implementation in `src/commands/worktree.ts` alongside `registerKeypair`.

#### Agent-home resolution

A single environment variable carries the agent home across processes:
**`INSTAR_AGENT_HOME`**. Set by the agent's lifeline launcher and the
session-start hook. The wrapper script (Layer 3) sets it before
`exec`. No `--agent-home` flag — one transport, no contradiction.

Resolution order:

1. **`INSTAR_AGENT_HOME` env var** — canonical when present.
2. **CWD walk-up fallback** — when env var is absent, walk upward
   looking for a directory containing `.instar/AGENT.md`.

Regardless of which path resolved, the final value must pass:

- `realpath` (rejects symlinks pointing outside `~/.instar/agents/`).
- Anchored regex `^<instarHome>/agents/[a-z0-9-]+/?$` (where
  `instarHome` defaults to `~/.instar/` and is configurable).
- Membership in `~/.instar/registry.json` (or the agent-registry
  data source). Refuse if no registry entry exists.

A planted `.instar/AGENT.md` outside `<instarHome>/agents/` is rejected
at validation regardless of how the walk-up found it.

#### Instar-repo resolution

Resolution order:
1. `INSTAR_REPO` env var.
2. Default: `~/Documents/Projects/instar/`.
3. Secondary fallback: `~/instar/`.

Each candidate must pass integrity validation:

- `git -C <path> rev-parse --git-common-dir` succeeds (covers normal
  repos, bare repos, and worktrees with `.git` *file* pointers).
- `git -C <path> config --get remote.origin.url` matches one of:
  - The default URL allowlist baked into the CLI:
    `git@github.com:instar-ai/instar.git`,
    `https://github.com/instar-ai/instar.git`.
  - An entry in `~/.instar/config.json` under
    `worktree.repoUrlAllowlist` (operator-controlled list of
    remote-origin URL strings).
- `git -C <path> config --get core.hooksPath`, if set, resolves inside
  the repo. Out-of-repo hooks path → refuse.
- Resolved absolute path is logged to the audit ledger.

(Threat model: a compromised local user could edit `config.json` to
widen the allowlist — explicitly out of scope per Non-goals.)

#### Branch and slug validation

- **Branch name**: passed through `git check-ref-format --branch <name>`.
  Refused if invalid, contains `..`, starts with `-`, or contains NUL.
- **Slug**: defaults to `branch.replace(/\//g, "-")`. Result must match
  `^[A-Za-z0-9._-]+$`. Case-insensitive collision check against
  existing `.worktrees/` entries.
- **Final-path containment** before any git call:
  - `parentReal = realpath(dirname(WORKTREE_PATH))`
  - Assert `parentReal === realpath(<agent_home>/.worktrees)`.
  - Assert `<agent_home>/.worktrees` is a real directory (not a
    symlink) via `lstat`.

#### Branch base

Brand-new branch base is resolved as:
1. Config override `worktree.defaultBaseBranch` if set.
2. `git -C <instar_repo> symbolic-ref refs/remotes/origin/HEAD`.
3. Fall back to `main` only if step 2 fails.
4. Hard-fail otherwise.

(The config override exists so an operator can pin against
`remote.set-head` poisoning.)

#### node_modules handling (v1 default preserves current behavior)

**Default: symlink `node_modules` from the resolved instar repo into
the new worktree.** This matches today's bash helper behavior so no
existing caller breaks at flip-day. The symlink is created only when:

- Source `realpath(<instar_repo>/node_modules)` resolves to a real
  directory (NOT a symlink) inside the validated instar repo.
- Destination `<worktree>/node_modules` does not exist.

The CLI emits a one-line caveat when symlinking: "shared node_modules
— concurrent `npm install` in the main checkout may mutate this
worktree's dependency tree mid-test."

**Opt-out: `--no-share-node-modules`.** Skips the symlink. Caller
runs their own install per worktree.

**Sandbox-revoke risk (Gemini R1 / R2):** if the sandbox follows the
symlink to resolve modules and revokes at the *target*, the symptom
is ENOENT on `require()`, not the EPERM-on-worktree-itself failure
this spec addresses. The opt-out exists for callers who want full
isolation.

(R-6 in Residuals tracks evaluating a default flip to no-share after
v1 ships and callers are audited.)

#### Per-worktree git identity

After `git worktree add`, set local config:
- `git -C <worktree> config user.name "Instar Agent (<agent_name>)"`
- `git -C <worktree> config user.email "<agent_name>@instar.local"`

**Explicit non-claim**: these values are cosmetic/attribution, not
authority. Downstream consumers MUST NOT treat `*@instar.local` as a
trust signal. Authenticity comes from signed commits using existing
keys.

**Signing preservation**: the CLI does NOT touch `user.signingkey`,
`commit.gpgsign`, `gpg.format`, or `gpg.ssh.allowedSignersFile`.
Existing global signing config flows through unchanged.

**Env precedence caveat**: `GIT_AUTHOR_NAME`/`GIT_COMMITTER_EMAIL`
in the calling environment override local config. The CLI documents
this in its help output; agents that need attribution must avoid
exporting those vars.

(R-7 tracks signed-attribution as a follow-up <!-- tracked: R-7 --> — requires per-agent
signing keys, out of scope for v1.)

#### Permissions

`<agent_home>/.worktrees/` is created `0700` on first worktree
creation and re-asserted on every `create`. Documented: worktree
contents inherit this protection. BackupManager (`stateDir`-scoped)
is unaffected — `.worktrees/` is a sibling of `stateDir`, not a
descendant.

#### Concurrency and idempotency

- No pre-existence path check. Rely on `git worktree add`'s atomic
  refusal when the destination exists.
- Run `git worktree prune` *before* every `add` to clear dangling
  registrations.
- On `git worktree add` failure, **do NOT remove any partial
  directory** — git owns rollback semantics; deleting risks racing
  another agent's concurrent invocation on the same slug. Print the
  git error verbatim.
- Error messages distinguish:
  - "directory exists" → `rm -rf` (operator's choice) and retry.
  - "stale worktree metadata exists" → spec prescribes
    `git -C <instar_repo> worktree prune` then retry; if prune
    doesn't clear it, manual `git -C <instar_repo> worktree remove
    --force <full-path>` (path, not slug — corrected per Round 2 GPT).

#### Audit ledger

Every successful invocation appends one JSONL line to
`<agent_home>/.worktrees/.ledger.jsonl`:

```json
{"ts":"2026-05-17T22:00:00Z","agent":"echo","branch":"spec/foo","slug":"spec-foo","worktreePath":"...","instarRepo":"...","instarRepoSha":"abc1234","shareNodeModules":true}
```

Open semantics: `O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC`,
mode `0600`. Before each append, the CLI `fstat`s the resulting fd
and refuses if `st_uid != geteuid()` or `st_mode & 0o077 != 0`.

**Ledger is signal, never authority.** The Layer 4 detector
**must not** use the ledger as an allowlist. The detector's only
decision rule is path-based: `worktree_path` starts with
`realpath(<agent_home>/.worktrees)` for *some* registered agent.
This invariant is restated in §Side-effects (under "Signal vs
authority") so future maintainers don't drift.

Also mirrored to `<stateDir>/audit/worktree-ops.jsonl` (the
canonical audit dir, protected by existing infrastructure) so a
compromised `.worktrees/` can't erase the trail.

Reader tolerance: the consumer parses line-by-line and tolerates a
torn last line (drops it silently and continues).

Ring rotation: when the ledger exceeds 1 MB, rotate to
`.ledger.jsonl.1` (overwrite previous). Rotation runs **only inside
the PostUpdateMigrator step (Layer 3)** — never inside the CLI's
hot path — to avoid the stat→rename→open race between concurrent
`create` invocations. The CLI appends only; the migrator (single-
agent-scoped, single-threaded per agent) handles size checks and
rotation. The mirror at `<stateDir>/audit/worktree-ops.jsonl` is
the **durable trail** — bounded by the same mechanism — and the
per-worktree ledger is local convenience only. Future maintainers
should not derive enforcement from the local ledger; the durable
trail is the source.

### Layer 2 — Scaffold seed (new agents)

`src/scaffold/templates.ts`:

- **Seed CLAUDE.md** gains a "Worktree convention" section that says
  literally: "Create worktrees for collaborator repos with
  `instar worktree create <branch>` — it resolves your agent's home
  automatically. Never hardcode another agent's name or place
  worktrees inside the shared checkout." Avoids the "my home / this
  agent" deictic ambiguity surfaced in Round 1.
- **Seed MEMORY.md** gains a feedback entry equivalent to echo's
  `feedback_worktree_in_agent_home.md`.
- **Seed `.gitignore`** at `<agent_home>/.gitignore` gains the line
  `.worktrees/` (idempotent — only added if missing).

### Layer 3 — `PostUpdateMigrator` step (single-agent scope)

`PostUpdateMigrator` is single-agent (`stateDir`-scoped) by existing
architecture — it runs against the agent whose binary just updated.
Layer 3 adheres to that scope. Each agent gets the helper on its own
next update tick.

A `migrateWorktreeConvention()` step runs on every update for the
running agent:

1. Resolve `<agent_home>` from the migrator's existing `stateDir`
   (parent of `stateDir`). Re-run the same registry-membership +
   anchored-regex validation from §Agent-home resolution before any
   filesystem mutation. Refuse on mismatch (no chmod, no write).
2. **Assert `<agent_home>/.bin` is a real directory inside
   `<agent_home>`** via `realpath` containment + `lstat` symlink
   check. Refuse if it's a symlink (defeats /usr/local/bin clobber).
3. Install/refresh `<agent_home>/.bin/instar-worktree-create.sh`
   (always-overwrite per Migration Parity Standard).
4. Idempotently add `.worktrees/` to `<agent_home>/.gitignore`.
5. Ensure `<agent_home>/.worktrees/` exists with `0700`.
6. If the agent has an existing `INSTAR_REPO` config or env that
   fails the new allowlist validation, emit a one-shot attention
   item ("INSTAR_REPO needs allowlist entry — see config knob
   worktree.repoAllowlist") so the operator can fix BEFORE the
   helper's `exec` line goes hot. Idempotent — emit at most once
   per migrator run.

**Layer 3 does NOT cross-agent iterate.** Cross-agent visibility is
the lifeline detector's job (Layer 4).

### Layer 4 — Lifeline detector (in v1, signal only)

Runs once per agent startup as part of the lifeline health checks.
Per agent home (so it sees its own worktrees by default).

1. Resolve the canonical instar repo via the **deterministic** path
   chain:
   - Read `worktree.repoPath` from `~/.instar/config.json` if set
     (operator-supplied absolute filesystem path).
   - Otherwise probe the default fallback chain
     (`~/Documents/Projects/instar/`, then `~/instar/`) for the
     first one that passes the same integrity validation as Layer 1.
   The resolved path is then validated (it must pass the same
   `INSTAR_REPO` integrity checks: `git rev-parse --git-common-dir`,
   `remote.origin.url` in `worktree.repoUrlAllowlist`, sane
   `core.hooksPath`).
   Do NOT honor `INSTAR_REPO` here — env vars can differ between
   lifeline boot and interactive sessions; a deterministic source
   ensures consistent results.
   (`repoUrlAllowlist` controls *which* URLs are allowed;
   `repoPath` controls *where* the local repo lives. They are
   distinct configs — never confused.)
2. `git -C <instar_repo> worktree list --porcelain` with a **2-second
   timeout**. On timeout: emit a "detector skipped (instar repo slow
   to respond)" attention item; do not block lifeline startup.
3. **Skip the main checkout entry.** The first entry is always the
   canonical repo's own working tree (or marked `bare`). The detector
   compares each path against `realpath(<instar_repo>)` and skips
   it; bare entries are skipped outright.
4. For each remaining entry whose path is not under
   `<this-agent-home>/.worktrees/` (and that exists on disk — stale
   entries are silently ignored), emit an attention-queue item with
   `category: 'worktree-misplaced'` and a deterministic dedupe key
   `worktree-misplaced:sha256(worktree_path)`. Items with the same
   key within 24h are not re-emitted.
5. **Telegram-gated** per the existing AttentionQueue contract. If
   the agent has no Telegram adapter configured, the detector
   degrades to appending a JSONL line at a **dedicated** path
   `<stateDir>/audit/worktree-detector.jsonl` — NOT the existing
   `<stateDir>/recovery-events.jsonl` (that file is consumed by
   the recovery infrastructure with its own schema and would be
   polluted by mixed sources). Opened with the same
   `O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC` semantics, mode
   `0600`, and post-open `fstat` owner/mode check as the audit
   ledger.

Dedupe state: the spec **delegates dedupe to the existing
AttentionQueue's idempotency contract** (items with the same
`category` and `dedupeKey` within the configured TTL are not
re-emitted). The detector supplies
`dedupeKey: 'worktree-misplaced:' + sha256(worktree_path)` and
the configured TTL (24h). No separate dedupe file is created;
no separate poisoning surface introduced. For the JSONL fallback
path (no Telegram), the detector deduplicates by reading the last
24h of fallback-file lines on each emit and skipping matching
keys.

Detector does NOT delete, move, or block. Operator decides.

### Layer 5 — Documentation and discoverability

- This spec at `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md`.
- ELI16 companion at `docs/specs/AGENT-WORKTREE-CONVENTION-ELI16.md`.
- `instar worktree --help` lists `create` with a one-liner and a link.
  Group description distinguishes the two purposes (`register-keypair`
  for migration cryptography; `create` for sandbox-safe agent
  worktrees).
- Self-Knowledge Tree entry at `docs/self-knowledge/worktrees.md`.
- The seed CLAUDE.md change (Layer 2) carries the convention into
  every new agent's first session.

## Side-effects review (per `signal-vs-authority`)

### Over-block risk

- **Refusing to create outside `<agent_home>/.worktrees/`** — intentional.
- **Refusing on invalid slug/branch** — clear errors, no silent partial
  state.
- **`INSTAR_REPO` allowlist refusal** — operator-controllable via
  `worktree.repoAllowlist` in `~/.instar/config.json`. Default
  closed.
- **Strict agent-home validation** — refuses when run outside a
  registered agent home. Error message points at the registry path.
- **Detector** — never blocks. Pure signal.

### Under-block risk

- **Raw `git worktree add` still works.** Mitigation: memory rule +
  scaffold seed + Layer 4 detector.
- **Compromised local user** — explicitly out of scope (Non-goals).

### Level-of-abstraction fit

CLI / migrator / detector / scaffold — each at the right layer in
the existing instar architecture.

### Signal vs authority

- **CLI subcommand** = structural easy-path. Refuses unsafe placement
  under its own roof; cannot police raw `git`.
- **Detector** = signal. Emits attention items, never blocks.
- **Audit ledger** = signal. Append-only; explicitly NOT consumable
  as an allowlist by the detector. Detector's authoritative rule is
  pure path-startsWith comparison.
- **Memory rule + scaffold seed + spec** = authority.

### Interactions

- **`worktree register-keypair`**: same group, zero overlap. Group
  help distinguishes purposes.
- **Pre-commit / pre-push gates**: unaffected (they read
  `git diff --cached`).
- **BackupManager**: scopes to `stateDir = .instar/`, so `.worktrees/`
  (sibling) is already out. Confirmed by reading
  `src/core/BackupManager.ts:89`.
- **Git-sync of agent home**: `.worktrees/` added to seed gitignore
  AND migrator ensures existing agents get the entry. This is the
  load-bearing change against the multi-GB foreign-repo-contents
  corruption mode.
- **Multi-machine sync**: `.worktrees/` is per-machine. Non-goal
  states this.
- **AttentionQueue schema**: detector uses `category: 'worktree-
  misplaced'` matching existing schema. Telegram-gated, JSONL fallback
  when absent. (Source confirmed:
  `src/messaging/TelegramAdapter.ts:2843`.)
- **PostUpdateMigrator scope**: single-agent. Matches existing
  architecture (`src/core/PostUpdateMigrator.ts:55-92`). No cross-
  agent writes.
- **GPG signing**: preserved. Spec explicitly does not touch
  signing config.

### Rollback cost

- **Layer 1**: revert one commit; bash helper continues.
- **Layer 2**: revert one commit; existing agents unaffected.
- **Layer 3**: revert one commit; existing-agent files remain.
- **Layer 4**: revert one commit; attention items drain.
- **`.gitignore` entry**: leave it (harmless).

Total rollback: under 10 minutes. No data loss.

## Sequencing

1. **Pre-task (done):** bash helper spread to bob.
2. **Spec convergence + approval (this doc).**
3. **/instar-dev cycle (single PR):** Layers 1 + 2 + 3 + 4 + 5
   (CLI, scaffold, migrator, detector, docs, tests).
4. **Bash helper wrapper refresh** in echo + bob `.bin/` (agent-home
   file edit after Layer 1 lands; no instar source change, no gate).
   The wrapper:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   export INSTAR_AGENT_HOME="$(dirname "$SCRIPT_DIR")"
   # Honor explicit override first.
   if [[ -n "${INSTAR_BIN:-}" && -x "$INSTAR_BIN" ]]; then
     exec "$INSTAR_BIN" worktree create "$@"
   fi
   # Resolve to an absolute path — shell aliases (like `instar` → `npx instar`)
   # are not honored by `exec`, so we must verify a real binary path.
   INSTAR_RESOLVED="$(command -v instar 2>/dev/null || true)"
   if [[ -n "$INSTAR_RESOLVED" && "$INSTAR_RESOLVED" == /* ]]; then
     exec "$INSTAR_RESOLVED" worktree create "$@"
   fi
   # Fall back to npx when instar is not on PATH as a binary
   # (per echo's memory: `instar installs via npx instar`).
   if command -v npx >/dev/null 2>&1; then
     exec npx --no-install instar worktree create "$@"
   fi
   # Last resort: inlined logic from current helper.
   ```

   Single transport: `INSTAR_AGENT_HOME` env var. No `--agent-home` flag.
   The npx path is the production setup for many machines per memory
   `feedback_mcp_install_is_per_machine.md` style — flowing through it
   transparently is required for the wrapper to actually delegate to
   Layer 1 on most installs.

## Tests

**Unit:**
- Agent-home resolution: `INSTAR_AGENT_HOME` beats CWD walk-up; walk-up
  stops at FS root; rejects when CWD has no `.instar/AGENT.md`; rejects
  when resolved path doesn't match `<instarHome>/agents/<name>/`;
  rejects when not in registry.
- `INSTAR_REPO` validation: `git rev-parse --git-common-dir` failure;
  remote URL absent or not in allowlist; `core.hooksPath` outside repo.
- Slug validation: `..`, `/`, NUL, leading `-`, shell metacharacters,
  case-insensitive collision.
- Branch validation: `git check-ref-format` integration; rejects
  `--upload-pack=...`.
- Path containment: rejects when `dirname(WORKTREE_PATH)` is a symlink
  pointing outside `<agent_home>`.
- Ledger open semantics: `O_NOFOLLOW`, fstat owner/mode check, refuses
  pre-planted symlink at ledger path.

**Integration** (tmp bare repo + tmp agent home):
- Happy path creates worktree, sets git identity (without touching
  signing config), writes ledger entry + audit mirror.
- Default symlinks `node_modules`; `--no-share-node-modules` skips.
- Re-running with same slug fails cleanly without removing partial
  directory.
- `git worktree prune` invoked before `add`.
- Error messages distinguish directory-exists vs stale-metadata, with
  correct recovery commands (path-based, not slug-based).
- Refuses with clear errors on missing/invalid instar repo.
- **Concurrent invocations** against the same instar repo from two
  agent homes do not produce partial state on either side.

**Scaffold:**
- `generateClaudeMd(identity)` output contains "Worktree convention"
  and parses as well-formed markdown.
- `generateGitignore()` includes `.worktrees/`.
- `generateMemorySeed()` includes the convention entry.
- Scaffold seed text uses literal "Create worktrees with
  `instar worktree create`" — not "my home" / "this agent" deictic.

**Migrator:**
- Idempotent (no change on second run).
- Adds `.gitignore` entry if absent; leaves alone if present.
- Always-overwrites bash helper (Migration Parity Standard).
- **Refuses to write when `<agent_home>/.bin` is a symlink** (covers
  the /usr/local/bin clobber adversarial finding).
- Creates `.worktrees/` `0700` if absent.
- Emits one-shot attention item when existing `INSTAR_REPO` fails the
  new allowlist.

**Detector:**
- Emits one item per misplaced worktree.
- **Skips the main checkout entry** (path == `realpath(<instar_repo>)`).
- **Skips `bare` entries.**
- Silent when all worktrees are correctly placed.
- Tolerates missing instar repo.
- Times out at 2s on slow/blocked `git worktree list`; emits
  "skipped" attention item.
- Dedupe: re-emit of same path within 24h does not duplicate the
  attention item.
- Falls back to JSONL at `<stateDir>/recovery-events.jsonl` when
  Telegram not configured.

## Acceptance criteria

- `instar worktree create <branch>` from inside a registered agent
  home produces a worktree at `<agent_home>/.worktrees/<slug>/` with
  correct git identity (without touching signing config), ledger
  entry + audit mirror, and `0700` on `.worktrees/`.
- Running from outside a registered agent home fails cleanly.
- All hostile-input scenarios (planted `.instar/AGENT.md`, attacker
  `INSTAR_REPO`, shell-metachar slug, pre-planted symlink at
  `.worktrees/`, pre-planted symlink at ledger path) refuse with
  clear errors.
- `instar init`-bootstrapped new agents have the convention in seed
  CLAUDE.md, MEMORY.md, `.gitignore`.
- The agent's own `instar` update tick refreshes the bash helper,
  ensures `.gitignore` entry, creates `.worktrees/` `0700`, surfaces
  `INSTAR_REPO` allowlist issues if any.
- Lifeline detector emits attention items for misplaced worktrees
  (deduped), skipping the main checkout and bare entries, with a 2s
  timeout.
- All pre-existing tests pass.
- All new tests above pass.
- ELI16 companion is published.
- Self-Knowledge Tree entry exists.

## Residuals (conscious deferrals) <!-- tracked: residuals -->

- **R-1**: Cleanup migration of pre-existing worktrees in unsafe
  locations (~30 today). Manual `git worktree move` per case. Detector
  emits, operator decides.
- **R-2**: Hardlink-farm node_modules to eliminate sandbox-revoke risk
  with sharing. Deferred to v2. <!-- tracked: R-2 -->
- **R-3**: Disk-usage telemetry in `instar doctor`.
- **R-4**: Capacity tests (50 worktrees × 10 agents).
- **R-5**: `instar worktree list` / `instar worktree prune`
  subcommands.
- **R-6**: Flip default to `--no-share-node-modules` once existing
  callers are audited. Tracked separately. Triggered by zero
  attention items for `node_modules absent` over 30 days.
- **R-7**: Per-agent signed-commit attribution. Requires per-agent
  signing keys; spec sets cosmetic identity only for v1, explicit
  non-claim documented.
- **R-8**: System-owned `~/.instar/system.json` for `repoAllowlist`
  (defends against agent-writable config). Out of scope per Non-goals
  threat-model boundary. <!-- tracked: R-8 -->
- **R-9**: Throttle the PostUpdateMigrator's audit emission to once
  per N hours via a state-file timestamp. v1 emits at most one item
  per misplaced INSTAR_REPO per migrator run, naturally bounded.
- **R-10**: Hash-chained audit ledger (tamper evidence). Append-only
  with O_NOFOLLOW + fstat gating is sufficient for v1's threat model.
- **R-11**: Windows portability. The spec assumes macOS/Linux; the
  `O_NOFOLLOW` semantics and the `~/.instar/` path layout are POSIX
  shape. instar is currently macOS/Linux only; tracking for if/when
  Windows support lands.

Operational notes (not residuals — just documentation):
- `fstat`-owner check defends against **cross-user** tampering. In a
  shared-uid environment (same user, post-compromise, or shared
  container running as one uid) the check passes — this is in-scope
  of the R-8 threat-model carve-out.
- The deterministic detector source (`worktree.repoPath`) is read
  from `~/.instar/config.json` — same threat surface as
  `repoUrlAllowlist`. Both are agent-writable under the
  threat-model boundary in Non-goals (R-8).

## Risk classification

**Low-medium.** Additive in CLI (new subcommand), refresh-only in
migrator (no destructive ops), signal-only in detector (no blocks).
`.gitignore` change prevents a much worse failure mode (multi-GB
git-sync corruption) the first time the convention sees use without
it.

Two material behavior changes worth highlighting:
- Per-worktree git identity now sets local `user.name`/`user.email`
  to `Instar Agent (<name>)`/`<name>@instar.local`. Signing config
  untouched.
- Lifeline detector emits one-time attention items per misplaced
  worktree on agent start. ~30 pre-existing items expected on first
  run for echo's machine; deduped within 24h.

Both are documented; neither breaks workflow.

Rollback under 10 minutes if convention proves wrong.

## Amendment (2026-05-29): per-worktree Husky hook activation

The convention originally guaranteed that a new agent worktree lands in the
safe agent-home location, gets the correct local git identity, and writes an
audit ledger. Dogfooding #525 exposed a separate structural gap: Git config can
point at Husky's generated hook directory while that generated directory is
absent in a fresh worktree. The tracked pre-commit script exists, and
`core.hooksPath` is set, but commits still go ungated because the generated
shim is local ignored state created by Husky's prepare step.

### Change

- After `instar worktree create` adds the new worktree and sets local identity,
  it verifies the generated Husky pre-commit shim exists and is executable when
  the checkout has a tracked Husky pre-commit script and a package prepare
  script.
- If the generated shim is missing, the manager runs the package prepare script
  in the new worktree, then verifies the shim again.
- If prepare fails, or the shim is still missing/non-executable afterward,
  worktree creation fails loudly. An ungated developer worktree is not a valid
  output of the command.
- Repositories without Husky do not opt into this behavior; the check is gated
  by the presence of a tracked Husky pre-commit script.

### Acceptance Criteria (hook activation amendment)

H1. A newly-created Instar worktree with Husky configured has a generated,
executable pre-commit shim before `instar worktree create` returns.
H2. The generated shim is produced even when it was absent from the source
checkout because it is ignored local state.
H3. If the prepare step cannot activate the shim, worktree creation fails with a
clear error rather than silently creating an ungated worktree.
H4. Tests cover both the low-level executable-shim predicate and real worktree
creation producing the shim.
