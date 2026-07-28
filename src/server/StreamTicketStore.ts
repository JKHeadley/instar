/**
 * StreamTicketStore — phase 2 of Pool Dashboard Streaming
 * (POOL-DASHBOARD-STREAM-SPEC §2.3, the auth boundary).
 *
 * Lives on the SERVING machine (the one that holds the session). When a peer
 * wants to stream a remote session it first calls the serving machine's
 * machine-authed `POST /pool-stream/ticket` (proving its identity via the mesh
 * signing scheme); the serving machine mints a SHORT-LIVED, SINGLE-USE ticket
 * and returns it. The peer presents that ticket on the `/pool-stream` WS
 * upgrade; the serving machine consumes it (one-time) and binds the resulting
 * connection to a server-issued id.
 *
 * Why a ticket and not signed-headers-at-upgrade (security review sec#1): a
 * long-lived WS authenticated only once at upgrade lets a captured upgrade be
 * replayed for the whole connection. A ticket is bounded (TTL), single-use, and
 * its consumed-set is PERSISTED so a captured ticket cannot be replayed even
 * across a serving-machine restart (sec#4).
 *
 * Pure + injected (clock, randomness via `mintId`, fs path) so the whole
 * lifecycle — mint / consume / expiry / replay-across-restart — is
 * deterministically unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StreamTicket {
  ticket: string;
  /** The peer this ticket was minted FOR (must match the WS upgrade's authed sender). */
  forMachineId: string;
  /** ms epoch when the ticket stops being valid. */
  expiresAtMs: number;
}

export type ConsumeResult =
  | { ok: true; forMachineId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'already-consumed' | 'wrong-machine' };

interface TicketRecord {
  forMachineId: string;
  expiresAtMs: number;
  consumed: boolean;
}

interface StoreFileShape {
  version: 1;
  tickets: Record<string, TicketRecord>;
}

export interface StreamTicketStoreDeps {
  /** Absolute path to the persistence file. */
  filePath: string;
  now: () => number;
  /** Mint a fresh opaque ticket string (crypto-random in prod; deterministic in tests). */
  mintId: () => string;
  /** Ticket lifetime (ms). Default 60_000. */
  ttlMs?: number;
  /** How long a CONSUMED/expired record is retained for replay rejection before GC (ms). Default 1h. */
  retentionMs?: number;
  logger?: (line: string) => void;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;

export class StreamTicketStore {
  private tickets = new Map<string, TicketRecord>();
  private loaded = false;

  constructor(private readonly d: StreamTicketStoreDeps) {}

  private ttl(): number { return this.d.ttlMs ?? DEFAULT_TTL_MS; }
  private retention(): number { return this.d.retentionMs ?? DEFAULT_RETENTION_MS; }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const body = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8')) as StoreFileShape;
        if (body && body.tickets) {
          for (const [t, r] of Object.entries(body.tickets)) {
            if (r && typeof r.forMachineId === 'string' && typeof r.expiresAtMs === 'number') {
              this.tickets.set(t, { forMachineId: r.forMachineId, expiresAtMs: r.expiresAtMs, consumed: !!r.consumed });
            }
          }
        }
      }
    } catch (e) {
      // A corrupt store must FAIL CLOSED (lose pending tickets) rather than
      // crash — re-minting a ticket is a cheap one-round-trip retry, but a
      // crash would take the serving endpoint down. Persisted consumed-records
      // are the replay defense; losing them only widens the replay window to
      // pre-restart tickets that are TTL-bounded anyway.
      this.d.logger?.(`[stream-ticket] store unreadable, starting empty: ${(e as Error)?.message ?? e}`);
      this.tickets.clear();
    }
    this.gc();
  }

  /** Mint a single-use ticket for `forMachineId`. */
  mint(forMachineId: string): StreamTicket {
    this.ensureLoaded();
    this.gc();
    const ticket = this.d.mintId();
    const expiresAtMs = this.d.now() + this.ttl();
    this.tickets.set(ticket, { forMachineId, expiresAtMs, consumed: false });
    this.persist();
    return { ticket, forMachineId, expiresAtMs };
  }

  /**
   * Consume a ticket presented on the WS upgrade. The ticket is an unguessable
   * single-use bearer credential minted ONLY to an authenticated peer (over the
   * machine-authed `pool-stream-ticket` mesh verb), so possession authorizes;
   * the consumed `forMachineId` (bound at mint) tells the server which peer it
   * is — never an unverified claim from the upgrade. `presentedBy` is OPTIONAL
   * defense-in-depth: when the upgrade independently proves identity, the ticket
   * must also have been minted for exactly that machine (rejects a stolen ticket
   * replayed by a different authenticated machine).
   */
  consume(ticket: string, presentedBy?: string): ConsumeResult {
    this.ensureLoaded();
    const rec = this.tickets.get(ticket);
    if (!rec) return { ok: false, reason: 'unknown' };
    if (rec.consumed) return { ok: false, reason: 'already-consumed' };
    if (this.d.now() >= rec.expiresAtMs) return { ok: false, reason: 'expired' };
    if (presentedBy !== undefined && rec.forMachineId !== presentedBy) return { ok: false, reason: 'wrong-machine' };
    // Mark consumed (NOT delete) + persist BEFORE returning ok, so a crash
    // mid-consume can never yield a second successful consume of the same ticket.
    rec.consumed = true;
    this.persist();
    return { ok: true, forMachineId: rec.forMachineId };
  }

  /** Drop expired-past-retention and consumed-past-retention records. */
  private gc(): void {
    const cutoff = this.d.now() - this.retention();
    let changed = false;
    for (const [t, r] of this.tickets) {
      // Keep a consumed/expired record until retention elapses (replay window),
      // then it's safe to forget (its TTL long passed — re-presenting it fails
      // 'expired' anyway, but GC keeps the map bounded).
      if (r.expiresAtMs < cutoff) {
        this.tickets.delete(t);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Count of live (unconsumed, unexpired) tickets — tests/observability. */
  liveCount(): number {
    this.ensureLoaded();
    const now = this.d.now();
    let n = 0;
    for (const r of this.tickets.values()) if (!r.consumed && now < r.expiresAtMs) n++;
    return n;
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.d.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tickets: Record<string, TicketRecord> = {};
      for (const [t, r] of this.tickets) tickets[t] = r;
      const body: StoreFileShape = { version: 1, tickets };
      const tmp = `${this.d.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
      fs.renameSync(tmp, this.d.filePath);
    } catch (e) {
      // @silent-fallback-ok: a persistence failure degrades replay-across-restart
      // protection for in-flight tickets only (all TTL-bounded); it must not
      // crash the mint/consume path. The in-memory consumed-set still blocks
      // replay within this process lifetime (POOL-DASHBOARD-STREAM-SPEC §2.3).
      this.d.logger?.(`[stream-ticket] persist failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
