/**
 * RemoteAckStore — durable queue for operator-bound attention acks that target
 * an attention item OWNED BY A DIFFERENT MACHINE (WS4.1 follow-up, CMT-1416).
 *
 * The problem this closes: when an operator acknowledges/resolves a pooled
 * attention item whose owner is briefly offline, the ack PATCH is lost — the
 * operator's intent evaporates and the item reappears OPEN on the owner's
 * return. This store persists the ack INTENT (with the authenticated operator
 * principal that performed it) so it survives the owner being dark; a drain
 * tick + a boot sweep re-deliver it when the owner comes back.
 *
 * Design constraints (mirrors RemoteCloseAudit / PendingInboundStore):
 *   - Append-then-compact JSONL under logs/ — no DB dependency.
 *   - Each pending ack is idempotent on (itemId, targetMachineId): a re-ack of
 *     the same item just refreshes the intent, never stacks duplicates.
 *   - The operator principal is carried as data the OWNER revalidates at apply
 *     time — this store never authorizes anything, it only remembers intent.
 *   - Best-effort writes; a failed append/compact logs loudly (an unrecorded
 *     ack-intent deserves a trace) but never throws into the ack path.
 *
 * This file ships behind the dark gate multiMachine.seamlessness.ws41DurableAck:
 * when off, the route that feeds it 503s and the store is never constructed, so
 * a single-machine or flag-off agent is a strict no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PendingRemoteAck {
  /** Attention item id on the OWNING machine. */
  itemId: string;
  /** Registry lookup key for the owning machine (never a URL). */
  targetMachineId: string;
  /** Normalized attention status the operator chose (e.g. DONE, ACKNOWLEDGED). */
  status: string;
  /** Authenticated operator principal that performed the ack (data the owner
   *  revalidates — never trusted as authorization by this store). */
  operatorUid: string;
  /** Operator display name (for the owner's audit; not load-bearing). */
  operatorDisplayName?: string;
  /** When the operator's intent was first captured (ISO). */
  enqueuedAt: string;
  /** Delivery attempts so far (drain backoff / give-up bound). */
  attempts: number;
  /** Last delivery attempt outcome class, for observability. */
  lastOutcome?: 'pending' | 'unreachable' | 'rejected' | 'stale-superseded';
}

export class RemoteAckStore {
  private readonly filePath: string;
  /** Keyed on `${itemId}::${targetMachineId}` — idempotent intent. */
  private readonly pending = new Map<string, PendingRemoteAck>();
  private loaded = false;

  constructor(
    stateDir: string,
    private readonly log: (msg: string) => void = console.log,
  ) {
    this.filePath = path.join(stateDir, '..', 'logs', 'remote-ack-queue.jsonl');
  }

  private key(itemId: string, targetMachineId: string): string {
    return `${itemId}::${targetMachineId}`;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const entry = JSON.parse(t) as PendingRemoteAck & { _deleted?: boolean };
          const k = this.key(entry.itemId, entry.targetMachineId);
          if (entry._deleted) {
            this.pending.delete(k);
          } else {
            this.pending.set(k, entry);
          }
        } catch {
          // @silent-fallback-ok — a torn last line (crash mid-append) is skipped;
          // the rest of the durable log still loads.
        }
      }
    } catch {
      // @silent-fallback-ok — absent file reads as empty queue (first run).
    }
  }

  private append(entry: PendingRemoteAck & { _deleted?: boolean }): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      /* state-registry: remote-ack-queue */
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      // Loud, not silent: a lost ack-intent reappears as a re-OPENed item to the
      // operator later — worth a trace even when the log file is the failure.
      this.log(
        `[remote-ack] QUEUE APPEND FAILED (intent held in memory only): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Record (or refresh) the operator's ack intent for an item owned elsewhere.
   * Idempotent on (itemId, targetMachineId): a repeat ack updates status/principal
   * and resets attempts rather than stacking a second pending row.
   */
  enqueue(intent: Omit<PendingRemoteAck, 'enqueuedAt' | 'attempts' | 'lastOutcome'>): PendingRemoteAck {
    this.ensureLoaded();
    const k = this.key(intent.itemId, intent.targetMachineId);
    const existing = this.pending.get(k);
    const entry: PendingRemoteAck = {
      ...intent,
      enqueuedAt: existing?.enqueuedAt ?? new Date().toISOString(),
      attempts: 0,
      lastOutcome: 'pending',
    };
    this.pending.set(k, entry);
    this.append(entry);
    return entry;
  }

  /** Mark a delivery attempt's outcome (drain observability + backoff input). */
  recordAttempt(itemId: string, targetMachineId: string, outcome: PendingRemoteAck['lastOutcome']): void {
    this.ensureLoaded();
    const k = this.key(itemId, targetMachineId);
    const entry = this.pending.get(k);
    if (!entry) return;
    entry.attempts += 1;
    entry.lastOutcome = outcome;
    this.append(entry);
  }

  /** Remove a delivered (or owner-rejected-as-stale) intent — terminal. */
  resolve(itemId: string, targetMachineId: string): void {
    this.ensureLoaded();
    const k = this.key(itemId, targetMachineId);
    if (!this.pending.has(k)) return;
    this.pending.delete(k);
    this.append({
      itemId,
      targetMachineId,
      status: '',
      operatorUid: '',
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      _deleted: true,
    });
  }

  /** All still-pending intents (for the drain tick / boot sweep / observability). */
  list(): PendingRemoteAck[] {
    this.ensureLoaded();
    return Array.from(this.pending.values());
  }

  /** Pending intents targeting one machine (drain when that peer comes online). */
  listForMachine(targetMachineId: string): PendingRemoteAck[] {
    return this.list().filter((e) => e.targetMachineId === targetMachineId);
  }

  /** Count of still-pending intents (cheap status read). */
  get size(): number {
    this.ensureLoaded();
    return this.pending.size;
  }
}
