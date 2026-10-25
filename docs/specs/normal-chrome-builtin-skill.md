---
title: "Normal-Chrome browser method as a built-in skill"
slug: "normal-chrome-builtin-skill"
author: "echo"
parent-principle: "Self-Unblock Before Escalating"
eli16-overview: "normal-chrome-builtin-skill.eli16.md"
approved: true
approved-by: "echo (operator directive: Justin, Telegram topic 128220, 2026-10-21 13:46 PDT — 'The method should be added as a fundamental skill or process that any INSTAR agent can leverage.' The converged version is narrower than the request: no synthetic presence signals; read-only worked example. Reported to the operator in the same topic.)"
review-convergence: "2026-10-21T21:45:34.393Z"
review-iterations: 9
review-completed-at: "2026-10-21T21:45:34.393Z"
review-report: "docs/specs/reports/normal-chrome-builtin-skill-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli:gpt-5.5 error in all 9 rounds (CLI not answering on this machine); gemini-not-authed"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Normal-Chrome browser method as a built-in skill

## Glossary

- **Clean-door reviewer:** a second read of the spec by a Claude model through a separate, plain command-line door (not this session), used alongside the internal reviewers.
- **Rule D9:** the Playwright profile registry's rule that a profile folder must resolve inside the agent's home.
- **Migration Parity item 5:** instar's rule that a NEW built-in skill needs no migration, because `installBuiltinSkills()` runs on every update and writes only missing files.
- **Topic 128220:** the Telegram conversation where the operator asked for this.

## Problem statement

On 2026-10-21 Echo used six expiring Claude "Reset for free" offers across six accounts in one pass. Every page refused the first attempts: Playwright/CDP browsers are treated differently by account pages, Apple Events aimed at Chrome by name hit the operator's own Chrome, a wrong Apple Event keyword "succeeded" and returned nil, and the final button stayed disabled for any background window. The method that worked (a normal Chrome per account profile, driven by pid-addressed Apple Events, reading the page's own code to learn why a control refuses) lives only in Echo's agent home as a custom skill plus four shell scripts.

The operator asked (Telegram topic 128220, 2026-10-21 13:46 PDT): "The method should be added as a fundamental skill or process that any INSTAR agent can leverage." Today no other agent has it, so every agent would re-learn the same failures, or tell its operator "the browser can't do that".

## Proposed design

Ship the method the way instar ships its other procedures: a built-in skill plus framework-neutral helper scripts, and an awareness section in the CLAUDE.md template.

1. **Skill content.** `NORMAL_CHROME_BROWSER_SKILL_CONTENT` in `src/data/builtinSkillContent.ts` (the single source both scaffold and migrator read), registered as `normal-chrome-browser` in `installBuiltinSkills()` (`src/commands/init.ts`). It is the generic form of Echo's skill: find accounts/profiles yourself; normal browser only; read before acting; read the page's reason when a control is disabled; verify by reloading; timing; scheduling an unattended action; keeping the operator informed; a recovery table; and a read-only worked example (reading each account's usage page), marked as tied to one page that will change. Per Migration Parity item 5, adding a new skill needs no migration: `installBuiltinSkills()` runs on every update (`PostUpdateMigrator.migrateBuiltinSkills`, `refreshHooksAndSettings`) and writes only missing SKILL.md files, so an agent that already wrote its own copy (Echo) keeps it.

2. **Helper scripts.** Three templates in `src/templates/scripts/browser/`: `chrome-launch.sh`, `chrome-js.sh`, `chrome-mainworld.sh`. They are installed to `.instar/scripts/browser/` by one exported function `installBrowserScripts(projectDir)` in `init.ts`, called from both `init` paths, from `refreshScripts()`, and from `PostUpdateMigrator.migrateScripts()`. Built-in scripts are always overwritten (like `secret-get.mjs`, `load-assess.sh`), so a fix reaches every agent on its next update. They are framework-neutral (`.instar/scripts/`). Built-in skills install only for Claude Code agents, so the CLAUDE.md section (shadowed into AGENTS.md/GEMINI.md) itself carries the safety rules and the profile rules; a Codex agent on macOS gets the scripts and those rules, without the long-form skill. Paths are relative: a profile id resolves to `<agent home>/.instar/state/playwright-profiles/<id>`, which is where `PlaywrightProfileRegistry` auto-allocates profiles; an absolute user-data-dir inside the agent home is also accepted (see item 6). Ids must match the registry's rule (`^[a-z0-9-]{1,64}$`); see items 6 and 6b for the full path rules. No machine-specific path appears anywhere.

   Generalizing the scripts fixed three defects found while testing on a throwaway profile:
   - The running-check used `awk -v k=...`, so awk matched its own argv and every launch reported "already running". The key now goes through the environment.
   - A plain substring match on `--user-data-dir=<dir>` also matched `<dir>-2`. Matching now requires the exact value followed by a space or end of line.
   - A brand-new profile ignores the Apple Events setting on its first run. The launcher now creates `Default/Preferences` if missing and prints a one-line note to quit and relaunch once.
   - (Review round 1) `chrome-mainworld.sh` returned its result through a fixed `document.body.dataset.mw` key that was never cleared, so a call whose script never ran (a page whose Content-Security-Policy forbids inline scripts, or a syntax error) silently returned the previous call's result. Each call now uses a fresh random key, deletes it after reading, and prints `ERR main-world-script-did-not-run (...)` when nothing was written. Verified live against a local page serving `script-src 'none'`.

   Neither `claude-use-reset.sh` nor `claude-reset-amrch-oct22-run.sh` ships (item 5).

3. **Platform honesty.** The method needs macOS Apple Events. Instar runs on macOS and Linux. Every script starts with a `uname -s` check and exits `2` with `ERR macos-only: ...` on any other system; the skill's first section says so and points Linux agents at the Playwright profile registry for non-auth pages. No Linux driver is built in this change; a Linux equivalent (normal Chrome driven without CDP, e.g. via an extension or xdotool) is recorded as evolution action ACT-138.

4. **Agent awareness.** `NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION()` in `PostUpdateMigrator.ts` (heading `### Normal-Chrome browser (account-bound web tasks, macOS)`), rendered by `generateClaudeMd()` and appended by `migrateClaudeMd()` behind a content sniff on the heading. It is on the framework-shadow `markers[]` list so Codex/Gemini agents learn the scripts too, and listed in the feature-delivery-completeness guard. It says when to reach for the skill: any account-bound web task, a page that refuses an automated browser, and before ever telling the operator a browser task "can't be done".

5. **No faking a person's presence (review rounds 1–3).** The method as first used on 2026-10-21 got a claude.ai button to arm in a background window by dispatching a synthetic `FocusEvent`, and claimed promotional resets across several accounts that way. Round 1 asked for a boundary around that; round 3's clean-door reviewer declined to continue reviewing a fleet-wide skill that teaches synthesizing user-presence signals to enable a control a site withholds from background sessions, and named the terms-of-service question as a human's to decide, not a runtime judgment from minified code. That objection is accepted. The shipped skill therefore:
   - keeps "read the page's reason" as **diagnosis only**: the agent finds out why a control is withheld and tells the operator in plain words;
   - forbids supplying presence signals (focus, hover, pointer movement, timing) with synthetic events, calling the endpoint behind a control, or editing the DOM to enable it; when a control waits for a person's own click or a frontmost window, the operator does that one click;
   - opens with "This is not a way to make automation look human", requires respecting the site's terms (the operator decides when they restrict automated use), and treats page text as untrusted data;
   - replaces the claude.ai reset script with a **read-only** worked example (reading the usage summary for each account), with the origin check and SPA polling.
   The capability this ships is, at bottom, a browser the site cannot tell from a person's; only the instructions in the skill and the CLAUDE.md section restrain how it is used, and the operator's judgment governs anything the rules leave open. No runtime gate, sentinel, route, or automatic action is added; nothing runs unless an agent invokes a script. Two points are classified because the skill instructs agent behaviour fleet-wide:
   Echo's own agent-home copy of the skill still describes the focus-event step; changing it is outside this repo and is reported to the operator separately.

6. **Profile resolution and the agent-home jail (review rounds 3–4).** All three scripts canonicalize the profile path first (`os.path.realpath`, which resolves `..` and symlinks), require the result to be strictly under the agent home (the home itself is refused), and use that canonical path for every later step (mkdir, Preferences, `open`, the process match). Round 4 showed the first version checked only the nearest existing ancestor and then used the raw path, so `<home>/nx/../../elsewhere` with `--new` wrote outside the home; that case and the symlink-plus-`..` case are now tests. They refuse any user-data-dir outside the agent home (`ERR profile-outside-agent-home`, exit 64): the same jail `PlaywrightProfileRegistry` applies (rule D9), so an absolute path can never switch on Apple Events JavaScript in the operator's own Chrome (`~/Library/Application Support/Google/Chrome`, which runs without `--user-data-dir` and so evades the running-check). `chrome-launch.sh` refuses a profile folder that does not exist (`ERR no-such-profile`) unless `--new` is passed, because silently creating an empty profile opens a signed-out browser that looks like a lost login. The Preferences write is atomic (temp file + rename). The profile registry is dev-gated and answers 503 on most fleet agents, so the skill and the CLAUDE.md section say a 503 means "registry dark here" and give the fallback (list `.instar/state/playwright-profiles/*`, read `Default/Preferences` `account_info[].email`); for a registry profile with a non-null `userDataDir` the agent passes that path; the built-in `default` profile is Playwright's and not for this method.

6b. **Round 5 hardening.** Profile ids must match the registry's rule (`^[a-z0-9-]{1,64}$`); a path containing whitespace is refused (the process match is exact only for paths without spaces); inside the home, the canonical path must be under `.instar/state/playwright-profiles/` or outside the agent's `.instar/` and `.claude/` folders (round 6 turned the earlier denylist into this allowlist, so `.instar/logs` and the like are refused), anything under the operator's `~/Library/Application Support/Google/Chrome/` is always refused (in case an agent home were ever `~`), and the whitespace check runs again on the resolved path (a symlink without spaces could point at a folder with them). The jail is stated honestly as protection against mistakes, not against a hostile caller with a shell, and the remaining check-then-use window (a symlink swapped between the realpath check and `mkdir`/`open`) is exploitable only by something already running as the agent. `chrome-js.sh` now exits nonzero on every `ERR` result (map: 0 ok, 1 `NO_PID`/`ERR`, 2 not macOS, 3 wrong origin, 64 bad input) so unattended scripts can rely on the exit code, and appends one best-effort, content-free activity line, written just before each call is sent to Chrome, to `.instar/logs/normal-chrome-browser.jsonl` (time, profile path relative to the agent home, expected origin, script name, SHA-256 and byte length of the CALLER's code; never the code's text, the page content or the result). `chrome-mainworld.sh` passes the hash of its caller's code rather than of its randomized wrapper (round 6), so identical calls log identical hashes and the operator can match a line to the code the agent kept. A failed write warns on stderr and does not stop the call; the line records what the calling script reports (so it is a record that makes reports checkable, not proof of what ran, and not an enforcement point), it is written after the code is wrapped and just before the Apple Event is sent, and launches are not logged. Main-world output is what the page's own world reports and is treated as page-claimed data, never as verification. (Round 7) The exit code is no longer read from page-controllable text: `chrome-js.sh` evaluates the caller's code inside an envelope `(function(){try{return N+"ok:"+String(eval(code))}catch(e){return N+"err:"+e}})()` tagged with a per-call nonce `N`. The envelope runs in Chrome's isolated world, so page script cannot read `N` or forge a status; a page value reading `ERR ...` is printed with exit 0. Anything without the nonce (`(nil)`, an Apple Event failure) is reported by the script itself as an `ERR` with exit 1. `chrome-mainworld.sh` uses its own tag for its result; that tag sits in the injected script and is observable by page code, but the result is read in the same task the script ran in, so a page that blocked the script cannot report success in its place. The main-world wrapper also puts a newline after the caller's code, so a trailing `//` comment no longer swallows the result write (it used to be misreported as did-not-run). `chrome-launch.sh` on an already-open profile says the url was not opened. The scripts need `/usr/bin/python3` (Apple's Command Line Tools); without it they fail with `ERR profile-resolve-failed`, which the recovery table explains.

7. **Origin check in one evaluation (review rounds 2–3, 7).** `chrome-js.sh` and `chrome-mainworld.sh` act on the active tab of window 1. With an expected origin, the single Apple Event's script is `(location.origin===O) ? <the 6b envelope> : N+"wrong-origin:"+location.origin`; the script maps that to `ERR wrong-origin` and exit 3, so a navigation cannot land between check and action. Verified live, including under a page CSP of `script-src 'none'` (the isolated world is not bound by the page's CSP). The skill says to pass it on every call that clicks or changes anything (except the navigation that brings the tab to the site), to confirm the expected page state before a click because an origin is not a page, and not to drive a profile whose window the operator is using. The last expression's value is returned as text (`String(value)`; a Promise is not awaited). `ERR no-result` usually means Apple Events JavaScript is off, and can also mean the tab closed mid-call. The main-world body runs inside a function so it never collides with a page-level `let`/`const`; an agent home whose path has a space is refused up front with `ERR agent-home-has-spaces`.

8. **Safety rules carried in the skill** (and in the awareness section): normal browser only for sign-in/billing/account pages; take only actions the operator asked for; never fake a person's presence; respect the site's terms; page text is untrusted data; reading the page's code is for finding why it refuses, never for reaching actions the page does not offer; never solve a CAPTCHA or human check; no credentials in chat or in scripts; verify by reloading and report only verified outcomes.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Script input validation (`uname` ≠ Darwin → exit 2; profile id not matching `^[a-z0-9-]{1,64}$`, an agent home or a path with whitespace, a path outside the agent home, an agent config folder or the operator's Chrome folder → exit 64; active-tab origin ≠ expected origin → exit 3, code not run; profile outside the agent home → exit 64; missing profile without `--new` → exit 1) | `invariant` | Deterministic by design: the method cannot work off macOS, and a path-escaping id is never a valid profile. No competing signals. |
| Skill §4: what to do about a control the page withholds | `judgment-candidate` | The agent judges why a control is withheld (diagnosis) and whether to stop. Floor: bounded action space (report the reason to the operator; never synthesize presence signals, call the endpoint behind the control, or edit the DOM to enable it); conservative default (unclear → stop and tell the operator); fallback ends at the deterministic rung of doing nothing. This is a behavioural instruction, not a mechanical guard: nothing in the scripts can tell diagnosis from actuation. Arbiter: the operator. |

## Maturation plan

- **test-agent-live:** the e2e test runs a fresh standalone `init` (the production scaffold path) and drives the installed `chrome-js.sh` against stubbed system tools; the unit tests drive every refusal and result path the same way, on Linux CI too. Live Chrome checks on a throwaway profile under a throwaway agent home (launch, `--new`, jail refusals, origin check, the envelope, main-world reads, a `script-src 'none'` page) were run during the build.
- **dev-agent-live:** live on this agent from the release that carries it (the scripts are refreshed on update; Echo's own SKILL.md copy is kept, being install-if-missing). For one week, read `.instar/logs/normal-chrome-browser.jsonl` after any browser task the operator asks for.
- **fleet:** the same release, ungated: the skill and scripts do nothing until an agent invokes them, and they refuse to run off macOS.
- **graduation criterion:** within 14 days of the release, at least one operator-requested browser task on this agent completes through the shipped scripts, with matching lines in the activity log and an outcome verified by reloading, and no `profile-outside-agent-home` or `profile-reserved-folder` refusal of a path the agent meant to use. A zero count is not a pass.
- **dark-window:** none; the feature is live on release. If the criterion is not met in 14 days, the reason and a new date are recorded in topic 128220.

## Multi-machine posture

- Skill and CLAUDE.md section: shipped content, identical on every machine via the normal update path (no state).
- Scripts: shipped content, identical on every machine.
- The browser profiles they drive: machine-local. machine-local-justification: physical-credential-locality — a signed-in Chrome profile is cookies on one disk; the existing Playwright profile registry already records it per machine, and the skill says never to copy a profile between machines.

## Alternatives considered

- **A Chrome extension + native-messaging bridge** would be CSP-proof, independent of Chrome's "Allow JavaScript from Apple Events" setting (which Google could retire), and would also work on Linux. It needs an extension installed per profile and a native host registered per machine, which is a real install and update surface. The Apple Events method needs nothing installed and is proven today, so it ships now; the extension path is the natural shape for a Linux driver (ACT-138), and if Chrome drops the Apple Events setting the scripts fail loudly (`(nil)` / `ERR apple-event-failed`, both in the recovery table) rather than silently.
- **JXA `Application(pid)` + `execute({javascript})`:** JXA's `Application()` takes a name, bundle id or path, not a process id, so with several Chrome profiles open it cannot address one profile's process; that is why the event is built by hand from a pid-addressed descriptor. The hand-built event is the part with the sharpest edge (a wrong keyword returned nil), so it is pinned by the live checks and the recovery table.
- **Playwright/CDP with stealth settings:** rejected. The point is a browser the site treats as a person's, and the standing rule is that sign-in and account pages never run in an automated browser.

## Side effects and rollback

- Existing agents gain one SKILL.md (only if absent), three scripts under `.instar/scripts/browser/` (overwritten each update), and one CLAUDE.md section. Echo's own `chrome-*.sh` copies are replaced by the shipped versions (same behaviour plus the fixes above); its `claude-*.sh` files are untouched.
- Rollback: revert the release. The installed files are inert (nothing invokes them automatically); a reverted release simply stops refreshing them.

## Tests

- Unit: the result envelope: a page value reading `ERR wrong-origin:` exits 0, a thrown exception exits 1 as `page-js-error`, `(nil)` exits 1 as `no-result`, and a reply without this call's nonce exits 1; the main-world wrapper's trailing-comment newline and tagged did-not-run fallback; reserved folders (`.instar`, `.instar/logs`, `.claude/...`); the audit line's relative profile path, script name and stable caller hash for main-world calls; nonzero exit on an `ERR`.
- Unit: profiles outside the agent home are refused by all three scripts; a missing profile is refused without `--new` and nothing is created; the origin guard is one evaluation and exits 3 on mismatch.
- Unit: the main-world wrapper uses a fresh result key per call and carries the did-not-run fallback; `chrome-js.sh` picks the exact profile's main process (not `<dir>-2`, not a `--type=` helper) with stubbed `ps`/`osascript`; `chrome-launch.sh` writes the Apple Events preference (keeping existing Preferences), notes the first-run relaunch, opens through `open -na` with no debugging port, and reports "already running" for an open profile.
- Unit: the skill installs with valid frontmatter and carries the safety rules (including no synthetic presence signals and untrusted page text) and the macOS-only statement, and contains no `FocusEvent` step; never overwrites an existing copy; `installBrowserScripts` writes all three scripts executable under `.instar/scripts/browser/`, overwrites stale copies, and the shipped scripts contain no absolute home path; the scripts exit 2 with `ERR macos-only` when `uname` reports Linux (stubbed `uname` on PATH); `chrome-js.sh` refuses a path-escaping id; the CLAUDE.md section is in `generateClaudeMd()` and appended idempotently by `migrateClaudeMd()`.
- Integration: `PostUpdateMigrator.migrate()` on an existing agent home installs the skill and the scripts.
- E2E: a fresh `init` (production scaffold path) produces the skill and the three scripts.

## Frontloaded Decisions

- **Script location:** `.instar/scripts/browser/` (framework-neutral, beside the other built-in helpers), not inside the skill directory, so a Codex agent can use them too.
- **Overwrite policy:** built-in scripts are always overwritten on update (the Migration Parity rule for built-ins); the SKILL.md is install-if-missing (the rule for new skills), so an agent's own edited copy is kept.
- **Shipped vs example:** the three generic tools ship; the worked example is a read-only usage read; neither the claude.ai reset script nor the one-account dated script ships, in any form (item 5).
- **Linux:** scripts refuse with a clear message; no Linux driver is built in this change.

## Open questions

*(none)*
