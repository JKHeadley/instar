# Side-Effects Review — Machine self-maintenance, browser care and honest lock reading (watch-only)

**Version / slug:** `machine-self-maintenance-browser-care-lock-reading`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (--second-pass false, as instructed for this build)`

## Summary of the change

Increment 2 of docs/specs/machine-self-maintenance.md: Part B (browser and window care, CMT-1201) in watch-only form, and Part A (honest lock reading, CMT-1204) as a read surface.

- Part A: `lockState.ts` is the spec's five-row decision table, pure. `MachineLockStateReader` (src/core) gathers its inputs on macOS from the packaged desktop helper's existing `probe` (run with the existing lock-input switch, which only adds read-only fields) and `sysadminctl -screenLock status`. `GET /machine-maintenance/lock-state` serves the verdict with every input beside it. Linux reads `not-applicable`, Windows and WSL read `unknown`.
- Part B: `BrowserCare.ts` holds the instance ledger and a 15-minute sweep that applies the spec's ownership rule, the three close grounds and the keep checks, and records what it WOULD close. It has no close path. New helpers `chrome-ledger.sh`, `chrome-close.sh` (dry-run: records the completion signal and reports), `chrome-renew.sh`, `chrome-unsaved.sh` (read-only per-tab check); `chrome-launch.sh` and `chrome-js.sh` now keep the ledger current. `GET /machine-maintenance` carries a `browserCare` block. An awareness section reaches fresh and updated agents, and the release note is `upgrades/next/machine-self-maintenance-browser-care-lock-reading.md`.

Tier 2 (spec-driven, the operator accepted the spec at the round cap). Size: 4 new source modules (about 650 lines), 4 new shell helpers, small edits to 2 helpers, wiring, 3 new test files and 3 extended ones. Effort: one design pass, no spec rounds in this increment.

Deliberate differences from the spec text, all in the safe direction:

1. `chrome-close.sh` closes nothing in this release (the operator's instruction: anything that quits apps ships dry-run first). It records the completion signal, runs the same checks and logs `would-close` or `would-keep`.
2. The launch cap does not refuse a launch while dry-run is on. The spec has the launcher refuse at the cap during dry-run; a dry-run that blocks launches is not a dry-run, so this build only reports `overAgentCap` and `overHostCap`. Enforcement arrives with closing.
3. The host count is read from the process table (every agent's normal-Chrome profiles), not from marker files. Same number, no new host directory.
4. A sign-in repair episode open on this machine keeps every browser (the spec excludes that episode's profile). Coarser, never wider.
5. A `keepProfiles` allowlist is added (`machineMaintenance.browserCare.keepProfiles`): those profiles are never picked.
6. The frontmost-window exclusion is replaced by a stronger rule: any console input in the last 5 minutes keeps every candidate.
7. Part A's changes to `/desktop/diagnostics` and to the helper's capture admission are not in this increment; the lock reading is a separate read route. <!-- tracked: CMT-1204 -->

## Decision-point inventory

- `lockState` verdict — add — deterministic table, reported only. Nothing in Instar reads it to admit, refuse or act; it answers "is that Mac really locked?" honestly.
- Browser sweep verdict (`would-close` / `keep` with a reason) — add — recorded evidence only. No code acts on it.
- `chrome-close.sh` verdict — add — printed and logged; it closes nothing.
- No admission, block, kill or message decision is added, modified or consulted.

---

## 1. Over-block

No block/allow surface. Nothing is refused or closed. The one behavioural change to an existing tool: `chrome-launch.sh` now also refuses a malformed `--ttl-minutes` or an empty `--purpose` (exit 64); calls without those flags behave as before.

---

## 2. Under-block

As evidence, known gaps, each visible:
- The per-tab check reads ordinary form fields, ticked boxes, selects, chosen files and contenteditable text. Text held only in a page's own memory or drawn on a canvas reads as no input. Any non-empty contenteditable reads as yes (it has no default to compare), so pages like editors are always kept: over-keeping, the safe side.
- Tabs are walked by window index; if the window order changed mid-read a tab could be read twice and another missed. The check runs only after 5 minutes with no console input, which makes a reorder unlikely, and in this release nothing closes on its answer.
- A Chrome with no windows reads as unreadable and is kept.
- Only the real Chrome app's main process counts (`Google Chrome.app/Contents/MacOS/Google Chrome`). Chrome for Testing, Chromium and any browser started with automation flags (`--remote-debugging-port/pipe`, `--enable-automation`, `--test-type`) are never counted, even inside a profiles folder, so the Playwright MCP browser is never adopted. The same rule applies to the PID lookup in `chrome-unsaved.sh` and `chrome-close.sh`. Added after the independent review of PR 2582.
- The sweep ignores `relogin-chrome-profile-*` directories and anything outside this agent's profiles folder, so those are never counted as owned.
- Part A: a lock shield drawn while the flag is set and no password is required is conflicting evidence and reads `unknown` (row 5), not `screensaver-or-display-sleep`; row 3 requires no shield. Added after the independent review.
- Part A: a stale or missing lock sample, an old helper without lock inputs, or an unreadable policy all read `unknown`. That is honest but means `unknown` may be common until the helper is present everywhere; the live matrix (L1) is still to run.

---

## 3. Level-of-abstraction fit

The decision logic lives in `monitoring/machineMaintenance/` beside the drain rehearsal and under the same source rule (no way to signal a process, OS commands only through the fixed read-only table). The two reads that must run a helper (`chrome-unsaved.sh`) or read a profile's folders live in `src/core/BrowserCareProbes.ts`, injected as dependencies. The lock reader reuses the existing desktop helper and its existing `lockInputs` rather than adding a native verb, and keeps the spec's table separate from the desktop-locked-screen classifier, which answers a different question (whether remote control may proceed).

---

## 4. Signal vs authority compliance

Signal only. `tests/unit/machine-maintenance-watch-only.test.ts` now covers `BrowserCare.ts` and `lockState.ts` too, and separately the two reads kept in src/core (`BrowserCareProbes.ts`, `MachineLockStateReader.ts`): no restart words, no process signal, no file writes, only their named commands with fixed arguments, and an import allowlist. In the maintenance folder: no restart words, no way to signal a process, exec only through the one allowlisted runner (which gained one read: `ps -axo pid=,lstart=,args=`). `chrome-close.sh` is checked by `tests/unit/browser-care-scripts.test.ts` to hold no kill, quit or Apple Event. `chrome-unsaved.sh`'s page code is checked to assign nothing and to send one event type only. Reference: docs/signal-vs-authority.md.

---

## 5. Interactions

- `chrome-launch.sh` and `chrome-js.sh` call `chrome-ledger.sh` after their own work; a ledger failure warns on stderr and never changes their exit code or output.
- The sweep's per-tab check sends a read-only Apple Event to an agent-owned Chrome. It runs only for close candidates, at most 5 per pass, only after 5 minutes without console input. If macOS has not yet allowed the server's process tree to control Chrome, that first event can show macOS's own permission prompt on the machine. Sessions already drive these same Chromes through the same tmux tree, so the grant normally exists; the bound keeps any prompt rare.
- The lock reader runs the helper's `probe` with the lock-input switch. On that verb the switch only adds fields; it starts no indicator, takes no lock and grants nothing. Cached 5 s, one read at a time.
- The drain rehearsal, `DirectDesktopAccess` and `DesktopLockedController` are not touched.

---

## 6. External surfaces

New route `GET /machine-maintenance/lock-state` (Bearer, 503 when dark). New field `browserCare` on `GET /machine-maintenance`. New state `.instar/state/browser-instances/` (one file per open owned browser, removed when it exits) and `logs/browser-care.jsonl` (rotated at 2 MiB), both registered in the state coherence registry. Four new helper scripts in `.instar/scripts/browser/`, installed by the existing always-overwrite installer. One CLAUDE.md section, added to existing agents by `migrateClaudeMd` with a content-sniff guard. Everything runs only where `machineMaintenance` is on (dev-gated; dark on the fleet); the helper scripts install everywhere, and the ledger they write is inert where the sweep is dark.

---

## 7. Multi-machine posture

Machine-local by design (hardware-bound-resource): the ledger and verdicts describe live processes on one machine, and the lock reading is that machine's own console. `?scope=pool` for these fields is part of the later pool increment. <!-- tracked: CMT-1199 -->

---

## 8. Rollback cost

`machineMaintenance.browserCare.enabled: false` stops the sweep (read live). `machineMaintenance.enabled: false` removes both the sweep and the lock route at the next restart. Reverting the release leaves inert ledger files and the extra helper scripts; nothing reads them. No data migration, no state repair.

## Second-pass review

**Reviewer:** independent subagent, second pass, 2026-11-02

**Verdict: concur**, after a confirming pass on 58b722a80. Findings fixed: automation browsers (Chrome for Testing, Playwright) excluded from the sweep and scripts; the cannot-act test covers BrowserCareProbes.ts and MachineLockStateReader.ts; a lock shield with no password reads unknown. Known low items: the scripts exclude --remote-debugging- as a prefix while the parser lists port and pipe; chrome-close.sh records finished before its checks; a missing sign-in repair system reads as no repair open. The two skipIf(!HAS_PY) skips are justified: /usr/bin/python3 is what the scripts themselves require.
