<!-- bump: patch -->
## What Changed

Boot claim safety, increment 1 of the takeover-ready pool (spec `docs/specs/takeover-ready-pool.md` R1, feedback fb-2bf6ccd0-705, outage repair N4/A4). Fix id: `boot-claim-safety`.

On 2026-11-20 a restarted Laptop read its own `lease-local.json` ("I held last, lapsed"), could not reach the Studio in its first ~10 s, and claimed the next epoch while the Studio was the live holder. The two then fought over the lead (36 moves in six hours). The ask-peers-first step was skipped whenever `preferredAwakeMachineId` was set, because `server.ts` makes `survivorMayHold()` hard-false then, and the boot claim ran before the lease pull loop started.

Now, from process start until the *boot hold* ends:

- A machine whose own lease lapsed (or that has none) asks its peers before any claim, whatever `survivorMayHold`, `soloCaptainHold` or the preferred machine say.
- A machine that is not the named preferred machine and has reached no peer defers every claim.
- While the named preferred machine answers at all, no other machine claims. A signed reply always counts. An unsigned reply counts only if it carries Instar's own response marker (the new `X-Instar-Machine` header, a fingerprint of the machine id) on a Tailscale or named-tunnel endpoint, and only for a bounded window: 45 s + 3 min for now, or the preferred machine's published restart time + 60 s once it publishes one (floor 45 s, ceiling 10 min). A tunnel edge's 52x/530, an error page without the marker, a LAN or quick-tunnel address, and a legacy dial with no endpoint kind never count.
- The hold ends when a peer's view names a live holder or a strictly newer epoch than this machine's own record (a standby holding the same stale view does not count), or when the preferred machine has been silent on at least 3 probes spanning at least 45 s. With no preferred machine named, or on the preferred machine itself, every known peer must have answered without a live holder or stayed silent that long. A git store with no remote never counts as a peer answer.
- After the hold, the normal rules still need the holder's lease to have lapsed. The preferred machine is not exempt: on return it adopts the current epoch and gets the lead back only through hand-back.
- The boot claim now runs after the lease pull loop starts, and the moment the hold ends the pull loop runs the lease tick once (instead of waiting up to a heartbeat).
- Each decision is logged `boot-hold: <rule> <verdict>`; each ended hold is one row in the feature evidence log (`multiMachine.takeoverReadyPool`).
- `HttpLeaseTransport` records each lease pull per peer as a signed answer, an unsigned Instar answer, or silence (before, every non-2xx collapsed to unconfirmed). The AgentServer and the boot health beacon set the marker on every response, errors included.

Switch: `multiMachine.takeoverReadyPool.bootClaimSafety.enabled`. Live on development agents, dark on the fleet. `multiMachine.takeoverReadyPool.enabled: false` turns it off everywhere. Off is the old acquisition path, unchanged. Values: `silentProbes` (default 3), `silentSpanMs` (default 45000).

Rollout note: the Laptop (Echo and Luna) and the Mini currently run a hand-applied hotpatch with similar logic. Once a release carries this fix, installing it overwrites the patched file with the same behavior, so nothing needs removing by hand. Until then, auto-apply stays held on those machines.

## What to Tell Your User

If your agent runs on more than one computer: when one of them restarts, it no longer grabs the lead from the computer that is already answering. It waits until it has checked with the others, and it takes over only if the main computer really stays silent for most of a minute. You don't need to do anything.

## Summary of New Capabilities

- Boot claim safety for multi-machine agents: a restarted machine asks before re-taking the lead, never takes it while the preferred machine answers, and takes it only after 3 silent checks over at least 45 s. Switch: `multiMachine.takeoverReadyPool.bootClaimSafety.enabled` (development agents first). No new routes.
- Every server response now carries an `X-Instar-Machine` header: a fingerprint of the machine id, not the id itself.

## Evidence

- Unit: `tests/unit/BootClaimHold.test.ts` (both sides of the 3-probe/45-s boundary, the unsigned-answer window and its floor/ceiling, every rule, the stale-standby case, the switch); `tests/unit/LeaseCoordinator-bootClaimSafety.test.ts` (asks first with a preferred machine named; switch-off reproduces the 2026-11-20 claim; never claims while the preferred answers; claims exactly at 45 s; the wedged-503 window; the preferred machine adopts a newer epoch); `tests/unit/HttpLeaseTransport-bootProbe.test.ts` (signed/unsigned/silent classification, 530/52x, quick tunnel, LAN, marker binding, legacy dial); `tests/unit/BootHealthBeacon.test.ts` (marker on the 503).
- Integration: `tests/integration/boot-claim-safety.test.ts`, over real HTTP: the marker on every AgentServer response; no claim when the preferred is unreachable for 10 s; a wedged preferred (the real boot beacon answering 503) blocks only for the window; a dead preferred behind a tunnel edge answering 530 counts as silent; a restarted former holder on a git store with no remote defers and then adopts the holder's epoch.
- E2E: `tests/e2e/boot-claim-safety-boot-path.test.ts`, the real `MultiMachineCoordinator.initializeLease` boot path: pull loop first, no claim from the stale record, claim only after ≥45 s with the role reconciled by the nudge; dark keeps today's behavior; server.ts, AgentServer and beacon wiring.
