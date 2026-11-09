/**
 * Unit tests for the phone's native Permission slips and What I'm allowed to do
 * (docs/specs/mobile-native-permissions.md): the action line and signed bytes, the action-bound
 * challenge store, the read summarizers (field allow-list, caps, peers), the actions state, the
 * dev gate, and the device allowlist rules.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  actionLine, buildAction, permissionPresenceMessage, reasonHash, ActionChallengeStore, isPermissionActionsEnabled,
  summarizeSlips, summarizeLocalSlips, summarizePeerFeatures, featureRow, approvalRow, slipRow,
  MAX_APPROVAL_ROWS, PERMISSION_ACTION_VERSION, OFF_WARNINGS, NO_DISCLOSURE, consentDisclosure, expectedDisclosure, type LocalSlips,
} from '../../src/server/mobilePermissionsRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { PRESENCE_MESSAGE_VERSION, PRESENCE_ENROLL_VERSION } from '../../src/server/mobileConsoleTicket.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const HASH = 'a'.repeat(64);

describe('the action line and the signed bytes', () => {
  it('names exactly one action and its target', () => {
    expect(actionLine({ kind: 'approve-request', target: 'authreq-1', proposalHash: HASH })).toBe(`approve-request authreq-1 ${HASH}`);
    expect(actionLine({ kind: 'set-feature', target: 'cloudflare-tunnel', value: 'disabled', disclosureHash: 'none' })).toBe('set-feature cloudflare-tunnel disabled none');
    const reason = '  not now  ';
    expect(actionLine({ kind: 'decline-request', target: 'authreq-1', reason })).toBe(`decline-request authreq-1 ${crypto.createHash('sha256').update(Buffer.from(reason, 'utf8')).digest('hex')}`);
  });
  it('hashes the reason bytes exactly as sent (no trimming), so phone and server agree', () => {
    expect(reasonHash(' a')).not.toBe(reasonHash('a'));
    expect(reasonHash('é')).toBe(crypto.createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
  });
  it('signs under its own version, never the console ticket\'s or the enrolment\'s', () => {
    const m = permissionPresenceMessage('dev-1', 'Echo.Example.dev', 'c'.repeat(43), 'approve-request x y');
    expect(m).toBe(`${PERMISSION_ACTION_VERSION}\ndev-1\necho.example.dev\n${'c'.repeat(43)}\napprove-request x y`);
    expect(PERMISSION_ACTION_VERSION).not.toBe(PRESENCE_MESSAGE_VERSION);
    expect(PERMISSION_ACTION_VERSION).not.toBe(PRESENCE_ENROLL_VERSION);
  });
  it('builds only well-formed actions', () => {
    expect(buildAction('approve-request', 'authreq-1', { proposalHash: HASH }).ok).toBe(true);
    expect(buildAction('approve-request', 'authreq-1', {})).toEqual({ ok: false, error: 'bad-proposal-hash' });
    expect(buildAction('approve-request', 'authreq-1', { proposalHash: 'A'.repeat(64) })).toEqual({ ok: false, error: 'bad-proposal-hash' });
    expect(buildAction('approve-request', 'a/b', { proposalHash: HASH })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('approve-request', 'x'.repeat(129), { proposalHash: HASH })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('decline-request', 'authreq-1', { reason: '   ' })).toEqual({ ok: false, error: 'reason-required' });
    expect(buildAction('decline-request', 'authreq-1', { reason: 'x'.repeat(501) })).toEqual({ ok: false, error: 'reason-too-long' });
    expect(buildAction('decline-request', 'authreq-1', { reason: 'x'.repeat(500) }).ok).toBe(true);
    expect(buildAction('set-feature', 'git-backup', { value: 'on' })).toEqual({ ok: false, error: 'bad-value' });
    expect(buildAction('set-feature', 'git-backup', { value: 'enabled' })).toEqual({ ok: true, action: { kind: 'set-feature', target: 'git-backup', value: 'enabled', disclosureHash: 'none' } });
    expect(buildAction('set-feature', 'git-backup', { value: 'enabled', disclosureHash: 'zz' })).toEqual({ ok: false, error: 'bad-disclosure-hash' });
    expect(buildAction('set-feature', 'Git-Backup', { value: 'enabled' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('revoke-slip', 'm-1', {})).toEqual({ ok: false, error: 'bad-action' });
  });
});

describe('ActionChallengeStore', () => {
  const line = `approve-request authreq-1 ${HASH}`;
  it('is single use, bound to device, Host and line, and expires', () => {
    let t = NOW;
    const s = new ActionChallengeStore(() => t);
    const a = s.issue('dev-1', 'Host.dev', line);
    expect(s.consume(a.secret, 'dev-1', 'host.dev', line)).toBe(true);
    expect(s.consume(a.secret, 'dev-1', 'host.dev', line)).toBe(false); // replay
    const wrongs: Array<[string, string, string]> = [['dev-2', 'host.dev', line], ['dev-1', 'other.dev', line], ['dev-1', 'host.dev', `decline-request authreq-1 ${HASH}`], ['dev-1', 'host.dev', `approve-request authreq-2 ${HASH}`]];
    for (const [d, h, l] of wrongs) {
      const c = s.issue('dev-1', 'host.dev', line);
      expect(s.consume(c.secret, d, h, l), `${d} ${h} ${l}`).toBe(false);
      expect(s.consume(c.secret, 'dev-1', 'host.dev', line), 'consumed by the wrong attempt').toBe(false);
    }
    const e = s.issue('dev-1', 'host.dev', line);
    t += 60_000;
    expect(s.consume(e.secret, 'dev-1', 'host.dev', line)).toBe(false);
    expect(s.consume('not-a-secret', 'dev-1', 'host.dev', line)).toBe(false);
  });
  it('keeps at most 4 per device and 64 in total', () => {
    const s = new ActionChallengeStore(() => NOW);
    const first = s.issue('dev-1', 'h', line);
    for (let i = 0; i < 4; i++) s.issue('dev-1', 'h', line);
    expect(s.consume(first.secret, 'dev-1', 'h', line)).toBe(false);
    for (let i = 0; i < 100; i++) s.issue(`dev-${i + 2}`, 'h', line);
    expect(s.size()).toBe(64);
  });
});

describe('the dev gate', () => {
  it('is live on a development agent, dark on the fleet, and an explicit value wins', () => {
    expect(isPermissionActionsEnabled({ developmentAgent: true } as never)).toBe(true);
    expect(isPermissionActionsEnabled({} as never)).toBe(false);
    expect(isPermissionActionsEnabled({ mobilePairing: { permissionActions: { enabled: true } } } as never)).toBe(true);
    expect(isPermissionActionsEnabled({ developmentAgent: true, mobilePairing: { permissionActions: { enabled: false } } } as never)).toBe(false);
  });
  it('is registered in DEV_GATED_FEATURES with a justification', () => {
    const e = DEV_GATED_FEATURES.find((f) => f.configPath === 'mobilePairing.permissionActions.enabled');
    expect(e?.name).toBe('mobilePairingPermissionActions');
    expect(e!.justification.length).toBeGreaterThan(100);
  });
});

const personName = (uid: string) => (uid === 'U0SAM' ? 'Sam' : null);
const localApproval = (over: Record<string, unknown> = {}) => ({
  id: 'authreq-1', createdByAgent: 'echo', createdAt: at(-5), requestExpiresAt: at(60), headline: 'Let Sam deploy to production for 1 hour.',
  reason: 'release 1.3', heldOnThisMachine: true, proposalHash: HASH, recipientKnown: true, ...over,
});
const mandate = (over: Record<string, unknown> = {}) => ({
  id: 'm-1', scope: 'user-authority-grant', agents: ['fp-aaaa', 'fp-aaaa'], authorities: [], author: 'system', createdAt: at(-10), expiresAt: at(50),
  revoked: null, authProof: 'proof-xyz', grants: [{ floorAction: 'prod-deploy', grantedTo: 'U0SAM', authorizedBy: 'operator', expiresAt: at(50) }], ...over,
});
const local = (over: Partial<LocalSlips> = {}): LocalSlips => ({
  approvals: { state: 'ok', rows: [localApproval()] },
  slips: { state: 'ok', mandates: [mandate(), mandate({ id: 'm-2', revoked: { at: at(-1), reason: 'x' } }), mandate({ id: 'm-3', expiresAt: at(-1) })], invalidIds: [] },
  ...over,
});
const opts = { now: NOW, personName, nicknameOf: (id: string) => (id === 'm_peer' ? 'Mac Mini' : null), offlineMachineIds: [] as string[] };

describe('summarizeSlips', () => {
  it('lists approvals and active slips in words, with no fingerprints, Slack ids or proofs', () => {
    const s = summarizeSlips(local(), [], opts) as any;
    expect(s.approvals).toMatchObject({ state: 'ok', total: 1, truncated: false });
    expect(s.approvals.rows[0]).toMatchObject({ id: 'authreq-1', proposalHash: HASH, headline: 'Let Sam deploy to production for 1 hour.', reason: 'release 1.3', agent: 'echo', here: true, machine: null });
    expect(s.slips).toMatchObject({ state: 'ok', total: 1, endedCount: 2 });
    expect(s.slips.active[0]).toMatchObject({ title: 'A person may act', invalid: false });
    expect(s.slips.active[0].summary).toBe('Sam may deploy to production');
    const text = JSON.stringify(s);
    for (const leak of ['fp-aaaa', 'U0SAM', 'proof-xyz', 'authorizedBy', '"m-1"']) expect(text, leak).not.toContain(leak);
  });
  it('withholds the approve hash when the request is not held here or its person is not a registered name', () => {
    expect(approvalRow(localApproval({ heldOnThisMachine: false }), { local: true, machine: null })).toMatchObject({ here: false, proposalHash: null, machine: 'another machine' });
    expect(approvalRow(localApproval({ recipientKnown: false }), { local: true, machine: null })).toMatchObject({ here: true, proposalHash: null });
    expect(approvalRow(localApproval({ proposalHash: 'nothex' }), { local: true, machine: null })!.proposalHash).toBeNull();
  });
  it('marks an invalid signature on a slip and says "a person" for an unknown grantee', () => {
    const s = slipRow(mandate({ grants: [{ floorAction: 'odd-action', grantedTo: 'U0OTHER', authorizedBy: 'operator', expiresAt: at(30) }] }), { now: NOW, invalid: true, machine: null, personName });
    expect(s).toMatchObject({ invalid: true });
    expect(s!.summary).toBe('A person may take an action');
    expect(s!.summary).not.toContain('U0OTHER');
  });
  it('keeps the soonest-expiring rows when capped and reports the full total', () => {
    const rows = Array.from({ length: MAX_APPROVAL_ROWS + 5 }, (_, i) => localApproval({ id: `authreq-${i}`, requestExpiresAt: at(1000 - i) }));
    const s = summarizeSlips(local({ approvals: { state: 'ok', rows } }), [], opts) as any;
    expect(s.approvals.rows).toHaveLength(MAX_APPROVAL_ROWS);
    expect(s.approvals.total).toBe(MAX_APPROVAL_ROWS + 5);
    expect(s.approvals.truncated).toBe(true);
    expect(s.approvals.rows.map((r: any) => r.id)).not.toContain('authreq-0'); // expires last
    expect(s.approvals.rows[0].id).toBe(`authreq-${MAX_APPROVAL_ROWS + 4}`);
  });
  it('reads peers read-only, names them, counts their uncapped totals, and names unread and can\'t-tell machines', () => {
    const peerLocal = summarizeLocalSlips(local(), { now: NOW, personName });
    const s = summarizeSlips(local({ approvals: { state: 'ok', rows: [] } }), [
      { machineId: 'm_peer', state: 'ok', data: { ...peerLocal, approvals: { ...(peerLocal as any).approvals, total: 3 } } },
      { machineId: 'm_gone', state: 'unreached' },
      { machineId: 'm_sick', state: 'ok', data: { approvals: { state: 'unavailable' }, slips: { state: 'ok', active: [] } } },
    ], opts) as any;
    expect(s.approvals.rows).toHaveLength(1);
    expect(s.approvals.rows[0]).toMatchObject({ id: 'authreq-1', here: false, proposalHash: null, machine: 'Mac Mini' });
    expect(s.approvals.total).toBe(3);
    expect(s.approvals.truncated).toBe(true);
    expect(s.slips.active.find((x: any) => x.machine === 'Mac Mini')).toBeTruthy();
    expect(s.unread).toEqual({ count: 1, names: ['another machine'] });
    expect(s.cantTell).toEqual({ count: 1, names: ['another machine'] });
  });
  it('a peer answer never carries rows held elsewhere, and its holder\'s row wins over a local copy', () => {
    const peerLocal = summarizeLocalSlips(local({ approvals: { state: 'ok', rows: [localApproval(), localApproval({ id: 'authreq-9', heldOnThisMachine: false })] } }), { now: NOW, personName }) as any;
    expect(peerLocal.approvals.rows.map((r: any) => r.id)).toEqual(['authreq-1']);
    const s = summarizeSlips(local({ approvals: { state: 'ok', rows: [localApproval({ heldOnThisMachine: false })] } }), [{ machineId: 'm_peer', state: 'ok', data: peerLocal }], opts) as any;
    expect(s.approvals.rows).toHaveLength(1);
    expect(s.approvals.rows[0].machine).toBe('Mac Mini');
  });
  it('says off or unavailable instead of "nothing waiting"', () => {
    const s = summarizeSlips({ approvals: { state: 'off', rows: [] }, slips: { state: 'unavailable', mandates: [], invalidIds: [] } }, [], opts) as any;
    expect(s.approvals.state).toBe('off');
    expect(s.slips.state).toBe('unavailable');
  });
});

describe('featureRow', () => {
  const f = (over: Record<string, unknown> = {}, state = 'enabled', effective: unknown = { status: 'on', summary: 'On.' }) => ({
    definition: { id: 'git-backup', name: 'Git backup', oneLiner: 'Back up state to git.', switchable: true, configPath: 'gitBackup.enabled', enableAction: { method: 'PATCH', path: '/x' }, dataImplications: [{ dataType: 'secret' }], ...over },
    state: { discoveryState: state, consentRecordId: 'c-1' }, effective,
  });
  it('flattens as the console does and returns no config paths, actions or consent data', () => {
    const r = featureRow(f())!;
    expect(r).toEqual({ id: 'git-backup', name: 'Git backup', oneLiner: 'Back up state to git.', on: true, stateWords: 'On.', switchable: true, readOnlyReason: null, notice: false, offWarning: null, consent: null });
    const text = JSON.stringify(r);
    for (const leak of ['gitBackup', '/x', 'secret', 'c-1']) expect(text).not.toContain(leak);
  });
  it('read-only switches carry their reason; a mismatch carries a notice; the tunnel and guards warn', () => {
    expect(featureRow(f({ switchable: false, honestyNote: 'Ignored in this version.' }, 'disabled', { status: 'on' }))).toMatchObject({ switchable: false, on: true, readOnlyReason: 'Ignored in this version.' });
    expect(featureRow(f({}, 'enabled', { status: 'on-after-restart', summary: 'On after a restart.' }))).toMatchObject({ notice: true });
    expect(featureRow(f({}, 'disabled', null))).toMatchObject({ on: false, stateWords: 'Off' });
    expect(featureRow(f({ id: 'cloudflare-tunnel' }))!.offWarning).toBe(OFF_WARNINGS['cloudflare-tunnel']);
    expect(featureRow(f({ id: 'bad id' }))).toBeNull();
  });
  it('a consent-tier switch carries the console\'s disclosure and the hash a turn-on must sign', () => {
    const def = { id: 'threadline-relay', consentTier: 'network', fullDescription: 'Joins the agent network.', dataImplications: [{ dataType: 'messages', description: 'Messages you send to other agents', destination: 'relay.example' }, { dataType: 'id', description: 'Agent identity', destination: 'local' }], reversibilityNote: 'Turn it off any time.' };
    const r = featureRow({ definition: { ...def, name: 'Agent network', switchable: true }, state: { discoveryState: 'disabled' }, effective: { status: 'off' } })!;
    expect(r.consent).toMatchObject({ tier: 'network', description: 'Joins the agent network.', howToUndo: 'Turn it off any time.', data: [{ text: 'Messages you send to other agents', goesTo: 'relay.example' }, { text: 'Agent identity', goesTo: null }] });
    expect(r.consent!.disclosureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedDisclosure(def, 'enabled')).toBe(r.consent!.disclosureHash);
    expect(expectedDisclosure(def, 'disabled')).toBe(NO_DISCLOSURE);
    expect(expectedDisclosure({ ...def, consentTier: 'informational' }, 'enabled')).toBe(NO_DISCLOSURE);
    // Any change to what is disclosed changes the hash.
    expect(consentDisclosure({ ...def, dataImplications: [...def.dataImplications, { description: 'More' }] })!.disclosureHash).not.toBe(r.consent!.disclosureHash);
  });
  it('peer switches are rebuilt through the same allow-list, read-only by machine', () => {
    const p = summarizePeerFeatures([
      { machineId: 'm_peer', state: 'ok', data: { state: 'ok', features: [{ ...featureRow(f({ id: 'cloudflare-tunnel' })), configPath: 'leak.path' }] } },
      { machineId: 'm_gone', state: 'unreached' },
    ], { nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : null), offlineMachineIds: ['m_far'] }) as any;
    expect(p.otherMachines).toHaveLength(1);
    expect(p.otherMachines[0]).toMatchObject({ name: 'Mac Mini', state: 'ok' });
    expect(p.otherMachines[0].features[0]).toMatchObject({ id: 'cloudflare-tunnel', on: true, offWarning: null, consent: null });
    expect(JSON.stringify(p)).not.toContain('leak.path');
    expect(p.unread.count).toBe(1);
    expect(p.offline.count).toBe(1);
  });
});

describe('device allowlist rules', () => {
  const rules = (m: string, p: string) => DEVICE_ALLOWLIST.filter((r) => r.method === m && r.re.test(p));
  it('admits exactly the six routes, owner-only, in their own buckets', () => {
    for (const p of ['/mobile/permissions/slips', '/mobile/permissions/features']) expect(rules('GET', p)[0]).toMatchObject({ ownerOnly: true, body: 'none', bucket: 'permissions-reads', ownBucket: 20 });
    for (const p of ['/mobile/permissions/challenge', '/mobile/permissions/requests/authreq-1/approve', '/mobile/permissions/requests/authreq-1/decline', '/mobile/permissions/features/git-backup']) {
      expect(rules('POST', p), p).toHaveLength(1);
      expect(rules('POST', p)[0]).toMatchObject({ ownerOnly: true, body: 'json', bucket: 'permission-actions', ownBucket: 12 });
    }
  });
  it('admits none of the raw routes and no other shapes', () => {
    for (const [m, p] of [['GET', '/mandate'], ['POST', '/mandate/m-1/revoke'], ['POST', '/mandate/m-1/grants'], ['GET', '/authorization-requests'], ['POST', '/authorization-requests/authreq-1/approve'],
      ['POST', '/authorization-requests/authreq-1/deny'], ['GET', '/features'], ['POST', '/features/git-backup/transition'], ['POST', '/mobile/permissions/requests/authreq-1/withdraw'],
      ['POST', '/mobile/permissions/requests/a/b/approve'], ['GET', '/mobile/permissions/challenge'], ['POST', '/mobile/permissions/slips'], ['DELETE', '/mobile/permissions/features/git-backup']]) {
      expect(DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)), `${m} ${p}`).toBe(false);
    }
  });
});
