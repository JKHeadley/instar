# Convergence Report — Normal-Chrome browser skill: the Linux driver (X11 input + AT-SPI reading)

**Spec:** [docs/specs/normal-chrome-linux.md](../normal-chrome-linux.md)
**Slug:** `normal-chrome-linux`
**Outcome:** `convergence-failed` at the round cap (Tier 2, 6 of 6 rounds). The last round still found design issues, and two of them concern safety or data loss. They are fixed in the spec text, but no review round has checked those fixes. Under the skill's cap rule, findings like these go to the operator. **No convergence tag was written.**
**Iterations:** 6
**Final-round design findings:** 7 (2 safety or data loss, 5 other), all folded into the spec, none re-reviewed

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier review ran through the agent's codex CLI in all six rounds, each with status `ok`. The context sent with each review was the spec itself, `docs/specs/normal-chrome-cross-platform.md` and `docs/signal-vs-authority.md`.

The Gemini family was **unavailable** (`gemini-not-authed`) and Grok was not enabled.

A clean-door Anthropic read (`--family claude-code`) also ran in every round. It is recorded separately as `clean-door-anthropic-review: claude-code:claude-opus-5-5`. It ran on `claude-opus-5-5`, not the configured `claude-fable-5`, so it is a second Claude read, not a cross-family one.

The six internal reviewer lenses ran as Claude subagents on the session model (Opus 5.5) in every round. Externals ran on every round because the spec's body changed each time.

## ELI10 Overview

Instar agents can already drive a normal, signed-in Chrome window on a Mac and on Windows. That matters for pages that refuse or behave strangely for automated browsers: sign-in, billing and account settings. On Linux every tool just said "not supported".

This spec designs the Linux version. It moves the real mouse and keyboard through the X11 display system. It reads the page the way a screen reader does, through the Linux accessibility bus. Before writing the design, Echo proved the method by hand on Cirrus, a Linux test VM, on 2026-11-03.

If it ships, an agent on a Linux machine with a normal X11 desktop can do those account-bound web tasks:
- a cloud VM with a VNC desktop;
- an older or KDE laptop;
- a GNOME laptop, through a second virtual desktop.

The trade-offs:
- **No code inside the page.** The Mac version can run code in the page; the Linux version cannot.
- **No Wayland.** On a Wayland desktop it refuses and explains the way out.
- **A long rule set.** It has to share a keyboard and screen safely with a person who might be using them. Most of the six review rounds went into making it stop the instant the operator touches anything, never type into the wrong box or onto the wrong website, and never leave a key held down or a page in an unknown state after a crash.

## Original vs Converged

- **Safety rules moved from "checked once" to "checked every keystroke."**
  - Originally: the driver checked the right window was in front once per command, and judged "is the operator using the computer" from idle time.
  - Now:
    - It pins the exact box being typed into, and before every keystroke checks the window, the box and whether the operator touched anything.
    - It watches XInput2 device events, so it can tell its own input from a person's, including a person working through VNC tools that relay input the same way the driver does.
    - It refuses to type with Caps Lock on.
  - Why: idle time cannot see an operator during a burst of typing, and a page or popup can steal focus mid-word.
- **Passwords go to the site they are meant for, and nothing leaks.**
  - Originally: the destination was checked against the top page's address. Typed text and Chrome's environment were exposed in several ways.
  - Now:
    - The site is judged by the frame that actually receives the input, so a login frame from another site is caught.
    - All typed text arrives on stdin.
    - Chrome starts with a clean environment, so the agent's tokens never reach it.
    - Sign-in codes in addresses are blanked before the agent sees them.
    - The agent's own file API can never download a browser profile.
- **A crash cannot leave things in a bad state.**
  - Originally there were no deadlines and no recovery.
  - Now:
    - Every step has a time limit.
    - A crash or kill sets a "don't type until you have looked at the page" latch, scoped to that profile.
    - Held keys are released before anyone types on that display again, but not while the operator is active.
    - `close` never force-quits over unsaved work unless the operator says so.
- **Honest about what it is.**
  - A threat model now says these rules guard an honest agent against mistakes, not against other programs running as the same user.
  - Three statements about existing code were corrected:
    - which tools write the activity log;
    - that the macOS care sweep only watches;
    - that sign-in repair never runs on plain Linux.
- **Built so the existing checks can see it.**
  - The blocking-decision lint widens to `.py`, and both new files are declared and content-pinned, as the macOS + Windows spec did for `.ps1`.
  - Every refusal is classified in a decision table.
  - Every open question is resolved into a frontloaded decision.
- **Simpler where it could be.**
  - `xdotool` was dropped: all input is sent from one process, so the driver knows exactly which events are its own.
  - The XRes ownership check and the X-server identity on the input mark were cut.
  - Proposed deferrals (a Wayland driver, a Linux care sweep, Linux sign-in repair) became plain scope decisions instead of promises.

## Iteration Summary

| Iteration | Standards-Conformance Gate | Reviewers who flagged design issues | Design findings | Left behind (precision) | Spec changes |
|-----------|----------------------------|-------------------------------------|-----------------|-------------------------|--------------|
| 1 | ran (1 flag: blocking-decision placement; fit weak) | security, adversarial, integration, scalability, decision-completeness, P20, lessons-aware, codex, clean-door | 28 | ~14 | Design rewritten: threat model, decision table, frontloaded decisions, P20 table, env allowlist, desktop resolution, per-keystroke focus, deadlines and latch, expected host, popups, hit-test hardening, migration branches, lint widening |
| 2 | ran (2 flags, then 1 after the truncation fix; fit) | all lenses + codex + clean-door | 18 | ~15 | URI redaction, XInput2 listener, file-API exclusion, iframe-aware host check, display lock path, in-flight latch, one-walk reads, deferrals removed, `/usr/bin/python3 -I` |
| 3 | ran (1 flag; fit weak) | security, adversarial, integration, scalability, decisions, lessons, codex, clean-door | 12 | ~20 | stdin-only typing, per-display mark, key release, Caps Lock refusal, XTEST counting, click host from the hit-test target, `--new`, log rotation, Wayland message corrected |
| 4 | ran (1 flag; fit) | decisions, lessons, codex, clean-door | 7 | ~25 | All input in-process (no `xdotool`), override scope, session mapping, latch cleared only by reads, release on next call, `XD_PROFILE`, server identity cut |
| 5 | ran (1 flag; fit) | decisions, lessons, integration, codex | 5 | ~20 | Release under the display lock, latch per profile and display, `close-blocked`, destination-document recheck, first-success record moved |
| 6 | ran (1 flag; fit) | adversarial, decisions, lessons, integration, codex, clean-door | 7 (2 safety or data loss) | ~25 | Folded in, not re-reviewed: release checks the operator first; pending release per display; `close --force` judgment row; Wayland decided by the X server only; latch clears when the Chrome is gone; macOS log lock via `fcntl`; GLib iteration and streamed walks |

Standards-Conformance Gate: ran every round (one persistent flag). Its parent-principle fit varied between weak and fit.

**The persistent gate flag.** The flag was on "A Decision That Can Block Must Live Where the Checks Can See It". In rounds 2 to 6, the lessons-aware, decision-completeness and security reviewers each independently judged it a false positive, for three reasons:
- Widening the existing lint to `.py`, with both files declared and content-pinned, is the standard's own move (A), "declare the population".
- It is the same lint with one more file type, so it is not a second detector.
- It is the same treatment `ndrive.sh` and `native-drive.ps1` received.

The per-keystroke checks have to run inside the process that sends the keystrokes, and that process is the Python one that reaches the accessibility bindings.

## Proportion

Tier 2: a new capability that drives a real browser as the user. The spec grew from 280 lines (33 KB) to 81 KB, and all 6 of 6 rounds were used.

Design findings fell every round (28 → 18 → 12 → 7 → 5 → 7). From round 4 on they were refinements of existing mechanisms (the latch, release and operator-presence machinery), not new architecture. Reviewers flagged that machinery as the part that keeps attracting repairs.

⚠ The size of the rule set is itself a risk. Reviewers suggested two ways to shrink it, and both are reasonable alternatives for the operator to weigh:
- a dedicated display for the agent as the default;
- a short state table for one input call.

## Left behind

Precision findings not iterated on. Each is one line, and some were fixed in passing.
- Make the dedicated agent display the default and the shared display secondary. The spec lists it as an alternative and keeps the shared display supported.
- Add a long-running per-display helper process to remove per-call python startup and the mark file. Not adopted; the alternative is noted.
- Add a sequence diagram or state table for one input call's lock, latch and release ordering.
- Match XTEST event counting by event type, position or server timestamp, since a no-op motion may emit no raw event. Fails safe; the live gate measures it.
- Make the 200-candidate `find` cap provisional until measured. The live row converts it to a 3 s budget if needed.
- Refuse `shot` structurally on a credential-bearing URI, not only through a skill note.
- Plain-entry secrets (one-time codes) can be read back; the skill says to clear the field first.
- A cross-origin iframe hidden from accessibility can mislead the hit-test. Sensitive pages refuse framing; listed in the side-effects review.
- `XD_EXPECT_HOST` two-label floor versus the public-suffix list: stated as a floor.
- Lint taxonomy: add a `selfScopedRefusal` manifest category so "non-blocking" stops carrying an unwritten convention. This is a lint change for a separate spec.
- Unattended record: add a `machineId` so a future config sync cannot mark every machine unattended. Carried from the cross-platform spec.
- Name the v2 skill hash constant and its fixture (`NORMAL_CHROME_BROWSER_SKILL_V2_SHA256`, `tests/fixtures/skills/normal-chrome-browser-v2.md`), and clarify "SKILL.shipped.md refreshed if present".
- Add rows for the password-store choice and for choosing the `XD_EXPECT_HOST` value to the decision table.
- `-I` plus `env -i` still trusts system library paths; the threat model covers it.
- Bound the Python memory of a 200,000-node walk; output is now streamed to a temporary file.
- Two different displays named in the latch and the binding resolve to `ERR busy` timeouts, never a deadlock.

## Full Findings Catalog

**Round 1 (28 design).**
- The lint cannot see `.py`.
- No decision table.
- No frontloaded decisions, and 8 open questions.
- No threat model.
- The `basic` password store made the multi-machine justification false.
- Chrome inherited the agent's environment.
- `/proc` environ scraping was underspecified.
- Wayland was detected from the wrong environment.
- Focus was checked per command.
- The operator-idle formula was undefined.
- No deadlines, latch or lock reclaim.
- No expected-host check.
- A URI re-read was used as click proof.
- One window per binding.
- Hover swap and overlays.
- Forged output lines and ambiguous matches.
- `nav` autocompletion.
- Password values readable.
- Two agents on one display.
- Typed text on argv.
- A wrong sign-in repair claim.
- Browser care and the ledger mismatch.
- A migration early-return that would skip the update.
- Missing posture markers.
- `find` cost.
- Empty documents.
- No live-gate verdict rules.
- Chromium undecided.

All resolved in the design rewrite.

**Round 2 (18 design).**
- OAuth codes in printed URIs.
- Operator masked during typing.
- The `find` cap was silent.
- `nav` completion.
- The `data:` secret fixture had no host.
- Locked keyring.
- `clickxy` and keys bypassed the dialog refusal.
- The host was checked on the top document.
- Focus was checked only at the window level.
- Profiles were downloadable through the file API.
- The lock path and coverage.
- The latch was written only by a live wrapper.
- Paging over a changing tree.
- The pointer moved before the click.
- Deferral markers pointed at this same item.
- The lint row misstated.
- Python taken from PATH.
- Outfiles never deleted.

All resolved.

**Round 3 (12 design).**
- Argv typing through the wrapper.
- The per-agent mark between agents.
- Held keys after an interruption.
- The snapshot overclaim.
- Caps Lock.
- XTEST-relaying VNC servers.
- The host for clicks.
- PDEATHSIG watched `timeout`.
- The "on Xorg" way out is gone on GNOME 49 and later.
- Silent profile creation.
- An unimplemented log rotation.
- The sudo install as an unclassified judgment.

All resolved.

**Round 4 (7 design).**
- XTEST counting combined with `xdotool`.
- The override scope.
- The `loginctl` false blocker.
- `target` and `shot` cleared the latch.
- Release after a kill.
- A shared binding across sessions.
- The server-identity source.

All resolved.

**Round 5 (5 design).**
- `release` ran outside the display lock.
- The latch was cleared by another profile.
- `close` force-killed.
- The post-state host check on iframes.
- The first-success record's location and marker.

All resolved.

**Round 6 (7 design; fixes folded in, not re-reviewed).**

Safety and data-loss items:
- **Release erased operator-presence evidence and could release keys the operator was holding.** Codex and the adversarial lens both raised it. *Safety.*
- **`close --force` was an unclassified data-loss judgment.** The decisions and adversarial lenses raised it. *Data loss.*

Other items:
- Crash recovery was scoped per agent while the resource is per display (codex).
- The Wayland check could block the recommended VNC way out, and probing could start Xwayland (clean-door).
- The latch dead-ends when the bound Chrome is gone (lessons-aware).
- macOS has no `flock(1)`, so log rotation in `chrome-js.sh` would fail (integration).

Item-by-item detail for every round is in the reviewer outputs summarized above. Every finding's resolution is visible in the spec text, written in first-version voice.

## Convergence verdict

**Not converged: convergence-failed at the 6-round cap.** Round 6 found 7 design issues. All are now fixed in the spec, but two concern safety or data loss, and no review round has checked those fixes. The skill sends safety and data-loss findings at the cap to the operator rather than accepting them as risks, so no `review-convergence` tag was written and `approved: true` was not touched.

The operator's options:
1. **Authorize one verification round (round 7)** limited to the round-6 fixes, with the latch/release/close section as its focus. If it is quiet, the tag is written. This is the recommended option.
2. Accept the round-6 fixes as they stand.
3. Shrink the design first, making the dedicated agent display the default, which removes most of the shared-display machinery.

`## Open questions` is empty. The Decision-Completeness counts for the final round are:
- frontloaded decisions: 22
- cheap-to-change tags: 0
- contested then cleared: 0
