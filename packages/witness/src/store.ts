/**
 * WitnessStore — a local, append-only store of witness records and the key
 * bindings that say which key speaks for which agent.
 *
 * The issuer-to-key rule is part of the format, and the store enforces it:
 * a record counts only if its key_id belongs to a verified binding in the
 * issuer's chain (binding.agent === record.issuer) that was current at the
 * record's issued_at and not revoked as of then.
 *
 * Everything is stored one file per content hash, so the same item arriving
 * twice (from a peer and again from replication) is one file. Nothing is ever
 * deleted or rewritten. Every item is verified BEFORE it is written; an item
 * that cannot be verified yet (unknown issuer, predecessor binding not yet
 * received) is refused, and the caller may offer it again later.
 *
 * A stored record is untrusted data about a peer. It is never an answer to
 * "who is my operator" and never an authorization.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  bindingHash,
  bindingRevocationHash,
  verifyBinding,
  verifyBindingRevocation,
  verifySuccessor,
  type BindingRevocation,
  type KeyBinding,
} from './binding.js';
import { recordHash, verifyRecord, type WitnessRecord } from './record.js';

export type AddResult =
  | { status: 'added' | 'duplicate'; hash: string }
  | { status: 'rejected'; reason: string }
  | { status: 'conflict'; reason: string };

export type RecordStatus = 'valid' | 'expired' | 'revoked' | 'key-revoked' | 'conflicted' | 'unknown';

const HASH_FILE = /^[0-9a-f]{64}\.json$/;

export class WitnessStore {
  private readonly dirs: { records: string; bindings: string; revocations: string; conflicts: string };

  constructor(opts: { dir: string }) {
    this.dirs = {
      records: path.join(opts.dir, 'records'),
      bindings: path.join(opts.dir, 'bindings'),
      revocations: path.join(opts.dir, 'binding-revocations'),
      conflicts: path.join(opts.dir, 'conflicts'),
    };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
  }

  // ── Bindings ─────────────────────────────────────────────────────────

  /**
   * Add a key binding. A seq 0 binding starts a chain; a later one needs its
   * predecessor already stored. A second, different binding at a seq the agent
   * already has is a fork: it is refused and the agent is marked conflicted.
   * Pass `expectedFingerprint` for a seq 0 binding when you know the agent's
   * Threadline fingerprint from a verified pairing.
   */
  addBinding(binding: KeyBinding, opts: { expectedFingerprint?: string } = {}): AddResult {
    const check = verifyBinding(binding, binding.seq === 0 ? opts.expectedFingerprint : undefined);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    const hash = bindingHash(binding);
    const chain = this.chain(binding.agent);
    const existing = chain.find(b => b.seq === binding.seq);
    if (existing) {
      if (bindingHash(existing) === hash) return { status: 'duplicate', hash };
      this.markConflict(binding.agent, [bindingHash(existing), hash]);
      return { status: 'conflict', reason: `${binding.agent} already has a different binding at seq ${binding.seq}` };
    }
    if (binding.seq > 0) {
      const previous = chain.find(b => b.seq === binding.seq - 1);
      if (!previous) return { status: 'rejected', reason: `predecessor binding seq ${binding.seq - 1} not known yet` };
      const link = verifySuccessor(previous, binding);
      if (!link.ok) return { status: 'rejected', reason: link.reason };
    }
    return this.write(this.dirs.bindings, hash, binding);
  }

  addBindingRevocation(rev: BindingRevocation): AddResult {
    const target = this.chain(rev?.agent).find(b => bindingHash(b) === rev?.binding);
    if (!target) return { status: 'rejected', reason: 'revoked binding not known yet' };
    const check = verifyBindingRevocation(rev, target);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    return this.write(this.dirs.revocations, bindingRevocationHash(rev), rev);
  }

  /** The agent's bindings in seq order. Only verified, linked bindings are ever stored. */
  chain(agent: string): KeyBinding[] {
    return this.readAll<KeyBinding>(this.dirs.bindings, b => bindingHash(b))
      .filter(b => b.agent === agent)
      .sort((a, b) => a.seq - b.seq);
  }

  isConflicted(agent: string): boolean {
    return fs.existsSync(path.join(this.dirs.conflicts, `${agentKey(agent)}.json`));
  }

  /**
   * The key that speaks for `agent` under `keyId` at time `at`, or why there is none.
   * Binding k covers [k.issued_at, (k+1).issued_at), minus any revocation from its effective_from.
   */
  keyFor(agent: string, keyId: string, at: string): { key: string } | { error: string; revoked?: boolean } {
    if (this.isConflicted(agent)) return { error: `${agent} has conflicting key bindings` };
    const chain = this.chain(agent);
    const t = Date.parse(at);
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      if (b.key_id !== keyId) continue;
      const next = chain[i + 1];
      if (t < Date.parse(b.issued_at) || (next && t >= Date.parse(next.issued_at))) continue;
      const hash = bindingHash(b);
      const revoked = this.readAll<BindingRevocation>(this.dirs.revocations, bindingRevocationHash).some(
        r => r.binding === hash && Date.parse(r.effective_from) <= t,
      );
      if (revoked) return { error: `binding for key ${keyId} was revoked as of ${at}`, revoked: true };
      return { key: b.witness_public_key };
    }
    return { error: `no binding of ${agent} covers key ${keyId} at ${at}` };
  }

  // ── Records ──────────────────────────────────────────────────────────

  add(record: WitnessRecord, now: Date = new Date()): AddResult {
    const r = record as Partial<WitnessRecord>;
    if (typeof r?.issuer !== 'string' || typeof r.key_id !== 'string' || typeof r.issued_at !== 'string') {
      return { status: 'rejected', reason: 'missing issuer, key_id or issued_at' };
    }
    const resolved = this.keyFor(r.issuer, r.key_id, r.issued_at);
    if ('error' in resolved) return { status: 'rejected', reason: resolved.error };
    const check = verifyRecord(record, resolved.key, now);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    if (record.claim === 'revoked') {
      const target = this.get(record.revokes!);
      if (target?.claim === 'revoked') return { status: 'rejected', reason: 'a revocation cannot be revoked' };
    }
    return this.write(this.dirs.records, recordHash(record), record);
  }

  /** Returns the record only if its content still hashes to its name. */
  get(hash: string): WitnessRecord | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.dirs.records, `${hash}.json`), 'utf8')) as WitnessRecord;
      return recordHash(record) === hash ? record : undefined;
    } catch {
      return undefined;
    }
  }

  list(filter: { issuer?: string; subject?: string } = {}): Array<{ hash: string; record: WitnessRecord }> {
    return this.readAll<WitnessRecord>(this.dirs.records, recordHash)
      .filter(r => (!filter.issuer || r.issuer === filter.issuer) && (!filter.subject || r.subject === filter.subject))
      .map(record => ({ hash: recordHash(record), record }))
      .sort((a, b) => a.record.issued_at.localeCompare(b.record.issued_at));
  }

  /**
   * Status is re-judged on every call, so a binding revoked after a record was
   * stored still takes effect. A record is revoked only by a revocation from its
   * own issuer about its own subject; a revocation never lapses and is never
   * itself revoked, so revocations targeting a revocation are ignored.
   */
  status(hash: string, now: Date = new Date()): RecordStatus {
    const record = this.get(hash);
    if (!record) return 'unknown';
    if (this.isConflicted(record.issuer)) return 'conflicted';
    const key = this.keyFor(record.issuer, record.key_id, record.issued_at);
    if ('error' in key) return key.revoked ? 'key-revoked' : 'unknown';
    if (record.claim !== 'revoked') {
      const revoked = this.list({ issuer: record.issuer }).some(
        ({ record: r }) => r.claim === 'revoked' && r.revokes === hash && r.subject === record.subject &&
          !('error' in this.keyFor(r.issuer, r.key_id, r.issued_at)),
      );
      if (revoked) return 'revoked';
    }
    return record.valid_until !== undefined && Date.parse(record.valid_until) <= now.getTime() ? 'expired' : 'valid';
  }

  // ── Internals ────────────────────────────────────────────────────────

  private write(dir: string, hash: string, item: unknown): AddResult {
    const file = path.join(dir, `${hash}.json`);
    if (fs.existsSync(file)) return { status: 'duplicate', hash };
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(item, null, 2) + '\n', { flag: 'wx' });
    try {
      // link() fails if the target exists, so a concurrent writer of the same item cannot be overwritten.
      fs.linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return { status: 'duplicate', hash };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { status: 'added', hash };
  }

  /** Read every hash-named file in `dir`, dropping any whose content no longer matches its name. */
  private readAll<T>(dir: string, hashOf: (item: T) => string): T[] {
    const out: T[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!HASH_FILE.test(name)) continue;
      try {
        const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T;
        if (hashOf(item) === name.slice(0, 64)) out.push(item);
      } catch {
        // unreadable or tampered: not part of the store
      }
    }
    return out;
  }

  private markConflict(agent: string, hashes: string[]): void {
    const file = path.join(this.dirs.conflicts, `${agentKey(agent)}.json`);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, JSON.stringify({ agent, bindings: hashes, seen_at: new Date().toISOString() }, null, 2) + '\n');
  }
}

function agentKey(agent: string): string {
  return crypto.createHash('sha256').update(agent).digest('hex');
}
