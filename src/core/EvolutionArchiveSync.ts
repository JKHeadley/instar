/** Bounded archive anti-entropy on the existing authenticated peer-presence cadence. */
import { EvolutionArchive, type EvolutionArchivePage, type EvolutionArchiveSyncPeer } from './EvolutionArchive.js';

export const EVOLUTION_ARCHIVE_SYNC_MAX_FAILURES = 6;

/** Shared runtime/ratchet brake: unchanged evidence eventually permits no more requests. */
export function evolutionArchiveSyncAttemptDue(peer: EvolutionArchiveSyncPeer, now: number): boolean {
  return !peer.parked && peer.failures < EVOLUTION_ARCHIVE_SYNC_MAX_FAILURES && now >= peer.nextAttemptAt;
}

/** Pessimistic attempt reservation: only durable validated import earns the budget back. */
export function advanceEvolutionArchiveFailure(peer: EvolutionArchiveSyncPeer, now: number): EvolutionArchiveSyncPeer {
  const failures = peer.failures + 1;
  return { ...peer, failures, nextAttemptAt: now + Math.min(30 * 60_000, 30_000 * 2 ** (failures - 1)),
    parked: failures >= EVOLUTION_ARCHIVE_SYNC_MAX_FAILURES };
}

export interface EvolutionArchiveSyncDeps {
  fetchPage(peerId: string, url: string, offset: number, signal: AbortSignal): Promise<EvolutionArchivePage>;
  now?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}
/* @self-action-controller: evolution-archive-sync */
export class EvolutionArchiveSync {
  private readonly active = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly archive: EvolutionArchive, private readonly deps: EvolutionArchiveSyncDeps) {}

  private peer(peerId: string, url: string): EvolutionArchiveSyncPeer {
    const doc = this.archive.read();
    const prior = doc.syncPeers?.[peerId];
    return prior?.url === url ? { ...prior } : { url, offset: 0, failures: 0, nextAttemptAt: 0, parked: false };
  }
  private persist(peerId: string, peer: EvolutionArchiveSyncPeer): void {
    const doc = this.archive.read(); // Always re-read after any asynchronous fetch/import.
    doc.syncPeers = { ...(doc.syncPeers ?? {}), [peerId]: peer };
    this.archive.write(doc);
  }
  /** Explicit agent-owned re-arm; repeated presence alone never resets a parked peer. */
  resetPeer(peerId: string): void {
    const doc = this.archive.read();
    if (doc.syncPeers?.[peerId]) {
      doc.syncPeers[peerId] = { ...doc.syncPeers[peerId], failures: 0, nextAttemptAt: 0, parked: false };
      this.archive.write(doc);
    }
  }
  async onPeerRecorded(peerId: string, url: string): Promise<void> {
    if (this.stopped || this.active.has(peerId)) return;
    const now = this.deps.now ?? Date.now;
    // A corrupt ledger must refuse ALL requests; never silently reset its bound.
    let peer: EvolutionArchiveSyncPeer;
    try { peer = this.peer(peerId, url); }
    catch (err) { this.deps.log?.('evolution-archive-sync-unavailable', { peerId, error: String(err) }); return; }
    if (!evolutionArchiveSyncAttemptDue(peer, now())) return;
    const controller = new AbortController();
    this.active.set(peerId, controller);
    const deadline = setTimeout(() => controller.abort(), 5_000);
    deadline.unref();
    try {
      for (let pages = 0; pages < 4 && !this.stopped && !controller.signal.aborted; pages++) {
        if (!evolutionArchiveSyncAttemptDue(peer, now())) return;
        // Spend and fsync the retry budget BEFORE sending. A full/unwritable archive
        // authorizes zero requests; process loss or failed custody cannot reset attempts.
        const reserved = advanceEvolutionArchiveFailure(peer, now());
        this.persist(peerId, reserved);
        peer = reserved;
        const page = await this.deps.fetchPage(peerId, url, peer.offset, controller.signal);
        if (this.stopped || controller.signal.aborted) return;
        EvolutionArchive.validatePage(page);
        if (peer.incarnation !== undefined && peer.incarnation !== page.incarnation && peer.offset !== 0) {
          // Do not accept a stale-offset page from a rebuilt stream; rescan its beginning.
          const reset = { ...peer, offset: 0, incarnation: page.incarnation, failures: 0, nextAttemptAt: 0, parked: false };
          this.persist(peerId, reset);
          peer = reset;
          continue;
        }
        if (page.offset !== peer.offset) throw new Error('peer archive offset mismatch');
        this.archive.importPage(page); // fsync custody first; cursor is durable only afterwards.
        const imported = { ...peer, incarnation: page.incarnation, offset: page.nextOffset ?? 0, failures: 0, nextAttemptAt: 0, parked: false };
        this.persist(peerId, imported);
        peer = imported;
        if (page.nextOffset === null) return;
      }
    } catch (err) {
      if (!this.stopped) {
        // The attempt was already charged before fetch; never double-charge or
        // depend on a second write succeeding after a disk/custody failure.
        this.deps.log?.(peer.parked ? 'evolution-archive-sync-parked' : 'evolution-archive-sync-failed', { peerId, failures: peer.failures, nextAttemptAt: peer.nextAttemptAt, error: String(err) });
      }
    } finally {
      clearTimeout(deadline);
      this.active.delete(peerId);
    }
  }
  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
  }
}
