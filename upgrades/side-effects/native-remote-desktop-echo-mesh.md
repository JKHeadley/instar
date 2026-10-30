# Side-Effects Review — Echo mesh remote desktop

**Version / slug:** `native-remote-desktop-echo-mesh`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** Astra
**Tier / size / effort:** Tier 2 security-sensitive extension; parent approved spec had six convergence rounds and one focused Astra artifact correction round. The first commit gate found three direct test cleanups and two unmarked WSL discovery subprocesses; both are corrected here.

## Summary of the change

Extends the approved native remote desktop from one Mac Studio to the five registered Echo machines. The existing PIN dashboard becomes the designated front; signed, one-use assertions let a target machine issue its own short grant. Bounded encrypted streams cross the front without decryption. The target owns capture, input, one-controller locking, expiry, and Stop. A Windows interactive companion serves Mama PC's WSL agent; the other Macs use the packaged helper. The implementation touches the dashboard viewer, machine-auth and dashboard routes, `AgentServer` wiring, native hosts, installer, config activation, scaffold awareness, CI packaging, and three test tiers.

## Decision-point inventory

- Dashboard front admission — add: require a live PIN session, registered target, available peer, three remote-slot capacity, and a target-bound browser key.
- Target delegation — add: require the designated front's machine signature, a one-use signed assertion, exact target/browser/nonce binding, and short liveness.
- Stream relay — add: allow one-use tickets and bounded ciphertext; close both ends on backpressure or Stop.
- Host adapters — modify/add: require live interactive desktop, visible indicator, one physical controller, authenticated input lease, and immediate held-input release.
- Config activation — add: explicit opt-in followed by an existing supervised restart; rejects unconfigured hosts.

---

## 1. Over-block

A sleeping, locked, or permissionless Mac is intentionally disabled even if it appears online in the pool. A laptop whose tunnel and direct route are unreachable cannot be opened until a fresh target probe succeeds. The Windows companion refuses a second installer while one holds its process lock and refuses replacement while the old scheduled task still runs. These can delay a legitimate session, but admitting uncertain input control would be worse. A target with an unregistered signing key is unavailable until identity enrollment is repaired.

## 2. Under-block

The dashboard PIN proves possession of that credential, not a separately verified human. A party with that PIN and access to the designated dashboard can request the same operator action as Justin. A compromised target OS can misrepresent its own screen or input state; the browser verifies the registered machine signature, not host integrity. Windows normal-privilege input may not reach elevated applications under UIPI. A process crash can leave the old Windows task dark briefly; the installer retries on next boot and never force-stops a running task.

WSL companion discovery runs two bounded synchronous commands at server startup. They now enter Instar's existing in-flight sync marker, so the supervisor can distinguish their bounded work from an unresponsive server. The change adds no new restart decision or persistent desktop state. Replay-store tests clean temporary directories through `SafeFsExecutor`, preserving the normal destructive-file audit.

## 3. Level-of-abstraction fit

PIN verification remains in the dashboard authority. Machine identity remains in the pool machine-auth layer; the target alone issues grants. The front only routes authenticated calls and ciphertext. The Windows companion is a constrained host adapter, not a new general network desktop service. Structural validators enforce cryptographic and transport invariants; they do not infer conversational intent.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle judgment authority is added. The new refusals are hard security invariants: malformed signed assertions, wrong machine identity, expired grant, absent screen permission, closed controller lease, and bounded transport frames.

The existing PIN and target grant authorities remain the sole admission path. A peer health observation is only a readiness signal; it does not issue a grant.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The exact front identity, grant validity, controller count, time limits, and frame limits are enumerated security invariants. A failed probe reports unavailable; it does not judge user intent.

## 5. Interactions

- **Shadowing:** Target dashboards stay dark for browser admission while machine-auth target routes remain live. The ordinary Bearer peer-URL guard is unchanged; only desktop relay traffic may use a Tailscale CGNAT HTTP peer when the local daemon confirms its online node key.
- **Double-fire:** Both explicit Stop and the target's missed-heartbeat deadline may revoke. Revocation is idempotent, and a later resume is refused after Stop.
- **Races:** The broker reserves pending begins and quarantines a restarted front for 25 seconds, longer than the delegated session's 20-second liveness. Stop validates the PIN session, forgets local authority, aborts in-flight calls, and closes active and pending relay sockets before any peer lookup. A late ticket response cannot reopen a stopped request. Windows update uses a process-owned lock, staged compilation, token-bound prepare/commit/cancel, and a stopped-task check before replacement. Per-start lease IDs fence stale async cleanup and Stop-before-Start.
- **Feedback loops:** The front only reads readiness and sends bounded keepalives. A failed link cannot create a new grant; it makes the existing target grant expire.

## 6. External surfaces

The designated dashboard now lists registered machines by nickname and a plain unavailable reason. Other machine dashboards remain dark for local desktop admission. New machine-auth routes and a scoped Bearer maintenance route are exposed, but neither accepts a raw PIN or grants control without the target's verifier. The replay ledger persists per target; delegated sessions are memory-only and disappear on restart. Neither stores screen frames or input payloads. Windows installs a visible interactive scheduled task and private shared secret under the Windows user's LocalAppData. `/desktop/activate-config` restarts the whole agent server, interrupting live connections; the front then waits 25 seconds before remote admission. On WSL, boot installs or verifies the companion before server initialization; installer failure leaves desktop disabled while the rest of Instar starts. There are no Telegram approval messages or new operator setup steps; Justin uses the existing dashboard PIN and machine picker.

## 6b. Operator-surface quality

1. **Primary action:** The PIN entry appears first. With multiple registered hosts, the machine picker shows every nickname and an unavailable reason before the operator chooses a ready host. A link naming one ready host opens it directly; a single-host roster also opens directly.
2. **Raw internals:** Cards show nicknames and human-readable availability; IDs and keys stay out of the visible labels.
3. **Destructive action:** Stop is available throughout a session without replacing the primary viewer.
4. **Phone width:** The existing full-screen viewer, pinch zoom, and keyboard controls are preserved. The new picker is a native select in the same responsive panel. Final phone-width and live-machine verification is a release gate, not inferred from source.

The entry copy now describes the chosen machine rather than calling it a first Mac version. The public browser smoke reports the selected machine, accepts an explicit any-resolution mode for hosts whose displays differ from Studio's 1920 × 1080, and checks live cursor readback and post-Stop refusal. Neither change affects admission or target authority.

## 7. Multi-machine posture

**Proxied-on-read:** The front probes each registered target through signed pool routes and relays encrypted streams. **Machine-local by design:** screen permissions, active login state, Windows companion pairing, controller lease, and revocation are truths owned by each physical host. One designated front prevents duplicate pool-level grants. The feature emits no new user-facing notices; the viewer link points to the stable front tunnel. Durable target state expires and does not follow a topic transfer, because a desktop grant belongs to a physical host and browser session.

## 8. Rollback cost

Disable `remoteDesktop.enabled` on each machine and request a supervised restart; the target then rejects new grants and current sessions end. Reverting the package removes the routes. Replay ledgers can remain inert; no data migration is needed. The Windows companion's scheduled task and authenticated listener can remain running after Instar desktop is disabled. Complete Windows rollback also disables or removes that task and its LocalAppData files. The server restart interrupts existing connections, and a bad rollout can temporarily remove remote desktop availability while the patch propagates.

## Conclusion

The design keeps input authority on the physical target and adds only bounded, signed delegation from the existing PIN dashboard. Source review closed the Windows installer races before release. Shipping remains conditional on CI and live screen, input, and Stop proof on each advertised machine.

## Second-pass review

**Reviewer:** Astra
**Independent read of the artifact:** Concur after correction. Astra identified an incorrect persistence claim, omitted restart effects and admission delay, and an incomplete Windows rollback description. Those statements are corrected above. Astra confirmed the artifact matches the implementation and found no remaining authority concern; CI and live per-machine verification remain release gates.

**Final picker pass:** Astra found that auto-opening the only ready host hid unavailable machines and their reasons. The picker now remains visible for a multi-machine roster, gives each unavailable option its reason, and disables Open when none are ready. Astra rechecked the change and concurred; the focused viewer regression passes 8/8.

**Commit-gate correction pass:** Astra reviewed the bounded `withSyncOp` wrappers and `SafeFsExecutor` test cleanup and concurred. Both lints pass, and the focused Windows host and replay-store tests pass 7/7.

## Evidence pointers

- `docs/specs/blocker-handoff-across-machines-and-surfaces.md` — approved converged source spec.
- `docs/specs/native-remote-desktop-echo-mesh.md` — rollout architecture and host inventory.
- Focused unit, HTTP integration, E2E boot, Windows CI self-test, and live host evidence are recorded in the PR and rollout log before merge and activation.
- The strengthened public-browser smoke ran against the live Mac Studio preview: 1920 × 1080 H.264 frame, real host cursor movement, browser wheel handling, Stop blanking, and post-Stop server refusal all passed. This proves the first machine and the smoke tool, not the other mesh targets.

## Class-Closure Declaration

`unbounded-self-action`: **n/a**. Desktop refresh and heartbeat run only while a PIN-authorized, target-bound grant exists and stop at revocation or the ten-minute ceiling. Windows companion installation runs once at opt-in boot; a server restart requires an operator config request. This change adds no autonomous spawn, restart, notification, or retry controller.

No agent-authored-artifact defect is introduced.

## Full-suite repair pass, 2026-10-30

The first full `npm run test:all` reached the unit tier and found three release
failures. The config activation route lacked its machine-local write-domain
entry; the entry now names the host-only supervised restart and excludes
shared state. The migration awareness text now states the PIN-only operator
flow explicitly. Four newly counted catch blocks now carry in-brace reasons:
two fail closed on missing Tailscale proof, one returns an explicit HTTP denial,
and the WSL install path visibly warns and leaves desktop dark. The fallback
ratchet remains at 494. These repairs add no input authority, grant state, or
new operator step. Focused retest passed all 14 assertions; the second full
suite is running and remains a release gate.

**Reviewer:** Astra. Astra independently reviewed the five edited files,
concurred that the annotations describe explicit denial or visible boot
failure, and found no P1/P2 issue. The activation entry is host-local and the
wording accurately preserves the PIN-only flow. This was a source review; it
does not replace the full suite or live host checks.

## Fresh-base security correction pass, 2026-10-30

After rebasing the mesh extension onto the merged Mac preview, Astra found four
P2 gaps. A peer lookup failure could bypass front-side Stop cleanup; a pending
WebSocket upgrade could finish after Stop; the revoke route closed a relay
before validating session ownership; and a host with no designated front ID
could still admit a local browser. The broker now forgets locally before any
network work, aborts in-flight control and keepalive calls, and fences late
responses. The relay tracks and cancels pending handshakes. The route delegates
closure to the broker's authenticated forget callback. Local admission requires
an explicit front ID matching the host. Stop reports local revocation even when
the peer is unreachable; the target's independent short liveness deadline is
the partition fallback. Unit, HTTP, and production-boot regressions cover these
boundaries.

**Second-pass reviewer:** Astra re-read the four fixes and concurred, with no
remaining P1/P2 in focused source review. This is source review only; the full
suite, CI, and live Windows checks remain release gates.
