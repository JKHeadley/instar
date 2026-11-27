# Side-Effects Review — named tunnel token off the command line

**Version / slug:** tunnel-token-off-argv
**Date:** 2026-11-11
**Author:** Echo

## Summary of the change
Tier 1. `CloudflareNamedProvider` started cloudflared with `tunnel run --token <value>` (via the `cloudflared` package's `Tunnel.withToken`), so the tunnel token sat in the process list where any local process could read it (`ps`). Sage Mind's daily device check flagged it on the Studio for every agent with a named tunnel (Echo, Luna, Groky). The provider now writes the token to `<stateDir>/secrets/cloudflared-token` (mode 0600, git-ignored with the other agent secrets) and starts `tunnel run --token-file <path>`. It uses the old path when no stateDir is given, the file cannot be written, or the binary's help does not list `--token-file` (checked once per binary).

## Decision-point inventory
None (process start arguments only).

## 1. Over-block
None: every case that cannot use the file falls back to the previous `--token` start.

## 2. Under-block
The token is still on disk (as it already is in the config/secret store), readable by the agent's own user. A stale binary without `--token-file` still exposes it on argv; current installs track cloudflared "latest" (2026.10.7 on the Studio supports it).

## 3. Level-of-abstraction fit
The provider owns the spawn; the change sits there. TunnelManager passes its existing stateDir.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No decision logic.

## 4b. Judgment-point check
None.

## 5. Interactions
Credential rotation writes the new token to the same file on the next start (the write always overwrites and re-tightens the mode). Quick tunnels and config-file tunnels are unchanged.

## 6. External surfaces
None visible to users. The tunnel connects the same way. Verified live on the Studio: `cloudflared tunnel run --token-file` with Echo's token registered 4 connections, with no token in the process arguments.

## 7. Multi-machine posture
Machine-local BY DESIGN (machine-local-justification: physical-credential-locality): each machine's tunnel process reads its own token file on its own disk.

## 8. Rollback cost
Plain revert; the leftover token file is harmless (same content as the existing secret).
