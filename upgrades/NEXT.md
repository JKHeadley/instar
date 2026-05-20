# Upgrade Guide — v1.1.0 (framework-choice install arc + agent worktree convention + deployment lockdown layer 2)

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

**6. Prompt Gate — auto-dismiss Claude Code's optional session-feedback survey, and reset detector state after every Telegram response.**
Two related fixes to the Prompt Gate detector and relay path, both
reported live in Echo's Telegram topic 9029 on 2026-05-20 with screenshots
showing the same survey re-relayed every 25–50 minutes across multiple
hours. (a) Claude Code's optional "How is Claude doing this session?"
widget is non-blocking — the session continues working whether or not
the operator answers — but the LLM-based detector was classifying it as
a `selection` prompt and re-relaying to Telegram on every 5-minute LLM
cooldown expiry. A new structural pattern in `PROMPT_PATTERNS` matches
the survey by both its question text and its canonical option row
(`1: Bad / 0: Dismiss`), tags the prompt with a new `autoDismissKey`
directive on `DetectedPrompt`, and the detected-prompt handler in
`server.ts` honours the directive: sends the dismiss key, resets
detector state, skips the classify/relay pipeline entirely. A second
pre-filter in `llmDetect()` short-circuits the survey before any LLM
tokens are spent. (b) When a user clicked a Telegram button,
`telegram.onPromptResponse` called `sessionManager.sendKey()` but did
not call `InputDetector.onInputSent()`, so the per-session 5-minute
LLM relay cooldown could silently swallow the next prompt in a
multi-question form. `onInputSent` now also clears
`llmRelayTimestamps`, and both `onPromptResponse` and
`onPromptTextResponse` invoke it after a successful send.

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

**4. Deployment lockdown — Layer 2 (release-tier gate).**
The publish workflow now consults `.instar/release-tier.json` before any
side-effectful step. The committed tier declares the active release line:
`patch` (routine maintenance, current default), `minor` (only publish when
package.json declares a minor leap over npm), `major` (Layer 5
multi-signature required; blocks until Layer 5 ships), or `hold` (all
publishes disabled). This closes the second of seven lockdown layers
designed after the 2026-05-19 v1.0.0 misalignment. Layer 1 (package.json
as version-truth) shipped in v1.0.8 and is what made every subsequent
1.0.x release ship at its declared version; Layer 2 is the operator's
authoritative "no deploy" signal, expressed in a single committed file
the workflow physically honors. Resolution logic lives in
`scripts/resolve-release-tier.mjs` and is exercised by 20 unit tests
including the regression case that reproduces the 2026-05-19 incident
under `tier: hold`. The initial committed value is `tier: hold` — this
release itself does not auto-publish; flip to `patch` to resume routine
maintenance, or leave on hold during major-version work.

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

Prompt Gate survey-spam reproduction prior: Telegram topic 9029
screenshots dated 6:23 AM through 8:31 AM (2026-05-20, single tmux
session) show identical "Your agent needs you to choose" relay messages
re-posted at 6:23, 6:51, 7:16, 7:38, 8:31 — the cadence matches the
5-minute LLM relay cooldown re-firing on the persistent survey text.
The relayed `summary` strings ("Framework is asking for user feedback
rating on Claude's performance this session", "System feedback question:
How is Claude doing this session?", "Claude Code feedback prompt asking
for session quality rating", "Claude Code is asking for session quality
feedback with options to rate or dismiss", "Session quality feedback
prompt asking user to rate how the agent is performing") all paraphrase
the same underlying Claude Code prompt and all carry the same
`1: Bad / 2: Fine / 3: Good` options — confirming the LLM-detection
path was the entry point and the fingerprint kept rotating because
surrounding terminal context (task counts, elapsed time) shifted between
captures. Prompt Gate survey-spam evidence after: new unit test
`InputDetector.pattern.sessionFeedbackSurvey` in
`tests/unit/PromptGate.test.ts` pins all three behaviours: (1) the
canonical survey block emits a `selection` prompt with
`autoDismissKey: '0'`; (2) the question text alone (without the
canonical option row) is NOT misclassified as a survey; (3) unrelated
numbered prompts are not labelled as the survey. A second unit test
`InputDetector.onInputSent` pins the `llmRelayTimestamps` clear-on-response
behaviour. Live verification cannot be exercised in dev because the
survey is fired by Claude Code itself on an opaque internal cadence;
post-deploy on Echo's host, the Telegram relay history for topic 9029
should show zero "Claude Code session-feedback survey" relays even as
agent sessions cross multi-hour durations.

Bind-failure probe evidence: today's AI Guy outage
(`~/Documents/Projects/ai-guy/.instar/logs/lifeline-launchd.log` records
"Suppressing duplicate server down notification (4163 suppressed this
outage)" — 2 days of suppressed alerts). After this PR, the same
configuration produces a BIND-FAIL log line on the first watchdog cycle and
a Telegram alert by cycle 3. `tests/unit/watchdog-bind-probe.test.ts`
(18 tests) + `tests/integration/watchdog-bind-fail-escalation.test.ts`
(2 tests) cover the probe's behaviour and the full bind-fail →
peer-escalation pipeline.

Lockdown Layer 2 evidence: reproduction of the 2026-05-19 incident
class — a no-deploy session with `package.json: 1.0.13` while npm is on
`0.28.121` would, under v1.0.8 alone, still publish (Layer 1 honors
package.json but has no concept of "hold"). Under Layer 2 with
`tier: hold` committed, the workflow's gate step writes the skip reason
to `$GITHUB_STEP_SUMMARY` and every downstream step (version bump,
NEXT.md rename, npm publish, version-bump commit) short-circuits. The
20-test unit suite `tests/unit/resolve-release-tier.test.ts` covers each
of the four tiers across both passing and blocking version configurations
plus an explicit regression case mirroring the 2026-05-19 incident input
under `tier: hold`. The committed tier in this release is `hold`, so
this PR's own merge does not auto-publish — exactly the headline
guarantee the spec promises.

## What to Tell Your User

- "You can now pick which AI runtime to use when you set up an Instar agent. Pass the framework flag to instar init for a Codex-only install. Default behavior is unchanged for everyone else. The framework flag is the first piece of a four-part install upgrade — the next three pieces add the same choice to setup, gate Claude-Code-only files behind the choice, and route the setup wizard through whichever runtime you pick."
- "Codex and Gemini agents now also get the same capability instructions Claude agents have — discover, private views, coherence gate, agent network. This closes the v1.0 cross-framework portability arc."
- "If two instar agents end up configured for the same port (configuration drift, leftover smoke-test fixtures, etc.), you'll now get a clear Telegram alert within about 15 minutes naming both agents involved. Previously the lifeline could spin silently for days while the supervisor suppressed its own server-down notifications as duplicates."
- "Prompt Gate is quieter now. It used to keep pinging you about Claude's optional session-feedback survey every twenty-something minutes — I just dismiss that one for you since it doesn't actually block anything. And when you answer a real Telegram prompt, the next prompt in a multi-step form will reach you immediately instead of getting swallowed by a five-minute cooldown."
- "Your instar agents have a new way to create git worktrees that the macOS sandbox can't kick them out of mid-session. There's a new instar worktree create command that places the worktree inside the agent's own home directory — the only place the sandbox can't revoke access to. Agents you create from now on will know about this convention out of the box. Agents already on your machine pick it up via the next update tick — the wrapper script is installed automatically, the worktree-convention section is backfilled into their CLAUDE.md, and the worktrees-directory is created with secure permissions, no operator action needed. On every agent startup, a lightweight detector also checks the shared instar repo for any worktrees that ended up in unsafe locations (created via raw git commands before this convention existed, for example) and surfaces them as a low-priority attention item so you can decide whether to relocate them with git worktree move."
- "I have a new way to physically pause all auto-publishing to npm — a small file at the top of the instar repo that says what release line we're on. If we're working on a major feature, I can set it to hold and the publisher will refuse to ship anything until we deliberately flip it back. This release ships with that switch already in the hold position, so no further auto-publishes happen until we choose to resume. This is the second of seven locks designed after the v1.0.0 deployment misalignment in May."

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
| Auto-dismiss Claude Code's optional session-feedback survey | Automatic. The Prompt Gate recognises the survey by its canonical option row and sends `0` (Dismiss) without relaying. |
| Detector state reset after every Telegram prompt response | Automatic. `onPromptResponse`/`onPromptTextResponse` now invoke `InputDetector.onInputSent()`, which clears `emittedPrompts`, `stableCount`, `lastOutput`, `lastEmissionTime`, `llmRelayTimestamps`, and the `noPromptCache` (with a generation bump). |
| Lifeline detector for misplaced worktrees | Automatic on every agent server boot. Resolves the canonical instar repo deterministically (`worktree.repoPath` config or default fallback chain), runs `git worktree list --porcelain` with a 2-second timeout, skips the main checkout and bare entries, and emits an attention-queue-shaped record (or JSONL fallback at `<stateDir>/audit/worktree-detector.jsonl` when no Telegram adapter) for every misplaced worktree. Signal-only — never blocks, never moves, never deletes. Dedupe via `worktree-misplaced:sha256(path)`. |
| `.instar/release-tier.json` | Committed file. Set `tier` to `patch`, `minor`, `major`, or `hold` to declare the active release line. The publish workflow honors the tier before any side-effectful step. |
| Tier `hold` engaged on release | Initial value committed as `hold`. To resume routine maintenance, edit `tier` to `patch`. |
| Workflow gate (Layer 2) | Automatic. Reads `release-tier.json`, runs `scripts/resolve-release-tier.mjs`, short-circuits all publish steps on skip with a structured `$GITHUB_STEP_SUMMARY` entry. |

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
- Layers 3–7 of the deployment lockdown spec — branch isolation as a
  workflow trigger restriction, NEXT.md `hold: true` frontmatter,
  multi-signature for major bumps, loud-refusal hardening with PR
  comments and Telegram mirror, and session-start memory injection —
  ship as separate PRs after Layer 2 lands. Spec:
  `docs/specs/deployment-lockdown.md` (to land alongside Layer 3 PR).
