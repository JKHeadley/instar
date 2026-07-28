/**
 * ExternalHogOwnership — the instar-own-process exclusion of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1).
 *
 * A candidate must be EXCLUDED from discovery if its ancestry reaches an instar-owned pid —
 * otherwise a legitimately-busy build/test child of a live instar session (a vitest worker,
 * `tsc`, a compiler) becomes a confirmed sustained hog and spams the observability floor
 * during exactly the heavy work instar is designed for (the 2026-07-02 29-vitest-root storm).
 *
 * This is the PURE ancestry walk over a process-tree SNAPSHOT (the actual `ps` read that
 * builds the tree is a later I/O slice). Two round-9/10-reviewed design points:
 *
 *  1. START-TIME-AWARE (not a bare pid walk): `resolveOwningSession` supplies only the
 *     cycle-guard + hop-bound and takes NO start-time — so this EXTENDS it. Each owned pid is
 *     matched by BOTH pid AND its recorded start-time, so a REUSED pid that coincidentally
 *     equals an instar-owned pid number does NOT falsely exclude (its start-time won't match).
 *
 *  2. INCLUDE-on-uncertainty is the ANTI-EVASION direction: if the chain can't be resolved
 *     (a hop's pid isn't in the snapshot, or a cycle/hop-bound), the candidate is treated as
 *     NOT instar-owned (stays a candidate). instar-own KILL protection is carried NOT by this
 *     walk but by reparent-to-pid-1 semantics + the §4 allowlist floor (an instar build child
 *     won't match the exthost allowlist regex anyway) — so INCLUDE-on-uncertainty costs only
 *     occasional observability noise, never a wrong kill, and it prevents an external hog from
 *     FALSE-EXCLUDING itself by faking an instar ancestor via a stale/foreign edge.
 *
 *  BOTH a tmux-pane ancestor AND an own-root pid count (round-10 integration: under launchd
 *  supervision the launchd-direct lifeline has NO tmux ancestor, so a tmux-only walk misses
 *  its descendants). The caller supplies both sets, merged into `ownedRefs`.
 */

export interface ProcNode {
  readonly pid: number;
  readonly ppid: number;
  /** The process's start-time (from `ps lstart=`), used to defeat pid reuse. */
  readonly startTime: string;
}

/** A process-tree snapshot: pid → its node. Built by the sampler from one `ps` read. */
export type ProcTree = ReadonlyMap<number, ProcNode>;

/** instar-owned pids (server `process.pid`, sampler pid, resolvable lifeline pid, tmux panes),
 *  each mapped to its EXPECTED start-time so a reused pid can't spoof ownership. */
export type OwnedRefs = ReadonlyMap<number, string>;

/**
 * Is `candidatePid` instar-owned — i.e. does its ppid-chain reach an owned pid whose recorded
 * start-time matches? Walks up to `maxHops`, cycle-guarded. Returns FALSE (not owned → stays a
 * candidate) on any unresolvable edge or on reaching init (ppid ≤ 1) — the anti-evasion
 * direction. `maxHops <= 0` or a non-finite candidate → not owned (nothing to verify).
 */
export function isInstarOwned(candidatePid: number, tree: ProcTree, ownedRefs: OwnedRefs, maxHops: number): boolean {
  if (!Number.isInteger(candidatePid) || candidatePid <= 0) return false;
  if (!Number.isFinite(maxHops) || maxHops <= 0) return false;

  const seen = new Set<number>();
  let current = candidatePid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current)) return false; // cycle → can't resolve → not owned (anti-evasion)
    seen.add(current);

    const node = tree.get(current);
    if (!node) return false; // pid not in the snapshot → unresolvable → not owned

    // Owned iff this pid is a known instar pid AND its start-time matches (defeats pid reuse).
    const expectedStart = ownedRefs.get(current);
    if (expectedStart !== undefined && expectedStart === node.startTime) return true;

    if (node.ppid <= 1) return false; // reached init/launchd — a genuine orphan, no instar ancestor
    current = node.ppid;
  }
  return false; // hop-bound exceeded → not owned (bounded; the floor still gates any kill)
}
