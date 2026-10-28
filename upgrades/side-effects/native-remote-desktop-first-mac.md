# Side effects review: native remote desktop first Mac

## Summary

Tier 2 security-sensitive first-machine slice of the approved blocker hand-off spec, incorporating Justin's direct-access clarification. This adds one local macOS display/input host, a browser viewer, verified Telegram step-up, and a process-local ten-minute grant. It is dark by default, limited to development agents, and does not advertise Windows or Linux as ready. The first pass is 37 files / about 2,350 added lines; the gate repair adds six runtime/test files. Spec convergence took six rounds. One commit gate attempt found missing side-effects trace, so this artifact records that review.

## Decision points touched

- Desktop admission in `DirectDesktopAccess`: added. Requires an explicit target, verified topic operator, dashboard PIN session, browser key proof, scope confirmation, healthy local host, and owner Telegram DM challenge.
- Stream and input admission in `DesktopStreamManager`: added. Rechecks the live grant at point of use, enforces one controller, queue and rate bounds, expiry and revocation.
- Production boot in `AgentServer`: added. Explicit config plus development role, macOS, machine identity, Telegram and operator binding; uncertainty leaves it dark.
- Telegram reply interception: added. Authenticated `/desktop` replies are consumed before normal logging and never become regular chat commands.

## 1. Over-block

A legitimate operator without a working private Telegram DM or macOS Screen Recording/Accessibility permission cannot begin control. This is deliberate for the first local test because the independent identity and OS boundaries cannot be proven otherwise. A second browser or a stale fingerprint is refused even if the dashboard PIN is correct.

## 2. Under-block

This first target is local to Echo. It does not provide cross-machine grant routing or a Windows/Linux host. The macOS helper has an ad-hoc local code signature, so the test package is not suitable as a signed fleet installer. A desktop grants the human control of the logged-in OS session; actions performed in other apps remain governed by those apps. Frame/input data stays in memory and is not recorded by this feature.

## 3. Level of abstraction

The target owns grant authority because only it can prove its display/input session and stop the stream. `DesktopHost` isolates the OS adapter. The browser cannot mint or extend a grant. Telegram is an independent, authenticated step-up channel; dashboard PIN is only the first factor. The write-domain registry marks requests machine-local and ephemeral; restart destroys keys and grants.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, no lexical detector decides whether a person may control the host. Admission is a finite security policy over cryptographic proof, verified identity, scope, lease, and live OS state. Each failed proof denies the specific privileged operation. The lower-level readiness probe is only a signal for availability; it does not grant access. There is no competing-signals judgment point here: possession, identity, scope, and expiry are invariants.

## 5. Interactions

The desktop viewer uses the existing dashboard PIN session but a separate Telegram challenge. Telegram lifeline interception runs before Instar's durable inbound queuing, so a challenge reply is not written to Instar's message log or handled as a normal agent command. The reply remains visible in Telegram topic history; its one-use code is bound to the verified sender and request. Server boot keeps the feature dark unless every dependency is present. Revoke closes the WebSocket and cancels held input; a server restart drops all grants. The new route prefix is classified in `WriteDomainRegistry` and listed in `CapabilityIndex`.

## 6. External surfaces

On an explicitly enabled development Mac, the Machines page offers “Open this machine.” The viewer uses the same named tunnel and requires a private DM approval. The DM contains a short code and target fingerprint; neither is posted to the topic. No cross-agent notice is emitted by this slice. The local Swift helper displays a menu bar indicator during control.

## 7. Multi-machine posture

Machine-local by design for this first target: display, input, grants, keys, and redacted audit belong to the physical host. Nothing is transferred with a conversation owner. The machine ID and signing key bind the browser to this target. A peer is not listed as controllable until it has its own live adapter and target server. The existing named tunnel is used for the local viewer link; no ephemeral URL is persisted.

## 8. Rollback cost

Set `remoteDesktop.enabled` false and restart Echo: admission and streams close. The local package overlay can be replaced with the saved installed package; no grant state needs migration. A redacted local audit may remain. Other dashboard functions are unaffected. A failed local enablement must restore the package and config before claiming success.

## Conclusion

The first-Mac design is appropriate for a controlled operator test after the full suite and live identity, frame, input and revoke checks pass. It cannot be described as all-machine access. The code preserves a generic host adapter seam for the Windows/WSL and Linux work tracked in topic 131439.

## Second-pass review

**Reviewer:** desktop_side_effects_review. **Independent read: concur with condition.** The reviewer found no concrete grant, input, browser-key or Telegram admission bypass. Before deployment, preserve installed 1.3.1481 changes, especially the WorktreeCreate/WorktreeRemove hook removal in `4c1251ab5`; verify the installed package version after overlay. The reviewer also required the Telegram-topic-visibility clarification above.

The full integration suite exposed a dark-feature shutdown mock without `setDesktopApprovalHandler`. Shutdown now clears the handler only when desktop access was initialized and the adapter offers that method. Grant revocation still runs first. The same reviewer checked this teardown fix and concurred.

## Evidence pointers

`tests/unit/DirectDesktopAccess.test.ts`, `tests/integration/desktop-routes.test.ts`, `tests/e2e/desktop-boot-lifecycle.test.ts`; live Mac test command used `DESKTOP_LIVE_TEST=1` and exercised real ScreenCaptureKit capture, CGEvent pointer movement and revoke.

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.
