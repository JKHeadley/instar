# Side-Effects Review — first-run screens, Linux setup gaps, Telegram bot limit, server sign-in token

**Version / slug:** `install-first-run-and-linux`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent; concern raised, four fixes made, then concurred (see the end of this file)`

## Summary of the change

Fixes four of the getting-started failures found on the first agent created on a fresh Linux cloud server (Cirrus, Hetzner, Ubuntu 24.04, 2026-11-02), recorded in the shared ledger as items A, B, D and E. Driven by `docs/specs/install-experience.md`.

- **A. Claude Code first-run screens.** `ensureInteractiveReady` now also answers the project MCP picker (`projects[dir].enableAllProjectMcpServers`). New `ensureBypassPromptSkipped` writes `skipDangerousModePermissionPrompt: true` to the login's `settings.json`. New `ensureClaudeFirstRunAnswered(configHome|null, projectDir)` does both, placing files correctly for the default login (`~/.claude.json` + `~/.claude/settings.json`) and for a `CLAUDE_CONFIG_DIR` login (both inside it). Called by `instar init` (installClaudeSettings), by every pinned launch (existing call site, now the combined helper), by account swaps (SessionRefresh adds the settings.json answer), and once per process for the default login on an unpinned interactive launch (new; skipped for confined spawns and under vitest).
- **D. Linux gaps.** The installer's tools step installs the sqlite3 command on Linux when missing, as its own command that may fail (named `sqlite` on dnf/yum), never bundled with tmux. A new optional step grants Tailscale operator rights (`sudo tailscale set --operator=<user>`) when `tailscale debug prefs` shows they're missing. The old-Node refusal names the exact Node 22 install on Linux. The 562.5k CLAUDE.md is not fixed here: it is the template's size, affects every agent, and needs its own spec; it was spun off to its own topic and session (issue topic 10000001426).
- **E. Telegram 20-bot limit.** Manual token prompts (Codex and Gemini drivers) accept `skip` and say why. The Codex browser setup records a bot-limit refusal in `.instar/state/telegram-setup-outcome.json`, and the dispatch then finishes app-only instead of falling into a manual setup that would hit the same limit. The Claude setup skill has the same instruction.
- **B. Server sign-in.** On an interactive install with no browser and Claude signed out, the installer asks for a `claude setup-token` token (hidden input, shape-checked), holds it in memory (never in the progress file), asks again at agent creation if a resume lost it, and writes it to `sessions.credentials.anthropic` = `{kind:"oauth-token"}` when the agent is created. Read by sessions since 1.3.1615 (fb-7cb86d4b-1fd). The legacy field is never written.

## Decision-point inventory

- Whether a config home needs first-run answers — modify — a missing key reads as needed; an unparseable file is never rewritten.
- Default-login seeding — add — once per process, unpinned interactive claude launches only.
- Which tool packages to install — modify — tmux required, sqlite3 optional on Linux.
- Whether to grant Tailscale operator rights — add — only when Tailscale is readable and names another operator; unreadable means leave it alone.
- Whether a pasted value is a Claude token — add — shape only.
- Whether Telegram setup ends app-only — add — the word `skip`, or a recorded bot-limit outcome.

## 1. Over-block

Nothing new refuses. The sqlite3 and Tailscale steps never fail an install. A pasted value that doesn't look like a token is asked again (three tries), then the normal sign-in runs. A genuinely valid token with an unexpected shape would be refused at the prompt; the person can still sign in normally.

## 2. Under-block

`enableAllProjectMcpServers` enables every server in the agent's own `.mcp.json`. Instar writes that file, but a person could add a server there and it would load without a prompt; that is the existing behaviour of every agent that already answered this dialog once. Shape-only token checking means a revoked token is accepted at install and fails at the first session, where the existing expired-login handling reports it. `skipDangerousModePermissionPrompt` is a per-login setting. On the default login it is the person's own `~/.claude/settings.json`, so it also turns off the bypass-permissions warning for their own Claude Code use on that machine. It only removes a warning screen; it grants no permission, and agents already launch in that mode. `enableAllProjectMcpServers` is written only on the agent directory's own project entry, so it can override a server the person declined in the agent's `.mcp.json`, never in their other projects. Both match what the operator clicked through by hand on every machine so far.

## 3. Level-of-abstraction fit

The first-run answers extend the existing helper that pool logins already use, so one place owns "this login is ready for an interactive session". The installer steps stay in the installer; the bot-limit text lives in one shared module for both drivers.

## 4. Signal vs authority compliance

No message is gated. The changes only write local settings that answer screens Claude Code would otherwise show.

## 4b. Judgment-point check

The default-login seed fires on launch without asking; the floor is "write only these keys, never rewrite an unparseable file". Matches how pool logins have been treated since 2026-06-09.

## 5. Interactions

- `SessionManager`: the pinned-launch helper now also writes `settings.json` in the pool home. The new default-login call runs before the existing launch, once per process, and never throws.
- `ensureInteractiveReady`: homes that had folder trust but not the MCP answer are now patched once (one extra write per pool home, at the next launch or migration sweep).
- `PostUpdateMigrator` already sweeps pool homes with `ensureInteractiveReady`, so existing pool homes gain the MCP answer on update. The default login is covered at the next session launch, so no new migration is needed (Migration Parity).
- State machine: a new step `do-tailscale-operator` sits between tools and AI install. An install paused after tools resumes there; one paused later is unaffected.

## 6. External surfaces

Runs `sudo apt-get/dnf/yum install sqlite3` and `sudo tailscale set --operator` only inside the installer, after the person's single consent (interactive) or when sudo needs no password. Reads `tailscale debug prefs`. No network calls added.

## 6b. Operator-surface quality

Every new message is plain and says what to do next. Nobody chooses a config field.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local-justification: physical-credential-locality. First-run answers and the sign-in token belong to this machine's Claude login and this agent's config.

## 8. Rollback cost

Revert the commit. Keys already written stay in the settings files; they are harmless answers to screens and match what an operator would have clicked.

## Conclusion

Safe to ship. Unit tests cover both sides of each new decision; the installer integration test passes.

## Evidence pointers

- `tests/unit/claude-first-run-answered.test.ts` (6), `tests/unit/telegram-bot-limit.test.ts` (4), new cases in `tests/unit/install-flow.test.ts` (Node 22 line, sqlite3 package list, Tailscale operator, token prompt and fallback, token write, token wiring through agent-init).
- `tests/unit/ensure-interactive-ready.test.ts`, `interactive-session-pin.test.ts`, `PostUpdateMigrator-subscriptionPoolInteractiveReady.test.ts` pass unchanged.
- `OperatorUser` field name checked on Cirrus (`tailscale debug prefs` → `"OperatorUser": "instar"`).
- Not tested live: a fresh Linux install end to end. That is the next check on a new VM.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `n/a`
- reason: one-time settings writes and one-shot installer steps, not a self-triggered loop.

## Second-pass review

Independent subagent, 2026-11-03, read the code and this file. **Concern raised**, four findings, all fixed with tests:

1. sqlite3 bundled into the same dnf/yum command as tmux; Fedora/RHEL call it `sqlite`, so tmux would fail too. Fixed: its own optional command, package name per manager.
2. The Codex prompt created the outcome folder with a relative path. Fixed: absolute path.
3. A resume between sign-in and agent creation lost the in-memory token, leaving the agent unsigned. Fixed: agent creation asks again on a no-browser computer that is still signed out (tested).
4. The default-login seed changes the person's own Claude Code settings and ran for confined spawns. Fixed: skipped for confined spawns; the effect on the person's settings is stated in section 2.

The fixes were re-run against the targeted tests (51) and the 47 related unit test files. The same reviewer then re-read all four fixes and the SessionRefresh change: **Concur with the review.** It noted one accepted cost: a person who pressed Enter at the sign-in step and is still signed out is asked for a token once more at agent creation.
