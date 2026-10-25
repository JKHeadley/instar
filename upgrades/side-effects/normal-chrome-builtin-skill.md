# Side-Effects Review — Normal-Chrome browser method as a built-in skill

**Version / slug:** `normal-chrome-builtin-skill`
**Date:** `2026-10-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no gate, sentinel, watchdog, messaging, session-lifecycle or trust surface; nine review rounds ran on the spec, see docs/specs/reports/normal-chrome-builtin-skill-convergence.md)

## Summary of the change

Ships the `/normal-chrome-browser` built-in skill (`NORMAL_CHROME_BROWSER_SKILL_CONTENT` in `src/data/builtinSkillContent.ts`, registered in `installBuiltinSkills()` in `src/commands/init.ts`) and three helper scripts (`src/templates/scripts/browser/chrome-launch.sh`, `chrome-js.sh`, `chrome-mainworld.sh`) installed to `.instar/scripts/browser/` by `installBrowserScripts()` from both init paths, `refreshScripts()` and `PostUpdateMigrator.migrateScripts()`. Adds `NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION()` rendered by `generateClaudeMd()`, appended by `migrateClaudeMd()` behind a heading sniff, and listed in the framework-shadow `markers[]`. The scripts drive a normal Chrome per agent-owned profile through pid-addressed macOS Apple Events; they refuse to run off macOS. Nothing runs unless an agent invokes a script.

## Decision-point inventory

- Script input validation (macOS check, profile id rule, agent-home jail, reserved folders, whitespace, missing profile without `--new`, expected origin) — add — deterministic refusals of a tool's own arguments.
- Skill §4: what to do about a control a page withholds — add (instruction) — diagnosis and report only; never synthesize presence signals. A behavioural instruction, not a runtime gate.

---

## 1. Over-block

- A legitimate profile kept outside the agent home (for example a registry profile with a custom absolute `userDataDir` outside the home) is refused. The registry's own jail (D9) already confines supplied paths to the agent home, so this matches the registry.
- An agent home or profile path containing a space is refused (`ERR agent-home-has-spaces` / `bad-profile-path`), because the exact process match needs space-free paths. Agent homes are `~/.instar/agents/<name>`; a username with a space would make the tools unusable on that machine, with a clear message.
- A brand-new profile needs `--new`, and one quit-and-relaunch before scripting works (Chrome ignores the setting on first run).
- Off macOS every script exits 2: this is the honest scope, named in the skill and the spec.

## 2. Under-block

- The safety rules (no faked presence signals, only operator-asked actions, respect site terms) are instructions. `chrome-mainworld.sh` will run whatever code it is given, including a synthetic event. Stated plainly in the spec's decision table.
- The jail guards against mistakes, not a hostile caller with a shell; a symlink swapped between the realpath check and use is exploitable only by something already running as the agent.
- The activity log records what the calling script reports (a caller can set the hash fields); it is a record, not proof. Launches are not logged.
- Main-world output is what the page's own world reports and can be shaped by page code; the skill says to treat it as page-claimed data.

## 3. Level-of-abstraction fit

Right layer. This is an operator-invoked tool plus a procedure, like `load-assess.sh` and `/subscription-signin`. It reuses the existing profile location (`PlaywrightProfileRegistry` auto-allocates `.instar/state/playwright-profiles/<id>`) and its jail rule, and the existing install/refresh paths (`installBuiltinSkills`, `migrateScripts`). It does not add a parallel profile registry.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The scripts' refusals validate their own arguments; they block no message, session, or other agent action. Nothing gates information flow.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The one judgment the skill asks for (why a page withholds a control, and whether to stop) is declared in the spec's `## Decision points touched` as a `judgment-candidate` with a floor (report only; unclear → stop; the operator is the arbiter).

## 5. Interactions

- **Shadowing:** none. The skill is install-if-missing, so an agent's own copy (Echo has one) is kept. The scripts overwrite only the three shipped names in `.instar/scripts/browser/`; other files there (Echo's `claude-*.sh`) are untouched (unit-tested).
- **Double-fire:** none; nothing runs on its own.
- **Races:** `chrome-launch.sh`'s running-check and `open -na` are not atomic; a double launch of one profile opens a second window, which Chrome merges into the running instance. The Preferences write is atomic (temp + rename).
- **Playwright:** a Playwright browser holding the same profile makes `chrome-launch.sh` say "already running" and `chrome-js.sh` say `NO_PID`; the recovery table names this.

## 6. External surfaces

- New files in every agent: one SKILL.md (Claude Code agents), three scripts, one CLAUDE.md section (and its AGENTS.md/GEMINI.md shadow).
- The scripts act on websites as the agent's own signed-in profiles when an agent uses them; that is the capability. Restraint is by instruction (spec item 5).
- macOS may show a one-time "allow Terminal/tmux to control Google Chrome" prompt the first time a script runs on a machine.
- The scripts depend on `/usr/bin/python3` (Apple Command Line Tools) and Chrome's "Allow JavaScript from Apple Events" setting, which Google could retire; failures are loud (`ERR profile-resolve-failed`, `ERR no-result`).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched (no dashboard, approval page or grant/revoke/secret form).

## 7. Multi-machine posture (Cross-Machine Coherence)

- Skill, scripts, CLAUDE.md section: shipped content, identical on every machine through the normal update path.
- Browser profiles and the activity log: machine-local. machine-local-justification: physical-credential-locality — a signed-in Chrome profile is cookies on one disk, already recorded per machine by the profile registry; the skill says never to copy a profile between machines.
- No user-facing notices, no durable topic state, no generated URLs.

## 8. Rollback cost

Revert the release. Installed files are inert; a reverted release stops refreshing them and the next update leaves them in place (harmless). No data migration, no state repair.

## Conclusion

Ship. The capability is deliberately narrower than the original method (no synthetic presence signals; read-only example), the scripts are confined to the agent's own profiles, and the limits (instructions not guards, macOS only, best-effort log) are stated where an agent and the operator will read them.

## Second-pass review (if required)

Not required (see header). The spec went through nine review rounds with an internal multi-angle reviewer and a clean-door reviewer; the last two rounds had no design-class findings.

## Evidence pointers

- Unit: `tests/unit/normal-chrome-browser-skill.test.ts` (23 tests), `tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts` (5), plus the `feature-delivery-completeness` guard entry.
- Integration: `tests/integration/normal-chrome-browser-update.test.ts` (full `migrate()` on an existing agent).
- E2E: `tests/e2e/normal-chrome-browser-init-lifecycle.test.ts` (fresh standalone `init`).
- Live checks on this Mac (throwaway agent homes and profiles): launch and `--new`; refusal of `~/Library/Application Support/Google/Chrome`; origin mismatch exit 3; CSP page `script-src 'none'` → `main-world-script-did-not-run`; trailing `//` comment; page value `"ERR fake"` exit 0; thrown error → `page-js-error`; main-world read of page state beside a page-level `let R`.
