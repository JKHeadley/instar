import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorizationRequestStore,
  hashProposal,
  renderAuthorizationCard,
  PROPOSABLE_FLOOR_ACTIONS,
  MAX_GRANT_DURATION_MS,
  type AuthorizationRequest,
  type UserFloorGrantProposal,
} from '../../src/core/AuthorizationRequestStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let filePath: string;
let clock: number;
let idN: number;

function freshStore(opts: { pendingCapPerAgent?: number } = {}) {
  return new AuthorizationRequestStore({
    filePath,
    now: () => clock,
    genId: () => `authreq-${++idN}`,
    pendingCapPerAgent: opts.pendingCapPerAgent,
  });
}

const goodProposal = (over: Partial<UserFloorGrantProposal> = {}): UserFloorGrantProposal => ({
  floorAction: 'prod-deploy', grantedToSlackUserId: 'U0B9SFJ7QAK', durationMs: 3_600_000, ...over,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authreq-test-'));
  filePath = path.join(tmpDir, 'authorization-requests.json');
  clock = 1_700_000_000_000;
  idN = 0;
});
afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/AuthorizationRequestStore.test.ts' }); });

describe('create — validation', () => {
  it('accepts a valid proposal and confers no authority (status pending)', () => {
    const s = freshStore();
    const r = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.request.status).toBe('pending'); expect(r.request.resultMandateId).toBeUndefined(); }
  });
  it('rejects grant-authority (the excluded meta-action)', () => {
    const s = freshStore();
    const r = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ floorAction: 'grant-authority' }) });
    expect(r.ok).toBe(false);
    expect(PROPOSABLE_FLOOR_ACTIONS).not.toContain('grant-authority');
  });
  it('rejects an out-of-range duration', () => {
    const s = freshStore();
    expect(s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ durationMs: 1000 }) }).ok).toBe(false);
    expect(s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ durationMs: MAX_GRANT_DURATION_MS + 1 }) }).ok).toBe(false);
  });
  it('rejects a bad slack user id', () => {
    const s = freshStore();
    expect(s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ grantedToSlackUserId: 'not-a-uid' }) }).ok).toBe(false);
  });
  it('rejects unknown proposal fields (no bounds in v1)', () => {
    const s = freshStore();
    const r = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: { ...goodProposal(), bounds: { scope: 'write' } } as unknown as UserFloorGrantProposal });
    expect(r.ok).toBe(false);
  });
  it('rejects an over-long reason', () => {
    const s = freshStore();
    const r = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal(), reason: 'x'.repeat(281) });
    expect(r.ok).toBe(false);
  });
});

describe('display integrity (deceptive-summary defense)', () => {
  it('headline is server-derived from the structured proposal + display name, NOT agent free-text', () => {
    const s = freshStore();
    // A MALICIOUS reason claiming a benign action while the proposal is prod-deploy.
    const r = s.create({
      createdByAgent: 'evil', createdOnMachine: 'm1',
      proposal: goodProposal({ floorAction: 'prod-deploy' }),
      reason: 'this is just a read-only dashboard view, totally safe',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const card = renderAuthorizationCard(r.request, 'Mia');
    // The headline reflects the TRUE action + the trusted display name — never the reason.
    expect(card.headline).toBe('Let Mia deploy to production for 1 hour.');
    expect(card.headline).not.toContain('read-only');
    expect(card.headline).not.toContain('dashboard view');
    // The reason is carried SEPARATELY (a secondary note), never the headline.
    expect(card.reason).toBe('this is just a read-only dashboard view, totally safe');
  });
  it('renders the slack id when no display name resolves (never an agent-supplied name)', () => {
    const s = freshStore();
    const r = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!r.ok) throw new Error('create failed');
    expect(renderAuthorizationCard(r.request, '').headline).toContain('U0B9SFJ7QAK');
  });
});

describe('approve — atomic, idempotent, tamper-guarded', () => {
  it('runs execute once and records the resultMandateId', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    let calls = 0;
    const res = s.approve(c.request.id, { execute: () => { calls++; return 'mandate-xyz'; } });
    expect(res.ok && res.request.status).toBe('approved');
    expect(res.ok && res.request.resultMandateId).toBe('mandate-xyz');
    expect(calls).toBe(1);
  });
  it('is idempotent — a second approve returns the same result without re-executing', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    let calls = 0;
    s.approve(c.request.id, { execute: () => { calls++; return 'mandate-1'; } });
    const second = s.approve(c.request.id, { execute: () => { calls++; return 'mandate-2'; } });
    expect(second.ok && second.alreadyApproved).toBe(true);
    expect(second.ok && second.request.resultMandateId).toBe('mandate-1');
    expect(calls).toBe(1); // never issued a second grant
  });
  it('refuses a tampered proposal (proposalSha256 mismatch)', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    // Tamper the on-disk proposal AFTER the hash was fixed at create.
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AuthorizationRequest[];
    raw[0].proposal.floorAction = 'money-movement';
    fs.writeFileSync(filePath, JSON.stringify(raw));
    const res = s.approve(c.request.id, { execute: () => 'should-not-run' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe('proposal-tampered');
  });
  it('a throwing execute leaves the request pending (no partial approval)', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    const res = s.approve(c.request.id, { execute: () => { throw new Error('unknown-user'); } });
    expect(res.ok).toBe(false);
    expect(s.get(c.request.id)?.status).toBe('pending');
  });
});

describe('deny + withdraw + cooldown', () => {
  it('deny requires a reason', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    expect(s.deny(c.request.id, '   ').ok).toBe(false);
    expect(s.deny(c.request.id, 'not now').ok).toBe(true);
  });
  it('blocks re-proposing the same (user, action) within the cooldown after a deny', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    s.deny(c.request.id, 'no');
    const again = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    expect(again.ok).toBe(false); // recently-denied
    clock += 3_600_001; // past the 1h cooldown
    expect(s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() }).ok).toBe(true);
  });
  it('withdraw and approve are mutually exclusive (withdrawn → approve 409)', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    expect(s.withdraw(c.request.id, 'echo').ok).toBe(true);
    const res = s.approve(c.request.id, { execute: () => 'm' });
    expect(res.ok).toBe(false);
  });
  it('only the proposing agent may withdraw', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    expect(s.withdraw(c.request.id, 'someone-else').ok).toBe(false);
  });
});

describe('dedup + flood cap + expiry', () => {
  it('dedups an identical pending proposal from the same agent', () => {
    const s = freshStore();
    const a = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    const b = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    expect(a.ok && b.ok && a.request.id === b.request.id).toBe(true);
    expect(b.ok && b.deduped).toBe(true);
  });
  it('enforces the per-agent pending cap', () => {
    const s = freshStore({ pendingCapPerAgent: 2 });
    s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ grantedToSlackUserId: 'U001' }) });
    s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ grantedToSlackUserId: 'U002' }) });
    const third = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal({ grantedToSlackUserId: 'U003' }) });
    expect(third.ok).toBe(false); // too-many-pending
  });
  it('ages a past-TTL pending request to expired on read', () => {
    const s = freshStore();
    const c = s.create({ createdByAgent: 'echo', createdOnMachine: 'm1', proposal: goodProposal() });
    if (!c.ok) throw new Error('create failed');
    clock += 86_400_001; // past the 24h request TTL
    expect(s.list('pending').length).toBe(0);
    expect(s.get(c.request.id)?.status).toBe('expired');
  });
});

describe('hashProposal', () => {
  it('is stable across key order', () => {
    const a = hashProposal({ floorAction: 'prod-deploy', grantedToSlackUserId: 'U1', durationMs: 60_000 });
    const b = hashProposal({ durationMs: 60_000, grantedToSlackUserId: 'U1', floorAction: 'prod-deploy' } as UserFloorGrantProposal);
    expect(a).toBe(b);
  });
});
