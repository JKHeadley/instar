# Windows desktop: persistent PowerShell relay

## Summary

src/core/WindowsDesktopLocalTransport.ts keeps two long-lived `powershell.exe -Serve` relays (capture lane, control lane) and serializes requests per lane; scripts/windows-desktop-local-transport.ps1 gains a `-Serve` loop. The one-request mode stays as the fallback.

## Over-block

None. Each request is validated exactly as before (allowed operation, size, local address, signed headers checked by the companion).

## Under-block

The per-lane ordering chain swallows a rejection only to keep the next request in order (marked @silent-fallback-ok); the caller of that request still receives the error.


Requests on one lane now run in order rather than in parallel; a slow request delays the next on that lane by up to its 4.5 s timeout, after which the relay is killed and restarted.

## Level of abstraction

Transport only; the companion, its HMAC check and lease rules are unchanged.

## Signal versus authority

No decision point changes.

## Interactions

Two idle PowerShell processes stay resident on the Windows host while the agent runs; they exit when the agent closes their input. An older installed relay script is detected (it exits without answering) and the one-process-per-request path is used.

## 6b. Operator-surface quality

Input latency on Windows drops from about a second per command.

## External surfaces

No new listener; the relay still opens no socket.

## Multi-machine posture

Machine-local to each WSL host.

## Rollback cost

Revert; the one-shot path is unchanged and remains in the code.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: n/a` (a relay process starts only when a caller sends a request and none is alive; at most one per lane, two in total; it is never restarted on its own). Also `defectClass: performance`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/windows-desktop-local-transport.test.ts, howCaught: a live mouse hook on Mama PC showed 1.2-1.5 s between input commands; the transport spawned powershell.exe per request }`.
