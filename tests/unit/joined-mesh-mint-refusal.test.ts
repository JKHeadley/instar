/**
 * The mint refusal — a machine that joined an existing mesh must never invent an agent identity.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §2, acceptance criterion 2.
 *
 * This is the guard that makes the whole fix stick. The handover in §1 can fail for ordinary
 * reasons (an old awake machine, a dropped response); what must NEVER follow from that is a
 * silently minted second identity. So the refusal is tested harder than the happy path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectJoinedMesh } from '../../src/threadline/client/JoinedMeshDetector.js';
import { IdentityManager, IdentityNotProvisionedError } from '../../src/threadline/client/IdentityManager.js';

/** Build a state dir with an optional machine registry + self identity. */
function stateDir(opts: { selfId?: string; registryIds?: string[] } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joined-mesh-'));
  if (opts.selfId) {
    fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'machine', 'identity.json'),
      JSON.stringify({ machineId: opts.selfId, name: 'test' }),
    );
  }
  if (opts.registryIds) {
    fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
    const machines: Record<string, unknown> = {};
    for (const id of opts.registryIds) machines[id] = { name: id, role: 'awake' };
    fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), JSON.stringify({ version: 1, machines }));
  }
  return dir;
}

describe('detectJoinedMesh — the discriminator is an on-disk fact', () => {
  it('JOINED: the registry names a machine other than this one', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    const v = detectJoinedMesh(d);
    expect(v.joined).toBe(true);
    if (v.joined) expect(v.peerMachineCount).toBe(1);
  });

  it('NOT joined: a standalone first machine has no registry at all', () => {
    const v = detectJoinedMesh(stateDir({ selfId: 'm_self' }));
    expect(v.joined).toBe(false);
    if (!v.joined) expect(v.reason).toBe('no-registry');
  });

  it('NOT joined: a registry listing only THIS machine is not a mesh', () => {
    const v = detectJoinedMesh(stateDir({ selfId: 'm_self', registryIds: ['m_self'] }));
    expect(v.joined).toBe(false);
    if (!v.joined) expect(v.reason).toBe('self-only');
  });

  it('fails toward MINTING when the registry is unreadable — never bricks a real agent', () => {
    const d = stateDir({ selfId: 'm_self' });
    fs.mkdirSync(path.join(d, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(d, 'machines', 'registry.json'), '{ not json');
    const v = detectJoinedMesh(d);
    expect(v.joined).toBe(false);
    if (!v.joined) expect(v.reason).toBe('registry-unreadable');
  });

  it('refuses to CONCLUDE joined when the self id is missing — cannot tell self from peer', () => {
    // Without a self id, "the registry lists one machine" is ambiguous: it could be this one.
    // Guessing "joined" there would deny a standalone agent its identity, so it resolves the
    // other way and the divergence detector covers the residual risk.
    const v = detectJoinedMesh(stateDir({ registryIds: ['m_unknown'] }));
    expect(v.joined).toBe(false);
    if (!v.joined) expect(v.reason).toBe('no-machine-id');
  });

  it('an empty registry object is not a mesh', () => {
    const v = detectJoinedMesh(stateDir({ selfId: 'm_self', registryIds: [] }));
    expect(v.joined).toBe(false);
  });
});

describe('IdentityManager.getOrCreate — refuses to mint on a joined machine', () => {
  it('THROWS rather than minting when this home joined a mesh (criterion 2)', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    expect(() => new IdentityManager(d).getOrCreate()).toThrow(IdentityNotProvisionedError);
  });

  it('writes NO identity file when it refuses — a refusal must leave no residue', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    try {
      new IdentityManager(d).getOrCreate();
    } catch { /* expected */ }
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'threadline', 'identity.json'))).toBe(false);
  });

  it('the refusal names the condition and the remedy, not an internal error', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    try {
      new IdentityManager(d).getOrCreate();
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityNotProvisionedError);
      const e = err as IdentityNotProvisionedError;
      expect(e.code).toBe('identity-not-provisioned');
      expect(e.peerMachineCount).toBe(1);
      expect(e.message).toMatch(/re-pair/i);
    }
  });

  it('STILL MINTS for a genuinely standalone first machine — the guard is not a blanket ban', () => {
    const d = stateDir({ selfId: 'm_self' });
    const id = new IdentityManager(d).getOrCreate();
    expect(id.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.existsSync(path.join(d, 'threadline', 'identity.json'))).toBe(true);
  });

  it('LOADS an existing identity on a joined machine — the guard only blocks MINTING', () => {
    // The provisioned case: identity already carried across. The guard must be invisible.
    const d = stateDir({ selfId: 'm_self' });
    const provisioned = new IdentityManager(d).getOrCreate();
    fs.mkdirSync(path.join(d, 'machines'), { recursive: true });
    fs.writeFileSync(
      path.join(d, 'machines', 'registry.json'),
      JSON.stringify({ version: 1, machines: { m_self: {}, m_peer: {} } }),
    );
    const reloaded = new IdentityManager(d).getOrCreate();
    expect(reloaded.fingerprint).toBe(provisioned.fingerprint);
  });
});
