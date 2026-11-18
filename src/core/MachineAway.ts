/**
 * Machine-away announcements (docs/specs/restart-lock-continuity.md, part B).
 *
 * A machine that shuts down gracefully tells its peers why (a SWIM/Serf-style
 * "leave"), and peers show the reason in the pool until the machine is back.
 * The record is display only: it never routes or blocks anything.
 *
 * Clearing (B.2): a presence answer from a DIFFERENT server instance clears it
 * (the replacement came up, even if every pull missed the downtime). The same
 * instance still answering 15 minutes after the announcement clears it (the
 * shutdown did not happen). A peer that does not report its instance falls back
 * to: cleared by a successful pull that follows a failed one.
 */
import fs from 'node:fs';

export type MachineAwayReason = 'machine-restart' | 'server-restart' | 'stopping';

export interface MachineAwayCommand {
  type: 'machine-away';
  reason: MachineAwayReason;
  expectedBackInSec?: number;
  serverStartedAt: string;
}

export interface MachineAwayRecord {
  reason: MachineAwayReason;
  /** Receiver's clock at first receipt. */
  announcedAt: number;
  /** Receiver's clock: announcedAt + expectedBackInSec, when given. */
  expectedBackBy?: number;
  serverStartedAt: string;
  sawFailedPull?: boolean;
}

export const SAME_INSTANCE_CLEAR_MS = 15 * 60 * 1000;

const REASONS: ReadonlySet<string> = new Set(['machine-restart', 'server-restart', 'stopping']);

export function parseMachineAway(cmd: unknown): MachineAwayCommand | null {
  const c = cmd as Partial<MachineAwayCommand> | null;
  if (!c || c.type !== 'machine-away' || typeof c.reason !== 'string' || !REASONS.has(c.reason)) return null;
  if (typeof c.serverStartedAt !== 'string' || !c.serverStartedAt) return null;
  if (c.expectedBackInSec !== undefined && (!Number.isFinite(c.expectedBackInSec) || c.expectedBackInSec < 0 || c.expectedBackInSec > 24 * 3600)) return null;
  return { type: 'machine-away', reason: c.reason as MachineAwayReason, serverStartedAt: c.serverStartedAt, ...(c.expectedBackInSec !== undefined ? { expectedBackInSec: c.expectedBackInSec } : {}) };
}

/** The reason this machine announces, from records it wrote itself (B.1). */
export function machineAwayReason(o: { restartDispatched: boolean; restartRequestedRecently: boolean }): { reason: MachineAwayReason; expectedBackInSec?: number } {
  if (o.restartDispatched) return { reason: 'machine-restart', expectedBackInSec: 1200 };
  if (o.restartRequestedRecently) return { reason: 'server-restart', expectedBackInSec: 300 };
  return { reason: 'stopping' };
}

export class MachineAwayBook {
  private readonly records = new Map<string, MachineAwayRecord>();
  constructor(private readonly now: () => number = Date.now, private readonly log?: (line: string) => void) {}

  /** Record a verified announcement from `sender` about itself. Idempotent per instance. */
  receive(sender: string, cmd: MachineAwayCommand): MachineAwayRecord {
    const existing = this.records.get(sender);
    if (existing) {
      if (existing.serverStartedAt === cmd.serverStartedAt) return existing; // duplicate or replay: keep the first deadline
      if (Date.parse(cmd.serverStartedAt) < Date.parse(existing.serverStartedAt)) return existing; // an older instance: ignored
    }
    const now = this.now();
    const rec: MachineAwayRecord = {
      reason: cmd.reason,
      announcedAt: now,
      serverStartedAt: cmd.serverStartedAt,
      ...(cmd.expectedBackInSec !== undefined ? { expectedBackBy: now + cmd.expectedBackInSec * 1000 } : {}),
    };
    this.records.set(sender, rec);
    return rec;
  }

  /** A presence pull result for `machineId`. `serverStartedAt` is null when the peer does not report it. */
  observePresence(machineId: string, ok: boolean, serverStartedAt: string | null): void {
    const rec = this.records.get(machineId);
    if (!rec) return;
    if (!ok) { rec.sawFailedPull = true; return; }
    const now = this.now();
    let clear: string | null = null;
    if (serverStartedAt !== null) {
      if (serverStartedAt !== rec.serverStartedAt) clear = 'a new server instance answered';
      else if (now - rec.announcedAt >= SAME_INSTANCE_CLEAR_MS) clear = 'the same instance is still answering: the shutdown did not happen';
    } else if (rec.sawFailedPull) {
      clear = 'answered again after a failed pull (peer reports no instance)';
    }
    if (clear) { this.records.delete(machineId); this.log?.(`[machine-away] cleared ${machineId}: ${clear}`); }
  }

  get(machineId: string): MachineAwayRecord | null { return this.records.get(machineId) ?? null; }
}

/** Plain words for the pool reading (B.3). */
export function describeAway(rec: MachineAwayRecord, now: number): string {
  const back = rec.expectedBackBy ? new Date(rec.expectedBackBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  if (rec.expectedBackBy && now > rec.expectedBackBy + 10 * 60 * 1000) return `said it would be back by ${back} and hasn't returned`;
  if (rec.reason === 'machine-restart') return `restarting the machine${back ? `, expected back by ${back}` : ''}`;
  if (rec.reason === 'server-restart') return `restarting its server${back ? `, expected back by ${back}` : ''}`;
  return 'stopped on purpose, reason not recorded';
}

let activeBook: MachineAwayBook | null = null;
export function setActiveMachineAwayBook(b: MachineAwayBook | null): void { activeBook = b; }
export function getActiveMachineAwayBook(): MachineAwayBook | null { return activeBook; }

/**
 * Did this machine actually dispatch a restart rung on this boot in the last 5 minutes?
 * Read from the host restart ledger's tail; any read problem answers false ("no rung").
 */
export function restartRungDispatched(ledgerPath: string, bootAt: number | null, now = Date.now()): boolean {
  try {
    const lines = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n').slice(-50);
    for (const line of lines.reverse()) {
      let row: { type?: string; state?: string; rung?: number; bootAt?: number; at?: number };
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'episode' || row.state !== 'dispatched' || !row.rung) continue;
      if (typeof row.at !== 'number' || now - row.at > 5 * 60 * 1000) continue;
      if (bootAt !== null && typeof row.bootAt === 'number' && Math.abs(row.bootAt - bootAt) > 60_000) continue;
      return true;
    }
  } catch { /* no ledger: no rung */ }
  return false;
}

/**
 * Send the announcement to every peer in parallel, at most `concurrency` in flight,
 * within `budgetMs` overall. Best effort: failures and timeouts are logged, never thrown.
 */
export async function announceMachineAway(o: {
  peers: string[];
  send: (machineId: string, cmd: MachineAwayCommand, timeoutMs: number) => Promise<unknown>;
  cmd: MachineAwayCommand;
  budgetMs?: number;
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<{ sent: number; failed: number }> {
  const budget = o.budgetMs ?? 2000;
  const deadline = Date.now() + budget;
  const queue = [...o.peers];
  let sent = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      const left = deadline - Date.now();
      if (left <= 0) { failed++; continue; }
      try {
        const r = await o.send(id, o.cmd, left) as { ok?: boolean; result?: { ok?: boolean }; reason?: string } | undefined;
        // Reached only when the transport AND the peer's handler both said ok. An older peer refuses
        // the unknown command (claim-unauthorized), and that refusal resolves rather than throws.
        if (r && r.ok === true && (r.result === undefined || r.result?.ok !== false)) sent++;
        else { failed++; o.log?.(`[machine-away] ${id} not reached: ${r?.reason ?? 'refused'}`); }
      } catch { failed++; }
    }
  };
  const workers = Array.from({ length: Math.min(o.concurrency ?? 8, Math.max(1, o.peers.length)) }, () => worker());
  await Promise.race([Promise.all(workers), new Promise((r) => setTimeout(r, budget).unref?.())]);
  o.log?.(`[machine-away] announced ${o.cmd.reason} to ${sent} peer(s)${failed ? `, ${failed} not reached` : ''}`);
  return { sent, failed };
}
