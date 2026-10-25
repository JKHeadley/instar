# Side-Effects Review — `instar wakeup` talks to the machine that is actually awake

**Version / slug:** `wakeup-targets-awake-machine`
**Date:** `2026-10-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (CLI target/URL resolution; the handoff protocol itself is unchanged)`

## Summary of the change

instar#2122: "`instar wakeup` reported 'Current location: mac-studio' while the laptop held the lease, then failed with `Invalid challenge signature`." Two causes in `wakeup()`:

1. It took the awake machine from the registry's ROLE field (`getAwakeMachine`), which lags the live lease and on Luna's Studio still named a removed identity. New `resolveAwakeMachine` asks the local server's `/health` for `multiMachine.syncStatus.leaseHolder` first (an active, non-revoked registry entry), falling back to the registry role.
2. It sent the handoff challenge to its OWN server (`localhost:<port>/health` → `tunnelUrl || localhost`). The server builds the challenge message with ITSELF as receiver while the client signed for the awake machine's id, so the signature never matched. New `resolveAwakeServerUrl` probes the awake machine's advertised endpoints (tailscale, lan, cloudflare) and last-known URL with `/health` and uses the first that answers; `localhost` is never a candidate.

## Decision-point inventory

- Which machine is "awake": live lease holder → registry role.
- Which URL receives the handoff: the awake machine's reachable rope.

## 1. Over-block

If none of the awake machine's addresses answer, wakeup now says so and points at `--force` — before, it would have contacted the wrong server and failed later with a confusing signature error.

## 2. Under-block

The handoff protocol, `--force` and the no-awake promotion path are unchanged.

## 3. Level-of-abstraction fit

Both helpers live in the CLI next to `wakeup()`, exported for tests.

## 4. Signal vs authority compliance

No authority change; the server's challenge verification is untouched.

## 4b. Judgment-point check

Not a competing-signals decision.

## 5. Interactions

Uses `MachineRegistryEntry.endpoints` (multi-transport mesh) and `lastKnownUrl` as the mesh RPC client does. The lease read via `/health` is the same field `instar doctor` shows.

## 6. External surfaces

CLI output: "Reaching <name> at <redacted url>".

## 7. Multi-machine posture (Cross-Machine Coherence)

This change exists for multi-machine; it reads the mesh's own records.

## 8. Rollback cost

Revert.

## Conclusion

The handoff request now goes to the machine that can answer it, named from the live lease.
