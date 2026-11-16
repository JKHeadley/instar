/**
 * Instar Documents — row hashing, machine signatures and per-origin chains (spec §3.4).
 *
 * One chain per origin ACROSS all documents (§5.1), so a sync vector is machines × incarnations.
 * Every row is signed by the accepting machine over its canonical payload, and carries the hash of
 * that origin's previous row, so any machine can verify any origin's rows and detect a gap or fork.
 */
import crypto from 'node:crypto';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSigner } from '../core/AppRecordSignatures.js';
import { rowKeyOf, streamOf, type DocRow, type UnsignedDocRow } from './rows.js';

const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The domain-separated bytes a machine signs for a row (everything but `machineSig`). */
export function rowSigningPayload(row: UnsignedDocRow): string {
  return `instar-doc-row-v1\n${canonicalJson(row)}`;
}

/** A row's hash, the value the next row of its origin names as `prevHash`. */
export function rowHash(row: DocRow): string {
  const { machineSig: _sig, ...rest } = row;
  return sha256Hex(rowSigningPayload(rest as UnsignedDocRow));
}

export function signRow(row: UnsignedDocRow, signer: MachineSigner): DocRow {
  if (signer.machineId() !== row.origin) throw new Error('a machine signs only rows of its own origin');
  const s = signer.sign(rowSigningPayload(row));
  return { ...row, machineSig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } } as DocRow;
}

export type SigVerdict = 'ok' | 'bad' | 'unknown';

/** Verify a row's machine signature. `unknown` when the signer's key can't be looked up yet. */
export function verifyRowSignature(row: DocRow, lookup: MachineKeyLookup): SigVerdict {
  if (row.machineSig?.machineId !== row.origin) return 'bad';
  const { machineSig, ...rest } = row;
  const atMs = Date.parse(row.receivedAt);
  // receivedAt is writer-supplied: it only selects which of the signer's keys to try, and is clamped to
  // now, so a future date can't reach a key not yet valid. Forging with a retired key still needs that key.
  const at = Number.isFinite(atMs) ? Math.min(atMs, Date.now()) : Date.now();
  return verifyMachineSignature(lookup, machineSig, rowSigningPayload(rest as UnsignedDocRow), at);
}

export type ChainProblem =
  | { kind: 'gap'; stream: string; afterSeq: number; nextSeq: number }
  | { kind: 'fork'; stream: string; seq: number }
  | { kind: 'broken-link'; stream: string; seq: number };

/**
 * Check every origin stream for gaps (a missing seq), forks (two different rows at one seq) and
 * broken links (prevHash not equal to the previous row's hash). Pure; rows may arrive in any order.
 */
export function checkChains(rows: ReadonlyArray<DocRow>): ChainProblem[] {
  const byStream = new Map<string, Map<number, DocRow[]>>();
  for (const r of rows) {
    const s = streamOf(r);
    let m = byStream.get(s);
    if (!m) { m = new Map(); byStream.set(s, m); }
    const at = m.get(r.seq) ?? [];
    if (!at.some((x) => x.eventId === r.eventId && rowHash(x) === rowHash(r))) at.push(r);
    m.set(r.seq, at);
  }
  const problems: ChainProblem[] = [];
  for (const [stream, m] of byStream) {
    const seqs = [...m.keys()].sort((a, b) => a - b);
    let prev: DocRow | null = null;
    let prevSeq = 0;
    for (const seq of seqs) {
      const at = m.get(seq)!;
      if (at.length > 1) { problems.push({ kind: 'fork', stream, seq }); prev = null; prevSeq = seq; continue; }
      const row = at[0];
      if (seq !== prevSeq + 1) problems.push({ kind: 'gap', stream, afterSeq: prevSeq, nextSeq: seq });
      else if (prev && row.prevHash !== rowHash(prev)) problems.push({ kind: 'broken-link', stream, seq });
      else if (!prev && seq === 1 && row.prevHash !== null) problems.push({ kind: 'broken-link', stream, seq });
      prev = row;
      prevSeq = seq;
    }
  }
  return problems;
}

/** The highest contiguous seq held per stream, the vector a sync request sends as `have`. */
export function heldVector(rows: ReadonlyArray<DocRow>): Record<string, number> {
  const seqs = new Map<string, Set<number>>();
  for (const r of rows) {
    const s = streamOf(r);
    let set = seqs.get(s);
    if (!set) { set = new Set(); seqs.set(s, set); }
    set.add(r.seq);
  }
  const out: Record<string, number> = {};
  for (const [s, set] of seqs) {
    let n = 0;
    while (set.has(n + 1)) n++;
    out[s] = n;
  }
  return out;
}

export { rowKeyOf, streamOf };
