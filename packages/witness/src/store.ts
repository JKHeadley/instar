/**
 * WitnessStore — a local, append-only store of witness records.
 *
 * One file per record, named by its content hash, so the same record arriving
 * twice (from a peer and again from replication) is one file. Nothing is ever
 * deleted or rewritten: revocation is another record.
 *
 * Every record is verified BEFORE it is stored. A record whose issuer key
 * cannot be resolved is refused, not stored "for later" — an unverified record
 * on disk is indistinguishable from a verified one to the next reader.
 *
 * A stored record is untrusted data about a peer. It is never an answer to
 * "who is my operator" and never an authorization.
 */

import fs from 'node:fs';
import path from 'node:path';
import { recordHash, verifyRecord, type WitnessRecord } from './record.js';

/** Returns the issuer's Witness public key (hex) for this key id, or undefined if unknown. */
export type KeyResolver = (issuer: string, keyId: string) => string | undefined;

export type AddResult =
  | { status: 'added' | 'duplicate'; hash: string }
  | { status: 'rejected'; reason: string };

export type RecordStatus = 'valid' | 'expired' | 'revoked' | 'unknown';

export class WitnessStore {
  private readonly recordsDir: string;

  constructor(private readonly opts: { dir: string; resolveKey: KeyResolver }) {
    this.recordsDir = path.join(opts.dir, 'records');
    fs.mkdirSync(this.recordsDir, { recursive: true });
  }

  add(record: WitnessRecord, now: Date = new Date()): AddResult {
    const issuer = (record as Partial<WitnessRecord>)?.issuer;
    const keyId = (record as Partial<WitnessRecord>)?.key_id;
    if (typeof issuer !== 'string' || typeof keyId !== 'string') {
      return { status: 'rejected', reason: 'missing issuer or key_id' };
    }
    const key = this.opts.resolveKey(issuer, keyId);
    if (!key) return { status: 'rejected', reason: `no known Witness key ${keyId} for ${issuer}` };
    const check = verifyRecord(record, key, now);
    if (!check.ok) return { status: 'rejected', reason: check.reason };

    const hash = recordHash(record);
    const file = this.fileFor(hash);
    if (fs.existsSync(file)) return { status: 'duplicate', hash };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    try {
      // link() fails if the target exists, so a concurrent writer of the same record cannot be overwritten.
      fs.linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return { status: 'duplicate', hash };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { status: 'added', hash };
  }

  get(hash: string): WitnessRecord | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(hash), 'utf8')) as WitnessRecord;
    } catch {
      return undefined;
    }
  }

  list(filter: { issuer?: string; subject?: string } = {}): Array<{ hash: string; record: WitnessRecord }> {
    const out: Array<{ hash: string; record: WitnessRecord }> = [];
    for (const name of fs.readdirSync(this.recordsDir)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const hash = name.slice(0, 64);
      const record = this.get(hash);
      if (!record) continue;
      if (filter.issuer && record.issuer !== filter.issuer) continue;
      if (filter.subject && record.subject !== filter.subject) continue;
      out.push({ hash, record });
    }
    return out.sort((a, b) => a.record.issued_at.localeCompare(b.record.issued_at));
  }

  /**
   * A record is revoked only by a stored revocation from the SAME issuer.
   * Anyone else "revoking" it is just a different statement (use claim "disputed").
   */
  status(hash: string, now: Date = new Date()): RecordStatus {
    const record = this.get(hash);
    if (!record) return 'unknown';
    const revoked = this.list({ issuer: record.issuer }).some(
      ({ record: r }) => r.claim === 'revoked' && r.revokes === hash,
    );
    if (revoked) return 'revoked';
    return Date.parse(record.valid_until) <= now.getTime() ? 'expired' : 'valid';
  }

  private fileFor(hash: string): string {
    return path.join(this.recordsDir, `${hash}.json`);
  }
}
