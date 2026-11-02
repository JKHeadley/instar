# Convergence Report — Remote desktop through the ordinary Mac lock screen

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran on all three rounds. Each returned "SERIOUS ISSUES". Gemini was unavailable (`gemini-not-authed`) and Grok is not enabled, so there was one external family.

**Verdict: NOT CONVERGED. Failed at the 3-round cap.** Round 3 raised safety design findings. No `review-convergence` tag and no `approved` tag were written, and `/instar-dev` will refuse to build from this spec.

## ELI10 Overview

The operator wants to open a locked Mac from a phone. An earlier spec covered both the ordinary lock and the login window, and failed at 6 rounds, mostly on the login window. This run split them. `docs/specs/desktop-login-window.md` now holds the login window as an unapproved note nothing depends on. This spec covers only the ordinary lock, with nothing to install and no root. The operator types the password live into the Instar app's native viewer, the Mac relocks when he finishes, and a hostile program running as him is not stopped.

## Original vs Converged

The split removed the root helper, the step-up, the certificate and the gate. It made the app the phone path and turned the browser box off by default, because the machine serving a page and the tunnel provider can read what is typed there. Review then replaced a loose "two inputs agree" rule with fixed predicates; moved the retained helper to one digest-checked binary per Mac; keyed grant state to the request, since a resumed grant changes id; and gave relock a real state machine, a replaceable guard and a shared lock.

## Iteration Summary

Reviewers ran on the session model, claude-opus-5-5. Round 1 used four panels covering all six lenses. Round 2 used two panels, and round 3 one, all lenses named. Each round also had Codex.

| Round | Reviewers | Design findings (deduped, approximate) | Left behind | Spec changes | Gate |
|---|---|---|---|---|---|
| 1 | 4 panels, Codex | 30 | 9 | Lock predicates, retained helper, request keys, relock, input rules | Standards-Conformance Gate: ran (3 flags) |
| 2 | 2 panels, Codex | 8 | 7 | Dirty field per Mac, marker lock, pin scope, per-Mac disable, rig Mac | Standards-Conformance Gate: ran (1 flag) |
| 3 | 1 panel, Codex | 8, of which 5 about safety | 9 | Fixes written, **not re-reviewed** | Standards-Conformance Gate: ran (0 flags) |

## Proportion

About 300 spec lines, 3 of 3 rounds. The cap was the operator's instruction for this run. By `/spec-converge`'s own size rule a password path is security-sensitive, which would be Tier 2+ with a cap of 6. Findings fell from 30 to 8, then held at 8, and round 3's were narrow gaps in relock and dirty-field state, not new attack paths.

## Round 3 findings, fixes unreviewed

Safety:
1. A dead guard left the Mac open with nothing noticing, and `executing` had no way out. Now the guard answers each renewal, gets replaced, and `executing` can be taken over.
2. "Boot resumes renewing" was wrong: requests are memory-only, so a restart left an open Mac with no viewer. Now boot relocks.
3. Node and Swift had no shared lock. Now every change goes through a helper verb using `flock`.
4. A guard could lock whoever else was on console. Now it re-checks and closes without locking.
5. A disable did not reach another agent's live grant. Now the probe and each `secretType` read it.

Not safety:
6. `field-dirty` had no exit on the normal path, which broke the feature. Now Enter and `unlocked` clear it.
7. A Mac locked with its display asleep likely fails readiness (`displayCount`), which is the commonest locked state. Read from SDK headers, not measured; now P10.
8. The pin's label rule could refuse a phone permanently. Now a stronger tap and a Forget action.

## Left behind

- **Mobile-Complete:** recorded in the spec as a conflict for the operator. P7 passing meets the standard; failing gates the per-Mac flip, never the build.
- Conformance **fit: weak** on the parent principle in rounds 2 and 3, as before: this serves the operator's reach, not a session's.
- Know Your Principal flag (rounds 1 and 2): the PIN is agent-readable. Enabling opens nothing without the password. The wider PIN class deserves its own item.
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

Not converged at round 3 of 3. Safety design findings remained at the cap, and their fixes are unreviewed, so the spec cannot honestly carry a tag. It stays unapproved.

The standing rule that only constitution changes need the operator (operator directive, 2026-10-22) would let Echo approve a spec that converged. It does not apply here, because this one did not, and `/spec-converge` sends an at-cap safety failure to the operator.
