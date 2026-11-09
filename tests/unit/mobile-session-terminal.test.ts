/**
 * Unit tests for the native session screen's server half (docs/specs/mobile-native-session-screen.md):
 * the allowlist entries and their flags, named device buckets, the plain-text filter, exact session
 * resolution, the miss classification, peer row matching, and the durable input replay record.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEVICE_ALLOWLIST, MobilePairingService } from '../../src/server/mobilePairingRoutes.js';
import {
  resolveDeviceSession, isPlainDeviceText, classifyMiss, peerRowsMatch, otherMachineReason, DeviceInputReplayRecord,
  NOT_RUNNING_REASON, LOCATION_UNKNOWN_REASON, appendInputAudit, AUDIT_ROTATE_BYTES, redactForDevice, requestedMachineReason,
} from '../../src/server/mobileSessionTerminalRoutes.js';
import { REPLAY_TTL_MS } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-session-terminal.test.ts' });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-')); dirs.push(d); return d; };

describe('DEVICE_ALLOWLIST: session output and input', () => {
  const out = DEVICE_ALLOWLIST.find((r) => r.method === 'GET' && r.re.test('/sessions/echo-topic-7/output'));
  const inp = DEVICE_ALLOWLIST.find((r) => r.method === 'POST' && r.re.test('/sessions/echo-topic-7/input'));
  it('both exist, owner-only, active devices only, with their own named buckets', () => {
    expect(out).toBeDefined();
    expect(inp).toBeDefined();
    for (const r of [out!, inp!]) {
      expect(r.ownerOnly).toBe(true);
      expect([...r.statuses]).toEqual(['active']);
      expect(r.conversationRef).toBeFalsy();
      expect(r.unassignedOk).toBeFalsy();
    }
    expect(out!.body).toBe('none');
    expect(out!.ownBucket).toBe(90);
    expect(out!.bucket).toBe('session-output');
    expect(inp!.body).toBe('json');
    expect(inp!.ownBucket).toBe(12);
    expect(inp!.bucket).toBe('session-input');
  });
  it('matches only the exact shapes: no other method, no other session route, no traversal', () => {
    for (const p of ['/sessions/a/output/x', '/sessions/../output', '/sessions//output', '/sessions/a%2fb/output', '/sessions/a/kill', '/mobile/sessions/relay/a/output', '/mobile/sessions/relay/a/input', '/mobile/sessions/relay/a/key', '/mobile/sessions/relay/a/state', `/sessions/${'a'.repeat(201)}/output`]) {
      expect(DEVICE_ALLOWLIST.some((r) => r.re.test(p)), p).toBe(false);
    }
    expect(DEVICE_ALLOWLIST.some((r) => r.method !== 'GET' && r.re.test('/sessions/a/output'))).toBe(false);
    expect(DEVICE_ALLOWLIST.some((r) => r.method !== 'POST' && r.re.test('/sessions/a/input'))).toBe(false);
  });
  it('the owner-only rules are exactly this named set (session screen + capacity, ops, plans and people, messages and insights, permissions screens, and Remote Desktop with Face ID)', () => {
    // Each owner-only rule, named by one request it admits. A new owner-only route adds its line here.
    const named: Array<[string, string]> = [
      ['GET', '/sessions/a/output'],
      ['POST', '/sessions/a/input'],
      // Conversations' exact additive owner-only route families. Functional
      // signature/ledger and owner refusal are covered by graph HTTP tests.
      ['GET', '/mobile/conversation-graph/roots'],
      ['GET', '/mobile/conversation-graph/nodes/e30'],
      ['GET', '/mobile/conversation-graph/nodes/e30/destinations'],
      ['GET', '/mobile/conversation-graph/pending'],
      ['GET', '/mobile/conversation-graph/changes/request-1234'],
      ['GET', '/mobile/conversation-graph/erasures/erasev1_12345678'],
      ['POST', '/mobile/conversation-graph/forget-header/discover'],
      ['POST', '/mobile/conversation-graph/forget-header/ensure'],
      ['POST', '/mobile/conversation-graph/changes'],
      ['POST', '/mobile/conversation-graph/preview'],
      ['POST', '/mobile/conversation-graph/undo'],
      ['POST', '/mobile/conversation-graph/forget-header'],
      ['POST', '/mobile/conversation-graph/changes/graph-event:change-12345678/cancel'],
      ['GET', '/mobile/accounts'],
      ['GET', '/mobile/spend'],
      ['GET', '/mobile/resources'],
      ['GET', '/mobile/jobs'],
      ['GET', '/mobile/commitments'],
      ['GET', '/mobile/machines'],
      ['GET', '/mobile/plans'],
      ['GET', '/mobile/learned'],
      ['GET', '/mobile/agents'],
      ['GET', '/mobile/messages'],
      ['GET', '/mobile/insights'],
      ['GET', '/mobile/secrets'],
      ['GET', '/mobile/health-issues'],
      ['GET', '/mobile/ideas'],
      ['GET', '/mobile/pace'],
      ['GET', '/mobile/development'],
      ['GET', '/mobile/maturation'],
      ['GET', '/mobile/files'],
      ['GET', '/mobile/files/read'],
      ['GET', '/mobile/proposals'],
      ['GET', '/mobile/inside'],
      ['GET', '/mobile/permissions/slips'],
      ['GET', '/mobile/permissions/features'],
      ['POST', '/mobile/permissions/challenge'],
      ['POST', '/mobile/permissions/requests/authreq-1/approve'],
      ['POST', '/mobile/permissions/features/git-backup'],
      ['POST', '/mobile/secrets/requests'],
      ['POST', '/mobile/secrets/requests/abcdef0123456789/cancel'],
      ['POST', '/mobile/health-issues/choices'],
      ['POST', '/mobile/health-issues/choices/undo'],
      // Approve a waiting phone with Face ID (mobile-pairing-approve §3.4).
      ['GET', '/mobile/pairing-requests'],
      ['POST', '/mobile/pairing-requests/00000000-0000-4000-8000-000000000000/approve'],
      ['POST', '/sessions/a/key'],
      ['POST', '/sessions/a/attachments'],
      ['GET', '/mobile/sessions/controls'],
      ['GET', '/mobile/sessions/new-options'],
      ['GET', '/mobile/sessions/history'],
      ['POST', '/mobile/sessions/door/134088'],
      ['POST', '/mobile/sessions/move/134088'],
      ['POST', '/mobile/sessions/bring-back/app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'],
      ['POST', '/mobile/sessions/close/a-session-id'],
      ['POST', '/mobile/sessions/new'],
      ['POST', '/mobile/sessions/default'],
      ['POST', '/mobile/attention/tg-1/choice'],
      // Team access: the owner's phone writes, and reads the whole team (team-roles-and-access §4.1).
      ['GET', '/mobile/team/context'],
      ['GET', '/mobile/team/activity'],
      ['GET', '/mobile/team/requests'],
      ['POST', '/mobile/team/requests/abc/decline'],
      ['GET', '/mobile/team/invites/mia'],
      ['POST', '/mobile/team/invites'],
      ['POST', '/mobile/team/grants'],
      ['POST', '/mobile/team/people/mia'],
      ['POST', '/mobile/team/off'],
      ['POST', '/mobile/team/restore'],
      ['POST', '/mobile/team/origin-gone'],
      ['POST', '/mobile/team/memory-privacy'],
      // Add a new agent from a phone you already use (mobile-pairing-introducer §3.2).
      ['GET', '/mobile/introducer'],
      ['POST', '/mobile/introductions/challenge'],
      ['POST', '/mobile/introductions'],
      // Remote Desktop with Face ID and the PIN page (mobile-owner-presence-pin §2.1–2.4).
      ['POST', '/mobile/desktop-unlock/challenge'],
      ['POST', '/mobile/desktop-unlock'],
      ['POST', '/mobile/dashboard-pin/challenge'],
      ['POST', '/mobile/dashboard-pin/reveal'],
      // The desktop calls the app makes after a Face ID unlock (§2.2).
      ['GET', '/desktop/targets'],
      ['GET', '/desktop/setup'],
      ['GET', '/desktop/setup/m_0123abcd'],
      ['POST', '/desktop/setup/m_0123abcd'],
      ['POST', '/desktop/requests'],
      ['GET', '/desktop/requests/00000000-0000-4000-8000-000000000000'],
      ['GET', '/desktop/requests/00000000-0000-4000-8000-000000000000/cursor'],
      ['POST', '/desktop/requests/00000000-0000-4000-8000-000000000000/ticket'],
    ];
    const ownerOnly = DEVICE_ALLOWLIST.filter((r) => r.ownerOnly);
    for (const [method, p] of named) expect(ownerOnly.filter((r) => r.method === method && r.re.test(p)), `${method} ${p}`).toHaveLength(1);
    for (const r of ownerOnly) expect(named.some(([method, p]) => r.method === method && r.re.test(p)), `${r.method} ${r.re}`).toBe(true);
  });
});

describe('named device buckets', () => {
  const svc = () => {
    const dir = tmp();
    const s = new MobilePairingService({ config: { projectName: 'x', stateDir: dir, authToken: 't', developmentAgent: true } as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm' });
    services.push(s);
    return s;
  };
  it('each named bucket counts separately; the default bucket keeps its old key', () => {
    const s = svc();
    for (let i = 0; i < 12; i++) expect(s.deviceBucketOk('d1', 12, 'session-input')).toBe(true);
    expect(s.deviceBucketOk('d1', 12, 'session-input')).toBe(false);
    expect(s.deviceBucketOk('d1', 90, 'session-output')).toBe(true);
    expect(s.deviceBucketOk('d1', 240)).toBe(true);
    expect(s.deviceBucketOk('d2', 12, 'session-input')).toBe(true);
  });
  it('emptied windows are dropped once the map grows', () => {
    const s = svc();
    let t = 1_000_000;
    (s as unknown as { now: () => number }).now = () => t;
    for (let i = 0; i < 70; i++) s.deviceBucketOk(`dev-${i}`, 5, 'session-input');
    t += 61_000;
    s.deviceBucketOk('fresh', 5, 'session-input');
    const map = (s as unknown as { deviceBucket: Map<string, number[]> }).deviceBucket;
    expect(map.size).toBe(1);
  });
});

describe('isPlainDeviceText', () => {
  it('allows text, newline and tab; refuses other C0, DEL and C1 controls', () => {
    expect(isPlainDeviceText('hello\nworld\tok — é 日本')).toBe(true);
    for (const c of ['\x1b', '\x03', '\x04', '\r', '\x00', '\x7f', '\x9b', '\x1b[201~']) expect(isPlainDeviceText(`a${c}b`), JSON.stringify(c)).toBe(false);
  });
});

describe('resolveDeviceSession', () => {
  const rec = (id: string, name: string, tmux: string, status = 'running') => ({ id, name, tmuxSession: tmux, status });
  it('matches exactly in the order tmux name, id, name', () => {
    const rows = [rec('s-1', 'alpha', 'echo-1'), rec('echo-1x', 'beta', 'echo-2')];
    expect(resolveDeviceSession(rows, 'echo-1')).toEqual({ kind: 'found', session: rows[0] });
    expect(resolveDeviceSession(rows, 'echo-1x')).toEqual({ kind: 'found', session: rows[1] });
    expect(resolveDeviceSession(rows, 'beta')).toEqual({ kind: 'found', session: rows[1] });
    // A name that is one record's tmux name and another's display name resolves by tmux name.
    const clash = [rec('s-1', 'echo-2', 'echo-1'), rec('s-2', 'other', 'echo-2')];
    expect(resolveDeviceSession(clash, 'echo-2')).toEqual({ kind: 'found', session: clash[1] });
  });
  it('is case-sensitive, ignores finished records, and refuses ambiguity', () => {
    const rows = [rec('s-1', 'Alpha', 'a1'), rec('s-2', 'gone', 'a2', 'completed'), rec('s-3', 'dup', 'a3'), rec('s-4', 'dup', 'a4')];
    expect(resolveDeviceSession(rows, 'alpha').kind).toBe('missing');
    expect(resolveDeviceSession(rows, 'a2').kind).toBe('missing');
    expect(resolveDeviceSession(rows, 'dup').kind).toBe('ambiguous');
    expect(resolveDeviceSession([rec('s-5', 'x', 'x5', 'starting')], 'x5').kind).toBe('found');
  });
});

describe('classifyMiss', () => {
  const nick = (id: string) => (id === 'm_peer' ? 'Mac Mini' : null);
  it('a peer that lists it is named from this machine\'s registry', () => {
    const a = classifyMiss([{ machineId: 'm_other', found: false }, { machineId: 'm_peer', found: true }], nick);
    expect(a).toEqual({ error: 'session-on-other-machine', reason: otherMachineReason('Mac Mini'), ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
  });
  it('two machines listing the name name no machine', () => {
    expect(classifyMiss([{ machineId: 'm_peer', found: true }, { machineId: 'm_x', found: true }], nick).error).toBe('session-location-unknown');
  });
  it('a request bound to another machine repeats the phone\'s claim', () => {
    expect(requestedMachineReason('Mac Mini')).toBe('You opened a session on Mac Mini. Open it from Mac Mini.');
    expect(requestedMachineReason(null)).toContain('another of your machines');
  });
  it('an unknown machine is "another of your machines"', () => {
    const a = classifyMiss([{ machineId: 'm_x', found: true }], nick);
    expect(a.error).toBe('session-on-other-machine');
    expect(a.reason).toContain('another of your machines');
  });
  it('every peer answered no → not running; any peer silent → location unknown; no peers → not running', () => {
    expect(classifyMiss([{ machineId: 'a', found: false }], nick)).toEqual({ error: 'session-not-running', reason: NOT_RUNNING_REASON });
    expect(classifyMiss([{ machineId: 'a', found: false }, { machineId: 'b', failed: true }], nick)).toEqual({ error: 'session-location-unknown', reason: LOCATION_UNKNOWN_REASON });
    expect(classifyMiss([], nick).error).toBe('session-not-running');
  });
});

describe('peerRowsMatch', () => {
  it('matches active rows by tmux name, id or name; ignores finished rows and junk', () => {
    const rows = [{ id: 's1', name: 'n1', tmuxSession: 't1', status: 'running' }, { id: 's2', name: 'n2', tmuxSession: 't2', status: 'killed' }];
    expect(peerRowsMatch(rows, 't1')).toBe(true);
    expect(peerRowsMatch(rows, 's1')).toBe(true);
    expect(peerRowsMatch(rows, 'n1')).toBe(true);
    expect(peerRowsMatch(rows, 't2')).toBe(false);
    expect(peerRowsMatch({ sessions: rows }, 't1')).toBe(false);
    expect(peerRowsMatch([null, 3], 't1')).toBe(false);
  });
});

describe('DeviceInputReplayRecord', () => {
  it('admits a digest once, refuses it again, and still refuses it after a restart (a new instance on the same file)', () => {
    const file = path.join(tmp(), 'state', 'replay.json');
    const d = DeviceInputReplayRecord.digest('dev-1\nhost\nPOST\n/sessions/a/input\n1700000000000\nbody');
    expect(new DeviceInputReplayRecord(file).admit(d)).toBe('ok');
    const r1 = new DeviceInputReplayRecord(file);
    expect(r1.admit(d)).toBe('replay');
    expect(r1.admit(DeviceInputReplayRecord.digest('dev-1\nhost\nPOST\n/sessions/a/input\n1700000000001\nbody'))).toBe('ok');
  });
  it('forgets a digest after REPLAY_TTL_MS', () => {
    const file = path.join(tmp(), 'replay.json');
    let t = 5_000_000;
    const r = new DeviceInputReplayRecord(file, () => t);
    expect(r.admit('abc')).toBe('ok');
    t += REPLAY_TTL_MS + 1;
    expect(r.admit('abc')).toBe('ok');
  });
  it('fails closed when the record cannot be written', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const r = new DeviceInputReplayRecord(path.join(blocker, 'replay.json'));
    expect(r.admit('abc')).toBe('unavailable');
    expect(r.admit('abc')).toBe('unavailable');
  });
});

describe('appendInputAudit', () => {
  it('writes one line per input and rotates past the size limit', () => {
    const dir = tmp();
    appendInputAudit(dir, { textLength: 5 });
    const file = path.join(dir, 'logs', 'mobile-session-input.jsonl');
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    fs.writeFileSync(file, 'x'.repeat(AUDIT_ROTATE_BYTES + 1));
    appendInputAudit(dir, { textLength: 6 });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8').trim())).toEqual({ textLength: 6 });
  });
});

describe('redactForDevice', () => {
  it('removes the API token, the dashboard PIN and private-view signatures; leaves other text alone', () => {
    const tok = 'tok-abcdef0123456789';
    const pane = `curl -H "Authorization: Bearer ${tok}" http://x/view/1?sig=${'ab12'.repeat(8)}&a=1\nPIN is 482913. ok ${tok}`;
    const out = redactForDevice(pane, [tok, '482913', null, '12']);
    expect(out).not.toContain(tok);
    expect(out).not.toContain('482913');
    expect(out).toContain('sig=removed&a=1');
    expect(out).toContain('Bearer [redacted]');
    expect(redactForDevice('a 12 b', ['12'])).toBe('a 12 b');
  });
});

describe('Agent Awareness + Migration Parity: the native session screen line', () => {
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const run = async (projectDir: string) => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(result);
    return result;
  };
  it('new agents get it once, right after the Open session line', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const { APP_CONVERSATIONS_OPEN_SESSION_LINE, APP_CONVERSATIONS_NATIVE_SESSION_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md.split(APP_CONVERSATIONS_NATIVE_SESSION_LINE).length - 1).toBe(1);
    const lines = md.split('\n');
    expect(lines[lines.indexOf(APP_CONVERSATIONS_OPEN_SESSION_LINE) + 1]).toBe(APP_CONVERSATIONS_NATIVE_SESSION_LINE);
  });
  it('existing agents get it in place, once (idempotent)', async () => {
    const { APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_CONVERSATIONS_OPEN_SESSION_LINE, APP_CONVERSATIONS_NATIVE_SESSION_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const md = path.join(dir, 'CLAUDE.md');
    const old = APP_CONVERSATIONS_CLAUDEMD_SECTION(4321).replace(`${APP_CONVERSATIONS_NATIVE_SESSION_LINE}\n`, '');
    expect(old).not.toContain('native session screen');
    fs.writeFileSync(md, `# CLAUDE.md\n${old}`);
    expect((await run(dir)).upgraded).toContain('CLAUDE.md: added the native session screen line');
    const lines = fs.readFileSync(md, 'utf-8').split('\n');
    expect(lines[lines.indexOf(APP_CONVERSATIONS_OPEN_SESSION_LINE) + 1]).toBe(APP_CONVERSATIONS_NATIVE_SESSION_LINE);
    expect((await run(dir)).upgraded).not.toContain('CLAUDE.md: added the native session screen line');
    expect(fs.readFileSync(md, 'utf-8').split(APP_CONVERSATIONS_NATIVE_SESSION_LINE).length - 1).toBe(1);
  });
});
