---
title: "Windows normal-Chrome: keep a covered window painting, and name a blank page instead of returning Chrome's own UI"
slug: "normal-chrome-windows-occlusion"
author: "echo"
created: 2026-11-19
parent-principle: "Self-Unblock Before Escalating"
eli16-overview: "normal-chrome-windows-occlusion.eli16.md"
tier: 1
approved: true
approved-by: "echo (own converged Tier-1 spec; not a constitution or protected-list change; operator directive 2026-11-19 topic 145625 asked for this fix in Instar). Read the convergence report first."
lessons-engaged: >
  P1 Structure > Willpower (the fix is a fixed launch flag and a named driver error, not a skill sentence telling the
  agent to move windows); P3 Migration Parity (the driver rides the always-overwrite browser-script installer; the
  skill note, row and launch sentence reach installed copies through three anchored, heading-guarded edits in
  PostUpdateMigrator); "An empty result is not
  a verified fact" (the old behaviour returned Chrome's toolbar strings with exit 0, which reads as "the page says
  nothing"); "A harness bug looks like a product bug" (an earlier feedback item blamed a disconnected display from a
  session-0 query; this spec corrects it with an in-session reproduction and a positive control).
review-convergence: "2026-11-19T18:12:00.263Z"
review-iterations: 3
review-completed-at: "2026-11-19T18:12:00.263Z"
review-report: "docs/specs/reports/normal-chrome-windows-occlusion-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Windows normal-Chrome: occlusion fix and a named blank-page error

## Problem

On Windows the normal-Chrome driver (`native-drive.ps1`, run through `ndrive.sh`) launches Chrome, the omnibox
navigates and the window title updates, but the page never paints: `shot` shows a blank content area, `text` returns
only Chrome's own UI strings (exit 0), and `editfields`/`find` say `page document not found`. Reload, focus and a real
keypress do not help.

Root cause: Chrome's native window occlusion tracking (`CalculateNativeWinOcclusion`) decides the window is hidden when
other windows cover it, then stops rendering the page and stops publishing its accessibility tree. On the Mama PC
(Windows 11) on 2026-11-19 a desktop app window covered most of the 1280x800 screen. The machine was not locked.

Reproduction (throwaway profile, the IANA example domain page, launched in the interactive session with the driver's
own arguments): baseline, page text absent; `--disable-gpu` added, absent; `--disable-features=CalculateNativeWinOcclusion`
added, the page text ("This domain is for use in documentation examples...") present and the screenshot shows the
page. Reproduced again through the shipped wrapper during this build (see Evidence).

Correction of an earlier report: feedback `fb-0cecd448-dfe` attributed the blank page to a disconnected display. That
screen query ran from Windows session 0, which sees no desktop, so its "no display" reading was an artefact of where it
ran. The display was connected; occlusion was the cause.

## Change

1. **Launch flag.** `launch` always adds `--disable-features=CalculateNativeWinOcclusion` to its fixed argument list.
   It is a rendering setting (Chrome keeps painting a covered window), not an automation or debugging switch; the
   justification is the measured recovery on a covered desktop, not a claim that no page could ever notice it. `ND_CHROME_FLAGS` cannot remove or override it: its allowlist already refuses every
   `--disable-features`/`--enable-features` spelling, and that allowlist is unchanged.
2. **Named failure, after one recheck.** Page reads go through one helper, `Get-PageDocument`. When the page Document
   element is missing and the window title names a site (not empty, not "New Tab", `about:blank` or "Google Chrome";
   English titles: a Chrome in another interface language names its new tab differently, which can only make a
   still-loading new tab report the named failure after the recheck), it waits one second and looks again, because a
   navigation can update the title before the new page's tree appears. Still missing, `text`, `find`/`click`/`invoke`
   (page scope) and `editfields`/`typeedit`/`typesecretedit` fail with `ERR page-not-rendering` (exit 2):
   - the bound browser's command line lacks the flag: the message reports the two observations separately (the page
     document was still unavailable after a recheck; this Chrome lacks the occlusion fix) and names covering windows as
     a known cause, not as the proven one: a missing Document proves the page is unreadable, not why. Remedy: if you started this Chrome, close it and start it again with `launch` (the sign-in
     survives); if someone else did, do not close it: read `shot` or use a profile of your own;
   - the flag is present, or the command line cannot be read: the neutral message, "page document unavailable"; wait if
     it is loading, focus a minimized window, read `shot`. (The flag check looks for the token inside any
     `--disable-features`; a Chrome started elsewhere with a later overriding `--disable-features` would read as fixed
     and get the neutral message. The driver's own launch cannot produce that.)
   The window title is page-supplied: control characters are dropped, it is cut to 80 characters (marked with `...`;
   the title is only a label in a diagnostic, the page itself is read by `text`) and labelled "(page-supplied)" in
   the message. A missing document with no site title keeps the old exit codes (`page document not found`, exit 2,
   for find/editfields; `text` exit 0), so polling a loading `about:blank` is unchanged; `text` now also writes
   `note: no page document (blank or new tab, or still loading); only Chrome's own UI was read` to stderr, so the
   Chrome UI strings it returns are never mistaken for page content. Exit code 2 is unchanged for every path that already returned 2. `text` changes from exit 0 (Chrome
   UI strings only) to exit 2 in the blank-site case, which is the point of the change.
3. **Attach warning.** `attach` binds as before (exit 0) and, when the bound browser's command line lacks the flag,
   writes one warning line to stderr naming the consequence and the remedy. A Chrome started before this update stays
   occluded until it is restarted with `launch`; the warning is how the agent learns that.
4. **Skill text.** A short note with a four-row table (symptom, meaning, what to do) is added at the end of the Windows
   section of the shipped `/normal-chrome-browser` skill, a row for `ERR page-not-rendering` goes into the skill's
   "Recovery quick list" table, and the `launch` row names the flag. Installed copies get all three through
   `PostUpdateMigrator.migrateNormalChromeWindowsBlankPageNote`, guarded on the note's heading, only for the built-in
   skill, as three guarded edits placed where the shipped text has them: the note just before the Linux section
   heading (appended if that heading is gone), the row above the existing `page document not found` row, and the flag
   sentence after the `launch` row's first sentence (each only when its anchor is still there); edits kept, in the
   file's own line endings. An untouched copy of the previous shipped text (pinned as
   `tests/fixtures/skills/normal-chrome-browser-v3.md`, taken from origin/main) ends byte-identical to a fresh install,
   LF and CRLF, which the unit test asserts. It runs after `migrateNormalChromeBrowserSkill`, so a copy that step replaces
   whole already carries the note.
5. **Pins.** The driver's hash pin moves to the new bytes in the unit test and in
   `scripts/blocking-decision-surfaces-baseline.json` (the file stays a content-pinned non-blocking surface). The
   unit test asserts every `ERR` token the driver emits is in the skill text, the flag is in the fixed launch list,
   the allowlist refuses `--disable-features`, and the read paths call the named check.

Migration parity for the driver itself needs no new code: `native-drive.ps1` is in `BROWSER_SCRIPT_NAMES`, and
`installBrowserScripts` overwrites every listed script on init, `refreshScripts` and `PostUpdateMigrator.migrateScripts`.

## Decision points touched

> None of these gate a message, a session or another agent's action. Each is a truthful answer from a read the driver
> already performs, returned to the calling agent as a signal (exit 2 with a named token, or a warning line).

- page read with no Document element and a site title -> `ERR page-not-rendering` instead of Chrome UI strings — invariant; basis: enumerable-domain; evidence: the inputs are two booleans (Document element present; title names a site) and the launch-flag reading, so the four cases are listed in the Change section and each has one correct answer; returning Chrome's toolbar text as page text is never correct.
- which of the two `page-not-rendering` messages -> keyed on whether the browser command line carries the flag — invariant; basis: enumerable-domain; evidence: the command line either contains `CalculateNativeWinOcclusion` inside `--disable-features` or not; an unreadable command line claims nothing (falls to the neutral "page document unavailable" message).
- `attach` warning when the flag is missing — invariant; basis: enumerable-domain; evidence: same two-valued reading; the warning never changes the exit code or the binding, so a wrong reading costs one stderr line.
- the fixed launch flag and the unchanged `ND_CHROME_FLAGS` allowlist — invariant; basis: external-constraint; evidence: Chrome reads only one `--disable-features` switch value, so letting the caller add another would silently drop the fix; the allowlist already refuses that spelling.

## Fixed limits

fixed-limits: none new. The one-second recheck is a wait, not a limit on the caller: the failure is exit 2 with "wait and retry", so the caller decides how long to keep polling.

## Maturation plan

- **test-agent-live:** the driver's UI Automation paths cannot run on Linux CI; the unit tests pin the driver bytes and check the launch list, allowlist, read paths and the skill migration against a fixture of the real previous skill text. The live proof ran on this agent's Windows machine with throwaway profiles (Evidence section).
- **dev-agent-live:** live on Echo's Windows machine (Mama PC) from this release: every browser task there launches with the fix; any `ERR page-not-rendering` or attach warning seen in a real task is read against `shot`.
- **fleet:** on for every Windows agent in the same release, no switch: the flag is a launch default with no page-visible automation signal and the named error replaces a wrong answer, so there is nothing to hold dark.
- **graduation criterion:** one week of real Windows browser tasks on Echo with no blank-page read returned as page text and no `ERR page-not-rendering` on a Chrome the driver launched while the page was visible in `shot`.
- **dark-window:** none; ships live (nothing dark to graduate).
- **ladder:** not applicable: no config key, revert the release to turn it off

## Frontloaded Decisions

- Flag always on, not opt-in: a covered window is the normal state of a shared desktop, and the measured recovery on a covered desktop is the reason. Decided.
- Old-style Chrome is warned about, never killed or relaunched by the driver: closing a browser the agent did not start could lose someone's tabs. Decided.
- Exit code for the named failure stays 2: callers that poll on 2 keep working. Decided.

## Open questions

*(none)*

## Multi-machine posture

Machine-local by design: the driver acts on the Chrome of the machine it runs on. No state, no notices, no URLs.

## Rollback

Revert the commit: the next update overwrites the driver with the old bytes. The skill note and row would remain in
installed copies and describe a token the old driver never emits (harmless but stale); a revert PR therefore includes
a migration that removes the section under the note's heading, the row and the `launch`-row flag sentence, all three
identified by their exact text (applied to a migrated copy of the v3 fixture it restores the fixture's bytes). No
persistent state otherwise.

## Evidence (Mama PC, 2026-11-19, throwaway profiles under `C:\Users\Public\InstarEchoProfiles\`, desktop app window covering the screen)

Final driver bytes, SHA-256 `74f2071c3a53ad92b305ed0d6b4ac5cfc73b6df0671da946adb7c9e1be6aad92` (the hash pinned in the test and
the baseline), run through the shipped wrapper `ndrive.sh` with `ND_SCRIPT` pointing at a copy:

- Old driver (installed), `launch` of the example domain: `text` returned 14 Chrome UI strings and no page text; `shot`
  showed a blank page under the "Example Domain" tab (UIA even reported the tab as "New Tab").
- New driver against that same old-style Chrome: `text` and `find documentation` answered `ERR page-not-rendering`
  naming the missing fix (exit 2) after the recheck; `attach` printed the warning (exit 0).
- New driver, `launch`: `text` contained "This domain is for use in documentation examples..." (exit 0), `find
  documentation` found the paragraph, `shot` showed the page, and `attach` printed no warning.
- New driver, `launch` at `about:blank`: `text` exit 0 with the stderr note that only Chrome's own UI was read;
  `editfields` answered `page document not found` (exit 2), the old behaviour.
- Every Chrome opened for the test was closed afterwards; a Chrome on another profile that was already running was not
  touched.
- Not live-run: the neutral branch (flag present, page document still missing after the recheck) and a Document that
  appears during the recheck; covered by static tests only. The driver's UI Automation paths cannot run on the Linux
  CI, which is why the driver is pinned by hash to the live-run bytes.
