/**
 * AC3 (a2a-single-agent-identity §2.1–§2.2): ONE comparison formula — the routing fingerprint
 * (`fingerprintOf(pub) === computeFingerprint(pub) === /provenance`; the sha256 form never
 * equals them) — and the continuous detector: four machines holding the same key read
 * `agree`; the 63b1/afd2 pair reads `disagree`; a disk value that differs from `connectedAs`
 * reads `disagree`; one unreachable member with two differing observed values reads
 * `disagree`; an offline-by-presence peer is `unobserved` and never increments `cannot-tell`;
 * the item is raised once by the lease holder and resolved after the split member is
 * re-observed repaired while a non-member sleeps; a revoked+offline member drops out.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fingerprintOf, legacyHandoverFingerprintOf, fingerprintMatchesEitherFormula, normalizeRootFingerprint } from '../../src/core/AgentIdentityHandover.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import {
  IdentityCoherenceDetector,
  evaluateIdentityCoherence,
  splitNotice,
  strictMajority,
  contributorsOf,
  type CoherenceObservation,
  type CoherenceAttentionItem,
  type IdentityCoherenceDetectorDeps,
} from '../../src/core/AgentIdentityCoherence.js';

const FP_A = '63b1dbb2'.padEnd(32, '1');
const FP_B = 'afd256bc'.padEnd(32, '2');
const FP_C = 'ff2e6980'.padEnd(32, '3');

describe('§2.1 one comparison formula', () => {
  it('fingerprintOf(pub) === computeFingerprint(pub) (the relay / health / provenance value); the sha256 form never equals them', () => {
    for (let i = 0; i < 5; i++) {
      const kp = generateIdentityKeyPair();
      const b64 = kp.publicKey.toString('base64');
      expect(fingerprintOf(b64)).toBe(computeFingerprint(kp.publicKey));
      expect(fingerprintOf(b64)).toBe(kp.publicKey.subarray(0, 16).toString('hex')); // what /provenance publishes
      const sha = createHash('sha256').update(kp.publicKey).digest('hex').slice(0, 32);
      expect(legacyHandoverFingerprintOf(b64)).toBe(sha);
      expect(sha).not.toBe(fingerprintOf(b64));
    }
  });

  it('transition: a join envelope is accepted under EITHER formula; a provenance root in the legacy form is rewritten in routing form', () => {
    const kp = generateIdentityKeyPair();
    const b64 = kp.publicKey.toString('base64');
    expect(fingerprintMatchesEitherFormula(b64, fingerprintOf(b64))).toBe(true);
    expect(fingerprintMatchesEitherFormula(b64, legacyHandoverFingerprintOf(b64))).toBe(true);
    expect(fingerprintMatchesEitherFormula(b64, 'zz'.repeat(16))).toBe(false);
    expect(normalizeRootFingerprint(legacyHandoverFingerprintOf(b64), b64)).toBe(fingerprintOf(b64));
    expect(normalizeRootFingerprint('some-other-root', b64)).toBe('some-other-root'); // presence-only, carried as-is
    expect(normalizeRootFingerprint(undefined, b64)).toBe(fingerprintOf(b64));
  });
});

const obs = (machineId: string, fingerprint: string | null, status: CoherenceObservation['status'] = 'observed', source: CoherenceObservation['source'] = 'peer', nickname = machineId): CoherenceObservation => ({ machineId, nickname, source, fingerprint, status });

describe('§2.2 the verdict', () => {
  it('four machines holding the same key read agree', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini', 'laptop', 'mama'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('self', FP_A, 'observed', 'self-connected'), obs('mini', FP_A), obs('laptop', FP_A), obs('mama', FP_A)] });
    expect(v.state).toBe('agree');
  });
  it('the 63b1/afd2 pair reads disagree with the sorted-set episode key', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini'], observations: [obs('self', FP_B, 'observed', 'self-disk'), obs('mini', FP_A)] });
    expect(v.state).toBe('disagree');
    expect(v.episodeKey).toBe(`agent-identity-split:echo:${[FP_A, FP_B].sort().join('+')}`);
  });
  it('a disk value that differs from connectedAs is itself disagree (the incident state)', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('self', FP_B, 'observed', 'self-connected'), obs('mini', FP_A)] });
    expect(v.state).toBe('disagree');
  });
  it('one unreachable member with two differing observed values reads disagree — an unreachable member never hides a split', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini', 'laptop'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('mini', FP_B), obs('laptop', null, 'cannot-tell')] });
    expect(v.state).toBe('disagree');
  });
  it('an offline-by-presence peer is unobserved → partial-agree (never agree); fewer than two values → cannot-tell', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini', 'laptop'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('mini', FP_A), obs('laptop', null, 'unobserved')] });
    expect(v.state).toBe('partial-agree');
    expect(v.unobserved).toEqual(['laptop']);
    expect(evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('mini', null, 'cannot-tell')] }).state).toBe('cannot-tell');
  });
  it('partial-agree persists until every active sibling has been observed once since the repair', () => {
    const seen = new Set(['laptop']);
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini', 'laptop'], observations: [obs('self', FP_A, 'observed', 'self-disk'), obs('mini', FP_A), obs('laptop', null, 'unobserved')], observedSinceRepair: seen });
    expect(v.state).toBe('agree');
  });
});

describe('§2.2 the proposal rule and contributors', () => {
  it('strict majority → target = minority machines, source = a majority machine; no majority → no direction, asks which address peers pinned', () => {
    const majority = splitNotice({ agentName: 'echo', selfNickname: 'studio', selfDisk: FP_B, connectedAs: FP_B, siblings: [], byValue: { [FP_A]: ['mini', 'laptop'], [FP_B]: ['studio (disk)', 'studio (relay)'] }, relayHolder: 'studio' });
    expect(majority.body).toMatch(/adopt the identity mini publishes \(63b1dbb2…\) onto studio/);
    expect(majority.body).toMatch(/instar identity adopt --from mini/);
    expect(majority.body).toMatch(/studio holds the relay connection right now/);
    const tie = splitNotice({ agentName: 'echo', selfNickname: 'studio', selfDisk: FP_B, connectedAs: FP_B, siblings: [], byValue: { [FP_A]: ['mini'], [FP_B]: ['studio (disk)'] } });
    expect(tie.body).toMatch(/no majority, so I will not guess a direction/);
    expect(tie.body).not.toMatch(/say yes and I will adopt/);
    expect(strictMajority({ a: FP_A, b: FP_A, c: FP_B })).toBe(FP_A);
    expect(strictMajority({ a: FP_A, b: FP_B })).toBeNull();
    expect(strictMajority({ a: FP_A, b: FP_A, c: FP_B, d: FP_B })).toBeNull();
  });
  it('contributors = machines whose last observed value ≠ the majority value (self by its disk value)', () => {
    const v = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini', 'laptop'], observations: [obs('m_self', FP_B, 'observed', 'self-disk', 'studio'), obs('m_mini', FP_A, 'observed', 'peer', 'mini'), obs('m_laptop', FP_A, 'observed', 'peer', 'laptop')] });
    expect(contributorsOf(v, 'm_self', FP_B, FP_B)).toEqual({ m_self: FP_B });
    const tie = evaluateIdentityCoherence({ agentName: 'echo', activeSiblingIds: ['mini'], observations: [obs('m_self', FP_B, 'observed', 'self-disk', 'studio'), obs('m_mini', FP_A, 'observed', 'peer', 'mini')] });
    expect(contributorsOf(tie, 'm_self', FP_B, null)).toEqual({ m_self: FP_B, m_mini: FP_A });
  });
  it('a peer name is clamped and HTML-escaped before it reaches an item', () => {
    const n = splitNotice({ agentName: 'echo', selfNickname: 'studio', selfDisk: FP_B, connectedAs: null, siblings: [], byValue: { [FP_A]: ['<b>mini</b>', 'laptop'], [FP_B]: ['studio (disk)'] } });
    // splitNotice renders what the detector hands it; the detector clamps via safeName (tested through the detector below).
    expect(n.title).toContain('echo');
  });
});

// ── The detector ───────────────────────────────────────────────────────────

interface World {
  selfDisk: string | null;
  connectedAs: string | null;
  peers: Record<string, { nick: string; fp: string | null; online: boolean | null; active: boolean }>;
  holdsLease: boolean;
}

function detector(world: World, extra: Partial<IdentityCoherenceDetectorDeps> = {}) {
  const items: CoherenceAttentionItem[] = [];
  const resolved: string[] = [];
  const degradations: unknown[] = [];
  let t = 0;
  const d = new IdentityCoherenceDetector({
    agentName: 'echo',
    selfMachineId: 'm_self',
    selfNickname: 'studio',
    readSelfDisk: () => world.selfDisk,
    connectedAs: () => world.connectedAs,
    listActiveSiblings: () => Object.entries(world.peers).filter(([, p]) => p.active).map(([id, p]) => ({ machineId: id, nickname: p.nick })),
    listRevokedSiblings: () => Object.entries(world.peers).filter(([, p]) => !p.active).map(([id, p]) => ({ machineId: id, nickname: p.nick })),
    isMachineActive: (id) => world.peers[id]?.active === true,
    isOnline: (id) => world.peers[id]?.online ?? null,
    fetchPeerFingerprint: async (s) => world.peers[s.machineId]?.fp ?? null,
    holdsLease: () => world.holdsLease,
    raiseItem: (i) => items.push(i),
    resolveItem: (id) => resolved.push(id),
    reportDegradation: (r) => degradations.push(r),
    now: () => (t += 300_000),
    ...extra,
  });
  return { d, items, resolved, degradations };
}

describe('§2.2 the detector — raise/resolve rules', () => {
  it('raises ONCE on the lease holder after 2 consecutive disagree reads, with contributors metadata; a non-holder never raises', async () => {
    const world: World = { selfDisk: FP_B, connectedAs: FP_B, holdsLease: false, peers: { m_mini: { nick: 'mini', fp: FP_A, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: true, active: true } } };
    const nonHolder = detector(world);
    await nonHolder.d.runOnce();
    await nonHolder.d.runOnce();
    await nonHolder.d.runOnce();
    expect(nonHolder.items).toEqual([]);
    expect(nonHolder.d.health().state).toBe('disagree'); // a health state, not a raise
    world.holdsLease = true;
    const holder = detector(world);
    await holder.d.runOnce();
    expect(holder.items).toEqual([]); // first read: not yet confirmed
    await holder.d.runOnce();
    await holder.d.runOnce();
    expect(holder.items).toHaveLength(1);
    const item = holder.items[0];
    expect(item.id).toBe(`agent-identity-split:echo:${[FP_A, FP_B].sort().join('+')}`);
    expect(item.priority).toBe('high');
    expect(item.metadata).toMatchObject({ contributors: { m_self: FP_B } });
    expect(item.body).toMatch(/adopt the identity mini publishes/);
    expect(item.body).toMatch(/onto studio/);
    expect(holder.d.health().openEpisode?.itemId).toBe(item.id);
  });

  it('resolves after 2 consecutive clean rounds re-observing the split member while a NON-member sleeps; holder only', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_B, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: true, active: true } } };
    const { d, items, resolved } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    expect(items[0].metadata).toMatchObject({ contributors: { m_mini: FP_B } });
    // The repair lands on mini; the laptop goes to sleep (a non-member) — it must not block.
    world.peers.m_mini.fp = FP_A;
    world.peers.m_laptop.online = false;
    await d.runOnce();
    expect(resolved).toEqual([]); // one clean round is not enough
    await d.runOnce();
    expect(resolved).toEqual([items[0].id]);
    expect(d.health().openEpisode).toBeNull();
  });

  it('a split member re-observed STILL differing keeps the item; a member asleep blocks resolution until seen', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_B, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: true, active: true } } };
    const { d, items, resolved } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    world.peers.m_mini.online = false; // the split member goes dark before repairing
    await d.runOnce(); await d.runOnce(); await d.runOnce();
    expect(resolved).toEqual([]);
    expect(d.health().state).toBe('partial-agree');
    world.peers.m_mini.online = true; // comes back, still split
    await d.runOnce();
    expect(resolved).toEqual([]);
    expect(d.health().state).toBe('disagree');
  });

  it('a revoked AND offline split member drops out of the required set; revoked but ONLINE is still required', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_old: { nick: 'old-mini', fp: FP_B, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: true, active: true } } };
    const { d, items, resolved } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    // Decommissioned: `instar machines remove` revokes it, but it is still online and still split.
    world.peers.m_old.active = false;
    await d.runOnce(); await d.runOnce(); await d.runOnce();
    expect(resolved).toEqual([]); // still online → still required → still differing
    world.peers.m_old.online = false; // now off; a revoked+offline member drops out
    await d.runOnce(); await d.runOnce();
    expect(resolved).toEqual([items[0].id]);
  });

  it('an offline-by-presence peer is unobserved and never increments cannot-tell; 10 online-unanswering rounds → one degradation + one medium item, after a presence re-pull', async () => {
    const refreshed: string[] = [];
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_A, online: true, active: true }, m_laptop: { nick: 'laptop', fp: null, online: false, active: true } } };
    const { d, items, degradations, resolved } = detector(world, { refreshPresence: (id) => { refreshed.push(id); } });
    for (let i = 0; i < 12; i++) await d.runOnce();
    expect(d.health().cannotTellRounds).toEqual({});
    expect(d.health().siblingsPublish.m_laptop).toMatchObject({ status: 'unobserved', reason: 'offline-by-presence' });
    expect(items).toEqual([]);
    world.peers.m_laptop.online = true; // online but never answers /provenance
    for (let i = 0; i < 10; i++) await d.runOnce();
    expect(d.health().cannotTellRounds).toEqual({ m_laptop: 10 });
    expect(refreshed).toEqual(['m_laptop']);
    expect(degradations).toHaveLength(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'agent-identity-cannot-tell:echo:m_laptop', priority: 'medium' });
    await d.runOnce();
    expect(items).toHaveLength(1); // once per episode
    world.peers.m_laptop.fp = FP_A;
    await d.runOnce();
    expect(resolved).toEqual(['agent-identity-cannot-tell:echo:m_laptop']);
  });

  it('a third value published later is a NEW item with a different sorted set, never a silent gap', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_B, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: false, active: true } } };
    const { d, items } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    world.peers.m_laptop.online = true;
    world.peers.m_laptop.fp = FP_C;
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(2);
    expect(items[1].id).toBe(`agent-identity-split:echo:${[FP_A, FP_B, FP_C].sort().join('+')}`);
    expect(d.health().openEpisodeCount).toBe(2);
  });

  it('after a third value BOTH items resolve once the fleet is whole — the first is not stranded', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_B, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: false, active: true } } };
    const { d, items, resolved } = detector(world);
    await d.runOnce(); await d.runOnce();
    world.peers.m_laptop.online = true;
    world.peers.m_laptop.fp = FP_C;
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(2);
    world.peers.m_mini.fp = FP_A;
    world.peers.m_laptop.fp = FP_A;
    await d.runOnce(); await d.runOnce();
    expect(resolved.sort()).toEqual(items.map((i) => i.id).sort());
    expect(d.health().openEpisode).toBeNull();
    expect(d.health().openEpisodeCount).toBe(0);
  });

  it('a former lease holder resolves the item it raised — the item lives only in ITS store', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_B, online: true, active: true } } };
    const { d, items, resolved } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    world.holdsLease = false; // the lease moves away while the item is open
    world.peers.m_mini.fp = FP_A; // …and the split is repaired
    await d.runOnce(); await d.runOnce();
    expect(resolved).toEqual([items[0].id]);
    expect(d.health().openEpisode).toBeNull();
  });

  it('a restarted detector re-adopts a split item still open in the store and resolves it once every active sibling is seen whole', async () => {
    const id = `agent-identity-split:echo:${[FP_A, FP_B].sort().join('+')}`;
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_A, online: true, active: true }, m_laptop: { nick: 'laptop', fp: FP_A, online: false, active: true } } };
    const open = new Set([id]);
    const { d, items, resolved } = detector(world, { openItemIds: (prefix) => [...open].filter((i) => i.startsWith(prefix)), resolveItem: (i) => { resolved.push(i); open.delete(i); } });
    await d.runOnce(); await d.runOnce(); await d.runOnce();
    expect(items).toEqual([]); // healed while the server was down: nothing new to raise
    expect(resolved).toEqual([]); // the laptop is asleep — the conservative member set waits for it
    expect(d.health().openEpisode?.itemId).toBe(id);
    world.peers.m_laptop.online = true;
    await d.runOnce(); await d.runOnce();
    expect(resolved).toEqual([id]);
  });

  it('a cannot-tell item never strands: re-adopted after a restart and closed when the peer answers, goes offline, or is removed', async () => {
    const prefix = 'agent-identity-cannot-tell:echo:';
    const mk = (world: World, open: Set<string>, resolved: string[]) =>
      detector(world, { openItemIds: (p) => [...open].filter((i) => i.startsWith(p)), resolveItem: (i) => { resolved.push(i); open.delete(i); } });
    // (a) raised before a restart; the peer answers afterwards.
    let open = new Set([`${prefix}m_laptop`]);
    let resolved: string[] = [];
    let world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_laptop: { nick: 'laptop', fp: FP_A, online: true, active: true } } };
    await mk(world, open, resolved).d.runOnce();
    expect(resolved).toEqual([`${prefix}m_laptop`]);
    // (b) the peer goes offline by presence: "online but not answering" is no longer true.
    open = new Set([`${prefix}m_laptop`]); resolved = [];
    world = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_laptop: { nick: 'laptop', fp: null, online: false, active: true } } };
    await mk(world, open, resolved).d.runOnce();
    expect(resolved).toEqual([`${prefix}m_laptop`]);
    // (c) the peer was removed from the registry and never appears in a round again.
    open = new Set([`${prefix}m_gone`]); resolved = [];
    world = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: {} };
    await mk(world, open, resolved).d.runOnce();
    expect(resolved).toEqual([`${prefix}m_gone`]);
    // (d) still online and still silent: the item stays open.
    open = new Set([`${prefix}m_laptop`]); resolved = [];
    world = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_laptop: { nick: 'laptop', fp: null, online: true, active: true } } };
    const still = mk(world, open, resolved);
    await still.d.runOnce(); await still.d.runOnce();
    expect(resolved).toEqual([]);
    expect(still.items).toEqual([]); // and it is not raised a second time
  });

  it('the cannot-tell item is raised by the lease holder only; a machine that becomes the holder later still raises it once', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: false, peers: { m_mini: { nick: 'mini', fp: FP_A, online: true, active: true }, m_laptop: { nick: 'laptop', fp: null, online: true, active: true } } };
    const { d, items, degradations } = detector(world);
    for (let i = 0; i < 12; i++) await d.runOnce();
    expect(items).toEqual([]); // a non-holder never raises
    expect(degradations).toEqual([]);
    expect(d.health().cannotTellRounds).toEqual({ m_laptop: 12 }); // still visible on the health read
    world.holdsLease = true;
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('agent-identity-cannot-tell:echo:m_laptop');
  });

  it('self disk ≠ connectedAs reads disagree and the item says the process still speaks under the old key', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_B, holdsLease: true, peers: { m_mini: { nick: 'mini', fp: FP_A, online: true, active: true } } };
    const { d, items } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items).toHaveLength(1);
    expect(items[0].body).toMatch(/still speaking under the old key/);
    expect(d.health()).toMatchObject({ state: 'disagree', connectedAs: FP_B, selfDisk: FP_A });
  });

  it('a registry nickname is clamped and escaped in items', async () => {
    const world: World = { selfDisk: FP_A, connectedAs: FP_A, holdsLease: true, peers: { m_x: { nick: '<script>alert(1)</script>'.padEnd(120, 'x'), fp: FP_B, online: true, active: true } } };
    const { d, items } = detector(world);
    await d.runOnce(); await d.runOnce();
    expect(items[0].body).not.toContain('<script>');
    expect(items[0].body).toContain('&lt;script&gt;');
  });
});
