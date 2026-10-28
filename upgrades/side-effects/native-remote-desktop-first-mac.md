# Side effects review: native remote desktop first Mac

## Summary

Tier 2 security-sensitive first-machine slice of the approved blocker hand-off spec, incorporating Justin's direct-access and PIN-only clarifications. This adds one local macOS display/input host, a browser viewer, and a process-local ten-minute grant after dashboard PIN entry. It is dark by default, limited to development agents, and does not advertise Windows or Linux as ready. Justin superseded the Telegram challenge in topic 131439 on 2026-10-27 at 23:41 PDT after reviewing the first live page.

## Decision points touched

- Desktop admission in `DirectDesktopAccess`: added. Requires an explicit target, live dashboard PIN session, browser key proof, healthy local host, and a ten-minute lease. The PIN page states the full-control scope.
- Stream and input admission in `DesktopStreamManager`: added. Rechecks the live grant at point of use, enforces one controller, queue and rate bounds, expiry and revocation.
- Production boot in `AgentServer`: added. Explicit config plus development role, macOS and machine identity; uncertainty leaves it dark. Telegram is not required for desktop admission.

## 1. Over-block

A legitimate operator without macOS Screen Recording/Accessibility permission cannot begin control. A second browser or changed target key is refused even if the dashboard PIN is correct. If the PIN is unavailable or its operator session expires, display and input are refused. The PIN-only choice loses independent Telegram identity assurance; this is an explicit operator revision.

## 2. Under-block

This first target is local to Echo. It does not provide cross-machine grant routing or a Windows/Linux host. The macOS helper has an ad-hoc local code signature, so the test package is not suitable as a signed fleet installer. A desktop grants the human control of the logged-in OS session; actions performed in other apps remain governed by those apps. Frame/input data stays in memory and is not recorded by this feature.

## 3. Level of abstraction

The target owns grant authority because only it can prove its display/input session and stop the stream. `DesktopHost` isolates the OS adapter. The browser cannot mint or extend a grant. A successful dashboard PIN unlock mints a short-lived operator session which the target rechecks while streaming. The write-domain registry marks requests machine-local and ephemeral; restart destroys keys and grants.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, no lexical detector decides whether a person may control the host. Admission is a finite security policy over the PIN-derived session, browser possession proof, target key, lease, and live OS state. Each failed proof denies the specific privileged operation. The lower-level readiness probe is only a signal for availability; it does not grant access. The PIN proves credential possession, not a named human identity.

## 5. Interactions

The desktop viewer uses the existing dashboard PIN session. Server boot keeps the feature dark unless the host and machine identity are available. Revoke closes the WebSocket and cancels held input; a server restart drops all grants. The new route prefix is classified in `WriteDomainRegistry` and listed in `CapabilityIndex`.

The capability description and generated agent awareness both describe the same PIN-only path. A stale capability description that still named Telegram approval and a fingerprint was corrected after the live flow changed.

## 6. External surfaces

On an explicitly enabled development Mac, the Machines page offers “Open this machine.” The viewer uses the same named tunnel and opens from PIN submission. It presents machine control in plain language and requires no Telegram setup, copied command, topic picker, checkbox, or fingerprint dialog. No cross-agent notice is emitted by this slice. The local Swift helper displays a menu bar indicator during control.

## 6b. Operator-surface quality

The viewer leads with its primary action: enter the existing dashboard PIN and open this machine. Its heading names the Mac Studio before access, and the explanation says plainly that clicks and typing affect open apps and can change files or settings. It exposes no keys, request IDs, fingerprints, topic numbers, or protocol details as primary content. Stop access is visible during control but styled as a secondary danger action rather than the first call to action. The form and live image fit phone width, with short labels and readable text. Justin's phone screenshot caught a stale-script error before PIN entry; the page now loads a content-versioned script with no-store headers. A fresh real Chrome browser completed the public HTTPS PIN-to-frame, click, and Stop path after deployment.

## 7. Multi-machine posture

Machine-local by design for this first target: display, input, grants, keys, and redacted audit belong to the physical host. Nothing is transferred with a conversation owner. The machine ID and signing key bind the browser to this target. A peer is not listed as controllable until it has its own live adapter and target server. The existing named tunnel is used for the local viewer link; no ephemeral URL is persisted.

## 8. Rollback cost

Set `remoteDesktop.enabled` false and restart Echo: admission and streams close. The local package overlay can be replaced with the saved installed package; no grant state needs migration. A redacted local audit may remain. Other dashboard functions are unaffected. A failed local enablement must restore the package and config before claiming success.

## Conclusion

The revised first-Mac design is appropriate for a controlled operator test after PIN-to-stream, frame, input and revoke checks pass. It cannot be described as all-machine access or as independent human identity verification. The code preserves a generic host adapter seam for the Windows/WSL and Linux work tracked in topic 131439.

## Second-pass review

**Original reviewer:** desktop_side_effects_review. **Independent read: concur with condition.** This review covered the earlier Telegram design. Justin superseded its approval flow after live UX feedback; Astra's review found the PIN-only direction consistent with the dashboard surface standard if the loss of independent-factor assurance is recorded and session, revocation, audit, and PIN limits remain enforced. A code review of the revised path is still required before claiming it verified. Before deployment, preserve installed 1.3.1482 changes and verify the installed package version after overlay.

**Revised-path reviewer:** Astra reviewed the changed code and found no concrete replay or expired-session admission bypass. It identified a direct-network plaintext PIN path and three viewer retry failures. The revised code now limits desktop PIN and stream admission to local or TLS transport, keeps the Unlock form reachable when the target is unavailable, revokes a grant if setup fails, and returns to PIN entry when the session expires. The first-use fingerprint dialog is gone; the target key is pinned on first authenticated dashboard use and refused if it later changes. The residual is that first-use trust comes from the dashboard server, not an independent out-of-band fingerprint comparison.

The full integration suite exposed a dark-feature shutdown mock without `setDesktopApprovalHandler`. Shutdown now clears the handler only when desktop access was initialized and the adapter offers that method. Grant revocation still runs first. The same reviewer checked this teardown fix and concurred.

## Evidence pointers

`tests/unit/DirectDesktopAccess.test.ts`, `tests/integration/desktop-routes.test.ts`, `tests/e2e/desktop-boot-lifecycle.test.ts`; live Mac test command used `DESKTOP_LIVE_TEST=1` and exercised real ScreenCaptureKit capture, CGEvent pointer movement and revoke. A fresh Chrome DevTools session loaded the public named tunnel, entered the real dashboard PIN from the encrypted local config, received a 1920×1080 frame, clicked the image, and confirmed Stop cleared control. The first full suite found two scanner false positives in `AgentServer.ts` (one new fail-dark PIN-store catch, one read-only price catch shifted outside a 20-line marker window); both now have in-window documented exemptions and the focused ratchet returns its 494 baseline.

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.
