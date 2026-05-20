# Upgrade Guide — v1.1.0 (framework-choice install arc + agent worktree convention)

<!-- bump: minor -->

## What Changed

Seven changes ship together as v1.1.0 — completes the install/wizard
framework-choice arc Justin asked for (including a hotfix for the
parent-option interception that caused the smoke test to fail on the
v1.0.17 build), plus the v1.0.14-v1.0.16 content that has been queued
behind the npm auth issue.

**Hotfix on v1.0.17. Parent --framework option intercepted subcommand flag.**
The bareword command (`npx instar` with no subcommand) had its own
`--framework` option defined alongside the same flag on `init` and
`setup`. Commander treats program-level options as global, so an
invocation like `instar init --framework codex-cli` had its flag consumed
by the parent parser before the init subcommand saw it — the flag silently
fell back to `claude-code`. Smoke-test caught this; the parent-level
option is removed. To pick a framework from the bareword path, use
`instar setup --framework codex-cli` explicitly.

**A. `instar setup --framework codex-cli` runs end-to-end on a Codex-only host (portability install PRs 3+4 of 4).**
The `setup` and bareword (`npx instar`) commands now accept a `--framework
<claude-code|codex-cli>` flag. Detection no longer hard-exits on missing
Claude when the operator asked for Codex; it calls `checkFrameworkPrerequisite`
against whichever framework was selected and surfaces the install URL for
the missing one. The wizard launch and the secret-setup micro-session now
spawn the chosen runtime: Claude users get the historical
`claude --dangerously-skip-permissions /setup-wizard ...` invocation;
Codex users get `codex exec --dangerously-bypass-approvals-and-sandbox`
with a prompt that reads the same SKILL.md content (the wizard skill itself
lives in one place; both runtimes are pointed at it). The Playwright
Telegram-setup flow is untouched and remains portable — the entry to it
now works for Codex.

**0. Codex-only init produces zero `.claude/` files (portability install PR 2 of 4).**
With v1.0.15 the `--framework` flag became expressible; this release makes
it actually mean something at install time. When `instar init` is run with
`--framework codex-cli` (or with `enabledFrameworks: ['codex-cli']` in a
pre-existing config), every `.claude/`-targeting installer is skipped:
`.claude/settings.json`, `.claude/scripts/health-watchdog.sh`,
`.claude/scripts/smart-fetch.py`, `.claude/scripts/git-sync-gate.sh`,
`.claude/skills/`, and the rich CLAUDE.md instruction document. Codex
agents continue to receive the canonical `.instar/AGENT.md`, the AGENTS.md
shadow, framework-neutral hooks under `.instar/hooks/instar/`, and the
serendipity-capture script (which already lives under `.instar/scripts/`).
Claude-only and dual-framework installs are byte-for-byte unchanged.

**1. `instar init --framework <name>` — choose your runtime at install time.**
A new flag on the `init` command lets a user pick which AI runtime the agent
should target: `claude-code` (default — historical behavior), `codex-cli`
(Codex-only install), or `both` (dual-runtime). The choice is written to
`.instar/config.json` as `enabledFrameworks`, which the migrator, sentinel,
and runtime spawn paths already read (added in v1.0.11). This is the first of
four PRs in the install/wizard portability upgrade — subsequent PRs gate the
`.claude/` writes on this choice, add the same flag to `setup`, and route the
wizard through the chosen runtime.

**2. Shadow capability mirror (closes the v1.0.0 portability audit).**
The migrator now mirrors capability-instruction sections from the just-patched
CLAUDE.md into AGENTS.md and GEMINI.md when those shadows exist. Codex/Gemini
agents had their canonical identity from v1.0.9 but were missing the
"here's what you can do" sections; this closes that gap. Section bodies are
sliced literally from CLAUDE.md — never duplicated in source — so the two
cannot drift. Claude-only installs are byte-for-byte unchanged.

(Note: the shadow capability mirror originally bumped to v1.0.14, but the
publish step hit an unrelated npm auth issue and did not actually reach the
registry. Both changes ship together as v1.0.15 once the auth side is
resolved.)

**5. Agent worktree convention — migrator + lifeline detector (Layers 3 + 4).**
Completes the agent worktree convention spec. On every agent update tick,
a new `migrateWorktreeConvention` step installs/refreshes
`<agent_home>/.bin/instar-worktree-create.sh` (a wrapper that `exec`s
into `instar worktree create` when available, with an inline fallback
for hosts that don't have the CLI on PATH yet), adds `.worktrees/` to
`<agent_home>/.gitignore` (defense-in-depth on top of the seed change),
and ensures `<agent_home>/.worktrees/` exists with mode `0700`. The
migrator silently skips agents whose home doesn't match the
`<instarHome>/agents/<name>/` shape (project-bound agents with bespoke
layouts are unaffected) and refuses to write when `<agent_home>/.bin`
is a symlink (defeats the /usr/local/bin clobber adversarial surface).
The Migration Parity Standard backfill for the seed CLAUDE.md
"Worktree Convention" section also runs here, so existing agents pick
up the convention documentation on update; the section is mirrored
through to AGENTS.md/GEMINI.md for Codex/Gemini agents via the
shadow-capability mirror. On every agent server boot, a new
`AgentWorktreeDetector` runs once: it resolves the canonical instar
repo deterministically (config `worktree.repoPath` or the default
fallback chain — never `INSTAR_REPO` env, because that can differ
between lifeline boot and interactive sessions), runs
`git worktree list --porcelain` with a 2-second timeout, skips the
main checkout and bare entries, and emits an AttentionItem-shaped
record for every misplaced worktree. Signal-only — never blocks, never
moves, never deletes. Dedupe is path-hash-based with the documented
`worktree-misplaced:sha256(path)` key. When no Telegram adapter is
configured the detector falls back to a JSONL append at
`<stateDir>/audit/worktree-detector.jsonl` (O_NOFOLLOW + fstat
owner/mode gate, 24h rolling-window dedupe).
Side-effects review:
`upgrades/side-effects/agent-worktree-convention-layer-3-4.md`.

**4. Agent worktree convention — `instar worktree create <branch>` (Layers 1 + 2 + 5).**
A new CLI subcommand creates a sandbox-safe git worktree of the shared instar
repo inside the agent's own home directory
(`~/.instar/agents/<agent>/.worktrees/<slug>/`). This is the one location the
macOS sandbox cannot revoke mid-session — agents who land worktrees in the
shared checkout (the historical default of `git worktree add`) have been
stranded mid-implementation multiple times this month with no in-session
recovery path. The new command refuses any other destination, validates the
target instar repo against a `remote.origin.url` allowlist, sets per-worktree
git identity (`Instar Agent (<name>)` / `<name>@instar.local` — signing
configuration deliberately untouched), and appends a JSONL audit ledger plus
a durable mirror under `<stateDir>/audit/worktree-ops.jsonl`. New agents
created with `instar init` get the convention in their seed CLAUDE.md,
MEMORY.md, and `.gitignore` (`.worktrees/` excluded so it never enters
git-sync). Existing agents inherit the convention through Layer 3 — the
`PostUpdateMigrator` step shipping in the next release. The lifeline
detector (Layer 4) ships in the same follow-up release. Spec:
`docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` (approved 2026-05-17).
Side-effects review:
`upgrades/side-effects/agent-worktree-convention-layer-1-2-5.md`.

**3. Fleet-watchdog bind-failure probe.**
The watchdog now catches the failure mode where a lifeline reports healthy
to launchd but its server is locked out of its configured port (typically a
port collision with another agent). The probe issues an authenticated GET
/health for each loaded agent, compares the response's project field against
the agent's launchd-label-derived expected name, and routes any mismatch
through the existing crash-loop heal + peer-escalation pipeline from PR #245.
After 3 consecutive cycles (~15 min), the user gets a conflict-aware Telegram
alert naming both parties — closes the AI-Guy-stuck-behind-codex-server-smoke
class of failure that took 2 days to surface this week.

## Evidence

Install-framework-choice reproduction prior: `instar init` had no way to
express "Codex-only." Even with all the v1.0.9–v1.0.13 portability plumbing,
the user had no UI for the choice; install always wrote Claude-Code-shaped
defaults.

Install-framework-choice after: `instar init my-agent --framework codex-cli`
writes `enabledFrameworks: ['codex-cli']` to config. Verified by five unit
tests pinning the resolver: default unflagged is `['claude-code']`, explicit
`claude-code` matches the default, `codex-cli` returns `['codex-cli']`, `both`
returns `['claude-code', 'codex-cli']`, and successive calls return fresh
arrays (no shared mutable state). Backward compatible: users who do not pass
the flag get identical behavior to today.

Shadow capability mirror reproduction prior: a Codex agent's AGENTS.md
contained identity but none of the capability instructions Claude's CLAUDE.md
has. Shadow capability mirror after: AGENTS.md and GEMINI.md gain the same
sections, sliced directly from CLAUDE.md so the content is identical.
Verified by six unit tests covering append, idempotent re-run, both shadows,
no-shadow no-op, no-CLAUDE.md no-op, identity preservation.

Bind-failure probe evidence: today's AI Guy outage
(`~/Documents/Projects/ai-guy/.instar/logs/lifeline-launchd.log` records
"Suppressing duplicate server down notification (4163 suppressed this
outage)" — 2 days of suppressed alerts). After this PR, the same
configuration produces a BIND-FAIL log line on the first watchdog cycle and
a Telegram alert by cycle 3. `tests/unit/watchdog-bind-probe.test.ts`
(18 tests) + `tests/integration/watchdog-bind-fail-escalation.test.ts`
(2 tests) cover the probe's behaviour and the full bind-fail →
peer-escalation pipeline.

## What to Tell Your User

- "You can now pick which AI runtime to use when you set up an Instar agent. Pass the framework flag to instar init for a Codex-only install. Default behavior is unchanged for everyone else. The framework flag is the first piece of a four-part install upgrade — the next three pieces add the same choice to setup, gate Claude-Code-only files behind the choice, and route the setup wizard through whichever runtime you pick."
- "Codex and Gemini agents now also get the same capability instructions Claude agents have — discover, private views, coherence gate, agent network. This closes the v1.0 cross-framework portability arc."
- "If two instar agents end up configured for the same port (configuration drift, leftover smoke-test fixtures, etc.), you'll now get a clear Telegram alert within about 15 minutes naming both agents involved. Previously the lifeline could spin silently for days while the supervisor suppressed its own server-down notifications as duplicates."
- "Your instar agents have a new way to create git worktrees that the macOS sandbox can't kick them out of mid-session. There's a new instar worktree create command that places the worktree inside the agent's own home directory — the only place the sandbox can't revoke access to. Agents you create from now on will know about this convention out of the box. Agents already on your machine pick it up via the next update tick — the wrapper script is installed automatically, the worktree-convention section is backfilled into their CLAUDE.md, and the worktrees-directory is created with secure permissions, no operator action needed. On every agent startup, a lightweight detector also checks the shared instar repo for any worktrees that ended up in unsafe locations (created via raw git commands before this convention existed, for example) and surfaces them as a low-priority attention item so you can decide whether to relocate them with git worktree move."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `instar init --framework <name>` | Pass `claude-code` (default), `codex-cli`, or `both`. The choice is persisted to config and read by every downstream step. |
| Shadow capability mirror | Automatic on update. The migrator copies capability sections from CLAUDE.md into AGENTS.md and GEMINI.md when those shadows exist. |
| No-duplication source | The section bodies live in exactly one place (CLAUDE.md) and are sliced into shadows at migration time; Claude and non-Claude cannot drift. |
| Fleet watchdog bind-failure probe | Automatic. Catches port-collision / server-unreachable agents whose lifelines look healthy to launchd. Escalates via peer agent's `/attention` endpoint after 3 cycles. |
| Conflict-aware Telegram alerts | When the probe identifies the wrong-project case, the escalation summary names both contested parties. |
| `instar worktree create <branch>` | New CLI subcommand. Places the worktree at `~/.instar/agents/<agent>/.worktrees/<slug>/` — the only location the macOS sandbox cannot revoke mid-session. Resolves agent home from `INSTAR_AGENT_HOME` or CWD walk-up; validates the instar repo against `worktree.repoUrlAllowlist` in `~/.instar/config.json`; sets per-worktree git identity without touching signing config; symlinks `node_modules` by default (`--no-share-node-modules` opts out). |
| Sandbox-safe worktrees for new agents | `instar init` now seeds the convention into CLAUDE.md (top-level "Worktree Convention" section), MEMORY.md (Project Patterns entry), and `.gitignore` (`.worktrees/` excluded from git-sync). Existing agents pick this up via Layer 3 migrator in the next release. |
| Authoritative reference doc | `docs/self-knowledge/worktrees.md` — the "how do I create a worktree?" answer any future agent gets pointed at via the seed CLAUDE.md mention. |
| Existing agents pick up the worktree convention on update | Automatic on next `instar` update tick. `PostUpdateMigrator.migrateWorktreeConvention` installs `<agent_home>/.bin/instar-worktree-create.sh` (wrapper that `exec`s into `instar worktree create`), ensures the `.gitignore` entry, creates `<agent_home>/.worktrees/` with mode `0700`. Idempotent. Refuses if `<agent_home>/.bin` is a symlink. Silently skips agents whose home isn't under `~/.instar/agents/<name>/`. |
| Existing agents pick up the Worktree Convention CLAUDE.md section on update | Automatic on next update tick (Migration Parity Standard backfill in `migrateClaudeMd`). Section is mirrored through to AGENTS.md / GEMINI.md for Codex/Gemini agents via the shadow-capability mirror. |
| Lifeline detector for misplaced worktrees | Automatic on every agent server boot. Resolves the canonical instar repo deterministically (`worktree.repoPath` config or default fallback chain), runs `git worktree list --porcelain` with a 2-second timeout, skips the main checkout and bare entries, and emits an attention-queue-shaped record (or JSONL fallback at `<stateDir>/audit/worktree-detector.jsonl` when no Telegram adapter) for every misplaced worktree. Signal-only — never blocks, never moves, never deletes. Dedupe via `worktree-misplaced:sha256(path)`. |

## Deferred (Tracked Follow-ups)

- The install/wizard portability series is complete — Codex-only
  `instar setup --framework codex-cli` runs end-to-end on this release.
  Follow-up work tracked separately: a full smoke test of a fresh Codex-only
  install on a clean machine, and any narrative-prose tweaks the wizard
  skill should adopt to surface framework-specific paths in user-facing
  output.
- Per-agent "muted" flag for the bind-probe (legitimate maintenance
  windows) is deferred to the v3 Remediator's policy layer.
- Layers 3 + 4 of the agent worktree convention now ship in this release
  alongside Layers 1+2+5. Earlier note about deferral was for the
  previous PR boundary; both PRs land under v1.1.0. Wrapper refresh of
  echo + bob `.bin/` (agent-home file edit, no instar source change) is
  the remaining manual step.
- Detector first-run output: ~30 pre-existing worktrees outside agent
  homes on echo's machine will surface as a one-time burst of low-priority
  attention items on first agent restart after this release. Each is
  individually deduped for 24h. Operator decides whether to drain them
  or move them with `git -C <instar_repo> worktree move <old> <new>`.
- AttentionQueue wireup for the detector (currently it falls back to
  JSONL because TelegramAdapter initializes later in startServer than
  the detector runs) is tracked as a follow-up. The JSONL fallback is
  the durable trail for v1; promoting to Telegram attention items just
  changes the surfacing channel.
- (Earlier deferred text follows for historical context:) Layers 3 + 4 of the agent worktree convention will
  ship in the next release. Until then, existing agents continue to use
  the hand-rolled `instar-worktree-create.sh` already in their `.bin/`.
- The two-line wrapper refresh in echo + bob `.bin/` that wires the
  existing bash helper to `exec` into `instar worktree create` is an
  agent-home edit (no instar source change, no gate) and lands together
  with the v1.1.0 push.
