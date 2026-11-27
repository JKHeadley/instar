/**
 * Chief of Staff tree -> conversation graph import (work-front-doors §3.1, §7 stage 2). Unit tier: the validator,
 * the pure planner, the receive-side verifier inside the real verifyGraphAuthorization, the gate and the tree fold.
 */
import { describe, it, expect } from 'vitest';
import {
  validateGraphEvent, reduceGraph, nodeKey, type ConversationRef, type EffortRef, type GraphEvent, type ReducedGraph,
} from '../../src/core/conversationGraph.js';
import {
  planCosTreeImports, cosTreeImportCore, cosTreeImportEventId, cosTreeImportIdempotencyKey, verifyCosTreeImportCoreSource,
  validateCosTreeImportSource, cosTreeImportGate, cosTreeRecordStillLive, cosKeyMatchesRef, COS_TREE_IMPORT_PRINCIPAL,
  type CosTreeRecordInput, type CosTreeImportSource,
} from '../../src/core/ConversationGraphCosTreeImport.js';
import { foldTreeRecords, buildTreePut, buildTreeTombstone, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { verifyGraphAuthorization, signGraphAuthorizationReceipt, type GraphAuthorizationProof } from '../../src/core/ConversationGraphReplicationProof.js';
import { createGraphControlCapsule } from '../../src/core/GraphWitnessControl.js';
import { deriveGraphErasureIdentity } from '../../src/core/ConversationGraphOperation.js';
import { sealGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { encodeGraphSourceEnvelope } from '../../src/core/ConversationGraphSourceEnvelope.js';
import { canonicalHash, graphOperationKey } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from './conversation-graph-replication.fixtures.js';

const CHAT = '-1001';
const effort = (n: number): EffortRef => ({ kind: 'effort', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: CHAT, topicId });
let seq = 0;
function ev(partial: Record<string, unknown>): GraphEvent {
  seq += 1;
  const authority = (partial.authority as string) ?? 'owner';
  const kinds: Record<string, string> = { owner: 'owner-proof', delegation: 'dispatch-record', import: 'import-record', inference: 'inference-candidate' };
  return { schemaVersion: 1, eventId: `evt-${String(seq).padStart(6, '0')}`, authority, principal: 'owner',
    receipt: { kind: kinds[authority], id: `r-${seq}` }, machineId: 'm1', createdAt: `2026-11-05T10:${String(seq % 60).padStart(2, '0')}:00.000Z`, ...partial } as unknown as GraphEvent;
}
const place = (subject: ConversationRef | EffortRef, parent: ConversationRef | EffortRef | null, replaces: string[] = [], authority = 'owner') =>
  ev({ op: 'set-primary-placement', subject, parent, authority,
    relation: parent ? (parent.kind === 'effort' ? (subject.kind === 'effort' ? 'contains' : 'coordinates') : 'delegates-to') : null, replacesPlacementEventIds: replaces });
const create = (e: EffortRef) => ev({ op: 'create-effort', subject: e, projectScope: [], headerId: `hdr-${e.id.replace(/-/g, '')}` });
const frontDoor = (e: EffortRef, c: ConversationRef, observed: string[]) => ev({ op: 'set-front-door', subject: e, frontDoor: c, replacesFrontDoorEventIds: [], observedPlacementEventIds: observed });

/** An owner-accepted project: effort 1 with telegram:42 as its certified front door. */
function acceptedProject(extra: GraphEvent[] = []): { events: GraphEvent[]; graph: ReducedGraph; fdEventId: string } {
  const c = create(effort(1)); const p = place(tg(42), effort(1)); const fd = frontDoor(effort(1), tg(42), [p.eventId]);
  const events = [c, p, fd, ...extra];
  return { events, graph: reduceGraph(events, { verify: () => true }), fdEventId: fd.eventId };
}
const rec = (key: string, parent: string | null, physical = 1_700_000_000_000): CosTreeRecordInput =>
  ({ conversationKey: key, parentConversationKey: parent, hlc: { physical, logical: 0, node: 'mac-a' }, origin: 'mac-a' });
function plan(graph: ReducedGraph, tree: CosTreeRecordInput[], over: Partial<Parameters<typeof planCosTreeImports>[0]> = {}) {
  return planCosTreeImports({ agentId: 'echo', writerId: 'm1', leaseEpoch: 1, leaseStartMs: Date.parse('2026-11-05T08:00:00.000Z'), telegramChatId: CHAT, tree, graph, pendingSubjects: new Set(), knownEventIds: new Set(),
    isKnownConversation: () => true, isRootConversation: () => false, ...over });
}

describe('validator: what an import placement may be', () => {
  it('accepts only a first placement of a conversation directly under an effort', () => {
    expect(validateGraphEvent(place(tg(43), effort(1), [], 'import'))).not.toBeNull();
    expect(validateGraphEvent(place(tg(43), effort(1), ['evt-000001'], 'import'))).toBeNull(); // never displaces
    expect(validateGraphEvent(place(tg(43), tg(42), [], 'import'))).toBeNull(); // not delegates-to
    expect(validateGraphEvent(place(effort(2), effort(1), [], 'import'))).toBeNull(); // not contains
    expect(validateGraphEvent(place(tg(43), null, [], 'import'))).toBeNull(); // not a removal
  });
});

describe('planner', () => {
  it('imports a tree child of an accepted project, with a deterministic id that names the exact tree record', () => {
    const { graph, fdEventId } = acceptedProject();
    const a = plan(graph, [rec('telegram:43', 'telegram:42')]);
    const b = plan(graph, [rec('telegram:43', 'telegram:42')]);
    expect(a.imports).toHaveLength(1);
    expect(a.imports[0]).toMatchObject({ childKey: 'telegram:43', parentKey: 'telegram:42', effort: effort(1), frontDoorEventId: fdEventId, child: tg(43), frontDoor: tg(42) });
    expect(cosTreeImportEventId(a.imports[0])).toBe(cosTreeImportEventId(b.imports[0]));
    expect(cosTreeImportEventId(a.imports[0])).toMatch(/^cos-import-[0-9a-f]{64}$/);
    // A different tree write (a re-parent with a new HLC) is a different event.
    const c = plan(graph, [rec('telegram:43', 'telegram:42', 1_700_000_000_001)]);
    expect(cosTreeImportEventId(c.imports[0])).not.toBe(cosTreeImportEventId(a.imports[0]));
  });
  it('is idempotent: an event id already held (any origin, any state) is never emitted again', () => {
    const { graph } = acceptedProject();
    const first = plan(graph, [rec('telegram:43', 'telegram:42')]);
    const again = plan(graph, [rec('telegram:43', 'telegram:42')], { knownEventIds: new Set([cosTreeImportEventId(first.imports[0])]) });
    expect(again.imports).toEqual([]);
    expect(again.skipped).toEqual([{ conversationKey: 'telegram:43', reason: 'already-imported' }]);
  });
  it('an unaccepted (or pending) mapping keeps today\'s behaviour: nothing is emitted', () => {
    const c = create(effort(1)); const p = place(tg(42), effort(1));
    const noFrontDoor = reduceGraph([c, p], { verify: () => true });
    expect(plan(noFrontDoor, [rec('telegram:43', 'telegram:42')]).skipped).toEqual([{ conversationKey: 'telegram:43', reason: 'project-not-accepted' }]);
    // The owner's front-door event exists but is not certified yet (unverified here): still not accepted.
    const fd = frontDoor(effort(1), tg(42), [p.eventId]);
    const uncertified = reduceGraph([c, p, fd], { verify: (e) => e.eventId !== fd.eventId });
    expect(plan(uncertified, [rec('telegram:43', 'telegram:42')]).imports).toEqual([]);
  });
  it('never displaces: an owner placement, an owner removal or a pending change all mean skip', () => {
    const owned = place(tg(43), effort(2));
    expect(plan(acceptedProject([create(effort(2)), owned]).graph, [rec('telegram:43', 'telegram:42')]).skipped[0].reason).toBe('already-placed');
    const put = place(tg(43), effort(1)); const removed = place(tg(43), null, [put.eventId]);
    expect(plan(acceptedProject([put, removed]).graph, [rec('telegram:43', 'telegram:42')]).skipped[0].reason).toBe('already-placed');
    const { graph } = acceptedProject();
    expect(plan(graph, [rec('telegram:43', 'telegram:42')], { pendingSubjects: new Set([nodeKey(tg(43))]) }).skipped[0].reason).toBe('change-pending');
  });
  it('skips the root, front doors, unknown conversations, unmapped keys and parentless records', () => {
    const { graph } = acceptedProject();
    const out = plan(graph, [rec('telegram:44', 'telegram:42'), rec('telegram:42', 'telegram:9'), rec('slack:C1', 'telegram:42'), rec('telegram:45', null),
      { ...rec('telegram:46', null), role: 'chief-of-staff' }, rec('telegram:47', 'telegram:42')],
    { isRootConversation: (r) => r.platform === 'telegram' && r.topicId === 44, isKnownConversation: (r) => !(r.platform === 'telegram' && r.topicId === 47) });
    expect(out.imports).toEqual([]);
    expect(Object.fromEntries(out.skipped.map((s) => [s.conversationKey, s.reason]))).toEqual({
      'telegram:44': 'chief-of-staff-root', 'telegram:42': 'project-not-accepted', 'slack:C1': 'unmapped-key', 'telegram:45': 'no-parent',
      'telegram:46': 'chief-of-staff-root', 'telegram:47': 'unknown-conversation' });
  });
  it('a tombstoned tree record emits nothing (the real CoS fold drops it)', () => {
    const put = buildTreePut('telegram:43', 'telegram:42')({ physical: 1000, logical: 0, node: 'mac-a' }, 'mac-a')!;
    const gone = buildTreeTombstone('telegram:43', '2026-11-05T10:00:00.000Z')({ physical: 2000, logical: 0, node: 'mac-a' }, 'mac-a')!;
    const live = buildTreePut('telegram:44', 'telegram:42')({ physical: 1500, logical: 0, node: 'mac-b' }, 'mac-b')!;
    const entries: UnionEntry[] = [{ data: put, origin: 'mac-a' }, { data: gone, origin: 'mac-a' }, { data: live, origin: 'mac-b' }];
    const tree = foldTreeRecords(entries);
    expect(tree.map((r) => r.conversationKey)).toEqual(['telegram:44']);
    expect(tree[0]).toMatchObject({ parentConversationKey: 'telegram:42', origin: 'mac-b', hlc: { physical: 1500, logical: 0, node: 'mac-b' } });
    const out = plan(acceptedProject().graph, tree);
    expect(out.imports.map((s) => s.childKey)).toEqual(['telegram:44']);
    expect(cosTreeRecordStillLive(out.imports[0], tree)).toBe(true);
    expect(cosTreeRecordStillLive(out.imports[0], foldTreeRecords([...entries, { data: buildTreeTombstone('telegram:44', '2026-11-05T11:00:00.000Z')({ physical: 3000, logical: 0, node: 'mac-b' }, 'mac-b')!, origin: 'mac-b' }]))).toBe(false);
  });
  it('respects the effort\'s project scope like an owner move would', () => {
    const c = { ...create(effort(1)), projectScope: ['instar'] } as GraphEvent; const p = place(tg(42), effort(1)); const fd = frontDoor(effort(1), tg(42), [p.eventId]);
    const graph = reduceGraph([c, p, fd], { verify: () => true });
    expect(plan(graph, [rec('telegram:43', 'telegram:42')], { projectOf: () => 'other' }).skipped[0].reason).toBe('project-scope');
    expect(plan(graph, [rec('telegram:43', 'telegram:42')], { projectOf: () => 'instar' }).imports).toHaveLength(1);
    expect(plan(graph, [rec('telegram:43', 'telegram:42')], { projectOf: () => null }).imports).toHaveLength(1);
  });
});

describe('reducer: owner corrections always win over an import', () => {
  it('an import places the child; a concurrent owner placement wins; a later owner removal wins', () => {
    const { events, graph } = acceptedProject();
    const source = plan(graph, [rec('telegram:43', 'telegram:42')]).imports[0];
    const imp = cosTreeImportCore(source);
    const g1 = reduceGraph([...events, imp], { verify: () => true });
    expect(g1.parentOf.get(nodeKey(tg(43)))).toEqual(effort(1));
    expect(g1.placementSource.get(nodeKey(tg(43)))?.authority).toBe('import');
    const ownerConcurrent = { ...place(tg(43), null), createdAt: '2026-11-05T11:00:00.000Z' } as GraphEvent; // older, but owner tier
    expect(reduceGraph([...events, imp, ownerConcurrent], { verify: () => true }).parentOf.get(nodeKey(tg(43)))).toBeNull();
    const ownerLater = place(tg(43), null, [imp.eventId]);
    const g2 = reduceGraph([...events, imp, ownerLater], { verify: () => true });
    expect(g2.parentOf.get(nodeKey(tg(43)))).toBeNull();
    expect(g2.placementHeads.get(nodeKey(tg(43)))).toEqual([ownerLater.eventId]);
  });
});

describe('receive-side verification (real verifyGraphAuthorization)', () => {
  const f = replicationFixture();
  const writerId = f.members[0].machineId;
  function packetFor(core: Record<string, unknown>, proof: GraphAuthorizationProof) {
    const plaintext = encodeGraphSourceEnvelope('graph-event', core, proof, Buffer.from('{}'));
    const bundle = sealGraphBundle(plaintext, f.membership.members, { agentId: 'echo', eventId: proof.receipt.eventId });
    return { coreType: 'graph-event' as const, controlHash: canonicalHash(createGraphControlCapsule('graph-event', core, proof)), erasureIdentity: deriveGraphErasureIdentity('graph-event', core),
      agentId: 'echo', eventId: proof.receipt.eventId, idempotencyKey: proof.receipt.idempotencyKey, coreHash: canonicalHash(core),
      authorizationReceiptHash: canonicalHash(proof.receipt), sourceSequence: 1, predecessorHash: null, membershipEpoch: 1, leaseEpoch: 1, writerId, sourceBundleHash: canonicalHash(bundle) };
  }
  function signed(source: CosTreeImportSource, method: 'cos-tree-import' | 'owner-device', core = cosTreeImportCore(source) as unknown as Record<string, unknown>,
    importSource: unknown = source) {
    const receipt = signGraphAuthorizationReceipt({ v: 1, agentId: 'echo', eventId: graphOperationKey('graph-event', core.eventId as string), coreHash: canonicalHash(core),
      actorPrincipal: COS_TREE_IMPORT_PRINCIPAL, authenticationMethod: method, receiptId: (core.receipt as { id: string }).id, membershipEpoch: 1, leaseEpoch: 1,
      idempotencyKey: cosTreeImportIdempotencyKey(source), writerId, fencedLeaseHash: canonicalHash(f.originalLease), acceptedAt: '2026-11-05T08:05:00.000Z' }, f.members[0].signing.privateKey);
    const proof = { receipt, membership: f.membership, lease: f.lease, originalLease: f.originalLease, ...(importSource !== undefined ? { importSource } : {}) } as GraphAuthorizationProof;
    return { core, proof, packet: packetFor(core, proof) };
  }
  const source = plan(acceptedProject().graph, [rec('telegram:43', 'telegram:42')], { writerId }).imports[0];

  it('accepts an import whose core is exactly what its carried tree record yields', () => {
    const s = signed(source, 'cos-tree-import');
    expect(verifyGraphAuthorization(s.packet, s.core, s.proof, f.owner.publicKey, writerId)).toEqual({ ok: true });
    expect(verifyCosTreeImportCoreSource(s.core, source, 'echo', writerId, 1)).toBe(true);
  });
  it('an unverifiable receipt is never authoritative', () => {
    // The core points somewhere its source does not say.
    const moved = { ...cosTreeImportCore(source), parent: effort(9) } as unknown as Record<string, unknown>;
    const a = signed(source, 'cos-tree-import', moved);
    expect(verifyGraphAuthorization(a.packet, a.core, a.proof, f.owner.publicKey, writerId)).toEqual({ ok: false, reason: 'import-source-invalid' });
    // A tampered source (another child) no longer matches the core.
    const b = signed(source, 'cos-tree-import', undefined, { ...source, childKey: 'telegram:44', child: tg(44) });
    expect(verifyGraphAuthorization(b.packet, b.core, b.proof, f.owner.publicKey, writerId)).toEqual({ ok: false, reason: 'import-source-invalid' });
    // No source at all.
    const c = signed(source, 'cos-tree-import', undefined, null);
    expect(verifyGraphAuthorization(c.packet, c.core, c.proof, f.owner.publicKey, writerId).ok).toBe(false);
    // An import core cannot ride an owner method, and an owner method cannot carry an import source.
    const d = signed(source, 'owner-device');
    expect(verifyGraphAuthorization(d.packet, d.core, d.proof, f.owner.publicKey, writerId)).toEqual({ ok: false, reason: 'receipt-authority-mismatch' });
    // Another agent's source, or a core written by a different machine, is refused.
    expect(verifyCosTreeImportCoreSource(a.core, source, 'other-agent', writerId, 1)).toBe(false);
    expect(verifyCosTreeImportCoreSource(cosTreeImportCore(source), source, 'echo', 'another-machine', 1)).toBe(false);
    expect(verifyCosTreeImportCoreSource(cosTreeImportCore(source), source, 'echo', writerId, 2)).toBe(false); // another lease epoch
    // And the reducer sets an unverified import aside: it places nothing.
    const { events } = acceptedProject();
    const imp = cosTreeImportCore(source);
    const g = reduceGraph([...events, imp], { verify: (e) => e.eventId !== imp.eventId });
    expect(g.parentOf.has(nodeKey(tg(43)))).toBe(false);
    expect(g.setAside).toContainEqual({ eventId: imp.eventId, reason: 'unverified-authority' });
  });
  it('the source shape is strict', () => {
    expect(validateCosTreeImportSource(source)).not.toBeNull();
    expect(validateCosTreeImportSource({ ...source, extra: 1 })).toBeNull();
    expect(validateCosTreeImportSource({ ...source, childKey: 'telegram:99' })).toBeNull(); // key and ref disagree
    expect(validateCosTreeImportSource({ ...source, parentKey: source.childKey, frontDoor: source.child })).toBeNull();
    expect(cosKeyMatchesRef('app:7a1c8a3e-1b2c-4d5e-9f90-1234567890ab', { kind: 'conversation', platform: 'app', conversationKey: '7a1c8a3e-1b2c-4d5e-9f90-1234567890ab' })).toBe(true);
  });
});

describe('gate: every machine runs it', () => {
  it('is shut when the switch is off, or while any other member does not advertise it (unknown counts as no)', () => {
    expect(cosTreeImportGate({ enabled: false, selfId: 'a', members: ['a'], advertises: () => true })).toEqual({ open: false, reason: 'off', waitingOn: [] });
    expect(cosTreeImportGate({ enabled: true, selfId: 'a', members: ['a', 'b', 'c'], advertises: (m) => (m === 'b' ? null : m === 'c' ? false : true) }))
      .toEqual({ open: false, reason: 'waiting-for-machines', waitingOn: ['b', 'c'] });
    expect(cosTreeImportGate({ enabled: true, selfId: 'a', members: ['a', 'b'], advertises: () => true })).toEqual({ open: true });
    expect(cosTreeImportGate({ enabled: true, selfId: 'a', members: ['a'], advertises: () => null })).toEqual({ open: true });
  });
});

describe('runner preconditions (no graph write without every precondition)', () => {
  it('is off, not ready, gated or not the writer before it reads anything', async () => {
    const { ConversationGraphCosTreeImporter } = await import('../../src/server/ConversationGraphCosTreeImporter.js');
    let treeReads = 0;
    const base = { identity: () => ({}) as never, tree: () => { treeReads++; return []; }, telegramChatId: () => CHAT, rootConversation: () => null };
    const fenced = { isReady: () => true, machineId: 'a', installedMembership: { members: [{ machineId: 'a' }, { machineId: 'b' }] },
      actuation: () => { throw new Error('graph-runtime-write-fenced'); } };
    expect(await new ConversationGraphCosTreeImporter({ ...base, runtime: () => fenced as never, enabled: () => false, advertises: () => true }).runOnce()).toEqual({ state: 'off' });
    expect(await new ConversationGraphCosTreeImporter({ ...base, runtime: () => null, enabled: () => true, advertises: () => true }).runOnce()).toEqual({ state: 'not-ready' });
    expect(await new ConversationGraphCosTreeImporter({ ...base, runtime: () => fenced as never, enabled: () => true, advertises: () => null }).runOnce())
      .toEqual({ state: 'gated', gate: { open: false, reason: 'waiting-for-machines', waitingOn: ['b'] } });
    // A standby: actuation is fenced. Reported as not-writer, quietly (no degradation), and the tree is never read.
    expect(await new ConversationGraphCosTreeImporter({ ...base, runtime: () => fenced as never, enabled: () => true, advertises: () => true }).runOnce()).toEqual({ state: 'not-writer' });
    expect(treeReads).toBe(0);
  });
});

describe('failover: two writers never fork one event id', () => {
  it('the same record from two writers (or two lease epochs) is two events; the same writer twice is byte-identical', () => {
    const { events, graph } = acceptedProject();
    const a = plan(graph, [rec('telegram:43', 'telegram:42')], { writerId: 'mac-a' }).imports[0];
    const a2 = plan(graph, [rec('telegram:43', 'telegram:42')], { writerId: 'mac-a' }).imports[0];
    const b = plan(graph, [rec('telegram:43', 'telegram:42')], { writerId: 'mac-b', leaseEpoch: 2 }).imports[0];
    expect(cosTreeImportCore(a)).toEqual(cosTreeImportCore(a2));
    expect(cosTreeImportEventId(a)).not.toBe(cosTreeImportEventId(b));
    expect(cosTreeImportEventId(a)).not.toBe(cosTreeImportEventId(plan(graph, [rec('telegram:43', 'telegram:42')], { writerId: 'mac-a', leaseEpoch: 2 }).imports[0]));
    // Both land: two import heads that agree on the parent are not a conflict and nothing is set aside.
    const g = reduceGraph([...events, cosTreeImportCore(a), cosTreeImportCore(b)], { verify: () => true });
    expect(g.parentOf.get(nodeKey(tg(43)))).toEqual(effort(1));
    expect(g.setAside).toEqual([]);
    expect(g.conflicts).toEqual([]);
  });
});

describe('owner corrections are never made stale by an import', () => {
  it('an owner change that did not see an import head still counts as observing the current heads', async () => {
    const { ownerObservedHeads } = await import('../../src/server/ConversationGraphOwnerChanges.js');
    const { events, graph } = acceptedProject();
    const imp = cosTreeImportCore(plan(graph, [rec('telegram:43', 'telegram:42')]).imports[0]);
    const owned = place(tg(43), effort(1));
    const all = [...events, imp, owned];
    // Owner saw only its own head (or nothing) while the import landed: still current.
    expect(ownerObservedHeads([imp.eventId, owned.eventId].sort(), [owned.eventId], all)).toBe(true);
    expect(ownerObservedHeads([imp.eventId], [], all)).toBe(true);
    // An unseen OWNER (or delegation) head is a real conflict, and naming a head that is not current is too.
    const other = place(tg(43), effort(2));
    expect(ownerObservedHeads([imp.eventId, other.eventId].sort(), [imp.eventId], [...all, other])).toBe(false);
    expect(ownerObservedHeads([imp.eventId], ['evt-999999'], all)).toBe(false);
  });
});
