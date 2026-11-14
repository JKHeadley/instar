# Server-down recovery: existing state, 2026-11-05 UTC

## Outcome

This checkout does not provide two pre-proven ways to repair a stopped machine. The current Echo server reports mutual SSH `not-configured` and peer HTTP `broken`; `/machines/ssh-health` reports `dryRun: true`, `listener: false`, four `mutual: false` pairs and no installed/reachable standing keys. These are read-only observations, not a live server-down test. No production agent or operator channel was used for testing.

## What exists

- `docs/specs/mutual-ssh-autobootstrap.md` and `src/core/MutualSshRuntime.ts` already define per-agent, per-machine keys, signed adverts, pinned host proof, directional probes, a repair controller and `/machines/ssh-health`. `PeerAuthorizedKeys.ts` manages only marked `authorized_keys` lines.
- `machine-self-assertion.md` defines machine identity continuity and local recovery roots. It is an identity foundation, not a host repair path.
- `GET /channels` and `GET /capability-registry` exist. `instarChannels.ts` labels mutual SSH `working` upon runtime construction, with a note that no peer round trip was proven. The capability registry reported `never-observed` at this read.
- `machine-self-maintenance.md` and the generated `machines.md` reference describe watch-only maintenance and a dry-run wedge judge. They cannot restart or stop work today.
- Cold-Start Lifeline Fallback tells a user where to go when a topic session cannot start. It is an always-on notice while the lifeline/ingress is available, not a peer repair channel.
- Mesh Rope Health is dev-gated in `ConfigDefaults.ts`; the mesh-self-heal G2/G3 work concerns poll ownership and duplicate session spawn, not a server-down host path.
- Native remote desktop routes require the target's agent server/helper path. Self-Unblock Before Escalating supplies a bounded attempt/handoff pattern but no transport.

## Shipped dark or dry run

- `ConfigDefaults.ts` deliberately omits `multiMachine.mutualSsh.enabled` and `multiMachine.peerExecution.enabled`; both resolve through the development-agent gate. Both default to `dryRun: true`. `commands/server.ts` starts the mutual SSH runtime inside the main server process. The optional real-sshd managed key is a broader host execution grant, but dry run installs nothing.
- Rope Health's `enabled` is omitted for the development-agent gate and remains dark on fleet agents. Machine self-maintenance is watch-only and cannot restart. The wedge-triggered restart path is dry run.
- The current Echo `/channels?scope=local` returned `mutual-ssh: not-configured`, `peer-http: broken`, `threadline-relay: working` (the server's relay client only), and `a2a-telegram: half-built`. The relay verdict is not proof that a stopped target can be repaired.

## Missing for the requirement

A separately supervised target recovery endpoint; two independent server-down transports and credentials; pre-incident source-to-target repair proof; safe forced-command migration of existing unrestricted managed SSH keys; signed offline admission/revocation with bounded exposure; pool-owned route health and one-voice notification; phone grant/revoke; update migration to existing agents; and live throwaway-agent tests on two real machines, including an SSH-path block and a kill loop. The converged design is in `docs/specs/server-down-remote-recovery.md`.

## General watchdog-kill detection

Yes. Instar should detect repeated premature server exits, especially `SIGKILL` during startup, from an independently supervised process. It should record exit signal, boot duration, restart count and the responsible supervisor/rule when observable; trip a bounded restart breaker; and report a plain diagnostic. A target main server cannot reliably detect its own repeated pre-ready death. Detection alone must not disable an external watchdog: another agent's or operator's rule requires its owner to act.

## Claim check

`instar` was absent from PATH, and the first built CLI attempt lacked dependencies. Running the installed CLI through the checkout's linked dependencies succeeded: `dev:claim-check` reported 31 potential path claims, chiefly the shared `routes.ts` file, plus an open claim on `instarChannels.ts` (#2760). The new recovery design uses dedicated modules and will avoid overlapping changes where possible. This is an advisory collision report, not proof that the feature was built.

## Continuation and live qualification blocker, 2026-11-05 UTC

- A fresh clone of current `origin/main` (`ddcec96aaf580ed39249d407298791ef165eb412`, package `1.3.1663`) was created at `/tmp/instar-remote-recovery-build` on `fix/server-down-remote-recovery`, with `echo@instar.local` commit identity. The saved spec, audit and key edit were copied there. No commit or PR was made.
- The focused `PeerAuthorizedKeys` test passed: 8 tests with `vitest run --no-cache tests/unit/peer-authorized-keys.test.ts`. An initial run passed all eight but exited nonzero because a linked dependency directory outside the writable sandbox prevented Vitest from writing `.vite`; `--no-cache` resolved that runner issue.
- A read-only `GET /machines/ssh-health` still returned `dryRun: true`, `listener: false`, and four pairs with `mutual: false`, `standingKeyInstalled: false`, `standingReachable: false`. The prior edit is preparatory only: the runtime does not supply `forcedCommand`, and there is no independent target listener.
- The required relay checkpoint and frame service has no deployment path available in this session: no `fly` or `docker` CLI, no relay deployment workflow in `.github/workflows`, and no `FLY_*` or `RELAY_*` environment credential. `gh secret list --repo JKHeadley/instar` showed signing, npm and release secrets, but no relay deploy secret. The visible GitHub production deployments were Vercel deployments, not the Threadline relay. No disposable two-machine test pair is provisioned here. The session's writable roots are the source worktree and temporary directories, so it cannot install a supervised recovery helper or create host admission on a real target. These are hard prerequisites in the converged spec; neither route can be graduated or the destructive test matrix honestly claimed without them.
