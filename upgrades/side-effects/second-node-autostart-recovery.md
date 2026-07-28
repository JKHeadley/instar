# Side-Effects Review — Second-node autostart recovery

**Version / slug:** `second-node-autostart-recovery`  
**Date:** `2026-07-23`  
**Author:** `Instar-codey`  
**Second-pass reviewer:** `not required`

## Summary of the change

`src/commands/setup.ts` now re-enables the exact macOS LaunchAgent label before
bootstrap and prevents `.instar/bin/node` from becoming its own symlink target.
The change modifies deterministic installation and executable-selection
decisions; it does not change session routing or lease authority.

## Decision-point inventory

- `ensureStableNodeSymlink` — modify — chooses a real Node target outside the managed link.
- `installMacOSLaunchAgent` — modify — re-enables the requested label before bootstrap.

## 1. Over-block

A PATH containing only the managed self-link now fails explicitly. That input
cannot boot Node successfully, so refusing to write the link is intentional.

## 2. Under-block

This does not repair unrelated plist corruption, missing Node installations, or
keychain/vault divergence. Those remain independently surfaced failures.

## 3. Level-of-abstraction fit

Both fixes sit at the installation primitive that owns the symlink and
LaunchAgent lifecycle. No parallel recovery controller is introduced.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The installer performs an explicitly requested, deterministic service action.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Exact path
identity and exact launchd label state are enumerable invariants.

## 5. Interactions

- **Shadowing:** existing plist validation still runs before launchctl.
- **Double-fire:** bootout remains idempotent; enable targets one exact label.
- **Races:** launchctl serializes bootout, enable, and bootstrap in order.
- **Feedback loops:** none; this is an operator-invoked installation path.

## 6. External surfaces

macOS agents whose exact label was disabled can be reinstalled successfully.
The persistent plist format and CLI surface are unchanged. No new
operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**machine-local BY DESIGN** — LaunchAgent state and Node executable paths are
properties of each physical machine. No notices, replicated durable state, or
URLs are created. Pool behavior benefits only after that machine boots normally.

## 8. Rollback cost

Pure code change: revert and ship a patch. Existing enabled services and valid
symlinks need no cleanup.

## Conclusion

The review found no authority expansion. The design fails safely when no real
Node target exists and restores an explicitly requested disabled service. Clear
to ship.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/agent-robustness.test.ts`
- `tests/unit/launchctl-load-guard.test.ts`
- Live two-node proof on Codey Mini, topic 3928.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

