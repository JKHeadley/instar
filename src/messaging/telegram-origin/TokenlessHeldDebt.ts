/**
 * standby-durable-forward-without-token §9 — "a reply is pending on machine X".
 *
 * While a token-less standby holds a reply, it is the only machine with that
 * reply. So when it creates such a hold it sends the operation's metadata-only
 * evidence (envelope: destination, digests, authored time — never the text) to
 * every pool peer it can reach. Each peer records a DEBT entry. The entry stays
 * open until the origin machine reports how the hold ended, or the owner records
 * the machine as gone in the owner-signed team records. Nothing ages it out.
 */
import fs from 'node:fs';
import path from 'node:path';

export type HeldOutcome = 'delivered' | 'retired' | 'expired' | 'outcome-unknown';
const OUTCOMES: ReadonlySet<string> = new Set<HeldOutcome>(['delivered', 'retired', 'expired', 'outcome-unknown']);
export interface TokenlessHoldNotice { rootOperationId: string; topicId: string | null; authoredAt: number }
export interface HeldDebtEntry extends TokenlessHoldNotice { originMachineId: string; recordedAt: number }
export interface HeldOutcomeReport { rootOperationId: string; outcome: HeldOutcome }

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } // @silent-fallback-ok — a missing/corrupt debt file starts empty and is rebuilt by the next notices
}
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
const ID = /^[A-Za-z0-9~-]{1,128}$/;

export function sanitizeHoldNotice(raw: unknown): TokenlessHoldNotice | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.rootOperationId !== 'string' || !ID.test(r.rootOperationId) || typeof r.authoredAt !== 'number' || !Number.isFinite(r.authoredAt)) return null;
  const topicId = typeof r.topicId === 'string' && r.topicId.length <= 32 ? r.topicId : null;
  return { rootOperationId: r.rootOperationId, topicId, authoredAt: r.authoredAt };
}
export function sanitizeOutcomes(raw: unknown): HeldOutcomeReport[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap(o => {
    const r = o as Record<string, unknown>;
    return typeof r?.rootOperationId === 'string' && ID.test(r.rootOperationId) && typeof r.outcome === 'string' && OUTCOMES.has(r.outcome)
      ? [{ rootOperationId: r.rootOperationId, outcome: r.outcome as HeldOutcome }] : [];
  });
}

/** Close (delete) every entry whose machine is gone, reporting each once: the deletion is the
 * brake, so a later pass finds nothing left to report (§9). Mutates `all`; returns the count. */
export function closeGoneEntries(all: Record<string, HeldDebtEntry>, isGone: (machineId: string) => boolean, onLoss?: (entry: HeldDebtEntry) => void): number {
  let n = 0;
  for (const [key, e] of Object.entries(all)) if (isGone(e.originMachineId)) { onLoss?.(e); delete all[key]; n++; }
  return n;
}

/** Peer side: open debt entries for other machines' token-less holds. */
export class PeerHeldDebtStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'tokenless-held-debt.json');
  }
  private load(): Record<string, HeldDebtEntry> { return readJson<Record<string, HeldDebtEntry>>(this.file, {}); }
  add(originMachineId: string, notice: TokenlessHoldNotice): void {
    const all = this.load();
    const key = `${originMachineId}:${notice.rootOperationId}`;
    if (all[key]) return;
    all[key] = { ...notice, originMachineId, recordedAt: this.now() };
    writeJsonAtomic(this.file, all);
  }
  /** Only the origin machine itself may close its entries. Returns the ids closed. */
  close(sender: string, outcomes: readonly HeldOutcomeReport[]): string[] {
    const all = this.load();
    const closed: string[] = [];
    for (const o of outcomes) {
      const key = `${sender}:${o.rootOperationId}`;
      if (all[key]) { delete all[key]; closed.push(o.rootOperationId); }
    }
    if (closed.length) writeJsonAtomic(this.file, all);
    return closed;
  }
  /** Close every entry of a machine the owner recorded as gone: each one is a real loss. */
  closeGone(isGone: (machineId: string) => boolean, onLoss?: (entry: HeldDebtEntry) => void): number {
    const all = this.load();
    const n = closeGoneEntries(all, isGone, onLoss);
    if (n) writeJsonAtomic(this.file, all);
    return n;
  }
  /** Entries past the hold deadline, collapsed per origin machine (count + oldest). */
  overdue(deadlineMs: number): Array<{ originMachineId: string; count: number; oldestAuthoredAt: number; label: string }> {
    const cutoff = this.now() - deadlineMs;
    const by = new Map<string, { count: number; oldest: number }>();
    for (const e of Object.values(this.load())) {
      if (e.authoredAt > cutoff) continue;
      const g = by.get(e.originMachineId) ?? { count: 0, oldest: e.authoredAt };
      g.count++; g.oldest = Math.min(g.oldest, e.authoredAt); by.set(e.originMachineId, g);
    }
    return [...by.entries()].map(([originMachineId, g]) => ({ originMachineId, count: g.count, oldestAuthoredAt: g.oldest,
      label: `pending on ${originMachineId}, outcome unknown` }));
  }
}

/** Standby side: which peers were told about which holds, and outcomes still to report. */
export class StandbyHeldDebtLedger {
  private readonly file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'state', 'tokenless-held-debt-notified.json'); }
  private load(): { notified: Record<string, string[]>; outcomes: Record<string, HeldOutcome> } {
    return readJson(this.file, { notified: {}, outcomes: {} });
  }
  notified(rootOperationId: string, peers: readonly string[]): void {
    if (!peers.length) return;
    const d = this.load();
    d.notified[rootOperationId] = [...new Set([...(d.notified[rootOperationId] ?? []), ...peers])];
    writeJsonAtomic(this.file, d);
  }
  resolved(rootOperationId: string, outcome: HeldOutcome): void {
    const d = this.load();
    if (!d.notified[rootOperationId]) return;
    d.outcomes[rootOperationId] = outcome;
    writeJsonAtomic(this.file, d);
  }
  /** Outcomes still owed to `peer`. */
  owed(peer: string): HeldOutcomeReport[] {
    const d = this.load();
    return Object.entries(d.outcomes).filter(([root]) => d.notified[root]?.includes(peer)).map(([rootOperationId, outcome]) => ({ rootOperationId, outcome }));
  }
  /** `peer` acknowledged these: forget them for that peer, and drop fully reported roots. */
  acked(peer: string, roots: readonly string[]): void {
    if (!roots.length) return;
    const d = this.load();
    for (const r of roots) {
      d.notified[r] = (d.notified[r] ?? []).filter(p => p !== peer);
      if (!d.notified[r].length) { delete d.notified[r]; delete d.outcomes[r]; }
    }
    writeJsonAtomic(this.file, d);
  }
  peersOwed(): string[] {
    const d = this.load();
    return [...new Set(Object.keys(d.outcomes).flatMap(r => d.notified[r] ?? []))];
  }
}

/** The root of a supersede chain (`<root>~r<hop>-<plan8>` → `<root>`). */
export function chainRoot(operationId: string): string {
  const m = /^(.*)~r\d+-[0-9a-f]{8}$/.exec(operationId);
  return m ? m[1] : operationId;
}

// ── Process-wide wiring (set by the server; read by the status route) ─────────
let peerStore: PeerHeldDebtStore | null = null;
let goneCheck: ((machineId: string) => boolean) | null = null;
let lossReporter: ((entry: HeldDebtEntry) => void) | null = null;
export function setPeerHeldDebtStore(store: PeerHeldDebtStore | null): void { peerStore = store; }
/** The owner-signed gone record (TeamAccessLog.isGone), and who is told of each real loss. */
export function setHeldDebtGoneCheck(check: ((machineId: string) => boolean) | null, onLoss?: (entry: HeldDebtEntry) => void): void {
  goneCheck = check; lossReporter = onLoss ?? null;
}
export function peerHeldDebtStore(): PeerHeldDebtStore | null { return peerStore; }
/** `peerHeldDebt` for GET /telegram/origins/status: gone machines first close as losses. */
export function peerHeldDebtSummary(deadlineMs: number): ReturnType<PeerHeldDebtStore['overdue']> {
  if (!peerStore) return [];
  if (goneCheck) { try { peerStore.closeGone(goneCheck, lossReporter ?? undefined); } catch { /* @silent-fallback-ok — the list still answers; closure retries on the next read */ } }
  return peerStore.overdue(deadlineMs);
}
