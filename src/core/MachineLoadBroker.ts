/**
 * MachineLoadBroker — the machine-local shared-load accounting for L6 (Multi-Agent-
 * Per-Machine). Multiple instar agents share one machine; each agent's router must
 * see the TRUE machine load, not just its own, so it won't pile sessions onto a
 * machine another agent is already saturating.
 *
 * Critically, the broker does NOT trust agent self-reports for the authoritative
 * number (Structure > Willpower — "no cross-agent trust required" only holds if an
 * agent cannot lie itself idle). The MACHINE independently reads OS ground truth
 * (loadavg, process footprint); agents report only their own session count + claimed
 * footprint; the broker CROSS-CHECKS and, when an agent under-reports its footprint
 * beyond `loadReportDivergenceTolerance`, marks it `suspect-overloaded`, reduces its
 * placement weight, and escalates — so a lying agent cannot make itself look idle.
 *
 * Pure functions over their inputs — no I/O, no clock; the caller samples the OS.
 */

export interface AgentSelfReport {
  agentId: string;
  port: number;
  reportedSessionCount: number;
  /** The agent's CLAIMED resource footprint (MB RSS). */
  reportedFootprintMB: number;
}

export interface OsProcessSample {
  /** The agent this measured process belongs to (resolved by port/cmdline upstream). */
  agentId: string;
  /** OS-measured resident memory (MB) — ground truth. */
  measuredFootprintMB: number;
}

export interface MachineLoadInput {
  /** os.loadavg()[0] — the authoritative load signal (cannot be faked by an agent). */
  loadAvg: number;
  cpuCount: number;
  /** OS-measured per-agent process footprint (ground truth). */
  osSamples: OsProcessSample[];
  /** Agent self-reports (session counts the OS can't directly see). */
  agentReports: AgentSelfReport[];
  /** Max allowed under-report before an agent is flagged. Default 0.20 (20%). */
  loadReportDivergenceTolerance?: number;
}

export interface AgentLoadVerdict {
  agentId: string;
  status: 'ok' | 'suspect-overloaded';
  reportedFootprintMB: number;
  measuredFootprintMB: number;
  /** Relative under-report: (measured - reported) / max(reported, 1). >tolerance ⇒ suspect. */
  divergence: number;
  /** Placement-weight multiplier — 1.0 for ok, reduced for a suspect agent. */
  placementWeight: number;
}

export interface MachineLoadResult {
  /** Authoritative OS load (always trustworthy — the machine read it itself). */
  loadAvg: number;
  /** Sum of ALL resident agents' reported sessions (the true machine session load). */
  activeSessionCount: number;
  /** False if any agent is suspect — the router should lean on `loadAvg` (OS truth)
   *  rather than `activeSessionCount` for this machine. */
  sessionCountTrustworthy: boolean;
  agentVerdicts: AgentLoadVerdict[];
  suspectAgents: string[];
}

const SUSPECT_PLACEMENT_WEIGHT = 0.1;

/**
 * Compute the machine's shared load view from OS ground truth + agent self-reports.
 * Accounts for ALL resident agents' sessions. Cross-checks each agent's claimed
 * footprint against its OS-measured footprint; an agent measured to use materially
 * MORE than it claims (the lie-idle case) is flagged `suspect-overloaded`. Pure.
 */
export function computeMachineLoad(input: MachineLoadInput): MachineLoadResult {
  const tolerance = input.loadReportDivergenceTolerance ?? 0.20;
  const measuredByAgent = new Map<string, number>();
  for (const s of input.osSamples) {
    measuredByAgent.set(s.agentId, (measuredByAgent.get(s.agentId) ?? 0) + s.measuredFootprintMB);
  }

  const verdicts: AgentLoadVerdict[] = input.agentReports.map((r) => {
    const measured = measuredByAgent.get(r.agentId) ?? 0;
    const denom = Math.max(r.reportedFootprintMB, 1);
    const divergence = (measured - r.reportedFootprintMB) / denom;
    // Only an UNDER-report (measured materially exceeds claimed) is dangerous — it lets
    // an agent look idle while saturating the machine. Over-reporting is conservative.
    const suspect = divergence > tolerance;
    return {
      agentId: r.agentId,
      status: suspect ? 'suspect-overloaded' : 'ok',
      reportedFootprintMB: r.reportedFootprintMB,
      measuredFootprintMB: measured,
      divergence,
      placementWeight: suspect ? SUSPECT_PLACEMENT_WEIGHT : 1.0,
    };
  });

  const suspectAgents = verdicts.filter((v) => v.status === 'suspect-overloaded').map((v) => v.agentId);
  const activeSessionCount = input.agentReports.reduce((sum, r) => sum + Math.max(0, r.reportedSessionCount), 0);

  return {
    loadAvg: input.loadAvg,
    activeSessionCount,
    sessionCountTrustworthy: suspectAgents.length === 0,
    agentVerdicts: verdicts,
    suspectAgents,
  };
}

export interface ResidentAgent {
  agentId: string;
  homeDir: string;
  port: number;
  identityFingerprint: string;
}

export type IsolationViolation =
  | { kind: 'duplicate-port'; port: number; agents: string[] }
  | { kind: 'duplicate-fingerprint'; fingerprint: string; agents: string[] }
  | { kind: 'nested-home'; outer: string; inner: string };

/**
 * Verify the L6 isolation invariant: resident agents never share a port or identity,
 * and no agent's home dir is nested inside another's (which would let one read/write
 * the other's state). Pure — returns the list of violations (empty = isolated).
 */
export function checkAgentIsolation(agents: ResidentAgent[]): IsolationViolation[] {
  const violations: IsolationViolation[] = [];

  const byPort = new Map<number, string[]>();
  const byFp = new Map<string, string[]>();
  for (const a of agents) {
    byPort.set(a.port, [...(byPort.get(a.port) ?? []), a.agentId]);
    byFp.set(a.identityFingerprint, [...(byFp.get(a.identityFingerprint) ?? []), a.agentId]);
  }
  for (const [port, ids] of byPort) if (ids.length > 1) violations.push({ kind: 'duplicate-port', port, agents: ids });
  for (const [fingerprint, ids] of byFp) if (ids.length > 1) violations.push({ kind: 'duplicate-fingerprint', fingerprint, agents: ids });

  const norm = (p: string) => (p.endsWith('/') ? p : p + '/');
  for (const a of agents) {
    for (const b of agents) {
      if (a.agentId === b.agentId) continue;
      if (norm(b.homeDir).startsWith(norm(a.homeDir))) {
        violations.push({ kind: 'nested-home', outer: a.homeDir, inner: b.homeDir });
      }
    }
  }
  return violations;
}
