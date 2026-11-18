/**
 * identity-security-piece2a: the owner record, a signed chain every machine evaluates the same way.
 * Spec: docs/specs/identity-security-piece2a-owner-record-chain.md (builds owner-authentication.md §6
 * under the approved umbrella identity-security-levels.md §12 item 2 and decision 17).
 *
 * A pure library: entries are parsed, verified and folded into the record's state from the FULL entry
 * set, in any order. It has no storage and no callers (piece 2b stores and replicates it).
 *
 * Authority (the parent specs, nothing wider):
 *   - owner keys sign every kind;
 *   - a machine key signs `tls-key` for its own machine, and `policy` and `merge` only while no owner key
 *     has ever existed (decision 17: "Machine-key policy entries stop the moment the first owner key
 *     signs"; at Basic the record is agent-producible, so a machine merge adds no authority);
 *   - the FIRST owner key is self-signed and admitted only through the caller's proof check (the route's
 *     proof, umbrella 4.5a; piece 3). No check supplied → refused.
 */
import crypto from 'node:crypto';
import { canonicalJson } from './GraphWitnessTypes.js';

export type OwnerRecordKind = 'genesis' | 'add-machine-key' | 'add-owner-key' | 'revoke-key' | 'policy' | 'tls-key' | 'merge';
export type SignerType = 'machine' | 'owner-key';

export interface OwnerRecordEntry {
  v: 1;
  kind: OwnerRecordKind;
  agentId: string;
  parents: string[];
  body: Record<string, unknown>;
  signer: { type: SignerType; keyId: string };
  sig: string;
}

export const OWNER_RECORD_ENTRY_MAX_BYTES = 8 * 1024;
/** Raw input bound: evaluation is quadratic in entries at worst, so it stays small; 2b never stores more,
 *  and a later piece compacts superseded TLS rotations. A real record holds tens to hundreds of entries. */
export const OWNER_RECORD_MAX_INPUT = 2_000;

const KINDS: ReadonlySet<string> = new Set(['genesis', 'add-machine-key', 'add-owner-key', 'revoke-key', 'policy', 'tls-key', 'merge']);
const MACHINE_ID = /^m_[0-9A-Za-z_-]{1,64}$/;
const OWNER_KEY_ID = /^o_[0-9A-Za-z_-]{1,64}$/;

export interface RejectedEntry { id: string | null; reason: string }
export interface KeyInfo { keyId: string; type: SignerType; publicKey: string; addedBy: string }

export interface OwnerRecordState {
  /** `owner-lost`: the record was enrolled but no owner key is valid now (machine keys may remain): human
   *  access is gone and only the owner's reset restores it. `contested`: an entry was excluded only by
   *  revocations whose signers are themselves revoked at the end (revoked keys revoking each other), so
   *  the outcome is ambiguous; the owner's reset decides, never a silent downgrade. Callers must not act on
   *  level, keys or policies while contested. */
  status: 'ok' | 'record-invalid' | 'no-valid-key' | 'owner-lost' | 'contested' | 'input-too-large';
  /** The entries whose exclusion made the record `contested`. */
  contested: string[];
  genesis: string | null;
  /** The sorted tip ids (one id when not forked). */
  head: string[];
  forked: boolean;
  keys: KeyInfo[];
  revoked: string[];
  level: string;
  policies: Record<string, unknown>;
  tlsKeys: Record<string, string>;
  /** True once any authentic owner key was added anywhere in the record; never goes back. */
  everEnrolled: boolean;
  /** True while no owner key is valid: the record is producible by the agent itself. */
  agentProducible: boolean;
  /** Entries on unmerged branches whose additions are held (revocations on them still apply). */
  held: string[];
  rejected: RejectedEntry[];
  /** Entries that took effect (pass B), with one revocation per (signer, target) pair plus one revocation
   *  for each entry a revocation excludes. */
  effective: string[];
  /** What storage (piece 2b) keeps, with their ancestors: `effective` plus the `contested` entries, so a
   *  stored copy evaluates to the same state as the full input. */
  keep: string[];
}

export interface EvaluateOptions {
  agentId: string;
  /** The genesis this machine pinned when it first adopted the record (2b). Unset: the lowest machine id's. */
  pinnedGenesis?: string;
  /** The route's proof for the FIRST owner key (umbrella 4.5a; piece 3). Absent → the first owner key is refused. */
  verifyFirstOwnerProof?: (body: Record<string, unknown>) => boolean;
}

export function ownerRecordSignedText(e: Omit<OwnerRecordEntry, 'sig'> | OwnerRecordEntry): string {
  const { sig: _sig, ...rest } = e as OwnerRecordEntry;
  void _sig;
  return canonicalJson(rest);
}
export function ownerRecordEntryId(e: Omit<OwnerRecordEntry, 'sig'> | OwnerRecordEntry): string {
  return crypto.createHash('sha256').update(ownerRecordSignedText(e)).digest('hex');
}

function verifySig(text: string, sig: string, publicKeyPem: string): boolean {
  try { return crypto.verify(null, Buffer.from(text), publicKeyPem, Buffer.from(sig, 'base64')); } catch { return false; /* @silent-fallback-ok: a key or signature that can't be parsed does not verify; the entry is rejected and listed */ }
}
function str(v: unknown, max = 4096): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }

function malformed(raw: unknown, agentId: string): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not-an-object';
  const e = raw as Record<string, unknown>;
  // Never String() a sender-controlled value: an object with a bad toString would throw.
  const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (e.v !== 1) return 'bad-version';
  if (!KINDS.has(txt(e.kind))) return 'bad-kind';
  if (e.agentId !== agentId) return 'wrong-agent';
  if (!Array.isArray(e.parents) || !e.parents.every((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))) return 'bad-parents';
  const sorted = [...(e.parents as string[])].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((p, i) => p !== (e.parents as string[])[i])) return 'parents-not-sorted-unique';
  if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body)) return 'bad-body';
  const s = e.signer as Record<string, unknown> | undefined;
  if (!s || (s.type !== 'machine' && s.type !== 'owner-key') || !str(s.keyId, 80)) return 'bad-signer';
  if (s.type === 'machine' ? !MACHINE_ID.test(txt(s.keyId)) : !OWNER_KEY_ID.test(txt(s.keyId))) return 'bad-signer-key-id';
  if (!str(e.sig)) return 'bad-sig-field';
  const kind = e.kind as OwnerRecordKind;
  const n = (e.parents as string[]).length;
  // Only a merge joins branches; every other entry extends exactly one tip.
  if (kind === 'genesis' ? n !== 0 : kind === 'merge' ? n < 2 : n !== 1) return 'bad-parent-count';
  const b = e.body as Record<string, unknown>;
  switch (kind) {
    case 'genesis': if (!MACHINE_ID.test(txt(b.machineId)) || !str(b.publicKey)) return 'bad-genesis-body'; break;
    case 'add-machine-key': if (!MACHINE_ID.test(txt(b.machineId)) || !str(b.publicKey)) return 'bad-body-fields'; break;
    case 'add-owner-key': if (!OWNER_KEY_ID.test(txt(b.keyId)) || !str(b.publicKey)) return 'bad-body-fields'; break;
    case 'revoke-key': if (!MACHINE_ID.test(txt(b.keyId)) && !OWNER_KEY_ID.test(txt(b.keyId))) return 'bad-body-fields'; break;
    case 'policy': if (!str(b.path, 200) || !('value' in b)) return 'bad-body-fields'; break;
    case 'tls-key': if (!MACHINE_ID.test(txt(b.machineId)) || !str(b.fingerprint, 200) || !Number.isSafeInteger(b.seq) || (b.seq as number) < 0) return 'bad-body-fields'; break;
    case 'merge': break;
  }
  try { canonicalJson(raw); } catch { return 'not-canonical'; /* @silent-fallback-ok: non-finite numbers or undefined values; the entry is rejected and listed */ }
  return null;
}

interface KeyInst extends KeyInfo {}
/** The effective state along one ancestry. Revocation targets a key INSTANCE (the entry that added it). */
interface Fold {
  keys: Map<string, KeyInst>;
  revokedInst: Set<string>;
  everOwner: boolean;
  policies: Map<string, { value: unknown; by: string }>;
}
const cloneFold = (f: Fold): Fold => ({ keys: new Map(f.keys), revokedInst: new Set(f.revokedInst), everOwner: f.everOwner, policies: new Map(f.policies) });
const validKey = (f: Fold, keyId: string): KeyInst | null => { const k = f.keys.get(keyId); return k && !f.revokedInst.has(k.addedBy) ? k : null; };

function authorized(e: OwnerRecordEntry, f: Fold, opts: EvaluateOptions): string | null {
  // The first owner key: self-signed, admitted only through the caller's proof check.
  if (e.kind === 'add-owner-key' && !f.everOwner) {
    if (e.signer.type !== 'owner-key' || e.signer.keyId !== e.body.keyId) return 'first-owner-key-must-be-self-signed';
    return opts.verifyFirstOwnerProof?.(e.body) ? null : 'first-owner-key-proof-missing';
  }
  const key = validKey(f, e.signer.keyId);
  if (!key || key.type !== e.signer.type) return 'signer-not-valid-in-ancestry';
  if (e.signer.type === 'owner-key') return null;
  if (e.kind === 'tls-key') return e.body.machineId === e.signer.keyId ? null : 'machine-key-tls-for-other-machine';
  if (e.kind === 'policy' || e.kind === 'merge') return f.everOwner ? 'machine-key-after-owner' : null;
  return 'machine-key-not-allowed-for-kind';
}

function signerPublicKey(e: OwnerRecordEntry, f: Fold): { pub: string; inst: string } | null {
  if (e.kind === 'add-owner-key' && !f.everOwner && e.signer.keyId === e.body.keyId) return { pub: String(e.body.publicKey), inst: 'self' };
  const k = validKey(f, e.signer.keyId);
  return k ? { pub: k.publicKey, inst: k.addedBy } : null;
}

function apply(e: OwnerRecordEntry, id: string, f: Fold): string | null {
  const b = e.body;
  switch (e.kind) {
    case 'add-machine-key':
      if (validKey(f, String(b.machineId))) return 'machine-already-has-a-key'; // one key per machine
      f.keys.set(String(b.machineId), { keyId: String(b.machineId), type: 'machine', publicKey: String(b.publicKey), addedBy: id });
      return null;
    case 'add-owner-key':
      if (f.keys.has(String(b.keyId))) return 'owner-key-id-reused';
      f.keys.set(String(b.keyId), { keyId: String(b.keyId), type: 'owner-key', publicKey: String(b.publicKey), addedBy: id }); f.everOwner = true; return null;
    case 'revoke-key': {
      const k = f.keys.get(String(b.keyId));
      if (!k) return 'no-such-key'; // revoking a key that doesn't exist does nothing and is never stored
      if (f.revokedInst.has(k.addedBy)) return 'already-revoked';
      f.revokedInst.add(k.addedBy); return null;
    }
    case 'policy': f.policies.set(String(b.path), { value: b.value, by: id }); return null; // along a chain, later wins
    default: return null;
  }
}

type Variants = Map<string, OwnerRecordEntry[]>;
const first = (byId: Variants, id: string): OwnerRecordEntry => byId.get(id)![0];

/** Ancestor test with a memo per descendant (iterative). */
function makeAncestry(byId: Variants) {
  const memo = new Map<string, Set<string>>();
  return (id: string): Set<string> => {
    const hit = memo.get(id); if (hit) return hit;
    const seen = new Set<string>(); const stack = [id];
    while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); const v = byId.get(x); if (v) for (const p of v[0].parents) stack.push(p); }
    memo.set(id, seen); return seen;
  };
}

/** Parents before children, deterministic (sorted ids). Entries in cycles or with missing parents are left out. */
function topoOrder(byId: Variants, rejected: RejectedEntry[]): string[] {
  const indeg = new Map<string, number>(); const children = new Map<string, string[]>();
  const missing = new Set<string>();
  for (const [id, v] of byId) {
    const ps = v[0].parents;
    if (ps.some((p) => !byId.has(p))) { missing.add(id); continue; }
    indeg.set(id, ps.length);
    for (const p of ps) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const ready = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const c of (children.get(id) ?? []).sort()) {
      if (!indeg.has(c)) continue;
      const d = indeg.get(c)! - 1; indeg.set(c, d);
      if (d === 0) { let i = 0; while (i < ready.length && ready[i] < c) i++; ready.splice(i, 0, c); }
    }
  }
  const placed = new Set(order);
  // Entries downstream of a missing parent, or in a cycle, never get placed.
  for (const id of byId.keys()) if (!placed.has(id)) rejected.push({ id, reason: missing.has(id) ? 'unknown-parent' : 'unlinked' });
  return order;
}

export function evaluateOwnerRecord(rawEntries: unknown[], opts: EvaluateOptions): OwnerRecordState {
  const rejected: RejectedEntry[] = [];
  if (rawEntries.length > OWNER_RECORD_MAX_INPUT) return emptyState('input-too-large', null, rejected);
  const byId: Variants = new Map();
  for (const raw of rawEntries) {
    const why = malformed(raw, opts.agentId);
    if (why) { rejected.push({ id: null, reason: why }); continue; }
    const e = raw as OwnerRecordEntry;
    if (Buffer.byteLength(ownerRecordSignedText(e)) > OWNER_RECORD_ENTRY_MAX_BYTES) { rejected.push({ id: null, reason: 'entry-too-large' }); continue; }
    const id = ownerRecordEntryId(e);
    // Every distinct signature over the same content is kept: the entry counts if ANY verifies,
    // so a junk copy can never shadow the real one.
    const v = byId.get(id) ?? [];
    if (!v.some((x) => x.sig === e.sig)) { v.push(e); v.sort((a, b) => (a.sig < b.sig ? -1 : 1)); }
    byId.set(id, v);
  }
  const verifiesAny = (id: string, pub: string): boolean => byId.get(id)!.some((x) => verifySig(ownerRecordSignedText(x), x.sig, pub));

  // Genesis: the pinned one, else the lowest machine id's (decision 17's tie rule). Others are foreign.
  const geneses = [...byId.keys()].filter((id) => { const e = first(byId, id); return e.kind === 'genesis' && e.signer.type === 'machine' && e.signer.keyId === e.body.machineId && verifiesAny(id, String(e.body.publicKey)); })
    .sort((a, b) => { const ma = String(first(byId, a).body.machineId), mb = String(first(byId, b).body.machineId); return ma < mb ? -1 : ma > mb ? 1 : a < b ? -1 : 1; });
  const genesisId = opts.pinnedGenesis ? geneses.find((id) => id === opts.pinnedGenesis) : geneses[0];
  for (const [id, v] of [...byId]) if (v[0].kind === 'genesis' && id !== genesisId) { rejected.push({ id, reason: 'not-this-record-genesis' }); byId.delete(id); }
  if (!genesisId) return emptyState('record-invalid', null, rejected);

  // Structure: well-formed entries whose ancestry reaches the genesis. An entry that does not COUNT stays
  // in the chain (ineffective), so nothing that builds on it is cut away.
  const order = topoOrder(byId, rejected);
  const ancestry = makeAncestry(byId);
  const genesis = first(byId, genesisId);

  /**
   * One pass: the effective fold at every entry, under an extra rule. HARD failures (unauthorized in
   * the entry's own ancestry, or a bad signature) remove the entry, and so its descendants, from the
   * structure: those rules are local to the ancestry, and junk anyone can make must not shape the record.
   * SOFT failures (the global rules, an apply conflict) keep the entry for connectivity but it can never
   * be a tip, so it can't fork the record.
   */
  const pass = (ids: string[], rule: (id: string, e: OwnerRecordEntry, signerInst: string) => string | null) => {
    const folds = new Map<string, Fold>();
    const effective = new Set<string>();
    const reasons = new Map<string, string>();
    const hard = new Set<string>();
    for (const id of ids) {
      const e = first(byId, id);
      if (id === genesisId) {
        folds.set(id, { keys: new Map([[String(genesis.body.machineId), { keyId: String(genesis.body.machineId), type: 'machine' as const, publicKey: String(genesis.body.publicKey), addedBy: id }]]), revokedInst: new Set(), everOwner: false, policies: new Map() });
        effective.add(id); continue;
      }
      if (e.parents.some((p) => hard.has(p) || !folds.has(p))) { hard.add(id); reasons.set(id, 'parent-rejected'); continue; }
      // TLS keys are side entries: nothing builds on one, so storage can keep only each machine's latest.
      if (e.parents.some((p) => first(byId, p).kind === 'tls-key')) { hard.add(id); reasons.set(id, 'parent-is-tls-key'); continue; }
      const parentFolds = e.parents.map((p) => folds.get(p)!);
      const base = e.kind === 'merge' ? mergeBase(parentFolds) : parentFolds[0];
      let after = e.kind === 'merge' ? joinFolds(parentFolds, ancestry) : cloneFold(parentFolds[0]);
      const why = authorized(e, base, opts);
      const signer = why ? null : signerPublicKey(e, base);
      const hardWhy = why ?? (!signer || !verifiesAny(id, signer.pub) ? 'bad-signature' : null);
      if (hardWhy) { hard.add(id); reasons.set(id, hardWhy); continue; }
      const reason = rule(id, e, signer!.inst) ?? apply(e, id, after);
      // An ineffective merge joins nothing: its children start from its first parent's state.
      if (reason && e.kind === 'merge') after = cloneFold(parentFolds[0]);
      if (reason) reasons.set(id, reason); else effective.add(id);
      folds.set(id, after);
    }
    return { folds, effective, reasons, hard };
  };

  // Pass A: base rules. It fixes the owner path and the revocations.
  const A = pass(order, () => null);
  const structure = order.filter((id) => !A.hard.has(id));
  const ownerAdds = structure.filter((id) => A.effective.has(id) && first(byId, id).kind === 'add-owner-key');
  const onOwnerPath = new Set<string>();
  for (const id of ownerAdds) for (const x of ancestry(id)) onOwnerPath.add(x);
  const revokedA = new Set<string>(); // key instances
  const revocationsOf = new Map<string, Array<{ id: string; by: string }>>();
  const storedRevocation = new Map<string, string>(); // one revocation kept per (signer instance, target instance)
  for (const id of structure) {
    const e = first(byId, id);
    if (e.kind !== 'revoke-key' || !A.effective.has(id)) continue;
    const parentFold = A.folds.get(e.parents[0])!;
    const k = parentFold.keys.get(String(e.body.keyId));
    if (k && !A.hard.has(id)) {
      const signerInst = parentFold.keys.get(e.signer.keyId)?.addedBy ?? 'self';
      revokedA.add(k.addedBy); revocationsOf.set(k.addedBy, [...(revocationsOf.get(k.addedBy) ?? []), { id, by: signerInst }]);
      const pair = `${signerInst}>${k.addedBy}`;
      const cur = storedRevocation.get(pair);
      if (!cur || id < cur) storedRevocation.set(pair, id);
    }
  }
  // EVERY revocation, not any: a revoked key can't supply its own "earlier" revocation to legitimise
  // what it backdates, because the owner's revocation on the main chain rules that out.
  // Strict: an entry by a revoked instance counts only if it precedes EVERY revocation of it, so nothing
  // backdated by a stolen key can take effect (no takeover). An evaluator can't tell a thief's revocation
  // from an honest one in general (owner-authentication §6 accepts a forced reset as the limit), so when
  // an entry is excluded ONLY by revocations from the key itself or keys it added, the record is
  // `contested`: never a silent downgrade, always the owner's reset.
  const precedesRevocation = (inst: string, id: string): boolean => (revocationsOf.get(inst) ?? []).every((r) => ancestry(r.id).has(id));
  const contested = new Set<string>();
  const excludedBy = new Map<string, Array<{ id: string; by: string }>>(); // excluded entry → the revocations that excluded it

  // Pass B: the two global rules, judged against pass A (one fixed definition, no iteration):
  //  - once any owner key exists, a machine-signed entry other than its own TLS key counts only on the
  //    path to an owner key;
  //  - a revoked key instance's non-revocation entries count only when they precede its revocation.
  const B = pass(structure, (id, e, inst) => {
    if (ownerAdds.length > 0 && e.signer.type === 'machine' && e.kind !== 'tls-key' && !onOwnerPath.has(id)) return 'machine-key-off-the-owner-path';
    if (inst !== 'self' && revokedA.has(inst) && e.kind !== 'revoke-key' && !precedesRevocation(inst, id)) {
      excludedBy.set(id, (revocationsOf.get(inst) ?? []).filter((r) => !ancestry(r.id).has(id)));
      return 'signer-revoked';
    }
    return null;
  });
  for (const [id, why] of A.reasons) if (A.hard.has(id)) rejected.push({ id, reason: why });
  for (const [id, why] of B.reasons) rejected.push({ id, reason: why });

  // Tips: effective entries no other such entry descends from. TLS keys and revocations are side
  // entries (a revocation's effect applies record-wide from pass A), and ineffective entries are carried
  // only for connectivity: none of them ever makes a fork, so a revoked key can't fork the record.
  const tlsIds = new Set(structure.filter((id) => first(byId, id).kind === 'tls-key'));
  const sideIds = new Set(structure.filter((id) => { const k = first(byId, id).kind; return k === 'tls-key' || k === 'revoke-key'; }));
  const candidate = (id: string): boolean => !sideIds.has(id) && B.effective.has(id);
  const covered = new Set<string>();
  for (const id of structure) if (candidate(id)) for (const x of ancestry(id)) if (x !== id) covered.add(x);
  const tips = structure.filter((id) => candidate(id) && !covered.has(id)).sort();

  let final: Fold;
  let held: string[] = [];
  if (tips.length === 1) final = cloneFold(B.folds.get(tips[0])!);
  else {
    const common = new Set([...ancestry(tips[0])].filter((x) => tips.every((t) => ancestry(t).has(x))));
    const commonTips = [...common].filter((id) => candidate(id) && ![...common].some((y) => y !== id && candidate(y) && ancestry(y).has(id))).sort();
    final = joinFolds(commonTips.map((id) => B.folds.get(id)!), ancestry);
    for (const t of tips) for (const r of B.folds.get(t)!.revokedInst) final.revokedInst.add(r); // revocations from every branch count
    held = structure.filter((id) => !common.has(id) && candidate(id)).sort();
  }
  for (const r of revokedA) final.revokedInst.add(r); // a revocation judged in pass A is never undone
  // An exclusion is settled only if a revocation causing it was signed by a key still valid at the end;
  // otherwise it rests on revoked keys revoking each other, and the record is `contested` (never silent).
  const validInsts = new Set([...final.keys.values()].filter((k) => !final.revokedInst.has(k.addedBy)).map((k) => k.addedBy));
  // Storage must reproduce every exclusion and its settled/contested verdict, so for each excluded entry
  // keep one revocation that excludes it: one by a still-valid key if any, else the lowest id.
  const exclusionRevocations = new Set<string>();
  for (const [id, revs] of excludedBy) {
    const settled = revs.filter((r) => validInsts.has(r.by)).map((r) => r.id).sort();
    if (settled.length === 0) contested.add(id);
    const pick = settled[0] ?? revs.map((r) => r.id).sort()[0];
    if (pick) exclusionRevocations.add(pick);
  }
  // TLS keys from every branch: per machine, the effective entry with the highest seq (ties: greater id),
  // signed by that machine's key instance still valid in the final state.
  const tls = new Map<string, { fingerprint: string; seq: number; by: string }>();
  for (const id of tlsIds) {
    if (!B.effective.has(id)) continue;
    const e = first(byId, id);
    const m = String(e.body.machineId);
    const k = final.keys.get(m);
    if (e.signer.type === 'machine' && (!k || final.revokedInst.has(k.addedBy) || B.folds.get(e.parents[0])!.keys.get(m)?.addedBy !== k.addedBy)) continue;
    const cur = tls.get(m); const seq = Number(e.body.seq);
    if (!cur || seq > cur.seq || (seq === cur.seq && id > cur.by)) tls.set(m, { fingerprint: String(e.body.fingerprint), seq, by: id });
  }
  const keys = [...final.keys.values()].filter((k) => !final.revokedInst.has(k.addedBy)).sort((a, b) => (a.keyId < b.keyId ? -1 : 1));
  const revokedIds = [...final.keys.values()].filter((k) => final.revokedInst.has(k.addedBy)).map((k) => k.keyId).sort();
  const policies = Object.fromEntries([...final.policies].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => [p, v.value]));
  // Only each machine's winning TLS entry is kept: a flood of TLS entries can't grow the stored record.
  const tlsWinners = new Set([...tls.values()].map((v) => v.by));
  const effective = [...new Set([...[...B.effective].filter((id) => { const k = first(byId, id).kind; return k !== 'revoke-key' && (k !== 'tls-key' || tlsWinners.has(id)); }), ...storedRevocation.values(), ...exclusionRevocations])].sort();
  return {
    status: keys.length === 0 ? 'no-valid-key' : ownerAdds.length > 0 && !keys.some((k) => k.type === 'owner-key') ? 'owner-lost' : contested.size > 0 ? 'contested' : 'ok', genesis: genesisId,
    contested: [...contested].sort(),
    head: tips, forked: tips.length > 1, keys, revoked: revokedIds,
    level: typeof policies.level === 'string' ? policies.level : 'basic', policies,
    tlsKeys: Object.fromEntries([...tls].sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, v]) => [m, v.fingerprint])),
    everEnrolled: ownerAdds.length > 0,
    agentProducible: !keys.some((k) => k.type === 'owner-key'), held, rejected: sortRejected(rejected),
    effective,
    keep: [...new Set([...effective, ...contested])].sort(),
  };
}

/** A merge's signer is judged on the keys common to every branch, with every branch's revocations applied. */
function mergeBase(folds: Fold[]): Fold {
  const out = cloneFold(folds[0]);
  for (const [k, v] of [...out.keys]) if (!folds.every((f) => f.keys.get(k)?.addedBy === v.addedBy)) out.keys.delete(k);
  for (const f of folds) for (const r of f.revokedInst) out.revokedInst.add(r);
  out.everOwner = folds.some((f) => f.everOwner);
  return out;
}

/**
 * Join branch folds: revocations unioned; for a key id, a policy path, set differently on several
 * branches, the value that descends from the other wins; truly concurrent values tie on the greater id.
 */
function joinFolds(folds: Fold[], ancestry: (id: string) => Set<string>): Fold {
  const out = cloneFold(folds[0]);
  const pick = (a: string, b: string): string => (a === b ? a : ancestry(b).has(a) ? b : ancestry(a).has(b) ? a : a > b ? a : b);
  for (const f of folds.slice(1)) {
    for (const [k, v] of f.keys) { const cur = out.keys.get(k); out.keys.set(k, !cur ? v : pick(cur.addedBy, v.addedBy) === v.addedBy ? v : cur); }
    for (const r of f.revokedInst) out.revokedInst.add(r);
    out.everOwner = out.everOwner || f.everOwner;
    for (const [p, v] of f.policies) { const cur = out.policies.get(p); out.policies.set(p, !cur ? v : pick(cur.by, v.by) === v.by ? v : cur); }
  }
  return out;
}

function emptyState(status: OwnerRecordState['status'], genesis: string | null, rejected: RejectedEntry[]): OwnerRecordState {
  return { status, genesis, head: [], forked: false, keys: [], revoked: [], level: 'basic', policies: {}, tlsKeys: {}, everEnrolled: false, agentProducible: true, held: [], rejected: sortRejected(rejected), effective: [], keep: [], contested: [] };
}

/** Build and sign an entry. `sign` returns a base64 Ed25519 signature over the given text (machine or owner key). */
export function signOwnerRecordEntry(draft: Omit<OwnerRecordEntry, 'sig' | 'v' | 'parents'> & { parents: string[] }, sign: (text: string) => string): { entry: OwnerRecordEntry; id: string } {
  const unsigned = { v: 1 as const, ...draft, parents: [...draft.parents].sort() };
  const text = ownerRecordSignedText(unsigned as OwnerRecordEntry);
  const entry = { ...unsigned, sig: sign(text) } as OwnerRecordEntry;
  return { entry, id: ownerRecordEntryId(entry) };
}

/** Input order and duplicates must not change the output: sort by (id, reason) and drop repeats. */
function sortRejected(rows: RejectedEntry[]): RejectedEntry[] {
  const key = (r: RejectedEntry): string => `${r.id ?? ''}\u0000${r.reason}`;
  const seen = new Map<string, RejectedEntry>();
  for (const r of rows) seen.set(key(r), r);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}
