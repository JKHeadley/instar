# Side-Effects Review — Agent Worktree Convention (Layers 1, 2, 5)

**Version / slug:** `agent-worktree-convention-layer-1-2-5`
**Date:** `2026-05-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`
(see §"Phase 5 trigger check" below — this change does not touch the
high-risk surfaces listed in the /instar-dev skill.)

## Summary of the change

Implements three of the five layers of the
`docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` (status: approved by
Justin 2026-05-17 22:35 UTC):

- **Layer 1 — `instar worktree create <branch>` CLI subcommand.** New
  command under the existing `worktree` group. Creates a sandbox-safe
  git worktree of the shared instar repo at
  `~/.instar/agents/<agent>/.worktrees/<slug>/`. Refuses any other
  destination. All validation logic lives in a new
  `src/core/InstarWorktreeManager.ts` so it can be unit-tested without
  spawning the CLI.
- **Layer 2 — Scaffold seed for new agents.** `generateClaudeMd()`
  gains a top-level "Worktree Convention" section with the literal
  spec text plus the `GIT_AUTHOR_NAME` / `GIT_COMMITTER_EMAIL`
  env-override caveat. `generateMemoryMd()` seeds a feedback-style
  entry under "Project Patterns". `MachineIdentity.ts`
  `GITIGNORE_ENTRIES` adds `.worktrees/` (consumed by `ensureGitignore`
  on `instar init`).
- **Layer 5 — Documentation & discoverability.**
  `docs/self-knowledge/worktrees.md` is the authoritative reference
  (linked from the seed CLAUDE.md). The `worktree` command group's
  `.description()` is updated to distinguish `create` (this spec) from
  the existing `register-keypair` (parallel-dev cryptography).

**Files touched:**
- `src/core/InstarWorktreeManager.ts` (new, ~430 lines)
- `src/commands/worktree.ts` (existing, +~22 lines for `createWorktree` shim)
- `src/cli.ts` (existing, +~28 lines for `create` subcommand and updated group description)
- `src/scaffold/templates.ts` (existing, +~25 lines for Worktree Convention section + MEMORY.md entry)
- `src/core/MachineIdentity.ts` (existing, +2 lines in `GITIGNORE_ENTRIES`)
- `docs/self-knowledge/worktrees.md` (new)
- `tests/unit/InstarWorktreeManager.test.ts` (new, 27 cases)
- `tests/unit/scaffold-worktree-convention.test.ts` (new, 5 cases)
- `tests/integration/instar-worktree-create.test.ts` (new, 6 cases)
- `upgrades/NEXT.md` (appended one section)

Layers 3 (PostUpdateMigrator step for existing agents) and 4 (lifeline
detector) are deliberately deferred to the next `/instar-dev` cycle —
PostUpdateMigrator changed substantially in the v1.0.x portability
work that just landed on main, and splitting keeps the diff readable.
Layer 3 is what propagates the convention to existing agents on
update; until it ships, existing agents continue to use the hand-rolled
bash helper that already exists in each agent's `.bin/`. New agents
created via `instar init` get the seed (Layer 2) immediately.

## Decision-point inventory

- **CLI accept/refuse on worktree placement** — *add*. Refuses any
  destination outside `<agent_home>/.worktrees/`. Structural
  hard-invariant validation (path containment via `realpath`), not a
  judgment call. Falls under the "safety guard on irreversible action"
  carve-out in `docs/signal-vs-authority.md`.
- **CLI accept/refuse on agent-home resolution** — *add*. Refuses
  unregistered homes, hostile-CWD-planted `AGENT.md`, and paths that
  don't match the `^<instarHome>/agents/[a-z0-9_-]+/?$` regex.
  Hard-invariant validation.
- **CLI accept/refuse on `INSTAR_REPO`** — *add*. Refuses repos whose
  `remote.origin.url` is not in the bake-in allowlist (extendable via
  `worktree.repoUrlAllowlist` in `~/.instar/config.json`) or whose
  `core.hooksPath` resolves outside the repo. Hard-invariant.
- **Audit ledger writes** — *add*. Two append paths (local
  `.worktrees/.ledger.jsonl` + audit mirror under
  `<stateDir>/audit/worktree-ops.jsonl`). No block/allow surface;
  signal-only for downstream consumers. `O_NOFOLLOW` + `fstat`
  owner/mode gate is structural validation of a security invariant,
  not a brittle filter.

No new authorities introduced. No detectors with blocking power.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Calls from a directory that is not under any registered agent
  home** are refused. *Intentional* — the whole point of the
  convention is "from inside an agent home, into the agent home." If
  an operator legitimately wants to create a worktree from a non-agent
  shell, they use raw `git worktree add` (still works, but the Layer 4
  detector — once it ships — will surface a one-time attention item).
- **`INSTAR_REPO` pointing at a fork** with a non-allowlisted remote
  URL is refused. *Operator-controllable* via
  `worktree.repoUrlAllowlist` in `~/.instar/config.json`. Default
  closed.
- **Slugs containing legitimate Unicode** (anything outside
  `[A-Za-z0-9._-]`) are refused. *Intentional*: the slug becomes a
  directory name passed to `git worktree add`, and the threat model
  (prompt-injection-driven slug pollution → path traversal back into
  the shared checkout) outweighs the convenience of accepting Unicode
  branch labels. Operators with Unicode branch names get the default
  hyphenation of slashes; if they want a custom slug, they pass an
  ASCII one explicitly.

## 2. Under-block

**What failure modes does this still miss?**

- **Raw `git worktree add` into the shared checkout is not
  intercepted.** Spec explicitly out-of-scope ("Non-goals"). Mitigation
  is the Layer 4 detector (deferred to next `/instar-dev` cycle) +
  scaffold seed memory + per-agent CLAUDE.md mention.
- **A compromised local user** (same uid, full execution privilege)
  can rewrite `~/.instar/config.json` to widen the
  `worktree.repoUrlAllowlist`, plant files in `~/.instar/agents/`, or
  replace the binary. Explicitly out-of-scope per the spec's threat
  model boundary in §Non-goals.
- **The agent-name segment can be any registered name**, not strictly
  "the agent whose `INSTAR_AGENT_HOME` env var resolved here." This is
  intentional — the env var IS the canonical identity transport set by
  the launcher; if the env var is wrong, the launcher is broken and
  the validation flags only structural problems (regex, registry
  membership, realpath containment). The walk-up fallback only triggers
  when the env var is unset and resolves against the real CWD, so
  there's no path where a different agent's home is silently selected
  while the current agent is running.
- **`GIT_AUTHOR_NAME` / `GIT_COMMITTER_EMAIL` env vars override** the
  per-worktree identity the CLI sets. The seed CLAUDE.md and
  self-knowledge doc both warn about this; we can't override env
  precedence without breaking legitimate per-call attribution.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- The CLI subcommand and the manager class live where every other
  instar CLI tool lives: `src/cli.ts` → `src/commands/<group>.ts` →
  `src/core/<Manager>.ts`. The split between the picocolors-printing
  command shim and the manager class matches `WorktreeKeyVault`,
  `BackupManager`, etc. — manager has no I/O on stdout, command shim
  has no business logic.
- The scaffold seed change is one entry in `GITIGNORE_ENTRIES` and one
  literal-text section in `generateClaudeMd`/`generateMemoryMd`. No
  new code path — it rides on top of `ensureGitignore` which already
  runs on every relevant `instar init` codepath.
- The self-knowledge doc lives in `docs/self-knowledge/` (new
  directory). The TreeGenerator integration (a node sourced from this
  file) is left as a follow-up — the runtime discoverability that
  matters for v1 is the seed CLAUDE.md mention + the `--help` text,
  both of which are wired here.

A lower-level primitive (`GITIGNORE_ENTRIES`) already exists and is
used; the new `.worktrees/` entry just feeds it. A higher-level gate
(the Layer 4 detector) is what the convention will eventually feed —
that's a follow-up, but the audit ledger this change writes is the
signal that detector will consume.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no judgment-call block/allow surface. The
  blocks are all structural hard-invariant validation (`realpath`
  containment, regex on agent-name segment, registry-membership lookup,
  `git check-ref-format`, `O_NOFOLLOW` + `fstat`), which fall under the
  "hard-invariant validation" and "safety guards on irreversible
  actions" carve-outs documented at the bottom of
  `docs/signal-vs-authority.md`.
- The audit ledger is explicitly a **signal**. The spec restates this
  in §Design ("Ledger is signal, never authority") and the manager
  comment at `worktreeDedupeKey` carries the same invariant for the
  Layer 4 detector — the detector's authority rule is path-based, not
  ledger-membership-based.
- No new LLM-backed gates introduced. No new authorities introduced.

## 5. Interactions

- **Shadowing:** The `worktree` command group's existing
  `register-keypair` subcommand is unaffected — different verb,
  different action method, different command path. Group description
  updated to distinguish them so `instar worktree --help` is honest
  about both purposes.
- **Double-fire:** The hand-rolled bash helper in echo/bob's `.bin/`
  (`instar-worktree-create.sh`) continues to exist and continues to
  work. After Layer 3 ships, the wrapper refresh re-exports it to
  `exec` into `instar worktree create` so the two paths converge; for
  now, both are functional but the bash helper is the primary path on
  echo's machine until Layer 3 lands.
- **Races:** The CLI runs `git worktree prune` before every `add`, and
  on add-failure it does NOT remove any partial directory — git owns
  rollback. Two agent homes targeting the same `INSTAR_REPO` cannot
  produce partial state on either side: each path is contained inside
  its own `.worktrees/`, and the `worktree-list`/`prune`/`add`
  sequence is git's own atomicity contract.
- **Feedback loops:** None. The ledger feeds nothing in this PR (Layer
  4 is the consumer, deferred). The scaffold seed is one-shot at
  `instar init`.

## 6. External surfaces

- **Other agents on the same machine:** the seed change shows up only
  in *newly initialized* agent homes (Layer 2 path). Existing agents
  see nothing until Layer 3 ships.
- **Other users of the install base:** no — same as above. The new
  CLI subcommand is available to anyone who upgrades, but it's purely
  additive; no existing command's behaviour changes.
- **External systems:** none. No network calls. No Telegram. No
  GitHub. The integration test creates a local bare git repo in `os.tmpdir()`.
- **Persistent state:** two new JSONL files per agent home
  (`.worktrees/.ledger.jsonl` + `<stateDir>/audit/worktree-ops.jsonl`)
  appended on every successful create. Both are bounded — the spec
  defers ring-rotation to the PostUpdateMigrator (Layer 3) — and both
  are git-ignored in the agent home. Rollback is `rm` of the two
  files, no schema migration.
- **Timing / runtime conditions:** the manager calls out to `git`
  shell-out (via `execFileSync`). The integration test exercises this
  against a real `git init`. No long-running operations; no timeouts
  needed.

## 7. Rollback cost

- **Code:** revert these commits. The hand-rolled bash helper in
  echo/bob `.bin/` already exists, has been in production today, and
  continues to work. No agent is dependent on `instar worktree create`
  yet because Layer 3 (migrator) hasn't shipped — until it does, no
  existing agent has the wrapper that calls into Layer 1.
- **Persistent state:** the two JSONL files. `rm
  <agent_home>/.worktrees/.ledger.jsonl` and
  `rm <stateDir>/audit/worktree-ops.jsonl` are safe one-liners; both
  are signal-only and consumed by nothing in this PR.
- **Agent state repair:** none required.
- **User visibility during rollback:** the only user-visible surface
  is the `instar worktree create` subcommand, which simply disappears.
  Anyone using it would fall back to the bash helper.

Total rollback time: under 5 minutes (one revert, two `rm`).

## Conclusion

The change is purely additive at the CLI layer, additive in the
scaffold layer (new agents only), and one-shot at the `.gitignore`
seed. All decision points are structural validators in the spec's
hard-invariant / safety-guard carve-outs. No new authorities. No
detectors with blocking power. 38 new tests pass (27 unit + 5
scaffold-unit + 6 integration). Rollback is straightforward and the
hand-rolled bash helper continues to function as a fallback.

Phase 5 trigger check: the change does **not** touch outbound or
inbound messaging dispatch, session lifecycle (spawn/restart/kill),
compaction/respawn, coherence gates, idempotency at the transport
layer, trust levels, or anything named sentinel/guard/gate/watchdog.
No second-pass reviewer required.

Clear to ship.

## Evidence pointers

- **Unit tests:** `tests/unit/InstarWorktreeManager.test.ts` (27
  cases — agent-home resolution including the hostile-CWD path,
  INSTAR_REPO validation including unallowlisted remote +
  out-of-repo `core.hooksPath`, slug/branch validation including
  path-traversal and `--upload-pack=` injection, ledger O_NOFOLLOW
  + fstat owner/mode gate).
- **Scaffold tests:** `tests/unit/scaffold-worktree-convention.test.ts`
  (5 cases — literal-text assertions on the seed sections + idempotent
  `.gitignore` addition).
- **Integration tests:** `tests/integration/instar-worktree-create.test.ts`
  (6 cases — happy path with identity verification + ledger + mirror,
  node_modules default symlink, `--no-share-node-modules` opt-out,
  slug collision without removing partial state, path-containment
  refusal of a pre-planted symlink at `.worktrees/`, refusal of a
  repo with unset remote).
- **Spec:** `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` (approved
  2026-05-17 22:35 UTC).
- **ELI16:** `docs/specs/AGENT-WORKTREE-CONVENTION-ELI16.md`.
- **Convergence report:**
  `docs/specs/reports/agent-worktree-convention-convergence.md`.
