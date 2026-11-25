import type Database from 'better-sqlite3';
import { OWNER_RECORD_MAX_INPUT } from '../core/ownerRecord.js';
import { normalizeHostedRelayHostname } from './clientHello.js';
import { readHostedRelayAgentPin, type HostedRelayAgentPin } from './agentIdentity.js';

type Candidate = Omit<Parameters<typeof readHostedRelayAgentPin>[0], 'previous'>;
const maxPinBytes = 384 * 1024;
const digest = /^[a-f0-9]{64}$/;
const fields = ['hostname', 'agentId', 'assignment', 'genesis', 'ownerHead', 'holder', 'leaseEpoch', 'spkiSha256', 'tlsFloors'];
const machineId = /^m_[0-9A-Za-z_-]{1,64}$/;
const isDigest = (value: unknown) => typeof value === 'string' && digest.test(value);

/** Storage parity fixture for a future native trust store. Verification and
 * the replacement write share one transaction against the latest recorded pin. */
export class HostedRelayAgentPinStore {
  constructor(private readonly db: Database.Database) {
    if (!db.open || db.readonly || db.memory || db.inTransaction
      || !['wal', 'delete'].includes(db.pragma('journal_mode', { simple: true }) as string)
      || Number(db.pragma('synchronous', { simple: true })) < 2) throw new Error('hosted-relay-pin-durability');
    db.exec(`CREATE TABLE IF NOT EXISTS main.hosted_relay_agent_pins (
      hostname TEXT PRIMARY KEY NOT NULL,
      pinJson TEXT NOT NULL CHECK(length(pinJson) <= ${maxPinBytes})
    ) STRICT`);
    const table = db.prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'hosted_relay_agent_pins'")
      .get() as { strict: number } | undefined;
    const columns = db.prepare('PRAGMA main.table_info(hosted_relay_agent_pins)').all() as
      Array<{ name: string; type: string; pk: number; notnull: number }>;
    if (table?.strict !== 1 || columns.length !== 2 || columns.some((column, index) =>
      column.name !== ['hostname', 'pinJson'][index] || column.type !== 'TEXT' || column.pk !== (index === 0 ? 1 : 0)
      || column.notnull !== 1)) throw new Error('hosted-relay-pin-schema');
  }

  verifyAndRecord(candidate: Candidate): HostedRelayAgentPin | undefined {
    if (this.db.inTransaction) return undefined;
    try {
      return this.db.transaction(() => {
        const hostname = candidate.locator.hostname;
        if (typeof hostname !== 'string' || normalizeHostedRelayHostname(hostname) !== hostname) return undefined;
        const previous = this.read(hostname);
        const next = readHostedRelayAgentPin({ ...candidate, previous });
        if (!next || next.hostname !== hostname) return undefined;
        const payload = JSON.stringify(next);
        if (Buffer.byteLength(payload) > maxPinBytes) return undefined;
        if (previous && JSON.stringify(previous) === payload) return next;
        const write = this.db.prepare(`INSERT INTO main.hosted_relay_agent_pins (hostname, pinJson) VALUES (?, ?)
          ON CONFLICT(hostname) DO UPDATE SET pinJson = excluded.pinJson`).run(hostname, payload);
        const saved = this.db.prepare('SELECT pinJson FROM main.hosted_relay_agent_pins WHERE hostname = ?').get(hostname) as
          { pinJson: string } | undefined;
        if (write.changes !== 1 || saved?.pinJson !== payload) throw new Error('hosted-relay-pin-write');
        return next;
      }).immediate();
    } catch { return undefined; } // @silent-fallback-ok — a failed read or persistence never replaces trust
  }

  private read(hostname: string): HostedRelayAgentPin | undefined {
    const row = this.db.prepare('SELECT pinJson FROM main.hosted_relay_agent_pins WHERE hostname = ?').get(hostname) as
      { pinJson: string } | undefined;
    if (!row) return undefined;
    if (typeof row.pinJson !== 'string' || Buffer.byteLength(row.pinJson) > maxPinBytes) throw new Error('hosted-relay-pin-record');
    const pin = JSON.parse(row.pinJson) as HostedRelayAgentPin;
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).length !== fields.length
      || !fields.every(field => Object.hasOwn(pin, field)) || pin.hostname !== hostname || typeof pin.agentId !== 'string' || !pin.agentId
      || typeof pin.holder !== 'string' || !machineId.test(pin.holder) || !Number.isSafeInteger(pin.leaseEpoch) || pin.leaseEpoch < 1
      || ![pin.assignment, pin.genesis, pin.ownerHead, pin.spkiSha256].every(isDigest)
      || !pin.tlsFloors || typeof pin.tlsFloors !== 'object' || Array.isArray(pin.tlsFloors)
      || !Object.hasOwn(pin.tlsFloors, pin.holder)) throw new Error('hosted-relay-pin-record');
    const floors = Object.entries(pin.tlsFloors);
    if (floors.length >= OWNER_RECORD_MAX_INPUT || floors.some(([holder, floor]) => !machineId.test(holder)
      || !floor || typeof floor !== 'object' || Object.keys(floor).length !== 2
      || !Object.hasOwn(floor, 'sequence') || !Object.hasOwn(floor, 'entryId')
      || !Number.isSafeInteger(floor.sequence) || floor.sequence < 0 || !isDigest(floor.entryId))) {
      throw new Error('hosted-relay-pin-record');
    }
    return pin;
  }
}
