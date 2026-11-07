/**
 * TeamAccessSync — how machines share the access log (team-roles-and-access, "Step 2b").
 *
 * Not the journal: that treats another machine's entry as forged and serves only a machine's own
 * stream, and rows here must be able to reach a machine through whoever has them. So a peer is asked
 * for what this machine lacks, by vector, and rows verify themselves on arrival.
 *
 */
import fs from 'node:fs';
import type { TeamAccessLog, TeamAccessRow } from './TeamAccessLog.js';

/** What a machine understands of team access. A joiner below this is refused while a team exists. */
export const TEAM_ENFORCEMENT_VERSION = 1;

/** What a machine says about itself on each exchange. */
export interface MachineStanding { enforcement: number; native: boolean; privacy: boolean }

export interface PeerRows { rows: TeamAccessRow[]; vector: Record<string, number>; standing?: MachineStanding }

/** A peer on a build with no log route answers this way, and is not waited for. */
export class PeerHasNoLog extends Error {}

export interface SyncPeer {
  machineId: string;
  fetchRows(have: Record<string, number>, heads: Record<string, string>): Promise<PeerRows>;
  /** Rows the peer lacks. How a machine that cannot be dialled still gets its rows out. */
  pushRows?(rows: TeamAccessRow[]): Promise<void>;
}

export interface PeerOutcome { machineId: string; answered: boolean; added: number; refused: number; noLog?: boolean; standing?: MachineStanding; behind?: boolean }

export type PullResult = { outcomes: PeerOutcome[]; anyAnswered: boolean; lastAnsweredAt: number | null; touched: string[] };

/** A peer sends at most this many rows in one exchange. Each stream stays in order, so the rest is only pending. */
export const ROWS_PER_CALL = 500;

/** Ask each peer for what is missing, and give it what it lacks. A peer that does not answer is not an error: laptops sleep. */
export async function pullFromPeers(log: Pick<TeamAccessLog, 'vector' | 'heads' | 'ingest' | 'rowsBeyond'>, peers: ReadonlyArray<SyncPeer>, now: () => number = Date.now): Promise<PullResult> {
  const outcomes: PeerOutcome[] = [];
  const touched = new Set<string>();
  let lastAnsweredAt: number | null = null;
  for (const peer of peers) {
    try {
      const { rows, vector, standing } = await peer.fetchRows(log.vector(), log.heads());
      const result = log.ingest(rows);
      for (const ref of result.touched) touched.add(ref);
      const held = log.vector();
      const behind = Object.entries(vector).some(([stream, seq]) => (held[stream] ?? 0) < seq);
      outcomes.push({ machineId: peer.machineId, answered: true, added: result.added, refused: result.refused, behind, ...(standing ? { standing } : {}) });
      lastAnsweredAt = now();
      const theirs = log.rowsBeyond(vector).slice(0, ROWS_PER_CALL);
      // @silent-fallback-ok — the peer answered; rows it lacks go at the next exchange.
      if (theirs.length > 0) await peer.pushRows?.(theirs).catch(() => undefined);
    } catch (err) {
      // @silent-fallback-ok — an unanswered pull is recorded in the outcome; shouldRefuseForStaleness judges it.
      outcomes.push({ machineId: peer.machineId, answered: false, added: 0, refused: 0, ...(err instanceof PeerHasNoLog ? { noLog: true } : {}) });
    }
  }
  return { outcomes, anyAnswered: outcomes.some((o) => o.answered), lastAnsweredAt, touched: [...touched] };
}

/** Evidence a peer is awake: a heartbeat or a signed row. A closed lid produces none. */
export const AWAKE_EVIDENCE_MS = 5 * 60_000;
export const PULL_STALENESS_BOUND_MS = 15 * 60_000;

export interface PeerLiveness { machineId: string; lastEvidenceAt: number | null; firstUnansweredAt: number | null }

/**
 * Should this machine refuse its team phones? Only when a peer is known to be awake and has gone
 * unanswered past the bound. A laptop's closed lid gives no evidence, so it never stops anything;
 * a peer that is not pullable answers by pushing, which clears `firstUnansweredAt`.
 */
export function shouldRefuseForStaleness(peers: ReadonlyArray<PeerLiveness>, now: number): boolean {
  return peers.some((p) => p.lastEvidenceAt !== null && now - p.lastEvidenceAt <= AWAKE_EVIDENCE_MS
    && p.firstUnansweredAt !== null && now - p.firstUnansweredAt >= PULL_STALENESS_BOUND_MS);
}

export interface BelowFloor { machineId: string; reason: 'old-build' | 'native-off' | 'memory-privacy-off' }

export const PULL_INTERVAL_MS = 60_000;
/** With `strictStaleness` on, a machine with no peer answering for this long refuses its team phones. */
export const STRICT_STALENESS_MS = 24 * 60 * 60_000;

export interface TeamPullerDeps {
  log(): TeamAccessLog | null;
  peers(): SyncPeer[];
  /** When a peer's lease last showed it awake, however that reached this machine. */
  leaseEvidenceAt?(machineId: string): number | null;
  /** Rows arrived: the conversations they touch, for ending live sessions, and phones to re-check. */
  afterIngest(touched: string[]): Promise<void> | void;
  strictStaleness?(): boolean;
  /** Where what each peer last said about itself is kept. */
  standingFile?: string;
  reportError?(err: unknown): void;
  now?(): number;
}

/** The regular exchange with peers, and what it shows about whether this machine may serve its team phones. */
export class TeamAccessPuller {
  private readonly evidence = new Map<string, number>();
  private readonly firstUnanswered = new Map<string, number>();
  private readonly noLog = new Set<string>();
  private readonly standing = new Map<string, MachineStanding>();
  private readonly behindPeers = new Set<string>();
  private lastAnsweredAt: number;
  private settled = false;
  private running = false;

  constructor(private readonly deps: TeamPullerDeps) {
    this.lastAnsweredAt = this.now();
    if (!deps.standingFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(deps.standingFile, 'utf8')) as Record<string, MachineStanding>;
      for (const [id, s] of Object.entries(saved)) this.standing.set(id, s);
    } catch {
      // @silent-fallback-ok — none yet: every peer is heard from at the next exchange.
    }
  }

  private recordStanding(machineId: string, standing: MachineStanding): void {
    const held = this.standing.get(machineId);
    if (held && JSON.stringify(held) === JSON.stringify(standing)) return;
    this.standing.set(machineId, standing);
    if (!this.deps.standingFile) return;
    try {
      fs.writeFileSync(this.deps.standingFile, JSON.stringify(Object.fromEntries(this.standing)), { mode: 0o600 });
    } catch (err) { this.deps.reportError?.(err); } // @silent-fallback-ok — reported; held in memory until the next change
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** A peer called here. Pulling shows it is awake; pushing also answers. */
  noteInbound(machineId: string, answered: boolean): void {
    this.evidence.set(machineId, this.now());
    if (!answered) return;
    this.firstUnanswered.delete(machineId);
    this.lastAnsweredAt = this.now();
  }

  /** After sleep this machine knows nothing new, so it waits for one exchange to finish. */
  noteWake(): void { this.settled = false; }

  private evidenceAt(machineId: string): number | null {
    const direct = this.evidence.get(machineId) ?? null;
    const lease = this.deps.leaseEvidenceAt?.(machineId) ?? null;
    if (direct === null) return lease;
    return lease === null ? direct : Math.max(direct, lease);
  }

  async tick(): Promise<PullResult | null> {
    const log = this.deps.log();
    if (this.running || !log) return null;
    this.running = true;
    try {
      if (log.healthState() === 'unreadable' || log.listDamaged()) {
        await this.repair(log);
        if (log.healthState() === 'unreadable' || log.listDamaged()) return null;
      }
      const result = await pullFromPeers(log, this.deps.peers(), () => this.now());
      const now = this.now();
      for (const o of result.outcomes) {
        if (o.noLog) {
          this.noLog.add(o.machineId);
          this.recordStanding(o.machineId, { enforcement: 0, native: false, privacy: false });
        } else if (o.answered) this.noLog.delete(o.machineId);
        if (o.behind) this.behindPeers.add(o.machineId); else if (o.answered) this.behindPeers.delete(o.machineId);
        if (o.standing) this.recordStanding(o.machineId, o.standing);
        if (o.answered) {
          this.evidence.set(o.machineId, now);
          this.firstUnanswered.delete(o.machineId);
          continue;
        }
        const at = this.evidenceAt(o.machineId);
        // The wait starts only while the peer shows it is awake, and a lapse starts it over.
        if (at === null || now - at > AWAKE_EVIDENCE_MS) this.firstUnanswered.delete(o.machineId);
        else if (!this.firstUnanswered.has(o.machineId)) this.firstUnanswered.set(o.machineId, now);
      }
      if (result.lastAnsweredAt !== null) this.lastAnsweredAt = result.lastAnsweredAt;
      this.settled = true;
      if (result.touched.length > 0 || result.outcomes.some((o) => o.added > 0)) await this.deps.afterIngest(result.touched);
      return result;
    } catch (err) {
      this.deps.reportError?.(err);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Any peer's rows rebuild a damaged log. With none answering, the owner's restore is the way forward. */
  private async repair(log: TeamAccessLog): Promise<void> {
    for (const peer of this.deps.peers()) {
      try {
        const { rows } = await peer.fetchRows({}, {});
        if (rows.length === 0) continue;
        const { touched } = log.rebuildFromPeer(rows);
        await this.deps.afterIngest(touched);
        return;
      } catch (err) {
        // @silent-fallback-ok — the next peer may answer; reported so a machine stuck damaged is seen.
        this.deps.reportError?.(err);
      }
    }
  }

  private liveness(): PeerLiveness[] {
    return this.deps.peers().filter((p) => !this.noLog.has(p.machineId)).map((p) => ({
      machineId: p.machineId, lastEvidenceAt: this.evidenceAt(p.machineId), firstUnansweredAt: this.firstUnanswered.get(p.machineId) ?? null,
    }));
  }

  /** Machines last known to be unable to keep a team's promises, with why. They block new invites and grants. */
  belowFloor(): BelowFloor[] {
    return this.deps.peers().flatMap((p): BelowFloor[] => {
      const s = this.standing.get(p.machineId);
      if (!s) return [];
      if (s.enforcement < TEAM_ENFORCEMENT_VERSION) return [{ machineId: p.machineId, reason: 'old-build' }];
      if (!s.native) return [{ machineId: p.machineId, reason: 'native-off' }];
      return s.privacy ? [] : [{ machineId: p.machineId, reason: 'memory-privacy-off' }];
    });
  }

  /** Is a reachable peer holding rows this machine has not taken in? Such a machine must not take the serving lease. */
  behind(): boolean { return this.behindPeers.size > 0; }

  /** The peers this machine is waiting on, for the owner's screen. */
  waitingOn(): string[] {
    const now = this.now();
    return this.liveness().filter((p) => shouldRefuseForStaleness([p], now)).map((p) => p.machineId);
  }

  /** Should this machine refuse its team phones right now? */
  refusing(): boolean {
    const peers = this.liveness();
    if (peers.length === 0) return false;
    if (!this.settled) return true;
    if (this.deps.strictStaleness?.() && this.now() - this.lastAnsweredAt >= STRICT_STALENESS_MS) return true;
    return shouldRefuseForStaleness(peers, this.now());
  }
}
