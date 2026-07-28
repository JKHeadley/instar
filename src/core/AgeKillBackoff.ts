/**
 * AgeKillBackoff — back-compat shim.
 *
 * The per-session veto-backoff ledger was GENERALIZED into `VetoedKillBackoff`
 * (docs/specs/session-respawn-thrash-elimination.md, Fix A): the same primitive now
 * serves BOTH the age-gate (this name) AND the bound-idle zombie killer. This shim
 * re-exports it under the original name so the age-gate callsites and the shipped
 * AgeKillBackoff tests keep compiling and behaving identically (the added
 * `reasonKey` parameter is optional; the 2-arg age-gate calls resolve it to null).
 */

export { VetoedKillBackoff as AgeKillBackoff, DEFAULT_AGE_KILL_BACKOFF } from './VetoedKillBackoff.js';
export type { AgeKillBackoffOptions } from './VetoedKillBackoff.js';
