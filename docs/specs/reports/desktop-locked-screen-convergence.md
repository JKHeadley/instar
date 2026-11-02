# Convergence Report — Remote desktop into locked machines

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran on all six rounds. Every round returned "SERIOUS ISSUES", with three to four findings each, and the findings kept getting narrower. Gemini was unavailable (`gemini-not-authed`), so there was one external family, not two. The Grok family was not enabled.

**Verdict: NOT CONVERGED. Failed at the cap.** Round 6 of 6 raised safety-related design findings. The skill's rule at the cap is to stop and ask the operator. No `review-convergence` tag and no `approved` tag were written.

## ELI10 Overview

The operator wants to open a locked Mac from a phone, as AnyDesk does. The main finding is that "locked" is several situations. The ordinary lock screen happens inside the user's own session, so no powerful helper is needed: the existing helper has to stop refusing and keep working through the lock. Only the login window after a restart, logout or user switch needs a new helper that macOS runs as root.

So the design has two tiers. Tier 1 covers the ordinary lock. It installs nothing, and the Mac's own password is the real barrier. Tier 2 covers the login window. It is designed here but not committed: Instar offers it when real rescue attempts keep failing there, and only the operator decides. FileVault's pre-boot screen and a fully asleep Mac stay out of reach for anyone.

The password is typed live, sealed for one small helper, and has no way to be stored. The Mac relocks when the session ends, and a Mac that cannot prove relock does not get a password box.

## Original vs Converged

- **"Login-window helper fixes locked Macs"** became two tiers. Reviewers and Apple's own material showed the helper never runs at the ordinary lock.
- **"A step-up no session can produce"** was false on Tier 1. The verifier, keys and helper are all writable by the same user. Tier 1's step-up was removed, and the spec now says plainly that Tier 1 does not stop hostile code running as the user. Tier 1 no longer depends on the mobile app, push or Telegram.
- **"Telegram tap as fallback"** was removed. Agents hold the operator's Telegram login in this deployment, so a tap proves nothing.
- **"The front sees ciphertext only"** was false for a browser viewer, because the front serves the page. It is now a stated limit.
- **The grant model** gained real transitions: a grant ends if a person unlocks locally, so nobody can wait at the shield for that.
- **Relock** went from a Node action to a detached guard with its own deadline and lease, and a logged-in Aqua agent on Tier 2, so a crash or update cannot leave a Mac open.
- **Tier 2** changed: a role account, outbound-only dial, a fork-safe roster, first key confirmed at the Mac, one designated front, and a measured offer rather than a committed phase.

## Iteration Summary

Reviewers below are internal Claude subagents on claude-opus-5-5 (the session's model), plus Codex. Rounds 3 to 6 combined the internal lenses into one reader to control cost; all lenses were named in each brief.

| Round | Reviewers | Design findings | Left behind | Spec changes | Gate |
|---|---|---|---|---|---|
| 1 | security, adversarial, integration, decision-completeness, lessons, platform facts, Codex | about 40 raw, heavily overlapping | a few | Full rewrite | ran (3 flags) |
| 2 | 3 combined panels, Codex | about 16 | 4 | Tier 1 simplified, step-up moved to Tier 2 | ran (4 flags) |
| 3 | combined, Codex | 7 | 4 | Local-unlock rule, relay, roster, Aqua relock holder | ran (1 flag) |
| 4 | combined, Codex | 6 | 3 | Carry binding, one front, allowlist | ran (1 flag) |
| 5 | combined, Codex | 6 | 1 | Lease, fork rule, attempt event, seal anchor | ran (2 flags) |
| 6 | combined, Codex | 6 (5 about safety or security) | 0 | Fixes written, **not re-reviewed** | ran (1 flag) |

## Proportion

Tier 2+ (security-sensitive), about 500 spec lines, 6 of 6 rounds. Effort was in line for the attack surface. Most late findings were in Tier 2, which is uncommitted: the spec is carrying a large design that nobody has decided to build.

## Round 6 findings, fixes unreviewed

These are written into the spec but no reviewer has seen them.

Tier 1:
1. Attempts were reserved before Enter, so a half-typed field could be submitted around the count. Now reserved before the first character, with input blocked until the field clears.
2. The guard did not confirm duty before typing, so Node dying right after the marker left a gap. Now it must acknowledge a lease first.
3. Relock at the ten-minute ceiling gave no warning. Now a 60 s countdown offers Leave unlocked. Not a safety item.

Tier 2:
4. A password logging in a different account left no relock holder. Now a relock-only record.
5. The app-started rate-limit exemption had no proof. Now needs a fresh roster signature.
6. A pending request could sit on the one grant slot. Now a signed request replaces it, with a 150 s bound.

## Left behind

- Standards-Conformance flag, **Mobile-Complete Operator Actions**: the macOS Screen Recording and Accessibility grants may need a person at the Mac. Apple allows no automation on an unmanaged Mac, and the standard grants no exception. This needs the operator's acceptance or a standard change; it cannot be designed away. L12 tests whether the phone can do it through the viewer.
- Conformance **fit: weak** on every round: the checker reads "The Agent Is Always Reachable" as being about sessions, and this feature serves the operator's reach. Parent principle may be worth reconsidering.
- The dashboard PIN readable by agents is a wider class: the same PIN gates kill arming, money commits, mandates and guard acceptance. Out of scope; deserves its own item.
- The single designated front contradicts decentralized-by-default and carries over from the mesh spec.
- Windows and Linux are direction only and need their own specs.
- Precision items: a hostile relay can fake the page; the agent awareness wording; Tart VM limits on secure-field proof; a stuck secure-input holder.

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

Not converged at round 6 of 6. Safety design findings remained at the cap. Their fixes are written and unreviewed, so the spec cannot honestly carry a convergence tag. It stays unapproved, and `/instar-dev` will refuse to build from it.

The standing rule that only constitution changes need the operator would cover approval of a converged spec. It does not apply here, because this one did not converge, and the skill sends an at-cap safety failure to the operator.

The recommended way forward is to split Tier 2 into its own spec, then run a fresh convergence on the much smaller Tier 1. Almost all late findings came from Tier 2, which is uncommitted.
