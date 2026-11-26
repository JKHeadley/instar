# Side-Effects Review — Normal-Chrome browser skill: one method for macOS and Windows

**Version / slug:** `normal-chrome-cross-platform`
**Date:** `2026-10-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no gate, sentinel, watchdog, messaging, session-lifecycle or trust surface is added; the change ships operator-invoked helper scripts, skill text, a CLAUDE.md card and their migrations; the spec went through eight convergence rounds with codex, a clean-door Claude read and three internal reviewers, see docs/specs/reports/normal-chrome-cross-platform-convergence.md)

## Summary of the change

Consolidates the macOS normal-Chrome method (PR 2283) and PP's Windows driver into ONE built-in skill (`NORMAL_CHROME_BROWSER_SKILL_CONTENT`, composed from `NORMAL_CHROME_BROWSER_SHARED_RULES` and `NORMAL_CHROME_BROWSER_WINDOWS_SECTION` in `src/data/builtinSkillContent.ts`), ships `native-drive.ps1` (byte-identical to the live-tested v5) and its wrapper `ndrive.sh` beside the three macOS scripts (`BROWSER_SCRIPT_NAMES` in `src/commands/init.ts`, same `installBrowserScripts()` path), hardens `chrome-launch.sh` (url-scheme rule, `open -g`), adds `PostUpdateMigrator.migrateNormalChromeBrowserSkill` (hash-gated whole-file replace of a first-shipped skill copy; appendix + `SKILL.shipped.md` for an edited copy), renames the CLAUDE.md card to `### Normal-Chrome browser (account-bound web tasks, macOS + Windows)` with an in-place replacement of the exact shipped v1 section (`replaceOrAppendMarkdownSection`, `findExactMarkdownSection`, `markdownSectionBounds`) in CLAUDE.md and the framework shadows, widens `scripts/lint-blocking-decisions-declared.mjs` to `.ps1`, and declares the five scripts in `scripts/blocking-decision-surfaces-baseline.json`. The wrapper carries every Instar-side rule on Windows: platform check, argument hygiene, profile jail, url rule, chrome.exe rule, focus-override gate on a recorded operator declaration, per-agent binding file, `WSLENV` append, `canfocus` before `invoke`, the interactive-desktop bridge (Task Scheduler `-LogonType Interactive` from a session-0 WSL shell), and a content-free activity line per call.

## Decision-point inventory

- Script input validation (macOS, unchanged + the url rule) — add/modify — deterministic refusals of a tool's own arguments.
- `ndrive.sh` platform check, argument hygiene, profile jail, url rule, chrome.exe rule — add — deterministic refusals (exit 64 / 2) before PowerShell runs.
- `ndrive.sh` focus-override gate — add — honors `ND_ALLOW_FOCUS_STEAL` / a low `ND_OPERATOR_IDLE_MS` only against a `normalChromeBrowser.unattendedMachine = {declaredBy, topicId, at}` record; drops and logs otherwise.
- `ndrive.sh` session routing (bridge / direct / `ND_BRIDGE=off` refusal; `ERR session-unknown` for an unreadable id; `ND_BRIDGE=direct` refused in a measured session 0) — add — deterministic on the PowerShell session id, retried once when empty.
- `ndrive.sh` platform check (`ERR windows-only`, `ERR wsl-only`) and `%LOCALAPPDATA%` probe (`ERR state-unavailable`) — add — deterministic on what the shell can reach.
- `ndrive.sh` per-agent lock (`ERR busy`; `mkdir` + remove-dead-owner's-file + `rmdir`, no rename; pid-less reclaim after the wait), orphan guard on both routes (a still-running bridged task or a driver written down as a survivor is waited for then `ERR busy`; an enumeration that answers nothing is `ERR state-unavailable`) and stale sweep (folders older than 1200 s, non-running tasks, `swept` logged) — add — deterministic on pid liveness, start-time identity, directory age and task state.
- `ndrive.sh` url credential rule (`ERR secret-shaped-url`), outfile rule (`ERR bad-outfile`), expected-host check (`ND_EXPECT_HOST` → `ERR expected-host-mismatch`) and unknown-outcome latch (`ERR unknown-outcome-unchecked`) — add — deterministic on the argument text, the omnibox host at a boundary, and a per-agent latch file.
- `ndrive.sh` `canfocus` before `invoke` — add — refuses when the operator is active; a wrapper-own failure of that check is `ERR canfocus-failed`, never "operator active".
- `ndrive.sh` exit-code relay (`ERR driver-crash` for a code outside 0-255, bridge route; the direct route's 8-bit truncation is stated) and timeout verdicts (pid identity by name AND recorded start time before `Stop-Process`; seven worded outcomes; a possible survivor written down, by the wrapper and by the exit trap when a signal interrupts a call, and adopted from a leftover folder's verdict by the next call) — add — deterministic on the relay files.
- `native-drive.ps1` binding, foreground gate, operator-active rule, flag allowlist — pass-through (shipped as-is).
- Skill §3 (a control the page withholds) — modify (instruction) — the Windows forward-window decision is explicit; a `judgment-candidate` with its floor in the spec.
- `migrateNormalChromeBrowserSkill`, `replaceOrAppendMarkdownSection`, the shadow strip — add — deterministic on hash / exact-text equality.

---

## 1. Over-block

- A Windows profile on a network or `\\wsl.localhost` share, a relative or WSL path, a path with `..`, `~`, a quote or a control character is refused (`ERR bad-profile-path`); profiles must be local drive-letter paths. The driver has only been run against local paths, so this matches the tested surface.
- The operator's DEFAULT Chrome profile folders (Chrome, Beta, Dev, SxS) are refused even if the operator wanted the agent in them; the skill says automation gets its own profile.
- A `launch`/`nav` url without a scheme, or with whitespace or a quote, is refused; `chrome:`/`file:` without `//` are refused (the five exact prefixes). A chrome.exe path that is not `...\chrome.exe` is refused (no `chrome.cmd` wrappers).
- `ND_ALLOW_FOCUS_STEAL` is dropped on a genuinely unattended machine until the operator's declaration is recorded in the declared shape; a bare `true` is not accepted. Without node the machine is treated as attended.
- On macOS a url argument without a scheme (`example.com`) is refused; the skill says to pass `https://`.
- A CLAUDE.md v1 section that an agent edited is never replaced; the new card is added beside it (two Normal-Chrome sections until the agent reconciles). A `####`-demoted copy is not recognized as the section.
- `invoke` refuses when `canfocus` says the operator is active, even for an element that would not open a window.
- Off macOS the three macOS scripts exit 2; off Windows `ndrive.sh` exits 2: the honest scope.

---

## 2. Under-block

- Every Windows-side rule lives in the wrapper; the driver accepts any directory, url and executable. A caller who edits the wrapper, calls the `.ps1` directly, or sets `ND_SCRIPT` to another file is outside the rules. The skill says so; this is a mistake-guard, not a boundary (the same posture as the macOS jail).
- An operator Chrome running with a custom `--user-data-dir` is attachable (only the default profile folders are refused). The same-profile case (the operator using the bound window) bypasses the driver's operator-active check, which runs only when the target is not already in front. Both are stated in the skill.
- The `normalChromeBrowser.unattendedMachine` record is in an agent-writable file; the gate proves a record of the right shape exists, not who wrote it. Cooperative boundary, stated.
- The bridge's `stdin.txt` holds one secret line under the user's own `%LOCALAPPDATA%` for the life of one call; a kill of the wrapper before its exit trap can leave the folder behind, and a kill before the task's `finally` can leave the one-shot task registered. The skill names both places to check after an interrupted run.
- The activity line records what the wrapper saw (command, exit code, route, override names); it is not proof of what the page did. Launches on macOS are not logged; the macOS activity line's hash fields are caller-reported.
- `url` on Windows is the omnibox display string (scheme and `www.` elided; the full url while the omnibox has focus); the skill compares the host at a boundary and `ND_EXPECT_HOST` enforces that before input when set, but a Unicode-displayed international host cannot be expressed, a port must be written, and a URL is still not a page: the skill says to read the page text as well.
- No canonicalization of 8.3 aliases beyond refusing `~`; a junction or symlink to the operator's profile folder is not detected.
- Windows 10 and multi-monitor setups are untested (the live tests ran on Windows 11, one monitor).

---

## 3. Level-of-abstraction fit

Right layer. These are operator-invoked tools plus a procedure, like `load-assess.sh` and `/subscription-signin`. The Windows rules sit in the wrapper rather than in the driver because the driver is PP's reviewed, live-tested artifact and must ship as tested; the wrapper is Instar's layer and is itself live-tested. Profiles reuse the existing registry location and jail rule on macOS; the Windows profile rule is the local-path equivalent. The migration reuses the existing skill-content-migration pattern (`migrateSubscriptionSigninByHand`) and the existing section-mirroring pass. The bridge reuses an in-box OS facility (Task Scheduler) rather than adding a service.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The scripts' refusals validate their own arguments and the moment they run in; they block no message, session, dispatch or other agent action. The driver's operator-active rule is a deterministic safety floor on an irreversible action (keystrokes into whatever window has focus), declared `invariant` in the spec with its honest scope.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The two judgments the skill asks for (why a page withholds a control and whether to stop; what to do after `canfocus` says no) are declared in the spec's `## Decision points touched` as `judgment-candidate` rows with bounded action spaces, conservative defaults (stop and tell the operator; wait) and the operator as arbiter. The wrapper enforces the one bound an agent could otherwise cross on its own (the override needs the recorded declaration).

---

## 5. Interactions

- **Shadowing:** the skill content migration runs after `migrateBuiltinSkills` (which only writes a missing file), so a fresh install gets the new text and an existing copy is migrated; the CLAUDE.md replacement runs in `migrateClaudeMd` before the shadow pass, so the shadows mirror the new section once. The old heading is not a prefix of the new one, so the two sniffs cannot confuse each other.
- **Double-fire:** none; nothing runs on its own. A second `migrate()` is a no-op for the skill and the card (marker / heading present) and refreshes the scripts (by design).
- **Races:** `chrome-launch.sh`'s running-check and `open` are not atomic (unchanged from PR 2283). On Windows two agents have separate binding files; the sessions of one agent share one on purpose and a scripted sequence pins `ND_USER_DATA_DIR`. Two sessions of one agent calling the wrapper at once WOULD interleave real input on the same Chrome (the driver's per-character check cannot see it: the target still holds the foreground), which is why a per-agent lock serializes calls; a dead owner's lock is reclaimed by removing its pid-named file and then `rmdir` (never a rename; a pid-less lock only once older than the wait and never under 5 s; an owner that finds a second pid file beside its own gives the lock back); a bridged driver that outlived its killed wrapper is counted through its still-running task, one that outlived its own timeout through the survivor record, and both are waited for on either route, bounded on wall time; a wrapper killed by a signal leaves its work folder and writes the survivor record from its exit trap, and the Windows side writes its verdict into the folder for the next call to adopt; the direct route runs the driver under `timeout`; a direct-route driver whose wrapper died by SIGKILL is the stated window. Each bridged call still has its own work folder and task name.
- **Feedback loops:** none. Every repeating path is bounded: the bridge's wait loop (`ND_BRIDGE_TIMEOUT`, default 120 s, 10–900; the task's own execution limit is the timeout plus 60 s), the lock wait, the running-task wait and the survivor wait (`ND_LOCK_WAIT`, 90 s, at most 900, every iteration sleeps and counts), the stale sweep (one pass per call, this agent's names only), every probe (one retry), the direct route's driver wait (coreutils `timeout`; unbounded only on a host without it, which the skill states). A timeout is never auto-retried, and the latch refuses input after one until the agent has looked.
- **Revert:** after a release revert the old `migrateClaudeMd` re-appends the v1 card beside the new one; the next upgrade's stale-v1 removal fixes it. Stated in the spec.

---

## 6. External surfaces

- New files in every agent: an updated SKILL.md (or an appendix + `SKILL.shipped.md` beside an edited copy), two new scripts, a refreshed `chrome-launch.sh`, the renamed CLAUDE.md card (and its AGENTS.md/GEMINI.md mirror).
- On Windows, the first bridged call creates `%LOCALAPPDATA%\native-drive\instar-<agent>-<hash>\` and, per call, a one-shot scheduled task `instar-ndrive-<agent>-<hash>-<run>` that is unregistered when the call ends; `.instar/state/native-drive/lock.d` (the per-agent lock, removed when the call ends), `.instar/state/native-drive/survivor` (a driver that may have outlived its timeout, removed when it is gone) and `.instar/state/native-drive/unknown-outcome` (the latch after a timeout or crash, removed by the next successful read-only command) under the agent home; `.instar/state/native-drive/localappdata.txt` under the agent home caches the probe.
- The scripts act on websites as the agent's own signed-in profiles when an agent uses them; that is the capability. Restraint is by the rules in the skill plus the wrapper's structural refusals.
- Timing: the bridge adds a task registration and a hidden runner per call (roughly a few seconds; measured by the Mama PC wrapper test and recorded in the build report). The wrapper runs the `%LOCALAPPDATA%` probe (cached) and the session-id probe (every call, once more when the answer is empty) before deciding; a call after an interrupted one adds the task enumeration (about 4 s measured) and, with a survivor record, one probe, on either route; a bridged call adds the logon check, the `wscript.exe` check and the registration call (13.4 s measured per bridged call in the second run with the enumeration on every call; the enumeration now runs only after an interruption).
- **Operator surface (Mobile-Complete Operator Actions):** the one operator decision this adds, "this machine is unattended", is given in conversation and written by the agent directly into `.instar/config.json` on the machine the operator means (`PATCH /config` refuses the key by design) in the declared shape; no PIN route, no dashboard form. "No operator-facing actions" beyond that conversational one.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or grant/revoke/secret form is touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Skill, CLAUDE.md card, all five scripts: shipped content, identical on every machine through the normal update path.
- Browser profiles: machine-local, physical-credential-locality (OS-keystore-encrypted cookies on one disk; never copied).
- The Windows binding file and own-input tick, the `%LOCALAPPDATA%` cache, the per-agent lock directory (`.instar/state/native-drive/lock.d`), the survivor record and the unknown-outcome latch beside it, and the per-call bridge folder: machine-local, hardware-bound-resource (a live process id, an input tick, a folder of one Windows user profile, one machine's live wrapper pid, one call's relay files). The unattended-machine record: machine-local, a fact about one machine's keyboard and screen, written on that machine.
- The activity log: proxied-on-read through the existing file API (`GET /api/files/download`), which is how this change's own gates read the Mama PC's reports.
- No user-facing notices, no durable topic state, no generated URLs. `lint-machine-local-justification` is clean on the spec.

---

## 8. Rollback cost

Revert the release. Installed files are inert; a reverted release stops refreshing them. The skill copy and the two new scripts stay in place (harmless); the CLAUDE.md card duplicates until the next upgrade (a contradictory platform statement, no behaviour). No data migration, no state repair. On Windows a leftover `%LOCALAPPDATA%\native-drive\instar-<agent>-<hash>\` folder is inert.

---

## Conclusion

Ship, after the Mama PC wrapper test passes on the final bytes (the driver test already did; the first wrapper run found four defects and the second one, each fixed at its cause). Eight review rounds moved every Windows-side protection into the wrapper (profile jail, url and chrome.exe rules, quote hygiene, per-agent binding, recorded-declaration override gate, `canfocus` before `invoke`, the bridge), kept the driver byte-identical to its live-tested bytes, made the skill-content migration non-destructive for edited copies (appendix + shipped sibling), made the CLAUDE.md replacement exact-text-only and revert-safe, and bound both live-test verdicts to the shipped hashes. The limits (instructions plus mistake-guards, not a boundary; the same-profile case; the agent-writable declaration; the secret's one-call file transit; Windows 10 and multi-monitor untested) are stated where an agent and the operator will read them.

---

## Second-pass review (if required)

Not required (see header).

---

## Evidence pointers

- Unit: `tests/unit/normal-chrome-browser-skill.test.ts`, `tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts`, the `feature-delivery-completeness` guard entry.
- Integration: `tests/integration/normal-chrome-browser-update.test.ts`.
- E2E: `tests/e2e/normal-chrome-browser-init-lifecycle.test.ts`.
- Live: the Mama PC driver report (`.instar/lanes/native-drive-wintest-report.md` on that machine; `native-drive.ps1` SHA-256 `9bacd88a…`, `VERDICT: PASS`), the Mama PC wrapper report (`.instar/lanes/ndrive-bridge-test-report.md`), and on this Mac the `open -g` frontmost-app check (Finder before and after), the flag refusals, and the wrapper's every path against a stub `powershell.exe`.
- Lints: `node scripts/lint-blocking-decisions-declared.mjs` (clean, 31 files, 19 non-blocking pins), `node scripts/lint-machine-local-justification.js docs/specs/normal-chrome-cross-platform.md` (clean).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot user-driven action, not a self-triggered loop: every ndrive.sh call is one operator-asked driver command; its probe retries are one each, its waits are bounded by ND_LOCK_WAIT/ND_BRIDGE_TIMEOUT (wall time), and nothing in it re-triggers itself across calls`.

No agent-authored-artifact defect — not applicable. (This change adds no self-triggered controller either: nothing fires on its own; the bridge's wait loop is bounded and runs only inside one operator-invoked call.)

## Redirect order at the three pidstart reads

The fourth Windows live run (bytes `c7a8edbd…`, PASS) surfaced one cosmetic leak: when a bridge work folder has `pid.txt` but no `pidstart.txt`, the read `tr -d '\r\n ' < pidstart.txt 2>/dev/null` printed `No such file or directory` on stderr, because bash applies redirections left to right and the failing input redirect ran before stderr was silenced. The stderr redirect now comes first at the three sites (cleanup trap, sweep adoption, timeout survivor). Side effects: none on behaviour. The value was already empty on that path and the start-time-less fallback already applied; only the stray line is gone. The decision-surface baseline is re-pinned to the new bytes, and those bytes get their own wrapper live run (the fifth and last permitted) before the PR opens.

## Redirect order: the class, not the sites (after live run 5)

Run 5 on the Mama PC (2026-10-22 00:00–00:25 PDT, 80 calls, every behavioural row passing) found the defect the three-site fix above had missed at a fourth site: the `verdict.txt` read in the sweep adoption, one line above a patched one, reached by the ordinary interrupted-call path (a wrapper killed while its driver runs leaves `pid.txt` without `rc.txt` or `verdict.txt`, and the next call's sweep printed the shell's missing-file diagnostic). The fix is now the class: every shell-opened input redirect in `ndrive.sh` stands after its stderr redirect (the `verdict.txt` read, the survivor `read`, the survivor `cut` in the `ERR busy` message, the `bridge.err` first-line read, plus the three `pidstart.txt` reads), verified silent under bash with every one of those files absent. No behaviour changes: the values read are the same, only a stray diagnostic line is gone. The spec's live-test gate paragraph is amended in the same commit: the five-run count it carried was a numeric gate, which the operator's rule of 2026-09-29 forbids; it is restated as a signal, with the blocking conditions stated in words (a new defect class after a passing-grade run; the same class again after a class fix; the Mama PC unable to run), and the run list now records runs 4 and 5.
