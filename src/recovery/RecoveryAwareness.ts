/** Shared by fresh scaffolds and post-update reference generation. */
export function recoveryAwareness(port:number):string {
  return `
### Server-down remote recovery

Before claiming a paired machine can be repaired while its server is down, read authenticated GET /pool or /machines/ssh-health and its serverDownRecovery summary. This is source-machine evidence: a missing, stale or failed route is never ready, and a different source machine can have different reachability. Both routes require independent fresh target-signed proofs and actual source transport observations. SSH socket construction or an ordinary relay session proves neither route. The target OS, host network and 24-hour authority lease remain common dependencies.

Set up through /dashboard/recovery.html on this machine's dashboard (port ${port} locally); unlock with the dashboard PIN, prepare, approve the paired-machine scope on the enrolled owner phone, then install and prove both routes. The authority must have a signer certified by the dedicated recovery certification root shipped in the installed signed release; never mint a local root or treat disposable keys as production authority. Recovery ships off until enrollment and explicit enablement. Grant and revoke are phone controls; a revoke stays pending until the target acknowledges it, with at most 24 hours of offline exposure. Main-server shutdown stops only source probes and leaves independent recovery listeners and the watchdog restorer alive.
`;
}
