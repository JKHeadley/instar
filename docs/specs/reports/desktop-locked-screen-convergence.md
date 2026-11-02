# Convergence Report — Remote desktop through the ordinary Mac lock screen

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran on all ten rounds. Rounds 1 to 7, 9 and 10 returned "SERIOUS ISSUES"; round 8 returned "MINOR ISSUES" with no design finding. Gemini was unavailable (`gemini-not-authed`) and Grok is not enabled, so there was one external family.

**Verdict: DID NOT CONVERGE at round 10. The operator accepted building behind proof gates P12 and P15.** Round 10 raised two design findings, both about safety. Their fixes are written and unreviewed. The convergence tag on this spec records that decision, not a quiet final round. His words, topic 134088, 2026-11-01: "go" at 17:20 PST, "2 minutes" at 17:44 PST accepting "relocks, and tells you if it couldn't", and "Build" at 18:11 PST. No `review-convergence` tag and no `approved` tag were written, and `/instar-dev` will refuse to build from this spec.

## ELI10 Overview

The operator wants to open a locked Mac from a phone. An earlier spec covered both the ordinary lock and the login window, and failed at 6 rounds, mostly on the login window. This run split them. `docs/specs/desktop-login-window.md` now holds the login window as an unapproved note nothing depends on. This spec covers only the ordinary lock, with nothing to install and no root. The operator types the password live into the Instar app's native viewer, the Mac relocks when he finishes, and a hostile program running as him is not stopped.

## Original vs Converged

The split removed the root helper, the step-up, the certificate and the gate. It made the app the phone path and turned the browser box off by default, because the machine serving a page and the tunnel provider can read what is typed there. Review then replaced a loose "two inputs agree" rule with fixed predicates; moved the retained helper to one digest-checked binary per Mac; keyed grant state to the request, since a resumed grant changes id; and gave relock a real state machine, a replaceable guard and a shared lock.

## Iteration Summary

Reviewers ran on the session model, claude-opus-5-5. Round 1 used four panels covering all six lenses. Round 2 used two panels, and rounds 3 to 10 one, all lenses named. Each round also had Codex.

| Round | Reviewers | Design findings (deduped, approximate) | Left behind | Spec changes | Gate |
|---|---|---|---|---|---|
| 1 | 4 panels, Codex | 30 | 9 | Lock predicates, retained helper, request keys, relock, input rules | Standards-Conformance Gate: ran (3 flags) |
| 2 | 2 panels, Codex | 8 | 7 | Dirty field per Mac, marker lock, pin scope, per-Mac disable, rig Mac | Standards-Conformance Gate: ran (1 flag) |
| 3 | 1 panel, Codex | 8, of which 5 about safety | 9 | Relock rewritten, dirty-field exits, display readiness | Standards-Conformance Gate: ran (0 flags) |
| 4 | 1 panel, Codex | 7 | 9 | Guard kill and cap, marker generations, sweep, Forget tombstone, disable reach | Standards-Conformance Gate: ran (2 flags) |
| 5 | 1 panel, Codex | 5 | 8 | Refused input, 15 s rule at Enter, relock-pending, build target | Standards-Conformance Gate: ran (2 flags) |
| 6 | 1 panel, Codex | 5, of which 1 about safety | 7 | Typist stopped first, stale markers, control channel, held keys; operator-required P15 added | Standards-Conformance Gate: ran (2 flags) |
| 7 | 1 panel, Codex | 3 | 10 | Guard death before admission, separate control direction, test-build route to P15 | Standards-Conformance Gate: ran (1 flag) |
| 8 | 1 panel, Codex | 1, marginally about safety | 9 | Unlisted macOS is feature-off; policy and notification freshness; pending-duty row | Standards-Conformance Gate: ran (2 flags) |
| 9 | 1 panel, Codex | 3, all about safety | 10 | Operator's 2-minute watch, one definition of gone, flag-true locked, IV domain 3 | Standards-Conformance Gate: ran (1 flag) |
| 10 | 1 panel, Codex | 2, both about safety | 8 | **None applied**; verbatim below | Standards-Conformance Gate: ran (1 flag) |

## Proportion

About 300 spec lines, 8 of 8 rounds. The run stopped at 3 under a mistaken cap, was corrected to 6, then the operator authorized 2 more with "go" in topic 134088 at 17:20 PST on 2026-11-01, checked in the topic history. Findings ran 30, 8, 8, 7, 5, 5, 3, 1, 3, 2. Round 9 was one round past what the operator authorized. The coordinator ordered it, on the reasoning that it only adds review and makes the feature more restrictive, and said it would tell him.

Disclosure: the round 8 panel brief said a behaviour settled by a proof row is not itself a design finding, which earlier briefs did not say. That may have reduced what it raised. Codex got no such steer. Rounds 9 and 10 used the neutral brief. Round 10 was ordered by the coordinator after the operator chose the 2-minute watch. Its panel brief added that the weaker promise itself is not a finding, while whether the design delivers it is.

## Round 10 findings, verbatim, fixes applied but not re-reviewed

Codex, gpt-6-astra:

**Verdict: SERIOUS ISSUES**

**DESIGN — Admission can reopen before the password producer is stopped.**  
References: **Relock → “Stopping the typist first,” “Admission,” “A dead guard.”**

The spec requires a guard to kill and confirm termination of the recorded `input-stream` helper before judging the lock state. However, the admission recovery path specifies killing only the **guard** before marking an expired duty `relock-failed` and allowing an ordinary grant. Guard replacement exhaustion likewise kills the guard without explicitly stopping the typist. Separately, failure to confirm typist termination can itself end in `relock-failed`, which permits admission.

**Observed in the text:** these terminal paths do not consistently require proof that the password producer is gone.

**Potential consequence, not a measured result:** if Node and the guard stall while the input helper is suspended mid-send, admission recovery can terminate the guard and reopen access. The helper could subsequently resume and post password events after its duty has closed. This is distinct from the explicitly accepted risk of macOS completing an already-posted submission late.

**Resolution:** make confirmed producer termination a prerequisite for reopening admission on every terminal/recovery path that could have started typing. If termination cannot be confirmed, retain an admission-blocking state even when relock has failed. Add a P12/P15 case that suspends the typist and guard, exercises deadline-based admission recovery, then resumes the typist.

This is a textual design finding only. No implementation source or execution results were supplied, so I have not independently verified the stated API behavior or proof outcomes.

Internal panel, claude-opus-5-5:

**D1. Renewal, heartbeat and sweep are undefined during `watching`, so the new promise's "tells you" half can fail.** Safety; medium. The lease is renewed by the server, the server reads the heartbeat "at each renewal", and `relock-failed` is noticed only at each renewal and boot. The watch now runs for 2 minutes after the request is gone, and nothing says renewal continues for a marker whose request has ended. So: (1) the watch ends in `relock-failed`, the guard exits, no renewal fires, and the owner hears nothing until the next boot; (2) a guard dies mid-watch with Node healthy, nobody reads the heartbeat, and the replacement is unreachable; (3) a heartbeat that only answers renewals goes stale once Node dies, and the admission test compares the grant deadline, so another agent can SIGKILL a healthy guard, cut the watch short and write a false `relock-failed`. Fix: the guard writes its heartbeat on its own 1 s tick. The server keeps a sweep timer while any of its markers is non-terminal and until the security item is recorded, independent of any live request. For `watching`, admission compares the stored watch start plus 2 minutes plus slack. Add a P12 case: a guard killed mid-watch after Stop with Node alive is replaced, and a `relock-failed` at watch end raises the item within about 10 s without a boot.

## Left behind

- **Mobile-Complete:** recorded in the spec as a conflict for the operator. P7 passing meets the standard; failing gates the per-Mac flip, never the build.
- Conformance **fit: weak** on the parent principle in rounds 2 and 3, as before: this serves the operator's reach, not a session's.
- Know Your Principal flag (rounds 1 and 2): the PIN is agent-readable. Enabling opens nothing without the password. The wider PIN class deserves its own item.
- Precision from round 10: the pre-lock check must allow `watching` as well as `executing`, or the watch never relocks; the relock trigger should be a fresh sample with the flag false; a user switch during the watch should close `closed-not-applicable`, and one unreadable end sample should retry; relate the two retry counts; the pending-duty row omits `watching`; `enter-pending` now only stamps the 15 s rule; P15's delayed case needs a detached test actor, and split P12's unreaped case; `control` needs a discriminator, `controlRecords` must be forwarded, and `scripts/desktop-compat-vectors.mjs` needs vectors.
- Precision from round 9: a policy refresh triggered by derived state flaps, so trigger on raw inputs; the P4 and P12 fallbacks promise a no-password mode that an unlisted version can no longer reach; a settings edit clears Disable, so clear it only on `enabled: true`; name the server that raises the item for another agent's dead marker; name the process carrying notifications; tie a P15 pass to the helper version constant.
- Precision from round 8: `control` must be binary with a discriminator, since `DesktopMeshStreamRelay` closes on non-binary, and the target holds the latest control state until the socket opens; the pending-duty table row disagrees with Admission; a delayed-password policy can end a grant at start; the unlock receipt has no proof row; a boot retry can lock a following session (safe direction, long-tail).
- Precision from round 7: raised in the report's earlier rows and folded in.
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

**This spec did not converge.** The criterion is a round with zero design findings, and round 10, the last, had two, both about safety. The operator was offered: apply both fixes, then build it switched off on every machine, with no Mac able to turn it on until the crash and Stop tests pass on real hardware. He answered "Build" at 18:11 PST on 2026-11-01 in topic 134088. No further review round ran, by that decision.

The two fixes and the pre-lock \`watching\` item are in the spec, and no reviewer has read them. P12 and P15 are required gates with no fallback, and the enable route refuses a macOS version without both passes. Real-hardware tests of those two rows now stand in for the review that did not finish.

Approval rests on his messages above and on the standing rule that only constitution changes need him (2026-10-22). Neither says the spec converged. Machine-readable tags here mean "cleared to build dark", and a reader should trust this paragraph over the tag name.
