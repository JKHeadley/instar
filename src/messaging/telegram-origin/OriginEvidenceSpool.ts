/** Inert evidence sink. It deliberately opens neither the primary origin DB nor
 * the executable outbox, and therefore survives primary open/lock failures.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EvidenceReceipt, OriginStoreOptions, StoredOriginInput } from './StoreTypes.js';

export function writeSpoolEvidence(options: OriginStoreOptions, record: StoredOriginInput): EvidenceReceipt {
  if (!record.originId || record.originId.length > 256 || !record.machineId || !Number.isSafeInteger(record.createdAt) || Buffer.byteLength(record.envelopeJson) > 256 * 1024) throw new Error('origin-spool:invalid-record');
  JSON.parse(record.envelopeJson);
  if (createHash('sha256').update(record.envelopeJson).digest('hex') !== record.envelopeDigest) throw new Error('origin-spool:digest-mismatch');
  const directory = options.spoolDir ?? path.join(options.stateDir, 'state', 'telegram-origin-spool', options.agentId.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'evidence.sqlite');
  const db = new Database(filename, { timeout: 25 });
  try {
    fs.chmodSync(filename, 0o600); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    db.exec('CREATE TABLE IF NOT EXISTS evidence(origin_id TEXT PRIMARY KEY,digest TEXT NOT NULL,record_json TEXT NOT NULL)');
    const inserted = db.transaction(() => {
      const previous = db.prepare('SELECT digest FROM evidence WHERE origin_id=?').get(record.originId) as { digest: string } | undefined;
      if (previous) { if (previous.digest !== record.envelopeDigest) throw new Error('origin-spool:origin-id-conflict'); return false; }
      db.prepare('INSERT INTO evidence VALUES (?,?,?)').run(record.originId, record.envelopeDigest, JSON.stringify(record));
      return true;
    }).immediate();
    const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return { originId: record.originId, digest: record.envelopeDigest, inserted, sink: 'spool' };
  } finally { db.close(); }
}
