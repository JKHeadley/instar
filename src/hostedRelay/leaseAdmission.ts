import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { normalizeHostedRelayHostname } from './clientHello.js';

const scopeId = /^[a-f0-9]{64}$/;
const machineId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface HostedRelayLease {
  readonly hostname: string;
  readonly assignment: string;
  readonly holder: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

export interface HostedRelayLeaseClaim extends HostedRelayLease {
  readonly challenge: string;
  readonly signature: string;
}

interface AdmittedConnection extends HostedRelayLease {
  readonly connectionId: string;
  readonly keyHash: string;
}

type Challenge = Readonly<{ nonce: string }>;

const keyDigest = (key: ReturnType<typeof createPublicKey>) =>
  createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex');

type Floor = Pick<AdmittedConnection, 'assignment' | 'holder' | 'epoch' | 'connectionId'>;

export function hostedRelayLeaseMessage(lease: HostedRelayLease, challenge: string): string {
  return 'instar-hosted-relay-lease-v1\n' + JSON.stringify([
    lease.hostname, lease.assignment, lease.holder, lease.epoch, lease.expiresAt, challenge,
  ]);
}

/** Persist the accepted holder and lease epoch before notifying the old stream.
 * The caller must supply the same authoritative database to all local workers.
 * resolveLease must independently verify the current owner record and committed
 * mesh lease. A holder's connection signature cannot issue a mesh lease. */
export class HostedRelayLeaseAdmission {
  private readonly challenges = new WeakMap<Challenge, number>();
  private readonly admitted = new WeakSet<AdmittedConnection>();

  constructor(private readonly db: Database.Database,
    private readonly resolveLease: (hostname: string) => (HostedRelayLease & { publicKeyPem: string }) | undefined,
    private readonly now: () => number = Date.now, private readonly elapsed: () => number = () => performance.now()) {
    if (!db.open || db.readonly || db.memory || db.inTransaction || !db.name
      || !['wal', 'delete'].includes(db.pragma('journal_mode', { simple: true }) as string)
      || Number(db.pragma('synchronous', { simple: true })) < 2) throw new Error('hosted-relay-lease-durability');
    db.exec(`CREATE TABLE IF NOT EXISTS main.hosted_relay_lease_floor (
      hostname TEXT PRIMARY KEY NOT NULL,
      assignment TEXT NOT NULL,
      holder TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch > 0),
      connectionId TEXT NOT NULL
    ) STRICT`);
    const table = db.prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'hosted_relay_lease_floor'")
      .get() as { strict: number } | undefined;
    const columns = db.prepare('PRAGMA main.table_info(hosted_relay_lease_floor)').all() as
      Array<{ name: string; type: string; pk: number; notnull: number }>;
    const fields = ['hostname', 'assignment', 'holder', 'epoch', 'connectionId'];
    if (table?.strict !== 1 || columns.length !== fields.length || columns.some((column, index) =>
      column.name !== fields[index] || column.type !== (column.name === 'epoch' ? 'INTEGER' : 'TEXT')
      || column.pk !== (index === 0 ? 1 : 0) || column.notnull !== 1)) throw new Error('hosted-relay-lease-schema');
  }

  /** Keep this handle on the socket and send only its nonce to the holder. */
  challenge(): Challenge {
    const challenge = Object.freeze({ nonce: randomBytes(32).toString('hex') });
    this.challenges.set(challenge, this.elapsed() + 30_000);
    return challenge;
  }

  /** Old streams must be fenced using canServe and the returned displaced ID. */
  admit(claim: HostedRelayLeaseClaim, handshake: Challenge):
    { connection: AdmittedConnection; displacedConnectionId?: string } | undefined {
    const deadline = this.challenges.get(handshake);
    this.challenges.delete(handshake);
    if (deadline === undefined || !(this.elapsed() < deadline)) return undefined;
    const expectedChallenge = handshake.nonce;
    if (this.db.inTransaction || !claim || typeof claim.hostname !== 'string'
      || normalizeHostedRelayHostname(claim.hostname) !== claim.hostname || typeof claim.assignment !== 'string' || !scopeId.test(claim.assignment)
      || typeof claim.holder !== 'string' || !machineId.test(claim.holder) || !Number.isSafeInteger(claim.epoch) || claim.epoch < 1
      || !Number.isSafeInteger(claim.expiresAt) || claim.challenge !== expectedChallenge
      || typeof claim.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(claim.signature)) return undefined;
    try {
      const accepted = this.db.transaction(() => {
        const lease = this.current(claim);
        if (!lease) return undefined;
        const key = createPublicKey(lease.publicKeyPem);
        if (key.asymmetricKeyType !== 'ed25519'
          || !verify(null, Buffer.from(hostedRelayLeaseMessage(claim, expectedChallenge)), key, Buffer.from(claim.signature, 'base64'))) {
          return undefined;
        }
        const connectionId = createHash('sha256').update(expectedChallenge).digest('hex');
        const floor = this.floor(claim.hostname);
        // A relay name is never recycled for another assignment.
        if (floor && (floor.assignment !== claim.assignment || floor.epoch > claim.epoch || floor.connectionId === connectionId
          || (floor.epoch === claim.epoch && floor.holder !== claim.holder))) return undefined;
        this.db.prepare(`INSERT INTO main.hosted_relay_lease_floor (hostname, assignment, holder, epoch, connectionId)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(hostname) DO UPDATE SET holder = excluded.holder, epoch = excluded.epoch, connectionId = excluded.connectionId`)
          .run(claim.hostname, claim.assignment, claim.holder, claim.epoch, connectionId);
        const { hostname, assignment, holder, epoch, expiresAt } = claim;
        return { connection: Object.freeze({ hostname, assignment, holder, epoch, expiresAt, connectionId, keyHash: keyDigest(key) }),
          displacedConnectionId: floor?.connectionId };
      }).immediate();
      if (accepted) this.admitted.add(accepted.connection);
      return accepted;
    } catch { return undefined; } // @silent-fallback-ok — unverified or unwritable leases cannot admit a connection
  }

  canServe(connection: AdmittedConnection): boolean {
    if (this.db.inTransaction || !this.admitted.has(connection)) return false;
    try {
      const floor = this.floor(connection.hostname);
      if (!floor || floor.assignment !== connection.assignment || floor.holder !== connection.holder
        || floor.epoch !== connection.epoch || floor.connectionId !== connection.connectionId) return false;
      const current = this.current(connection);
      return !!current && keyDigest(createPublicKey(current.publicKeyPem)) === connection.keyHash;
    } catch { return false; } // @silent-fallback-ok — unreadable current custody cannot forward a stream
  }

  private current(claim: HostedRelayLease) {
    const lease = this.resolveLease(claim.hostname);
    const now = this.now();
    return lease && Number.isSafeInteger(now) && now >= 0 && claim.expiresAt > now
      && lease.hostname === claim.hostname && lease.assignment === claim.assignment && lease.holder === claim.holder
      && lease.epoch === claim.epoch && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= claim.expiresAt ? lease : undefined;
  }

  private floor(hostname: string): Floor | undefined {
    return this.db.prepare(`SELECT assignment, holder, epoch, connectionId FROM main.hosted_relay_lease_floor WHERE hostname = ?`)
      .get(hostname) as Floor | undefined;
  }
}
