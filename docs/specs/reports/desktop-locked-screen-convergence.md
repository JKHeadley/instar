# Convergence Report — Remote desktop through the ordinary Mac lock screen

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran on all six rounds. Each returned "SERIOUS ISSUES". Gemini was unavailable (`gemini-not-authed`) and Grok is not enabled, so there was one external family.

**Verdict: NOT CONVERGED. Failed at the 6-round cap.** Round 6 raised one safety design finding and four others. No `review-convergence` tag and no `approved` tag were written, and `/instar-dev` will refuse to build from this spec.

## ELI10 Overview

The operator wants to open a locked Mac from a phone. An earlier spec covered both the ordinary lock and the login window, and failed at 6 rounds, mostly on the login window. This run split them. `docs/specs/desktop-login-window.md` now holds the login window as an unapproved note nothing depends on. This spec covers only the ordinary lock, with nothing to install and no root. The operator types the password live into the Instar app's native viewer, the Mac relocks when he finishes, and a hostile program running as him is not stopped.

## Original vs Converged

The split removed the root helper, the step-up, the certificate and the gate. It made the app the phone path and turned the browser box off by default, because the machine serving a page and the tunnel provider can read what is typed there. Review then replaced a loose "two inputs agree" rule with fixed predicates; moved the retained helper to one digest-checked binary per Mac; keyed grant state to the request, since a resumed grant changes id; and gave relock a real state machine, a replaceable guard and a shared lock.

## Iteration Summary

Reviewers ran on the session model, claude-opus-5-5. Round 1 used four panels covering all six lenses. Round 2 used two panels, and rounds 3 to 6 one, all lenses named. Each round also had Codex.

| Round | Reviewers | Design findings (deduped, approximate) | Left behind | Spec changes | Gate |
|---|---|---|---|---|---|
| 1 | 4 panels, Codex | 30 | 9 | Lock predicates, retained helper, request keys, relock, input rules | Standards-Conformance Gate: ran (3 flags) |
| 2 | 2 panels, Codex | 8 | 7 | Dirty field per Mac, marker lock, pin scope, per-Mac disable, rig Mac | Standards-Conformance Gate: ran (1 flag) |
| 3 | 1 panel, Codex | 8, of which 5 about safety | 9 | Relock rewritten, dirty-field exits, display readiness | Standards-Conformance Gate: ran (0 flags) |
| 4 | 1 panel, Codex | 7 | 9 | Guard kill and cap, marker generations, sweep, Forget tombstone, disable reach | Standards-Conformance Gate: ran (2 flags) |
| 5 | 1 panel, Codex | 5 | 8 | Refused input, 15 s rule at Enter, relock-pending, build target | Standards-Conformance Gate: ran (2 flags) |
| 6 | 1 panel, Codex | 5, of which 1 about safety | 7 | **None applied**; verbatim below | Standards-Conformance Gate: ran (2 flags) |

## Proportion

About 300 spec lines, 6 of 6 rounds. The run first stopped at 3 under a mistaken cap; the coordinator corrected it to the skill's 6 for a security-sensitive change. Findings fell 30, 8, 8, 7, 5, 5. They kept narrowing but never reached zero, and most late ones were lifecycle gaps at the edges of relock and input state.

## Round 6 remaining findings, verbatim, not applied

Codex, gpt-6-astra:

**Verdict: SERIOUS ISSUES**

- **DESIGN — “Relock,” “Password path,” and grant item 6: relock completion is not ordered after password-input termination.** The spec says Stop aborts typing between characters, the guard acts immediately, and an already-locked Mac closes the duty as `relocked` without a lock call. It does not require the guard to establish that the password producer has stopped before that terminal transition.

  A possible interleaving is: the helper passes its final check; Stop arrives; the guard observes the still-locked shield and records `relocked`; the helper posts Enter, or an already-posted Enter is delivered, unlocking the Mac after its relock duty has ended. Separate command reading and per-character checks do not establish the missing ordering.

  **Resolution:** Specify a shutdown handshake that prevents further password events and accounts for pending submission before the guard may declare completion. If input termination or submission outcome remains uncertain, retain the duty and continue bounded observation/relock handling. Extend P12 with Stop, deadline expiry, and transport expiry immediately before and after Enter, including a suspended input helper.

- **PRECISION — “Who this protects against” and “Honest limits”: absolute stolen-PIN claims contradict the documented timing exception.** These sections say a stolen PIN “cannot get in” without the password and “cannot get in through this path.” However, “A grant ends” explicitly allows continuation when a wrong remote submission coincides with a local unlock.

  **Resolution:** Say the PIN alone cannot unlock macOS, while noting that the documented coincidence can allow control after someone locally unlocks it.

These are observations about the supplied specification and a derived failure scenario, not measured runtime failures. No implementation source or proof results were supplied; the referenced platform behavior remains unverified here.

Internal panel, claude-opus-5-5, condensed only where its evidence lists were long:

**D1. `relock-pending` can block every desktop grant on a Mac indefinitely (medium; availability only).** Admission refuses on "any agent's marker" at `owed` or `executing`, but only the owning agent's server sweeps or replaces that marker. A guard dies at reboot or logout. If the owner never boots again (agent removed, stopped, or reverted to code that doesn't sweep), the marker stays `owed`. Every other agent on that Mac is then refused, including ordinary unlocked grants. The symbol says a duty is pending when no duty can run. Fix: admission ignores a marker from another boot or login session, and any agent's boot may close that marker `closed-not-applicable` through the flock verb. In the same boot, a marker past its deadline with a stale heartbeat also stops blocking. It reports `relock-failed`.

**D2. The spec relies on a target-to-viewer control channel that does not exist (medium; fails closed).** `DesktopAead` has only `frame` and `input` directions. `DesktopStreamSession` has no outbound call other than frames. Frames pass through byte-budget and buffer checks that can drop them. The "new reply type" named covers helper to Node only. Current viewers treat unknown plaintext as bad video. Fix: define a tagged control record in the `frame` direction, sent outside the video budget and never dropped, only to a viewer that declared the capability at grant start. No control record, no sheet.

**D3. A refused reply desynchronises held-input state (medium-low; not safety).** Both layers enforce down/up pairing and treat a mismatch as fatal. A key press refused at the shield, then a state change before release, sends an unmatched up and the grant dies. A control held before the lock has its up refused, Node forgets it, and a later SIGKILL leaves it down. Fix: releases of a control the helper actually holds are never refused, in any state. A refused reply leaves Node's and the stream manager's held sets unchanged. An up with no matching down is a refused no-op under the flag.

**D4. With the feature on, secure input from any app applies the allowlist on an unlocked Mac (low-medium; not safety).** A website password field, Terminal with Secure Keyboard Entry, or an app that leaks secure input all hold it. Fix: say "secure input held by loginwindow, or an unreadable owner".

## Left behind

- **Mobile-Complete:** recorded in the spec as a conflict for the operator. P7 passing meets the standard; failing gates the per-Mac flip, never the build.
- Conformance **fit: weak** on the parent principle in rounds 2 and 3, as before: this serves the operator's reach, not a session's.
- Know Your Principal flag (rounds 1 and 2): the PIN is agent-readable. Enabling opens nothing without the password. The wider PIN class deserves its own item.
- Precision from round 6: the decision table still says `secretType` where the body says a reserved attempt's Enter; name `DesktopStreamManager`'s two terminal paths and `releaseBarrier`; terminal markers have no retention rule; `version` must be a helper constant; `relock-pending` applies with the feature off; item 5 should say locked-class; absolute "cannot get in" wording conflicts with the timing exception.
- Precision from round 3: stamp the 15 s rule at Enter; a later `secretType` after `left-unlocked` needs a new marker; a replaced candidate must be strictly newer and the flip bound to the probed digest; enforce the allowlist in the helper and keep `activeSession()` on `type`; idle revoke's relock has no countdown; a Mac inside its delayed-lock window ends its own grant; cache the per-spawn hash; rebase over `f6f3700f0` and recheck the allowlist.
- Precision from earlier rounds: the on-screen keyboard limit is now P13; check the guard's identity on a real Mac (P4, P12).
- Windows and Linux moved to the design note as direction only.

## Apple constraints

- Screen Recording and Accessibility cannot be granted by software on an unmanaged Mac. A person must do it, and MDM can only delegate it.
- The monthly screen recording reconfirmation cannot be bypassed without Apple's `persistent-content-capture` entitlement or MDM (`forceBypassScreenCaptureAlert`).
- No third-party UI over the lock shield, apart from an authorization plug-in, which we refuse.
- A LaunchDaemon must not touch the window server. A pre-login agent runs as root, and launchd ignores `UserName` for it.
- FileVault's pre-boot screen runs no third-party code.
- A Developer ID certificate can be created only by the Account Holder. Restricted entitlements need Apple's approval and a provisioning profile.
- `CGSSessionScreenIsLocked`, `kCGSSessionSecureInputPID` and `SACLockScreenImmediate` are undocumented. Fine for Developer ID, and may change without notice.

## Sources

- Apple DTS, login window architecture, 2026: https://developer.apple.com/forums/thread/814152
- Apple DTS, Sequoia pre-login capture: https://developer.apple.com/forums/thread/768146
- Apple DTS, ScreenCaptureKit in locked and pre-login contexts: https://developer.apple.com/forums/thread/756908
- Apple DTS, screen lock and FileVault, 2020: https://developer.apple.com/forums/thread/129315
- PreLoginAgents readme: https://developer.apple.com/library/archive/samplecode/PreLoginAgents/Listings/Read_Me_About_PreLoginAgents_txt.html
- TN2083: https://developer.apple.com/library/archive/technotes/tn2083/_index.html
- AnyDesk macOS changelog (mirror read): https://anydesk.com.cn/en/changelog/mac-os
- AnyDesk permissions: https://support.anydesk.com/docs/security-permissions-on-macos
- TeamViewer plist locations, community: https://community.jamf.com/general-discussions-2/uninstall-teamviewer-via-script-or-terminal-4975
- RustDesk agent plist: https://github.com/rustdesk/rustdesk/blob/master/src/platform/privileges_scripts/agent.plist
- RustDesk lock screen typing fix: https://github.com/rustdesk/rustdesk/issues/11802
- Persistent content capture entitlement: https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/
- GNOME Remote Login: https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html-single/administering_rhel_by_using_the_gnome_desktop_environment/index
- Tahoe FileVault SSH unlock: https://tidbits.com/2025/09/17/macos-26-tahoe-pushes-filevault-use/

TeamViewer's own article is login-walled, and AnyDesk's file layout comes from a consumer source. Vendor internals here are partly inferred.

## Convergence verdict

Not converged at round 6 of 6. A safety design finding remained at the cap, so the spec carries no convergence tag and no approval, and `/instar-dev` will refuse to build from it. The round 6 findings are recorded above and were deliberately not applied, so the spec text is exactly what round 6 reviewed.

The standing rule that only constitution changes need the operator (operator directive, 2026-10-22) would let Echo approve a spec that converged. It does not apply here. `/spec-converge` sends an at-cap safety failure to the operator.
