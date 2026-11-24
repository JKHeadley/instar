/**
 * pinBudgetPoller — SEC-170 part 2 of 2 (docs/specs/pool-wide-pin-budget.md §4).
 *
 * Pulls every peer's signed PIN-share report (POST /api/pin-budget/state). Acknowledgments travel
 * this way: a peer has acknowledged a table when its report shows that table at or below its entry.
 * The reply is signed by the peer over this machine's fresh nonce, so a replayed or forged reply is
 * refused even though the transport only authenticates requests.
 *
 * Brakes (No Unbounded Loops): one round every 30 seconds, one call per peer per round; a failing
 * peer backs off from 5 seconds doubling to 60, and after 24 hours of failures it is only retried
 * when it is seen again (a signed call from it, or a registry change). Every failure is counted, never
 * thrown.
 */

import { randomBytes } from 'node:crypto';
import type { PeerShareReport } from './PinShareTable.js';
import { validateTable, MAX_TABLE_SEQ } from './PinShareTable.js';
import { AGENT_PIN_BUDGET } from './PinShare.js';

export const POLL_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STOP_AFTER_MS = 24 * 60 * 60 * 1000;
/** A report older than this no longer counts (as an acknowledgment, a founding check or a contact record). */
export const REPORT_MAX_AGE_MS = 5 * 60 * 1000;

export interface SignedStateReply {
  report: PeerShareReport;
  /** The peer's own newest signed contact per machine (merged here). */
  contacts: Record<string, number>;
  sig: string;
}

/** The exact text a peer signs. Domain-separated so it can never pass as a request signature. */
export function stateSigningText(nonce: string, report: PeerShareReport, contacts: Record<string, number>): string {
  return `pin-state-v1|${nonce}|${JSON.stringify(report)}|${JSON.stringify(contacts)}`;
}

export interface PinBudgetPollerDeps {
  self: () => string | null;
  /** Peers to pull: every other registry machine, active or retired since the last agreed table. */
  peers: () => string[];
  /** Members whose records must be readable for a gone-for-good to count (the registry's non-revoked machines). */
  members: () => string[];
  /** POST /api/pin-budget/state to a peer (signed request). Resolves with the parsed body or throws. */
  fetchState: (peerId: string, nonce: string) => Promise<unknown>;
  /** Verify `sig` over `text` with the peer's signing key. */
  verify: (peerId: string, text: string, sig: string) => boolean;
  now?: () => number;
}

interface PeerTrack { failures: number; nextAt: number; failingSince: number | null; lastOkAt: number }

export class PinBudgetPoller {
  private readonly reportsMap = new Map<string, PeerShareReport & { receivedAt: number }>();
  private readonly contactsMap = new Map<string, number>();
  private readonly tracks = new Map<string, PeerTrack>();
  private ready = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly now: () => number;

  constructor(private readonly deps: PinBudgetPollerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    void this.round();
    this.timer = setInterval(() => { void this.round(); }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Fresh verified reports only (younger than REPORT_MAX_AGE_MS). */
  reports(): ReadonlyMap<string, PeerShareReport> {
    const now = this.now();
    const out = new Map<string, PeerShareReport>();
    for (const [id, r] of this.reportsMap) if (now - r.receivedAt <= REPORT_MAX_AGE_MS) { const { receivedAt: _r, ...rest } = r; out.set(id, rest); }
    return out;
  }
  pollReady(): boolean { return this.ready; }

  /** Newest signed contact per machine, merged; complete only when every member's record was read. */
  contacts(): { map: ReadonlyMap<string, number>; complete: boolean } {
    const self = this.deps.self();
    const fresh = this.reports();
    const complete = this.deps.members().every((m) => m === self || fresh.has(m));
    return { map: this.contactsMap, complete };
  }

  /** A signed call arrived from `peerId`: it is alive, so a stopped retry resumes. */
  noteSeen(peerId: string): void {
    const now = this.now();
    this.bumpContact(peerId, now);
    const t = this.tracks.get(peerId);
    if (t && t.failingSince !== null) { t.failingSince = null; t.failures = 0; t.nextAt = now; }
  }

  /** One pass over the peers that are due. Exposed for tests. */
  async round(opts: { force?: boolean } = {}): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = this.now();
      const due = this.deps.peers().filter((p) => p && p !== this.deps.self()).filter((p) => {
        const t = this.tracks.get(p);
        if (!t) return true;
        if (t.failingSince !== null && now - t.failingSince >= STOP_AFTER_MS) return false;
        return opts.force === true || now >= t.nextAt;
      });
      await Promise.all(due.map((p) => this.pull(p)));
    } finally {
      this.inFlight = false;
      this.ready = true;
    }
  }

  private async pull(peerId: string): Promise<void> {
    const nonce = randomBytes(16).toString('hex');
    const now = this.now();
    const t = this.tracks.get(peerId) ?? { failures: 0, nextAt: 0, failingSince: null, lastOkAt: 0 };
    this.tracks.set(peerId, t);
    try {
      const body = await this.deps.fetchState(peerId, nonce) as SignedStateReply;
      const r = body?.report;
      if (!r || r.machineId !== peerId || typeof body.sig !== 'string' || !body.contacts || typeof body.contacts !== 'object') throw new Error('bad-reply');
      if (!this.deps.verify(peerId, stateSigningText(nonce, r, body.contacts), body.sig)) throw new Error('bad-signature');
      if (!Number.isInteger(r.applied) || r.applied < 0 || r.applied > AGENT_PIN_BUDGET) throw new Error('bad-applied');
      if (r.table !== null && !validateTable(r.table, r.table?.members ?? [], 0).ok) throw new Error('bad-table');
      if (r.table && (!Number.isSafeInteger(r.table.seq) || r.table.seq > MAX_TABLE_SEQ)) throw new Error('bad-seq');
      this.reportsMap.set(peerId, { machineId: peerId, table: r.table ?? null, applied: r.applied, retired: !!r.retired, needsShare: !!r.needsShare, heldTransfer: typeof r.heldTransfer === 'string' ? r.heldTransfer.slice(0, 64) : null, receivedAt: now });
      this.bumpContact(peerId, now);
      for (const [m, at] of Object.entries(body.contacts)) if (typeof at === 'number' && Number.isFinite(at) && at <= now + 60_000) this.bumpContact(m, at);
      t.failures = 0; t.nextAt = now + POLL_INTERVAL_MS; t.failingSince = null; t.lastOkAt = now;
    } catch {
      // @silent-fallback-ok — an unanswered or refused pull is counted as no acknowledgment (never as one)
      t.failures += 1;
      t.failingSince = t.failingSince ?? now;
      t.nextAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (t.failures - 1));
    }
  }

  private bumpContact(m: string, at: number): void {
    if ((this.contactsMap.get(m) ?? 0) < at) this.contactsMap.set(m, at);
  }
}
