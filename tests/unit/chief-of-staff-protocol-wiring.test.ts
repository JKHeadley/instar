/**
 * Wiring-integrity for the Chief of Staff action protocol (docs/specs/chief-of-staff-topic.md §2.4).
 * A protocol whose wiring is silently dropped passes its unit tests but fails HERE:
 *  1. SOURCE — server.ts constructs the protocol behind the dev gate with the REAL seams (lease,
 *     ownership, identity sign/verify, journal + peer streams, run registry, conversation lock,
 *     mesh route), registers both mesh handlers, and feeds the stand-down read to the Reconciler,
 *     the resume drainer and the heartbeat; MeshRpc carries both verbs in the union + RBAC class;
 *     the dev-gate registry has the entry; the config type has the block.
 *  2. DARKNESS — nothing in src/ calls `claim(` on the protocol yet (the loop is PR 3).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('Chief of Staff protocol wiring — 1. SOURCE assertions', () => {
  const server = read('src/commands/server.ts');
  it('constructs the protocol behind the dev gate with real seams', () => {
    expect(server).toContain("resolveDevAgentGate(liveConfig.get<boolean | undefined>('chiefOfStaff.enabled', undefined), config)");
    expect(server).toContain('new cosMod.ChiefOfStaffActionProtocol({');
    for (const seam of ['cosLease.currentHolder()', 'cosLease.freshRenewalWithin(m, ms)', 'sessionOwnershipRegistry?.ownerOf(String(t))', 'idMod.sign(c, localSigningKeyPem)', 'meshIdMgr.getSigningPublicKeyPem(machineId)', 'cosJournal.awaitDurableSeq(', 'cosPeerStreams.loadAllOriginRecords(', 'cosRunStore.findByIdempotencyKey(key)', 'cosRunStore.blockingStateForTopic(', 'sessionManager.withConversationLock(lockRef(conversationKey), fn)', 'meshClient.send({ machineId, url }, command as']) {
      expect(server, seam).toContain(seam);
    }
  });
  it('registers both mesh handlers and refuses when the protocol is not wired', () => {
    expect(server).toContain("'cos-action': async (cmd) => {");
    expect(server).toContain("'cos-settle': async (cmd) => {");
    expect(server).toContain("if (!_cosProtocol) return { outcome: 'disabled', reason: 'cos-disabled' };");
  });
  it('feeds the stand-down read to the Reconciler, the resume drainer and the heartbeat', () => {
    expect((server.match(/cosStandDown: \(topicId\) => _cosStandDownFor\(topicId\)/g) ?? []).length).toBe(2);
    expect(server).toContain("cosSuppress: (topicId) => {");
    expect(server).toContain("'cos-lease-expired'");
  });
  it('MeshRpc carries both verbs in the union and the registered-peer RBAC class', () => {
    const mesh = read('src/core/MeshRpc.ts');
    expect(mesh).toContain("type: 'cos-action';"); expect(mesh).toContain("type: 'cos-settle';");
    expect(mesh).toContain("    case 'cos-action':\n    case 'cos-settle':");
  });
  it('the dev-gate registry and the config type carry the feature', () => {
    const entry = DEV_GATED_FEATURES.find((f) => f.name === 'chiefOfStaff');
    expect(entry?.configPath).toBe('chiefOfStaff.enabled');
    expect(entry?.justification).toMatch(/action protocol/);
    expect(read('src/core/types.ts')).toContain('chiefOfStaff?: {');
    expect(read('src/core/AutonomousRunStore.ts')).toContain('cosNoRespawn?: boolean;');
  });
});

describe('Chief of Staff protocol wiring — 2. SOLE CLAIMER (only the check-in loop claims an action)', () => {
  it('the loop is the only runtime call site that claims an action', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const offenders = walk(path.join(ROOT, 'src')).filter((f) => !f.endsWith('ChiefOfStaffActionProtocol.ts') && /_cosProtocol\??\.claim\(|protocol\.claim\(\{ conversationKey/.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.basename(f))).toEqual(['ChiefOfStaffLoop.ts']);
  });
});
