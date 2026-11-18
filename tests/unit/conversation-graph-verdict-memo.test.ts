/** The certified-union row memo (docs/specs/graph-verify-verdict-memo.md): per-row verify / fullyPersisted /
 * descriptor results are reused only while the row's top-level values and the per-pass context are unchanged.
 * Runs with INSTAR_GRAPH_VERDICT_MEMO_CHECK=1 (tests/vitest-setup.ts), so every hit is also recomputed. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationGraphLocalErasureFence } from '../../src/core/ConversationGraphLocalErasure.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationGraphReplication, graphVerdictMemoDivergences, registerConversationGraphReplication, type ConversationGraphReplicationRecord } from '../../src/core/ConversationGraphReplication.js';
import { replicationFixture } from './conversation-graph-replication.fixtures.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-verdict-memo-')); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-verdict-memo-test:teardown' }); });
function sourceReader(dir: string, records: () => OriginRecord[]) {
  const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
  const dropped = new DroppedOriginRegistry({ stateDir: dir });
  const reader = new ReplicatedStoreReader({ registry, stores: { conversationGraph: { enabled: true } }, tierOf: () => 'high',
    droppedOrigins: dropped, conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    listRecordKeys: () => [...new Set(records().map((x) => x.envelope.recordKey))],
    loadOriginRecords: (_store, key) => records().filter((x) => x.envelope.recordKey === key) });
  return { reader, dropped };
}
type Internals = { verify: (r: ConversationGraphReplicationRecord, o: string) => boolean; fullyPersisted: (r: ConversationGraphReplicationRecord) => boolean;
  rowMemoContext: () => string | null; records: Map<string, { record: ConversationGraphReplicationRecord }>; verifierEpoch: number;
  rowMemo: WeakMap<object, { verified: Map<string, boolean> }>; options: { witnessPublicKeys: Map<string, unknown>; installedMembership?: { createdAt: string } } };
const internals = (source: ConversationGraphReplication) => source as unknown as Internals;

/** A writer and a peer holding one fully certified row; the peer's union verifies it against origin 'writer'. */
async function certifiedPair(ids = ['event-one']) {
  const f = replicationFixture(), dir = await directory(), writer = await ConversationGraphReplication.open(f.options(dir)),
    peer = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
  let predecessor: string | null = null; let sequence = 0;
  for (const id of ids) {
    const r = f.record(id, ++sequence, predecessor); predecessor = r.packet.coreHash;
    const a = await writer.appendLocal(r), b = await peer.receive(r, 'writer'), certificate = f.certificate(r, [a.receipt, b]);
    const ownA = await writer.attachCertificate(r.packet.eventId, certificate), ownB = await peer.attachCertificate(r.packet.eventId, certificate);
    for (const receipt of [ownA, ownB]) { await writer.recordCertificateReceipt(r.packet.eventId, receipt); await peer.recordCertificateReceipt(r.packet.eventId, receipt); }
  }
  const view = sourceReader(dir, () => [...writer.originRecords(), ...peer.originRecords()]);
  return { f, writer, peer, view };
}

describe('graph verdict memo', () => {
  it('reuses verify and fullyPersisted for unchanged rows and recomputes a changed row only', async () => {
    const { peer, view } = await certifiedPair(['event-one', 'event-two']);
    const verify = vi.spyOn(internals(peer), 'verify'), persisted = vi.spyOn(internals(peer), 'fullyPersisted');
    const first = peer.certifiedUnion(view.reader, view.dropped);
    expect(first.records).toHaveLength(2);
    const coldVerify = verify.mock.calls.length, coldPersisted = persisted.mock.calls.length;
    expect(coldVerify).toBeGreaterThan(0);
    verify.mockClear(); persisted.mockClear();
    expect(peer.certifiedUnion(view.reader, view.dropped).records).toHaveLength(2);
    // Check mode recomputes each hit once to compare, so a warm pass costs at most what the cold one did;
    // with check mode off (production) a warm pass makes no verify call at all (asserted below).
    expect(verify.mock.calls.length).toBeLessThanOrEqual(coldVerify);
    const stored = internals(peer).records.get('graph-event:event-one')!;
    const before = internals(peer).rowMemo.get(stored.record);
    expect(before?.verified.size).toBeGreaterThan(0);
    // A top-level reassignment (how every writer changes a stored row) makes the row miss.
    stored.record = { ...stored.record };
    expect(internals(peer).rowMemo.get(stored.record)).toBeUndefined();
    expect(peer.certifiedUnion(view.reader, view.dropped).records).toHaveLength(2);
    expect(internals(peer).rowMemo.get(stored.record)?.verified.size).toBeGreaterThan(0);
    void coldPersisted;
  });

  it('makes no warm verify call with check mode off', async () => {
    const previous = process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK; delete process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK;
    try {
      const { peer, view } = await certifiedPair();
      peer.certifiedUnion(view.reader, view.dropped);
      const verify = vi.spyOn(internals(peer), 'verify');
      peer.certifiedUnion(view.reader, view.dropped);
      expect(verify).not.toHaveBeenCalled();
    } finally { process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK = previous; }
  });

  it('a real pass recomputes after a witness key or the installed membership changes, and only then', async () => {
    const previous = process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK; delete process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK;
    try {
      const { peer, view } = await certifiedPair(['event-one', 'event-two']); const p = internals(peer);
      peer.certifiedUnion(view.reader, view.dropped);
      const verify = vi.spyOn(p, 'verify');
      peer.certifiedUnion(view.reader, view.dropped); expect(verify).not.toHaveBeenCalled();
      p.options.witnessPublicKeys.set('independent-witness-2', 'PEM-NEW');
      peer.certifiedUnion(view.reader, view.dropped); const afterKey = verify.mock.calls.length; expect(afterKey).toBeGreaterThan(0);
      peer.certifiedUnion(view.reader, view.dropped); expect(verify.mock.calls.length).toBe(afterKey);
      const membership = p.options.installedMembership!; membership.createdAt = 'changed';
      peer.certifiedUnion(view.reader, view.dropped); expect(verify.mock.calls.length).toBeGreaterThan(afterKey);
      // A different origin is a separate cached verdict: it misses once, then hits.
      const stored = p.records.get('graph-event:event-one')!.record; verify.mockClear();
      (p as unknown as { memoVerify: (r: unknown, o: string, c: string | null) => boolean }).memoVerify(stored, 'someone-else', p.rowMemoContext());
      expect(verify).toHaveBeenCalledTimes(1);
      // A change to one row leaves the other row's verdict cached.
      p.records.get('graph-event:event-one')!.record = { ...stored }; verify.mockClear();
      peer.certifiedUnion(view.reader, view.dropped);
      expect(new Set(verify.mock.calls.map(([row]) => (row as ConversationGraphReplicationRecord).packet.eventId))).toEqual(new Set(['graph-event:event-one']));
    } finally { process.env.INSTAR_GRAPH_VERDICT_MEMO_CHECK = previous; }
  });

  it('changes the pass context when any verifier input changes', async () => {
    const { f, peer } = await certifiedPair(); const p = internals(peer);
    const base = p.rowMemoContext(); expect(base).not.toBeNull();
    p.verifierEpoch++; const afterEpoch = p.rowMemoContext(); expect(afterEpoch).not.toBe(base);
    p.options.witnessPublicKeys.set('another-witness', 'PEM-OTHER'); const afterKey = p.rowMemoContext(); expect(afterKey).not.toBe(afterEpoch);
    p.options.witnessPublicKeys.set('another-witness', 'PEM-REPLACED'); expect(p.rowMemoContext()).not.toBe(afterKey);
    const membership = p.options.installedMembership; if (membership) { const now = p.rowMemoContext(); membership.createdAt = 'changed'; expect(p.rowMemoContext()).not.toBe(now); }
    void f;
  });

  it('signs the shared fence state: a deny through another instance for the same root changes the signature', async () => {
    const root = await directory(), a = new ConversationGraphLocalErasureFence(root), b = new ConversationGraphLocalErasureFence(root);
    const before = a.answerSignature();
    await b.deny({ sourceKind: 'conversation-metadata', sourceId: 'a'.repeat(64) } as never);
    expect(a.answerSignature()).not.toBe(before);
    expect(a.answerSignature().startsWith('true:false:')).toBe(true);
  });

  it('keeps the fence grow-only (no deny is ever removed and corrupt never resets)', () => {
    const source = fsSync.readFileSync(path.join(__dirname, '../../src/core/ConversationGraphLocalErasure.ts'), 'utf8');
    expect(source).not.toMatch(/denied\.(delete|clear)\(/);
    expect(source).not.toMatch(/corrupt\s*=\s*false/);
    expect(source).not.toMatch(/negativeRoots\.(delete|clear)\(/);
  });

  it('turns the memo off for a pass whose context cannot be read or when switched off', async () => {
    const { peer } = await certifiedPair(); const p = internals(peer);
    p.options.witnessPublicKeys.set('broken', { notAKey: true }); expect(p.rowMemoContext()).toBeNull();
    const previous = process.env.INSTAR_GRAPH_VERDICT_MEMO; process.env.INSTAR_GRAPH_VERDICT_MEMO = 'off';
    try { const { peer: off } = await certifiedPair(); expect(internals(off).rowMemoContext()).toBeNull(); }
    finally { if (previous === undefined) delete process.env.INSTAR_GRAPH_VERDICT_MEMO; else process.env.INSTAR_GRAPH_VERDICT_MEMO = previous; }
  });

  it('never covers rows whose checks read the clock, files or custody lineage', async () => {
    const { peer, view } = await certifiedPair(); const p = internals(peer);
    const stored = p.records.get('graph-event:event-one')!;
    stored.record = { ...stored.record, erasure: { stand: 'in' } as never };
    peer.certifiedUnion(view.reader, view.dropped);
    expect(p.rowMemo.get(stored.record)).toBeUndefined();
  });

  it('in check mode, freezes stored row values so a nested edit throws, and counts a divergence', async () => {
    const { peer, view } = await certifiedPair(); const p = internals(peer);
    peer.certifiedUnion(view.reader, view.dropped);
    const stored = p.records.get('graph-event:event-one')!.record as unknown as { certificatePersistenceReceipts: unknown[] };
    expect(() => stored.certificatePersistenceReceipts.push({})).toThrow(TypeError);
    // A tampered cached verdict is caught by the recompute on hit; the counter is read and reset here.
    const entry = p.rowMemo.get(p.records.get('graph-event:event-one')!.record)!;
    for (const [origin, value] of entry.verified) entry.verified.set(origin, !value);
    const before = graphVerdictMemoDivergences();
    expect(() => peer.certifiedUnion(view.reader, view.dropped)).toThrow(/graph-verdict-memo-divergence/);
    expect(graphVerdictMemoDivergences()).toBe(before + 1);
    (globalThis as Record<string, unknown>).__instarGraphVerdictMemoDivergences = 0;
  });

  it('covered rows never reach the excluded-only helpers', async () => {
    const { peer, view } = await certifiedPair(['event-one', 'event-two']);
    const p = peer as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = ['validMaterialization', 'validErasure', 'validErasedControl', 'currentHistoricalImportMembership', 'validMemberLossNegativeCustody']
      .map((name) => vi.spyOn(p, name as never));
    peer.certifiedUnion(view.reader, view.dropped); peer.certifiedUnion(view.reader, view.dropped);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('graph verdict memo: every input of the per-row work is classified', () => {
  // The spec's §1 list. A new read or a new call into another object fails until it is classified there.
  const CLASSIFIED_FIELDS = new Set(['records', 'pendingErasureTargets', 'erasureProofs', 'controlTargets', 'historicalImportAuthority', 'historicalImportActivationHash',
    'historicalImportMembership', 'historicalReopen', 'contexts', 'verifiedContexts', 'erasureAuthorities', 'rowMemo', 'rowMemoPass', '#pagedHistorical', 'verifierEpoch', 'rowMemoCheck', 'rowMemoEnabled']);
  const CLASSIFIED_OPTIONS = new Set(['localErasure', 'witnessPublicKeys', 'installedMembership', 'ownerPublicKey', 'agentId', 'machineId', 'validateCore']);
  it('finds no unclassified field read, option read or unfollowable syntax in the transitive closure', () => {
    const file = path.join(__dirname, '../../src/core/ConversationGraphReplication.ts');
    const sf = ts.createSourceFile(file, fsSync.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let cls: ts.ClassDeclaration | undefined;
    sf.forEachChild((node) => { if (ts.isClassDeclaration(node) && node.name?.text === 'ConversationGraphReplication') cls = node; });
    expect(cls).toBeDefined();
    const methods = new Map<string, ts.Node>();
    for (const member of cls!.members) if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member)) && member.name && ts.isIdentifier(member.name)) methods.set(member.name.text, member);
    const queue = ['verify', 'fullyPersisted', 'descriptorFor'], visited = new Set<string>(), fields = new Map<string, string>(), options = new Map<string, string>(), problems: string[] = [];
    // Helpers only rows in excluded classes reach (spec §2; pinned by 'covered rows never reach the excluded-only helpers').
    const EXCLUDED_ONLY = new Set(['validMaterialization', 'validErasure', 'validErasedControl', 'currentHistoricalImportMembership', 'validMemberLossNegativeCustody']);
    while (queue.length) {
      const name = queue.shift()!; if (visited.has(name) || EXCLUDED_ONLY.has(name)) continue; visited.add(name);
      const node = methods.get(name); if (!node) { problems.push(`missing method ${name}`); continue; }
      const walk = (n: ts.Node): void => {
        if (ts.isElementAccessExpression(n) && (n.expression.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && n.expression.name.text === 'options'))) problems.push(`computed access in ${name}`);
        if (ts.isVariableDeclaration(n) && n.initializer?.kind === ts.SyntaxKind.ThisKeyword) problems.push(`this aliased in ${name}`);
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isPropertyAccessExpression(n.initializer) && n.initializer.expression.kind === ts.SyntaxKind.ThisKeyword && n.initializer.name.text === 'options') problems.push(`this.options aliased in ${name}`);
        if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const member = n.name.text;
          if (methods.has(member)) queue.push(member);
          else if (member !== 'options') fields.set(member, `${member}@${name}`);
        }
        if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && n.expression.name.text === 'options') options.set(n.name.text, `${n.name.text}@${name}`);
        n.forEachChild(walk);
      };
      walk(node);
    }
    expect(problems).toEqual([]);
    expect([...fields].filter(([f]) => !CLASSIFIED_FIELDS.has(f)).map(([, where]) => where)).toEqual([]);
    expect([...options].filter(([o]) => !CLASSIFIED_OPTIONS.has(o)).map(([, where]) => where)).toEqual([]);
  });

  it('bumps the verifier epoch at every class-local verifier-state write', () => {
    const source = fsSync.readFileSync(path.join(__dirname, '../../src/core/ConversationGraphReplication.ts'), 'utf8');
    for (const write of [/this\.historicalImportAuthority=(?!=)/g, /this\.historicalReopen=(?!=)/g, /this\.pendingErasureTargets\.(?:set|delete)\(/g, /this\.erasureProofs\.push\(/g]) {
      const sites = [...source.matchAll(write)];
      expect(sites.length).toBeGreaterThan(0);
      for (const site of sites) expect(source.slice(Math.max(0, site.index! - 21), site.index)).toBe('this.verifierEpoch++,');
    }
  });
});
