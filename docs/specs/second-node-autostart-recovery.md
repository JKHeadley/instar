# Second-node autostart recovery

## Problem

A paired standby node could remain absent from the live session pool after its
LaunchAgent label had been disabled. Re-running `instar autostart install`
wrote a valid plist but attempted `bootstrap` while the label was still
disabled, which macOS reported only as an input/output error.

The repair command could also corrupt `.instar/bin/node` when invoked through
that managed symlink. Candidate discovery selected the symlink itself and
rewrote it as a self-referential link, preventing future boots.

## Contract

1. Installing macOS autostart explicitly enables the exact agent label before
   bootstrapping its plist.
2. Node candidate discovery considers every PATH entry, not just the first
   `node`.
3. The managed `.instar/bin/node` path is never eligible to become its own
   target.
4. If no real Node binary exists outside the managed link, installation fails
   explicitly instead of writing a self-loop.

## Evidence

- `tests/unit/launchctl-load-guard.test.ts`
- `tests/unit/agent-robustness.test.ts`
- `tests/unit/init-join-launchd-handoff.test.ts`
- `tests/e2e/launchd-node-boot-wrapper.test.ts`

