# Side-effects review — Mesh URL advertisement (lastKnownUrl population)

## What changed

`updateMachineUrl()` (the only writer of `registry.machines[id].lastKnownUrl`)
had **zero callers** on main. The Multi-Machine Session Pool routes every
cross-machine RPC — `deliverMessage`, session transfer, lease ops — to a peer by
reading that peer's `lastKnownUrl`, and filters peers with `!!e.lastKnownUrl`.
With the field never written, every peer was filtered out and **no session
could ever be delivered or transferred across machines**. The feature was inert
across real machines despite green 3-tier tests (which inject mock peer URLs).

Found 2026-05-29 bringing up a second real machine (the mini) for the
session-pool real-hardware proof.

This change adds:
- `src/core/MeshUrlAdvertiser.ts` — `resolveAdvertisedMeshUrl(tunnel, resolvedUrl?)`
  (named → `https://<hostname>`, quick → the runtime-resolved start URL, none →
  null) + `advertiseSelfMeshUrl(recorder, selfId, url)` (idempotent, tolerant of
  a missing self entry).
- `src/commands/server.ts` — calls the advertiser after `tunnel.start()` on both
  the boot path and the sleep/wake restart path (a quick tunnel gets a new URL
  after a wake, so the previously-advertised URL goes stale).
- `src/commands/machine.ts` (`joinMesh`) — the joiner records the URL it
  connected through as the awake peer's `lastKnownUrl`, so a standby can route
  back to the awake machine immediately without waiting for a registry sync.

## Blast radius

- **Dark-feature-only effect.** The populated `lastKnownUrl` is consumed solely
  by the session-pool mesh code, which is gated behind `multiMachine.sessionPool`
  (default `enabled:false`, `stage:'dark'`). On a single-machine agent there are
  no peers, so nothing changes. Populating the field is otherwise inert.
- **No new config, no new route, no schema change** → no migration needed.
  Existing agents pick up the behavior at boot on the next release. No
  `PostUpdateMigrator` entry required (the code runs at startup unconditionally
  when multi-machine is enabled and a tunnel URL exists).
- **Idempotent + fail-safe.** `advertiseSelfMeshUrl` writes only when the URL
  changed and swallows the "self entry not present yet" race (returns false).
  A tunnel-disabled machine advertises nothing (correct — it is genuinely
  unreachable cross-machine; peers skip it rather than route to a dead URL).
- **No secret exposure.** A tunnel URL is already public (the dashboard link).
  Recording it in the registry adds no new exposure.

## What this does NOT close (scoped, decision-gated follow-up)

The **awake machine learning a git-uncredentialed standby's URL** still needs one
of: (a) the standby having git push creds for the shared agent repo (so its
advertised entry syncs via the existing git-backed RegistrySyncDebouncer), or
(b) a signed mesh `announce-url` RPC so a standby can publish its URL to the
awake machine over authenticated MeshRpc without git. (b) also requires the
awake side to persist the joiner's identity, which today only happens via the
**interactive SAS pairing** confirmation — so closing this fully touches the
pairing security model. That is a genuine design fork (creds vs. new RPC +
non-interactive registration), not a silent deferral, and is raised explicitly
rather than hand-resolved on a production identity.

## Tests

- `tests/unit/mesh-url-advertiser.test.ts` — resolver (named/quick/disabled/none)
  + advertiser against a real `MachineIdentityManager` (writes, idempotent,
  updates on change, null no-op, missing-entry tolerance).
- `tests/unit/mesh-url-advertisement-wiring.test.ts` — wiring-integrity: asserts
  the advertiser is invoked on the boot + sleep/wake tunnel paths and the joiner
  records the connect URL. This is the tier that was missing — it would have
  caught the original "zero callers" gap.
