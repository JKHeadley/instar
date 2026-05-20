# Upgrade Guide — v1.0.18 (hotfix: parent-option intercepts --framework on subcommands)

<!-- bump: patch -->

## What Changed

Six changes ship together as v1.0.18 — completes the install/wizard
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

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `instar init --framework <name>` | Pass `claude-code` (default), `codex-cli`, or `both`. The choice is persisted to config and read by every downstream step. |
| Shadow capability mirror | Automatic on update. The migrator copies capability sections from CLAUDE.md into AGENTS.md and GEMINI.md when those shadows exist. |
| No-duplication source | The section bodies live in exactly one place (CLAUDE.md) and are sliced into shadows at migration time; Claude and non-Claude cannot drift. |
| Fleet watchdog bind-failure probe | Automatic. Catches port-collision / server-unreachable agents whose lifelines look healthy to launchd. Escalates via peer agent's `/attention` endpoint after 3 cycles. |
| Conflict-aware Telegram alerts | When the probe identifies the wrong-project case, the escalation summary names both contested parties. |

## Deferred (Tracked Follow-ups)

- The install/wizard portability series is complete — Codex-only
  `instar setup --framework codex-cli` runs end-to-end on this release.
  Follow-up work tracked separately: a full smoke test of a fresh Codex-only
  install on a clean machine, and any narrative-prose tweaks the wizard
  skill should adopt to surface framework-specific paths in user-facing
  output.
- Per-agent "muted" flag for the bind-probe (legitimate maintenance
  windows) is deferred to the v3 Remediator's policy layer.
