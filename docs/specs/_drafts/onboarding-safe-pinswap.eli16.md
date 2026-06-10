# ELI16 — Stop account-swapped sessions from wedging on the "first launch" screens

## The plain-English version

The agent can run on a pool of Claude accounts. When one account runs out of weekly quota, the agent moves a session onto another account ("swap"), and new sessions get launched on whichever account has the most room ("pinning"). On 2026-06-09 that machinery moved ~8 live sessions at once — and every one of them froze on Claude Code's *first-launch welcome screens*, spamming browser sign-in tabs until the operator logged in by hand.

## Why it happened

Each pool account lives in its own little config folder. Those folders were created by a *headless* login command (`claude auth login`), which stores the OAuth sign-in tokens — and nothing else. But when Claude Code starts *interactively* (a real terminal session, the kind the agent uses to talk to you), it also checks three little "the human already said yes" switches in that folder's `.claude.json`: *finished onboarding?*, *accepted bypass-permissions mode?*, *accepted the trust dialog?*. The headless login never flips those switches. So the relaunched session had perfectly valid credentials and STILL got marched through the welcome wizard — which no one was there to click through. The tokens were never the problem; three missing booleans were.

## What this change does

One small, careful utility — `ensureInteractiveReady(configHome)` — flips exactly those three switches in a config folder's `.claude.json`, and nothing else. It is:

- **Surgical.** It parses the existing file, sets the three flags, and writes everything else back untouched. It never reads, writes, or even looks at `oauthAccount` or any token field.
- **Paranoid about corruption.** If the file can't be parsed, it REFUSES to rewrite it (a broken-looking file might still hold recoverable credentials) and just reports why. Writes are atomic (temp file + rename), so a crash can't leave a half-written file.
- **Fail-safe.** It never throws into a launch. Worst case, you get the old behavior — never a dead spawn path.
- **Idempotent and cheap.** Calling it twice does nothing the second time, so we call it *everywhere it matters* without worrying.

Then we call it at every door a session can walk through into a pool account's folder:

1. **At enrollment** — the moment a new account finishes logging in, its folder is made interactive-ready, so the problem can't exist for new accounts.
2. **At every pinned launch** — both the headless and interactive launch lanes in SessionManager seed the flags right before setting `CLAUDE_CONFIG_DIR`.
3. **At every swap** — SessionRefresh seeds the target folder *before* killing and respawning the session, and the interactive respawn lane seeds it again (belt and braces).
4. **One migration sweep** — existing agents have pool folders enrolled *before* this fix; a PostUpdateMigrator pass seeds every claude-code account's existing folder once on update. Stale registry entries pointing at deleted folders are skipped, never created.

## Why it's safe

The flags are local "the human already accepted this" acknowledgements, not credentials — and on this machine the operator already accepted them manually during the incident recovery, which is exactly the state this code reproduces. Only claude-code accounts are touched (codex/gemini homes are skipped by construction). And every write path either succeeds, or reports a reason and gets out of the way.
