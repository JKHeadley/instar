/**
 * ExternalHogFactBuilder — the STAGE-2 deterministic fact + identity derivation (CMT-1901,
 * docs/specs/external-hog-zombie-autokill-sentinel.md §2, §4). PURE over its inputs.
 *
 * Given a candidate's proc row, its FULL argv (fetched off-loop by the impure adapter), the
 * process tree, the instar-owned set, and a couple of I/O-gathered inputs (own euid, the set of
 * launchctl-labeled pids), this builds the `ExternalHogFacts` the floor evaluates and the
 * identity (classId / commandHash / ledgerKey) the ledger + funnel key on. It NEVER spawns a
 * process or reads a clock — the impure edges (ps -o args=, launchctl, geteuid) live in the
 * adapter and are passed IN, so every derivation here is unit-testable.
 *
 * The load-bearing derivation is `ownerAppRunning` (§ round-6/round-8): for the editor-exthost
 * class it means "is the SPECIFIC `--parentPid` process that spawned this exthost still alive?"
 * — NOT "any window of the app," which would veto a real zombie whenever any editor window is
 * open (the exact 2026-07-03 anchor incident, where multiple windows is the common case). Every
 * un-establishable branch fails toward `ownerAppRunning:true` → the floor VETOES (alert-never-kill).
 */

import { createHash } from 'node:crypto';
import type { ProcTableRow } from './ExternalHogProcTable.js';
import { isInstarOwned, type ProcTree, type OwnedRefs } from './ExternalHogOwnership.js';
import { matchAllowlistClass, type ExternalHogFacts } from './ExternalHogFloor.js';

export interface FactBuilderInput {
  /** The candidate's proc row (from the parsed ps table). */
  readonly row: ProcTableRow;
  /** The candidate's FULL argv (ps -o args=), fetched off-loop by the adapter. */
  readonly argv: string;
  readonly tree: ProcTree;
  readonly ownedRefs: OwnedRefs;
  readonly maxAncestorHops: number;
  /** The sentinel's own effective uid (process.geteuid()), passed in by the adapter. */
  readonly ownEuid: number;
  /** The set of pids that are labeled launchd jobs (from `launchctl`), gathered by the adapter. */
  readonly launchctlLabeledPids: ReadonlySet<number>;
  /** Was the candidate over the core threshold THIS window? (The sampler guarantees true for a
   *  candidate; the orchestrator ANDs this with the N-window streak — see ExternalHogSustained.) */
  readonly sustainedThisWindow: boolean;
}

const PARENT_PID_RE = /--parentPid[= ](\d+)/;

/** Extract the class-parameterized spawning parent pid (`--parentPid=N`) from argv; null if absent. */
export function parseParentPid(argv: string): number | null {
  if (typeof argv !== 'string') return null;
  const m = PARENT_PID_RE.exec(argv);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse an `lstart` token (`ps lstart=` — "Wed Jul  2 10:00:00 2026") to epoch millis, for
 * ORDERING ONLY (the reused-parent-pid check). Returns null on ANY ambiguity — a null forces the
 * caller to the fail-safe (conservative veto) branch. The proc-table parser keeps `startTime` an
 * opaque equality token by design; this targeted parse is confined to the one ordering comparison.
 */
export function lstartToEpochMs(startTime: string): number | null {
  if (typeof startTime !== 'string' || startTime.trim().length === 0) return null;
  const ms = Date.parse(startTime);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is the SPECIFIC spawning parent still alive? (§ round-8 provenance path b.)
 *  - no `--parentPid` in argv → owner cannot be established → TRUE (veto, safe)
 *  - `--parentPid=N` absent from the table → parent dead → FALSE (kill-eligible)
 *  - `N` present, its start-time LATER than this child's → `N` was reused, real parent dead → FALSE
 *  - `N` present, started before-or-equal the child (or start-times un-orderable) → alive/uncertain
 *    → TRUE (veto, safe)
 */
export function deriveOwnerAppRunning(row: ProcTableRow, argv: string, tree: ProcTree): boolean {
  const n = parseParentPid(argv);
  if (n === null) return true; // no provenance token → cannot establish owner-dead → veto
  const parent = tree.get(n);
  if (!parent) return false; // the specific parent pid is gone → dead → kill-eligible
  // Parent pid is present — is it the REAL parent, or a reused pid now hosting a newer process?
  const childMs = lstartToEpochMs(row.startTime);
  const parentMs = lstartToEpochMs(parent.startTime);
  if (childMs === null || parentMs === null) return true; // can't order → assume live parent → veto
  if (parentMs > childMs) return false; // parent started AFTER the child ⇒ pid reused ⇒ real parent dead
  return true; // parent older-or-equal ⇒ plausibly the live real parent ⇒ veto
}

/**
 * Build the deterministic facts the floor evaluates. Returns null only if the row is structurally
 * unusable (a non-finite pid) — every OTHER uncertainty is encoded as a veto-leaning fact value,
 * never a silent drop (the §4 broad-observability floor still surfaces it).
 */
export function buildFacts(input: FactBuilderInput): ExternalHogFacts | null {
  const { row, argv, tree, ownedRefs, maxAncestorHops, ownEuid, launchctlLabeledPids } = input;
  if (!row || !Number.isInteger(row.pid) || row.pid <= 0) return null;
  return {
    name: row.comm,
    argv,
    pid: row.pid,
    // Defense-in-depth: a candidate is already non-instar-owned (the sampler filtered), recompute.
    isInstarProcess: isInstarOwned(row.pid, tree, ownedRefs, maxAncestorHops),
    // A root/system-owned process is never in our same-uid envelope → the floor vetoes it anyway,
    // but flag it explicitly so the veto reason is honest (`system-root-daemon`).
    ownerRootDaemon: row.uid === 0,
    hasLaunchctlLabel: launchctlLabeledPids.has(row.pid),
    ownerAppRunning: deriveOwnerAppRunning(row, argv, tree),
    // Single-window confirmation; the orchestrator ANDs this with the N-window streak (§1).
    sustainedHighCpu: input.sustainedThisWindow === true,
    targetUid: row.uid,
    ownEuid,
  };
}

/** Strip the volatile provenance token so the command signature is STABLE across re-launches (a
 *  fresh exthost gets a new `--parentPid`; the breaker must count respawns of the SAME command). */
function stableCommandSignature(argv: string): string {
  return argv.replace(PARENT_PID_RE, '--parentPid=<>');
}

/**
 * Derive the kill identity for a candidate: its allowlist class, a stable command-hash, and the
 * ledger key the P19 breaker uses. Returns null when the candidate is OUTSIDE the code-defined
 * allowlist (not kill-eligible) — the caller then surfaces it (observability) but never kills it.
 */
export function buildIdentity(facts: ExternalHogFacts): { classId: string; commandHash: string; ledgerKey: string } | null {
  const classId = matchAllowlistClass(facts.name, facts.argv);
  if (!classId) return null; // outside the narrow killable envelope
  const commandHash = createHash('sha256').update(stableCommandSignature(facts.argv), 'utf8').digest('hex');
  return { classId, commandHash, ledgerKey: `${classId}:${commandHash}` };
}
