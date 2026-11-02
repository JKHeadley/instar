# Convergence Report — Remote desktop through the ordinary Mac lock screen

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran on all nine rounds. Rounds 1 to 7 and 9 returned "SERIOUS ISSUES"; round 8 returned "MINOR ISSUES" with no design finding. Gemini was unavailable (`gemini-not-authed`) and Grok is not enabled, so there was one external family.

**Verdict: NOT CONVERGED after 9 rounds.** The confirming round 9 raised three design findings, all about safety. No `review-convergence` tag and no `approved` tag were written, and `/instar-dev` will refuse to build from this spec.

## ELI10 Overview

The operator wants to open a locked Mac from a phone. An earlier spec covered both the ordinary lock and the login window, and failed at 6 rounds, mostly on the login window. This run split them. `docs/specs/desktop-login-window.md` now holds the login window as an unapproved note nothing depends on. This spec covers only the ordinary lock, with nothing to install and no root. The operator types the password live into the Instar app's native viewer, the Mac relocks when he finishes, and a hostile program running as him is not stopped.

## Original vs Converged

The split removed the root helper, the step-up, the certificate and the gate. It made the app the phone path and turned the browser box off by default, because the machine serving a page and the tunnel provider can read what is typed there. Review then replaced a loose "two inputs agree" rule with fixed predicates; moved the retained helper to one digest-checked binary per Mac; keyed grant state to the request, since a resumed grant changes id; and gave relock a real state machine, a replaceable guard and a shared lock.

## Iteration Summary

Reviewers ran on the session model, claude-opus-5-5. Round 1 used four panels covering all six lenses. Round 2 used two panels, and rounds 3 to 9 one, all lenses named. Each round also had Codex.

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
| 9 | 1 panel, Codex | 3, all about safety | 10 | **None applied**; verbatim below | Standards-Conformance Gate: ran (1 flag) |

## Proportion

About 300 spec lines, 8 of 8 rounds. The run stopped at 3 under a mistaken cap, was corrected to 6, then the operator authorized 2 more with "go" in topic 134088 at 17:20 PST on 2026-11-01, checked in the topic history. Findings ran 30, 8, 8, 7, 5, 5, 3, 1, 3. Round 9 was one round past what the operator authorized. The coordinator ordered it, on the reasoning that it only adds review and makes the feature more restrictive, and said it would tell him.

Disclosure: the round 8 panel brief said a behaviour settled by a proof row is not itself a design finding, which earlier briefs did not say. That may have reduced what it raised. Codex got no such steer. Round 9 used the neutral brief again, and found more.

## Round 9 findings, verbatim, not applied

Codex, gpt-6-astra:

**Verdict: SERIOUS ISSUES**

- **DESIGN — Relock / “Stopping the typist first”; P15; Honest limits.** The guard can close its duty too early. The spec explicitly permits concluding that the Mac is already locked after a 10-second `enter-pending` watch, while also acknowledging that a submission could unlock after that window. Killing the helper prevents future event posting; it does not establish that an already-posted submission has finished processing. Consequently, the stated sequence allows `relocked` followed by a delayed unlock, with the guard gone and subsequent admission permitted.

  P15 measures observed latency, but the text supplies no mechanism that makes that measured latency an upper bound. This is a gap in the central relock guarantee, rather than an undiscovered empirical result.

  **Resolution:** Separate “currently locked” from “submission resolved.” Keep an unresolved submission’s duty and admission barrier active until a trustworthy completion condition exists, or explicitly weaken the relock guarantee and obtain acceptance of that behavior. A longer fixed timeout alone does not resolve the architectural gap. P15 should include delayed submission completion beyond the timeout, not merely measure ordinary completion times.

**Evidence boundary:** This is a textual state-machine finding, not a reproduced macOS failure. The supplied material contains proposed proof procedures, not their results or implementation source. The native password path, TOFU limitations, and exclusion of hostile same-user code are otherwise clearly explained; I found no basis here to recommend an LLM-mediated authorization layer or additional consent flow.

Internal panel, claude-opus-5-5:

**D1. "Confirmed gone" fails for a killed child of a hung Node, which breaks the hung-Node relock promise.** Safety, yes (Mac left unlocked). Medium. Measured: a SIGKILLed child whose parent has not reaped it stays in state `Z`; `kill(pid,0)` still succeeds and `ps` still reports its start time, so a pid-plus-start-time check reads it as alive. `input-stream` is Node's child. If Node is suspended the helper cannot be reaped, the check never passes, and the duty is held, retried, then goes `relock-failed` with the Mac unlocked. Takeover and admission hit the same problem, because the guard is also Node's child unless double-forked. Fix: define "gone" once for all three sites: no such process, or a different start time, or process state zombie. Add a P12 case: a suspended Node with an unreaped helper still ends with the Mac locked.

**D2. The guard's "already locked" can be satisfied by a locked-class reading, which closes the duty as `relocked` on an unlocked Mac.** Safety, yes. Low to medium. The only "locked" concept the spec defines is locked-class, justified by "a wrong locked costs refused typing". For relock the costs reverse. With a screensaver running and the flag false, the policy row reads locked-class whenever the policy is on, delayed, unreadable, or (new this round) mid-refresh. Fix: "for relock, locked means a fresh sample with the flag true; a policy-row reading with the flag false does not count, and the guard reads no policy."

## Left behind

- **Mobile-Complete:** recorded in the spec as a conflict for the operator. P7 passing meets the standard; failing gates the per-Mac flip, never the build.
- Conformance **fit: weak** on the parent principle in rounds 2 and 3, as before: this serves the operator's reach, not a session's.
- Know Your Principal flag (rounds 1 and 2): the PIN is agent-readable. Enabling opens nothing without the password. The wider PIN class deserves its own item.
- Precision from round 9: a policy refresh triggered by derived state flaps, so trigger on raw inputs; the P4 and P12 fallbacks promise a no-password mode that an unlisted version can no longer reach; `iv()` and `recordIv` use a two-way direction test, so `control` needs an explicit domain 3 and a unit test or it reuses a GCM nonce; a settings edit clears Disable, so clear it only on `enabled: true`; name the server that raises the item for another agent's dead marker; name the process carrying notifications; tie a P15 pass to the helper version constant.
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

Not converged after 9 rounds. The report states 9 rounds: 8 authorized by the operator, plus one confirming round ordered by the coordinator. Round 9 raised three design findings, all about safety, so no `review-convergence` or `approved` tag was written, and `/instar-dev` will refuse to build from this spec. As instructed, the findings are unapplied and the spec is exactly what round 9 reviewed.

The operator's "go" (topic 134088, 2026-11-01 17:20 PST) and the standing rule that only constitution changes need him (2026-10-22) would cover approval of a converged spec. Neither replaces convergence.
