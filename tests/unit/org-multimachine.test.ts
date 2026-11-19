/**
 * Multi-machine organization state (docs/specs/org-members-and-keepers.md §Multi-machine, CMT-1873):
 * a member's own state copies to a peer and a stale copy is refused; forwarded operations run only on
 * the machine that holds the organization key.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrgMemberSide } from '../../src/core/OrgMemberSide.js';
import { createOrgPackRouter, handleOrgForward, holdsOrgKey, markPublishedElsewhere, publishedPaths } from '../../src/server/orgPackRoutes.js';
import { OrgMembers, newMemberKeyPair, signPayload } from '../../src/core/OrgMembers.js';
import { newOrgKeyPair, sha256Hex, signRecord } from '../../src/core/OrgPack.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/org-multimachine.test.ts' }); });
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'org-mm-')); dirs.push(d); return d; };
const ORG = 'org_AAAAAAAAAAAAAAAAAAAA';

function publish(dir: string): { orgKey: ReturnType<typeof newOrgKeyPair> } {
  const k = newOrgKeyPair();
  const policy = '## Never\n- Spend organization money\n';
  const record = signRecord({ v: 1, orgId: ORG, orgName: 'Org', version: 1, policySha256: sha256Hex(policy), maxIndependence: 'balanced', publishedAt: 'x', publishedBy: 'A', keepers: [], updateOrigin: 'https://org.example.dev', signerPublicKey: k.publicKey }, k.privateKeyPem);
  const p = publishedPaths(dir);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.current, JSON.stringify({ bundle: { record, policy }, shareUpdates: true }));
  fs.writeFileSync(p.key(ORG), k.privateKeyPem);
  return { orgKey: k };
}

describe('member side across machines', () => {
  it('copies to a peer once; an older copy is refused; the key never changes', () => {
    const a = tmp(); const b = tmp();
    const sideA = new OrgMemberSide(a, ORG);
    sideA.onJoin({ inviteToken: 'tok-1234567890', afterLeave: false, consent: true });
    const x = sideA.exportForPeer()!;
    expect(new OrgMemberSide(b, ORG).importFromPeer(x)).toBe(true);
    expect(new OrgMemberSide(b, ORG).state()!.publicKey).toBe(sideA.state()!.publicKey);
    // B moves ahead (a check-in); A's older copy no longer applies.
    new OrgMemberSide(b, ORG).body({ agentName: 'W', personName: 'J', appliedVersion: 1, state: 'joined' });
    expect(new OrgMemberSide(b, ORG).importFromPeer(x)).toBe(false);
    // A different key is never taken.
    const other = tmp();
    new OrgMemberSide(other, ORG).onJoin({ afterLeave: false, consent: true });
    expect(new OrgMemberSide(b, ORG).importFromPeer(new OrgMemberSide(other, ORG).exportForPeer()!)).toBe(false);
  });
});

describe('draft placement', () => {
  it('refuses publishing a draft prepared before the publisher marker arrived', async () => {
    const stateDir = tmp();
    const app = express();
    app.use(express.json(), createOrgPackRouter({
      stateDir, machineId: 'peer', updateOrigin: () => null, ownerName: () => 'Jordan',
      effects: () => ({}), principalKind: () => 'device',
    }));
    const policy = { orgName: 'Org', policyMarkdown: '## Never\n- Share donor details\n' };
    const draft = await request(app).post('/org/draft').send(policy);
    expect(draft.status).toBe(200);
    markPublishedElsewhere(stateDir, ORG, 'first-computer');
    const publish = await request(app).post('/mobile/org/publish').send({
      draftId: draft.body.draftId, readBackConfirmed: true,
    });
    expect(publish.status).toBe(409);
    expect(publish.body).toMatchObject({ error: 'org-key-elsewhere', machineId: 'first-computer' });
    expect(fs.existsSync(publishedPaths(stateDir).current)).toBe(false);
    // A keeper proposal still has to obtain a real remote base; an admin draft cannot be made this way.
    const keeper = await request(app).post('/org/draft').send({ ...policy, asKeeper: true });
    expect(keeper.status).toBe(502);
    expect(keeper.body.error).toBe('org-unreachable');
  });
  it('directs a peer with an older unnamed publisher marker back to the publishing computer', async () => {
    const stateDir = tmp();
    markPublishedElsewhere(stateDir, ORG, '');
    const app = express();
    app.use(express.json(), createOrgPackRouter({
      stateDir, machineId: 'peer', updateOrigin: () => null, ownerName: () => 'Jordan',
      effects: () => ({}), principalKind: () => 'bearer',
    }));
    const res = await request(app).post('/org/draft').send({
      orgName: 'Org', policyMarkdown: '## Never\n- Share donor details outside the organization\n',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('org-key-elsewhere');
    expect(res.body.detail).toContain('computer');
    expect(res.body.machineId).toBeUndefined();
    expect(fs.existsSync(publishedPaths(stateDir).drafts)).toBe(false);
  });
});

describe('forwarded operations', () => {
  it('run only where the key is; a check-in lands in the key machine registry', async () => {
    const keyMachine = tmp(); const lease = tmp();
    publish(keyMachine);
    expect(holdsOrgKey(keyMachine)).toBe(true);
    expect(holdsOrgKey(lease)).toBe(false);
    expect((await handleOrgForward(lease, { op: 'members' })).status).toBe(409);
    expect((await handleOrgForward(keyMachine, { op: 'pack-current' })).status).toBe(200);
    const { token } = new OrgMembers(keyMachine, ORG).mintInvite();
    const m = newMemberKeyPair();
    const { sig: _s, ...unsigned } = { v: 1 as const, orgId: ORG, memberKey: m.publicKey, agentName: 'Wren', personName: 'Jordan', appliedVersion: 1, state: 'joined' as const, at: Date.now(), inviteToken: token, sig: '' };
    const r = await handleOrgForward(keyMachine, { op: 'checkin', body: signPayload(unsigned, m.privateKeyPem) });
    expect(r.status).toBe(200);
    const list = await handleOrgForward(keyMachine, { op: 'members', full: true });
    expect((list.body as { members: Array<{ agentName: string }> }).members[0]!.agentName).toBe('Wren');
    expect((list.body as { invitations: unknown[] }).invitations).toHaveLength(1);
  });
});
