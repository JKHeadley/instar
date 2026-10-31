# Windows desktop local transport: side effects

## Over-block

The WSL agent refuses desktop admission if the staged PowerShell transport is missing or if its process cannot reach the companion within a bounded request. This can hide a Windows desktop that is otherwise interactive. The card stays unavailable with a diagnostic rather than offering broken controls.

## Under-block

The Windows process can receive a request that races with browser Stop. The target revokes its grant immediately, aborts its local child, sends a signed release, and the companion independently expires a lost heartbeat. Actual WSL-to-Windows input/Stop timing still requires live verification before Mama PC is advertised ready.

## Level of abstraction

The transport is a one-request PowerShell interop hop from WSL to the already installed Windows companion. It opens no listening port. The existing companion retains capture, input, controller lock, signed-request validation, and lease expiry.

## Signal versus authority

An installer receipt or a successful probe is a readiness signal, not authority to claim remote control works. Only the target's PIN-derived grant admits input. The browser and target still enforce Stop and post-Stop refusal.

## Interactions

The installer stages the transport script alongside the companion on each opted-in WSL boot. Discovery validates the Windows-owned address and fixed script path. The transport passes signed headers and bounded bodies through standard input; screen bytes return through standard output without durable logging. A process or pipe failure returns a fixed error and leaves the desktop dark.

## External surfaces

The Windows package CI exercises the script against an actual companion probe. No new dashboard step, user permission, public port, or PIN flow is introduced. The internal endpoint remains Windows-local.

## Multi-machine posture

The change affects only opted-in WSL agents hosting a Windows companion. Mac targets and the Studio front stay on their existing paths. Every target still checks its own operator grant and controller lock.

## Rollback cost

Reverting the transport returns WSL to direct TCP. It may make Mama PC unavailable again, but it cannot grant input. The script is overwritten by the next opted-in Windows bootstrap, and no persistent format or credential changes.

## Second-pass review

**Reviewer:** Astra

Astra found two P1 process/pipe error races; both are fixed and covered by a unit test. Astra also identified required live WSL proof for delayed input versus Stop and practical frame/input latency. Mama PC remains unavailable until those checks pass.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`. Each desktop request launches at most one local child, with a 4.5 second timer and abort on authority loss. The stream permits at most one in-flight frame capture per stream. `tests/unit/windows-desktop-local-transport.test.ts` exercises process and pipe failure paths. The remaining live Stop and performance checks are release gates, not claims made by this guard.
