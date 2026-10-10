/**
 * WitnessStore — a local, append-only store of witness records and the key
 * bindings that say which key speaks for which agent.
 *
 * The issuer-to-key rule is part of the format, and the store enforces it:
 * a record counts only if its key_id belongs to a binding in the issuer's
 * effective chain (binding.agent === record.issuer) that was current at the
 * record's issued_at and not revoked as of then. See binding.ts for how the
 * chain advances (two-key rotation at once; one-key recovery after a hold,
 * vetoable; one-key revocation never reaching back).
 *
 * Everything is stored one file per content hash, so the same item arriving
 * twice (from a peer and again from replication) is one file. Nothing is ever
 * deleted or rewritten. Every item is verified BEFORE it is written; an item
 * that cannot be verified yet (unknown issuer, predecessor not yet received)
 * is refused, and the caller may offer it again later.
 *
 * Next to the content-addressed files the store keeps a first-seen time for
 * every item. Holds, revocation clamps and fork cut-offs are judged from these
 * LOCAL receipt times, never from a time the item claims for itself. Two
 * stores can therefore disagree, and not only briefly: a store that was
 * offline through a whole hold and then receives a recovery together with its
 * veto counts the veto and stays conflicted, while a store that watched the
 * hold run out matured the recovery. That fails closed, in the cautious
 * direction.
 *
 * Bindings and binding revocations carry signature SETS that their identity
 * hash leaves out, so a relay could strip one signature and produce a second
 * valid copy of the same statement. The store files every copy under the hash
 * of the whole object (copyHash) and counts the union of valid signers across
 * copies, so a stripped copy delivered first can never shadow the full one.
 *
 * Conflicts (two contradicting bindings at one seq, or a vetoed recovery) stop
 * the agent's chain at that seq. Records made under earlier bindings that this
 * store received BEFORE it first saw the conflict keep counting; everything
 * else from that agent reads "conflicted" until a person re-pairs over
 * Threadline, compares the SAS words, and records the choice with
 * resolveConflict(). A resolution is this store's own decision, not a shared
 * statement: each verifier decides whom it trusts.
 *
 * A stored record is untrusted data about a peer. It is never an answer to
 * "who is my operator" and never an authorization.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RECOVERY_HOLD_MS,
  bindingHash,
  bindingRevocationHash,
  copyHash,
  successorVetoHash,
  verifyBinding,
  verifyBindingRevocation,
  verifySuccessor,
  verifySuccessorVeto,
  type BindingRevocation,
  type KeyBinding,
  type KeyRole,
  type SuccessorVeto,
} from './binding.js';
import { MAX_CLOCK_SKEW_MS, recordHash, verifyRecord, type WitnessRecord } from './record.js';

export type AddResult =
  | { status: 'added' | 'duplicate'; hash: string }
  | { status: 'rejected'; reason: string };

export type RecordStatus = 'valid' | 'expired' | 'revoked' | 'key-revoked' | 'conflicted' | 'unknown';

export interface ChainLink {
  binding: KeyBinding;
  hash: string;
  /** When this binding's window opens (ms). */
  start: number;
}

export interface Chain {
  links: ChainLink[];
  /** A one-key successor waiting out its hold. It does not count and does not close the window before it. */
  pending?: { hash: string; maturesAt: number };
  /** The chain stops here. */
  conflict?: { seq: number; seenAt: number; reason: string };
}

const HASH_FILE = /^[0-9a-f]{64}\.json$/;
type Kind = 'records' | 'bindings' | 'revocations' | 'vetoes';

export class WitnessStore {
  private readonly dirs: Record<Kind | 'received' | 'resolutions', string>;

  constructor(opts: { dir: string }) {
    this.dirs = {
      records: path.join(opts.dir, 'records'),
      bindings: path.join(opts.dir, 'bindings'),
      revocations: path.join(opts.dir, 'binding-revocations'),
      vetoes: path.join(opts.dir, 'successor-vetoes'),
      received: path.join(opts.dir, 'received'),
      resolutions: path.join(opts.dir, 'resolutions'),
    };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
  }

  // ── Bindings ─────────────────────────────────────────────────────────

  /**
   * Store a key binding. A successor needs its predecessor already stored and
   * must be signed by at least one of the predecessor's keys. Whether it COUNTS
   * (at once, after a hold, or not at all) is decided by chain(), not here.
   * Pass `expectedFingerprint` for a seq 0 binding when you know the agent's
   * Threadline fingerprint from a verified pairing.
   */
  addBinding(binding: KeyBinding, opts: { expectedFingerprint?: string } = {}, now: Date = new Date()): AddResult {
    const check = verifyBinding(binding, binding?.seq === 0 ? opts.expectedFingerprint : undefined);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    if (tooFarAhead(binding.issued_at, now)) return { status: 'rejected', reason: 'issued_at is in the future' };
    if (binding.seq > 0) {
      const previous = this.bindings().find(b => bindingHash(b) === binding.supersedes);
      if (!previous) return { status: 'rejected', reason: 'superseded binding not known yet' };
      const link = verifySuccessor(previous, binding);
      if (!link.ok) return { status: 'rejected', reason: link.reason };
    }
    return this.write('bindings', copyHash(binding), binding, now);
  }

  addBindingRevocation(rev: BindingRevocation, now: Date = new Date()): AddResult {
    const target = this.bindings().find(b => bindingHash(b) === rev?.binding);
    if (!target) return { status: 'rejected', reason: 'revoked binding not known yet' };
    const check = verifyBindingRevocation(rev, target);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    if (tooFarAhead(rev.issued_at, now)) return { status: 'rejected', reason: 'issued_at is in the future' };
    return this.write('revocations', copyHash(rev), rev, now);
  }

  addVeto(veto: SuccessorVeto, now: Date = new Date()): AddResult {
    const all = this.bindings();
    const copies = all.filter(b => bindingHash(b) === veto?.successor);
    if (!copies.length) return { status: 'rejected', reason: 'vetoed successor not known yet' };
    const previous = all.find(b => bindingHash(b) === copies[0].supersedes);
    if (!previous) return { status: 'rejected', reason: 'superseded binding not known' };
    // Judge the veto against every signer seen on ANY copy, so a stripped copy cannot make a signer look absent.
    const check = verifySuccessorVeto(veto, merge(copies, previous), previous);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    if (tooFarAhead(veto.issued_at, now)) return { status: 'rejected', reason: 'issued_at is in the future' };
    return this.write('vetoes', successorVetoHash(veto), veto, now);
  }

  /**
   * Record this store's decision about a conflict, after a person re-paired with
   * the agent over Threadline and compared the SAS words. `keep` must be one of
   * the contradicting bindings at that seq; the others are ignored from now on.
   */
  resolveConflict(agent: string, seq: number, keep: string, note: string, now: Date = new Date()): AddResult {
    const candidate = this.bindings().find(
      b => b.agent === agent && b.seq === seq && bindingHash(b) === keep,
    );
    if (!candidate) return { status: 'rejected', reason: `no stored binding ${keep} for ${agent} at seq ${seq}` };
    if (!note.trim()) return { status: 'rejected', reason: 'say how the conflict was resolved (e.g. SAS words compared)' };
    const file = path.join(this.dirs.resolutions, `${sha256(agent)}-${seq}.json`);
    if (fs.existsSync(file)) return { status: 'rejected', reason: 'already resolved' };
    fs.writeFileSync(file, JSON.stringify({ agent, seq, keep, note, resolved_at: now.toISOString() }, null, 2) + '\n', { flag: 'wx' });
    return { status: 'added', hash: keep };
  }

  /** The agent's effective chain at `now`. */
  chain(agent: string, now: Date = new Date()): Chain {
    const copies = this.bindings().filter(b => b.agent === agent);
    // Earliest first-seen across every copy of a statement.
    const seenByHash = new Map<string, number>();
    for (const c of copies) {
      const h = bindingHash(c);
      seenByHash.set(h, Math.min(seenByHash.get(h) ?? Infinity, this.firstSeen(copyHash(c))));
    }
    const vetoes = this.items<SuccessorVeto>('vetoes', successorVetoHash).filter(v => v.agent === agent);
    const links: ChainLink[] = [];
    for (let seq = 0; ; seq++) {
      const prev = links[links.length - 1];
      const atSeq = copies.filter(b => b.seq === seq && (seq === 0 || b.supersedes === prev.hash));
      let cands = [...new Set(atSeq.map(bindingHash))].map(h => {
        const group = atSeq.filter(b => bindingHash(b) === h);
        return seq === 0 ? group[0] : merge(group, prev.binding);
      });
      if (!cands.length) return { links };
      const kept = this.resolution(agent, seq);
      const resolved = kept !== undefined && cands.some(b => bindingHash(b) === kept);
      if (resolved) cands = cands.filter(b => bindingHash(b) === kept);

      const seen = (b: KeyBinding) => seenByHash.get(bindingHash(b)) ?? Infinity;
      const secondSeen = (bs: KeyBinding[]) => bs.map(seen).sort((a, b) => a - b)[1];

      if (seq === 0) {
        if (cands.length > 1) return { links, conflict: { seq, seenAt: secondSeen(cands), reason: 'two different first bindings' } };
        links.push(link(cands[0], Date.parse(cands[0].issued_at)));
        continue;
      }

      const signers = (b: KeyBinding) => {
        const r = verifySuccessor(prev.binding, b);
        return r.ok ? r.signers.length : 0;
      };
      const twoKey = cands.filter(b => signers(b) === 2);
      const oneKey = cands.filter(b => signers(b) === 1);
      const matured = (b: KeyBinding) => seen(b) + RECOVERY_HOLD_MS <= now.getTime();
      const vetoedAt = (b: KeyBinding) => {
        const h = bindingHash(b);
        const times = vetoes
          .filter(v => v.successor === h)
          .map(v => this.firstSeen(successorVetoHash(v)))
          .filter(t => t < seen(b) + RECOVERY_HOLD_MS); // a veto counts only during the hold
        return times.length ? Math.min(...times) : undefined;
      };
      const recoveryStart = (b: KeyBinding) => Math.max(Date.parse(b.issued_at), seen(b));

      if (resolved) {
        const b = cands[0];
        links.push(link(b, twoKey.length ? Date.parse(b.issued_at) : recoveryStart(b)));
        continue;
      }
      if (twoKey.length > 1) {
        return { links, conflict: { seq, seenAt: secondSeen(twoKey), reason: 'two different rotations' } };
      }
      if (twoKey.length === 1) {
        const owner = twoKey[0];
        // A one-key successor that had already matured (unvetoed) before the owner's rotation arrived took effect: that is a fork.
        const tookEffect = oneKey.find(b => vetoedAt(b) === undefined && seen(b) + RECOVERY_HOLD_MS <= seen(owner));
        if (tookEffect) {
          return { links, conflict: { seq, seenAt: seen(owner), reason: 'rotation arrived after a recovery had taken effect' } };
        }
        // Otherwise the two-key rotation wins, and acts as the veto of any pending recovery.
        links.push(link(owner, Date.parse(owner.issued_at)));
        continue;
      }
      // Only one-key successors.
      const vetoed = oneKey.map(vetoedAt).filter((t): t is number => t !== undefined);
      if (vetoed.length) return { links, conflict: { seq, seenAt: Math.min(...vetoed), reason: 'recovery was vetoed' } };
      if (oneKey.length > 1) return { links, conflict: { seq, seenAt: secondSeen(oneKey), reason: 'two different recoveries' } };
      const only = oneKey[0];
      if (!matured(only)) return { links, pending: { hash: bindingHash(only), maturesAt: seen(only) + RECOVERY_HOLD_MS } };
      links.push(link(only, recoveryStart(only)));
    }
  }

  /**
   * The key that speaks for `agent` under `keyId` for a record issued at `at`
   * and first received by this store at `receivedAt`, or why there is none.
   */
  keyFor(
    agent: string,
    keyId: string,
    at: string,
    receivedAt: number,
    now: Date = new Date(),
  ): { key: string } | { error: string; status: 'key-revoked' | 'conflicted' | 'unknown' } {
    const { links, conflict } = this.chain(agent, now);
    const t = Date.parse(at);
    const i = links.findIndex(
      (l, idx) => l.binding.key_id === keyId && t >= l.start && (idx + 1 >= links.length || t < links[idx + 1].start),
    );
    if (conflict && (i < 0 || receivedAt >= conflict.seenAt)) {
      return { error: `${agent} has conflicting key bindings at seq ${conflict.seq}: ${conflict.reason}`, status: 'conflicted' };
    }
    if (i < 0) return { error: `no binding of ${agent} covers key ${keyId} at ${at}`, status: 'unknown' };
    const l = links[i];
    // Group revocation copies by statement; a statement is two-key if ANY copies together carry both valid signatures.
    const revs = new Map<string, { rev: BindingRevocation; signers: Set<KeyRole>; seen: number }>();
    for (const rev of this.items<BindingRevocation>('revocations', copyHash)) {
      if (rev.binding !== l.hash) continue;
      const check = verifyBindingRevocation(rev, l.binding);
      if (!check.ok) continue;
      const h = bindingRevocationHash(rev);
      const entry = revs.get(h) ?? { rev, signers: new Set<KeyRole>(), seen: Infinity };
      check.signers.forEach(r => entry.signers.add(r));
      entry.seen = Math.min(entry.seen, this.firstSeen(copyHash(rev)));
      revs.set(h, entry);
    }
    for (const { rev, signers, seen } of revs.values()) {
      const requested = Date.parse(rev.effective_from);
      const effective = signers.size === 2 ? requested : Math.max(requested, seen - MAX_CLOCK_SKEW_MS);
      if (t >= effective) return { error: `binding for key ${keyId} was revoked as of ${at}`, status: 'key-revoked' };
    }
    return { key: l.binding.witness_public_key };
  }

  // ── Records ──────────────────────────────────────────────────────────

  add(record: WitnessRecord, now: Date = new Date()): AddResult {
    const r = record as Partial<WitnessRecord>;
    if (typeof r?.issuer !== 'string' || typeof r.key_id !== 'string' || typeof r.issued_at !== 'string') {
      return { status: 'rejected', reason: 'missing issuer, key_id or issued_at' };
    }
    let hash: string;
    try {
      hash = recordHash(record);
    } catch (err) {
      return { status: 'rejected', reason: (err as Error).message };
    }
    const receivedAt = this.firstSeenOrUndefined(hash) ?? now.getTime();
    const resolved = this.keyFor(r.issuer, r.key_id, r.issued_at, receivedAt, now);
    if ('error' in resolved) return { status: 'rejected', reason: resolved.error };
    const check = verifyRecord(record, resolved.key, now);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    if (record.claim === 'revoked') {
      const target = this.get(record.revokes!);
      if (target?.claim === 'revoked') return { status: 'rejected', reason: 'a revocation cannot be revoked' };
    }
    return this.write('records', hash, record, now);
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
    return this.items<WitnessRecord>('records', recordHash)
      .filter(r => (!filter.issuer || r.issuer === filter.issuer) && (!filter.subject || r.subject === filter.subject))
      .map(record => ({ hash: recordHash(record), record }))
      .sort((a, b) => a.record.issued_at.localeCompare(b.record.issued_at));
  }

  /**
   * Status is re-judged on every call, so a later revocation, veto or conflict
   * still takes effect. A record is revoked only by a revocation from its own
   * issuer about its own subject that itself still counts; a revocation never
   * lapses and is never itself revoked.
   */
  status(hash: string, now: Date = new Date()): RecordStatus {
    const record = this.get(hash);
    if (!record) return 'unknown';
    const key = this.keyFor(record.issuer, record.key_id, record.issued_at, this.firstSeen(hash), now);
    if ('error' in key) return key.status;
    if (record.claim !== 'revoked') {
      const revoked = this.list({ issuer: record.issuer }).some(
        ({ hash: h, record: r }) =>
          r.claim === 'revoked' && r.revokes === hash && r.subject === record.subject &&
          !('error' in this.keyFor(r.issuer, r.key_id, r.issued_at, this.firstSeen(h), now)),
      );
      if (revoked) return 'revoked';
    }
    return record.valid_until !== undefined && Date.parse(record.valid_until) <= now.getTime() ? 'expired' : 'valid';
  }

  // ── Internals ────────────────────────────────────────────────────────

  private write(kind: Kind, hash: string, item: unknown, now: Date): AddResult {
    const file = path.join(this.dirs[kind], `${hash}.json`);
    if (fs.existsSync(file)) return { status: 'duplicate', hash };
    this.markSeen(hash, now);
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

  /** First-seen is written once and never moved, so it cannot be refreshed by re-offering an item. */
  private markSeen(hash: string, now: Date): void {
    try {
      fs.writeFileSync(path.join(this.dirs.received, hash), now.toISOString() + '\n', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  private firstSeenOrUndefined(hash: string): number | undefined {
    try {
      const t = Date.parse(fs.readFileSync(path.join(this.dirs.received, hash), 'utf8').trim());
      return Number.isNaN(t) ? undefined : t;
    } catch {
      return undefined;
    }
  }

  /** Missing first-seen reads as "now-ish never": +Infinity, which fails every "seen before" test closed. */
  private firstSeen(hash: string): number {
    return this.firstSeenOrUndefined(hash) ?? Number.POSITIVE_INFINITY;
  }

  private resolution(agent: string, seq: number): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirs.resolutions, `${sha256(agent)}-${seq}.json`), 'utf8')).keep;
    } catch {
      return undefined;
    }
  }

  private bindings(): KeyBinding[] {
    return this.items<KeyBinding>('bindings', copyHash);
  }

  /** Read every hash-named file of a kind, dropping any whose content no longer matches its name. */
  private items<T>(kind: Kind, hashOf: (item: T) => string): T[] {
    const dir = this.dirs[kind];
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
}

/**
 * One view of a successor statement with every valid previous signature found on
 * any of its copies. Invalid signatures on a copy are dropped, never counted.
 */
function merge(copies: KeyBinding[], previous: KeyBinding): KeyBinding {
  const sigs: { witness?: string; threadline?: string } = {};
  for (const c of copies) {
    for (const role of ['witness', 'threadline'] as const) {
      const sig = c.previous_signatures?.[role];
      if (sig === undefined || sigs[role]) continue;
      const one = { ...c, previous_signatures: { [role]: sig } };
      if (verifySuccessor(previous, one).ok) sigs[role] = sig;
    }
  }
  return { ...copies[0], previous_signatures: sigs };
}

function link(binding: KeyBinding, start: number): ChainLink {
  return { binding, hash: bindingHash(binding), start };
}

function tooFarAhead(iso: string, now: Date): boolean {
  return Date.parse(iso) > now.getTime() + MAX_CLOCK_SKEW_MS;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
