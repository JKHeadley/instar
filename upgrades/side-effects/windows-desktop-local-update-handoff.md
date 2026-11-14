# Windows desktop local update handoff: side effects

## Over-block

The Windows-local request only runs after the WSL request fails by timeout. A connection refusal or invalid reply stays dark and reports its existing code. The local request requires a Windows-owned IPv4 address, so a companion bound to a retired address cannot be contacted and remains dark.

## Under-block

Windows address ownership is checked by the invoking Windows user process. A compromised process with the companion secret could sign an update request; this is the same local trust boundary as the existing installer. The fallback does not bypass Task Scheduler's stopped-state check.

## Level of abstraction

The installer owns update handoff and the companion owns signed request verification. The HTTP diagnostic consumes only fixed failure codes. No browser or mesh grant decision changes.

## Signal versus authority

Per `docs/signal-vs-authority.md`, WSL timeout is a signal to try an alternate route, not authority to replace a running binary. The companion's signed one-use token and Task Scheduler's stopped state remain the authorities.

## Interactions

The process-owned install lock serializes update attempts. The fallback uses the same prepare/commit/cancel contract as WSL. The commit response may race process exit; InstallPrepared still refuses replacement while Task Scheduler reports running.

## External surfaces

Authenticated desktop diagnostics may show `prepare-local-timeout`, `prepare-local-forbidden`, `prepare-local-unavailable`, or `prepare-local-reply-invalid`. No raw path, address, response body, or secret is returned. The visible picker remains unavailable until capture/input readiness passes.

## Multi-machine posture

The companion and its secret are machine-local to Mama PC by design. Studio reads its signed target availability through the mesh; no secret or update token is replicated. The existing Studio URL and PIN are unchanged.

## Rollback cost

Revert the fallback in the next package release. Failure before a successful commit leaves the old companion and task intact. After commit the old process may have exited; a failed installation then needs a later successful boot to restart it. No state migration is needed, and the diagnostic code clears after that boot.

## Second-pass review

Concern raised by Astra: a Linux child environment variable is not forwarded
through WSL interop unless it is listed in `WSLENV`; Windows-only CI would miss
the prepare-to-commit failure. Resolved by forwarding only the one-use token
in the per-call `WSLENV` while preserving existing entries. Astra concurred
with the correction and requested precise rollback wording, now included
above. The live WSL update path remains the final proof of this boundary.
No other authority bypass or extra user step was found in the independent review.
