## What Changed

- **A new built-in skill, `/normal-chrome-browser`, plus three small helper tools.** Some web tasks have to be done as one of your own signed-in accounts, and account pages (sign-in, billing, settings, usage) often refuse or behave differently for an automated browser. The skill is a proven way to do those tasks in a normal Chrome window per account profile, controlled with the Mac's own scripting. The tools are installed for every agent in `.instar/scripts/browser/` and refreshed on each update: one opens a normal Chrome for a profile, one runs JavaScript in its tab, and one reads the page's own state (for example, to find out why a button stays disabled).
- **It only works on Macs.** On Linux the tools stop with a clear "macOS only" message, and the skill says so.
- **It is deliberately careful.** Your agent only takes actions you asked for. It never pretends a person is present to make a page enable something; it tells you what the page needs instead. When a site's terms restrict automated use, it asks you. The tools only work with browser profiles inside your agent's own folder, so they can never reach your personal Chrome. Every call leaves a short record in `.instar/logs/normal-chrome-browser.jsonl`, with no page content in it.
- **Your agent's instructions now say when to use it.** They name any task that needs a signed-in account, a page that refuses the automated browser, and the point before your agent would tell you a browser task "can't be done".

## What to Tell Your User

Your agent can now do web tasks in a normal Chrome window as one of its signed-in accounts, on a Mac. This is for things like reading a usage page or changing an account setting that an automated browser gets blocked on. It only does what you ask. If a page needs a person's own click, it tells you rather than faking one. It never touches your personal Chrome. The first time, your Mac may ask you to allow the terminal to control Google Chrome; that is the one approval it needs.

## Evidence

- Built and checked live on a Mac with throwaway agent homes and profiles. Checked: launch; the guard against profiles outside the agent folder (including the operator's own Chrome folder); the wrong-page check; a page whose security policy blocks injected scripts (now reported honestly instead of returning an old result); a trailing comment in the code; a page value that reads like an error; a thrown error; reading page state.
- Tests: `tests/unit/normal-chrome-browser-skill.test.ts`, `tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts`, `tests/integration/normal-chrome-browser-update.test.ts` (an existing agent gets the skill, tools and instructions on update; an edited skill copy is kept; stale tools are refreshed), and `tests/e2e/normal-chrome-browser-init-lifecycle.test.ts` (a fresh install gets all three).
- Spec: `docs/specs/normal-chrome-builtin-skill.md`, converged over nine review rounds (report in `docs/specs/reports/`).

## Summary of New Capabilities

- `/normal-chrome-browser` skill: account-bound web tasks in a normal Chrome on macOS, with the operator deciding anything a site's rules stand in the way of.
- `.instar/scripts/browser/chrome-launch.sh`, `chrome-js.sh`, `chrome-mainworld.sh`: launch a profile, run JavaScript in its tab (with an optional expected-origin check), and read page state; agent-home-confined, with clear exit codes and a content-free activity log.
