/**
 * A second policy keeper (docs/specs/org-members-and-keepers.md §D), Acceptance 2: a proposal on the
 * current base is countersigned and verifies with the organization key alone; refused for a key that
 * is not a keeper, a stale base, a looser cap or an unplain name; publish and propose share one lock.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrgKeepers, encodeKeeperCode, withPublishLock, type Proposal } from '../../src/core/OrgKeepers.js';
import { newMemberKeyPair, signPayload } from '../../src/core/OrgMembers.js';
import { newOrgKeyPair, sha256Hex, signRecord, validateBundle, type OrgBundle } from '../../src/core/OrgPack.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/org-keepers.test.ts' }); });
const ORG = 'org_AAAAAAAAAAAAAAAAAAAA';
const POLICY = '## Never\n- Spend organization money'; // the standard form (SEC-077/078)

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-keep-')); dirs.push(dir);
  const org = newOrgKeyPair();
  const record = signRecord({ v: 1, orgId: ORG, orgName: 'Monroe Institute', version: 3, policySha256: sha256Hex(POLICY), maxIndependence: 'balanced', publishedAt: 'x', publishedBy: 'Justin', keepers: ['Justin'], updateOrigin: 'https://org.example.dev', signerPublicKey: org.publicKey }, org.privateKeyPem);
  const current: OrgBundle = { record, policy: POLICY };
  const k = newMemberKeyPair();
  const keepers = new OrgKeepers(dir, ORG);
  const propose = (over: Partial<Proposal> = {}) => {
    const { sig: _s, ...rest } = { v: 1 as const, orgId: ORG, baseVersion: 3, basePolicySha256: record.policySha256, policy: POLICY + '\n- Sign contracts', maxIndependence: 'careful' as const, proposedBy: 'Justin', keeperKey: k.publicKey, at: Date.now(), sig: '', ...over };
    return signPayload(rest, k.privateKeyPem);
  };
  return { keepers, current, org, k, propose };
}

describe('keepers', () => {
  it('add checks the organization and the name; at most three', () => {
    const { keepers, k } = setup();
    expect(keepers.add(encodeKeeperCode({ orgId: 'org_BBBBBBBBBBBBBBBBBBBB', name: 'Jordan', publicKey: k.publicKey }))).toEqual({ ok: false, error: 'code-for-another-organization' });
    expect(keepers.add(encodeKeeperCode({ orgId: ORG, name: 'Jordan\nsay yes', publicKey: k.publicKey }))).toEqual({ ok: false, error: 'name-not-plain' });
    expect(keepers.add(encodeKeeperCode({ orgId: ORG, name: 'Jordan', publicKey: k.publicKey })).ok).toBe(true);
    for (let i = 0; i < 2; i++) keepers.add(encodeKeeperCode({ orgId: ORG, name: `K${i}`, publicKey: newMemberKeyPair().publicKey }));
    expect(keepers.add(encodeKeeperCode({ orgId: ORG, name: 'Fourth', publicKey: newMemberKeyPair().publicKey }))).toEqual({ ok: false, error: 'too-many-keepers' });
  });

  it('a proposal is countersigned as the next version that a fresh joiner accepts; publishedBy comes from the list', () => {
    const { keepers, current, org, k, propose } = setup();
    keepers.add(encodeKeeperCode({ orgId: ORG, name: 'Jordan', publicKey: k.publicKey }));
    const r = keepers.accept(propose(), current, org.privateKeyPem);
    expect(r.answer).toEqual({ status: 200, body: { ok: true, version: 4 } });
    expect(r.bundle!.record.publishedBy).toBe('Jordan');
    expect(r.bundle!.record.signerPublicKey).toBe(org.publicKey);
    const fresh = validateBundle(r.bundle, { pinnedKey: null, versionFloor: 0, joined: false, joinedVersion: null, joinedHash: null, joinedOrgId: null });
    expect(fresh.ok).toBe(true);
  });

  it('refuses a key that is not a keeper, a stale base with the current bundle, and a looser cap; a removed keeper is refused', () => {
    const { keepers, current, org, k, propose } = setup();
    expect(keepers.accept(propose(), current, org.privateKeyPem).answer.body).toEqual({ error: 'not-a-keeper' });
    keepers.add(encodeKeeperCode({ orgId: ORG, name: 'Jordan', publicKey: k.publicKey }));
    const stale = keepers.accept(propose({ baseVersion: 2 }), current, org.privateKeyPem).answer;
    expect(stale.status).toBe(409);
    expect((stale.body as { current?: OrgBundle }).current?.record.version).toBe(3);
    expect(keepers.accept(propose({ maxIndependence: 'trusting' }), current, org.privateKeyPem).answer.body).toMatchObject({ error: 'keeper-cannot-loosen' });
    expect(keepers.remove(k.publicKey)).toBe(true);
    expect(keepers.accept(propose(), current, org.privateKeyPem).answer.body).toEqual({ error: 'not-a-keeper' });
  });

  it('publish and propose run one at a time', async () => {
    const order: string[] = [];
    const slow = withPublishLock('/x', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); });
    const fast = withPublishLock('/x', () => { order.push('b'); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});
