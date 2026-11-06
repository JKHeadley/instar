/**
 * The pure half of the session screen's controls (docs/specs/mobile-native-session-controls.md): the
 * signed action lines, the input refusals, the menu's answer on both sides of each decision, and the
 * plain words for what a dashboard route answered.
 */
import { describe, it, expect } from 'vitest';
import { actionLine, buildAction, type PermissionAction, type SessionAction } from '../../src/server/mobilePermissionsRoutes.js';
import {
  closeAnswer, createBody, doorRows, machineRows, modelOptionWords, modelWords, moveAnswer, newSessionAnswer, regimeWords, runSessionAction,
  summarizeControls, summarizeNewOptions, type RouteAnswer, DOOR,
} from '../../src/server/mobileSessionControlsRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { AttachmentWindow, DEVICE_KEYS, peerTooOldReason, redactDeep } from '../../src/server/mobileSessionTerminalRoutes.js';

const built = (kind: string, target: string, extra: Record<string, unknown>): PermissionAction => {
  const r = buildAction(kind, target, extra);
  if (!r.ok) throw new Error(r.error);
  return r.action;
};
const refused = (kind: string, target: string, extra: Record<string, unknown>): string => {
  const r = buildAction(kind, target, extra);
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};

describe('session action lines', () => {
  it('name everything that changes what runs', () => {
    expect(actionLine(built('session-door', '134088', { framework: 'codex', model: 'gpt-6' }))).toBe('session-door 134088 here codex gpt-6');
    expect(actionLine(built('session-door', '134088', { framework: 'claude-code', machine: 'm_peer' }))).toBe('session-door 134088 m_peer claude-code none');
    expect(actionLine(built('session-move', '134088', { to: 'm_peer' }))).toBe('session-move 134088 m_peer none');
    const yes = 'a'.repeat(64);
    expect(actionLine(built('session-move', '134088', { to: 'm_peer', confirmation: yes }))).toBe(`session-move 134088 m_peer ${yes}`);
    expect(actionLine(built('session-close', 'sid-1', { tmux: 'Echo-topic-7' }))).toBe('session-close sid-1 Echo-topic-7 here');
    expect(actionLine(built('session-new', 'new', { name: 'Bug: login loop', platform: 'telegram', framework: 'codex', machine: 'm_peer' })))
      .toMatch(/^session-new new [0-9a-f]{64} telegram codex none m_peer$/);
    expect(actionLine(built('session-new', 'new', { name: 'x' }))).toMatch(/^session-new new [0-9a-f]{64} auto none none auto$/);
    expect(actionLine(built('session-default', 'new-topic-default', { framework: 'codex', model: 'gpt-6' }))).toBe('session-default new-topic-default codex gpt-6');
    expect(actionLine(built('session-default', 'new-topic-default', {}))).toBe('session-default new-topic-default none none');
  });

  it('the empty string the phone sends for a missing field is the missing field', () => {
    expect(actionLine(built('session-door', '7', { framework: 'codex', model: '', machine: '' }))).toBe('session-door 7 here codex none');
  });

  it('a field cannot add a word to the line', () => {
    expect(refused('session-door', '7', { framework: 'codex none here' })).toBe('bad-framework');
    expect(refused('session-door', '7', { framework: 'codex', model: 'a b' })).toBe('bad-model');
    expect(refused('session-door', '7', { framework: 'codex', machine: 'a\nb' })).toBe('bad-machine');
    expect(refused('session-move', '7', { to: 'a b' })).toBe('bad-machine');
    expect(refused('session-move', '7', { to: 'm', confirmation: 'yes' })).toBe('bad-confirmation');
    expect(refused('session-close', 'sid', { tmux: 'a b' })).toBe('bad-session-name');
    // A word that means "absent" on the line can't be a value.
    expect(refused('session-door', '7', { framework: 'none' })).toBe('bad-framework');
    expect(refused('session-door', '7', { framework: 'codex', model: 'none' })).toBe('bad-model');
    expect(refused('session-door', '7', { framework: 'codex', machine: 'here' })).toBe('bad-machine');
    expect(refused('session-move', '7', { to: 'auto' })).toBe('bad-machine');
  });

  it('refuses a target of the wrong shape', () => {
    expect(refused('session-door', 'slack:c1', { framework: 'codex' })).toBe('bad-target');
    expect(refused('session-move', 'abc', { to: 'm' })).toBe('bad-target');
    expect(refused('session-new', 'other', { name: 'x' })).toBe('bad-target');
    expect(refused('session-default', 'other', {})).toBe('bad-target');
    expect(refused('session-default', 'new-topic-default', { model: 'gpt-6' })).toBe('bad-framework');
  });

  it('refuses names that could not be a session name', () => {
    expect(refused('session-new', 'new', { name: '  ' })).toBe('name-required');
    expect(refused('session-new', 'new', {})).toBe('name-required');
    expect(refused('session-new', 'new', { name: ' spaced ' })).toBe('bad-name');
    expect(refused('session-new', 'new', { name: 'a'.repeat(121) })).toBe('bad-name');
    expect(refused('session-new', 'new', { name: 'a\u0007b' })).toBe('bad-name');
    expect(refused('session-new', 'new', { name: 'sk-ant-api03-' + 'x'.repeat(60) })).toBe('bad-name');
    expect(refused('session-new', 'new', { name: 'x', platform: 'email' })).toBe('bad-platform');
    expect(refused('session-new', 'new', { name: 'x', platform: 'slack', framework: 'codex' })).toBe('bad-platform');
    expect(refused('session-new', 'new', { name: 'x', platform: 'headless', machine: 'm' })).toBe('bad-platform');
    expect(refused('session-new', 'new', { name: 'x', model: 'gpt-6' })).toBe('bad-framework');
  });
});

describe('the hour limit on attached files', () => {
  it('stops at the limit and lets a file through again once the hour has moved on', () => {
    let t = 0;
    const w = new AttachmentWindow(() => t, 1000);
    expect(w.admit(1200)).toBe(true); // 900 bytes
    expect(w.admit(200)).toBe(false); // 150 more is over
    expect(w.admit(100)).toBe(true); // 75 more is not
    t = 3_600_000;
    expect(w.admit(1200)).toBe(true);
  });
});

describe('removing secrets from an answer', () => {
  it('touches strings only, so a number that contains a PIN can not corrupt it', () => {
    expect(redactDeep({ bytes: 4829137, list: [{ note: 'pin 482913' }], ok: true, none: null }, ['482913']))
      .toEqual({ bytes: 4829137, list: [{ note: 'pin [redacted]' }], ok: true, none: null });
  });
  it('leaves fields that name something, since a short PIN can fall inside one by chance', () => {
    const c = `aa2026${'b'.repeat(58)}`;
    expect(redactDeep({ confirmationChallenge: c, path: '/up/2026-11-05-a.png', sessionId: 'x-2026', at: '2026-11-05', message: 'in 2026' }, ['2026']))
      .toEqual({ confirmationChallenge: c, path: '/up/2026-11-05-a.png', sessionId: 'x-2026', at: '2026-11-05', message: 'in [redacted]' });
  });
});

describe('the keys and the device routes', () => {
  it('are the tray and no more', () => {
    expect([...DEVICE_KEYS].sort()).toEqual(['C-c', 'Down', 'Enter', 'Escape', 'Left', 'Right', 'Up', 'n', 'y'].sort());
  });
  it('every route that changes what runs shares the permission bucket', () => {
    for (const p of ['door/7', 'move/7', 'close/sid-1', 'new', 'default']) {
      const r = DEVICE_ALLOWLIST.filter((x) => x.method === 'POST' && x.re.test(`/mobile/sessions/${p}`));
      expect(r, p).toHaveLength(1);
      expect(r[0]).toMatchObject({ ownerOnly: true, ownBucket: 12, bucket: 'permission-actions', body: 'json' });
    }
  });
  it('a door or move target is digits only, and a phone path can never reach a relay route', () => {
    expect(DEVICE_ALLOWLIST.some((x) => x.re.test('/mobile/sessions/door/abc'))).toBe(false);
    expect(DEVICE_ALLOWLIST.some((x) => x.re.test('/mobile/sessions/door/0'))).toBe(false);
    expect(DEVICE_ALLOWLIST.some((x) => x.re.test('/mobile/sessions/relay/a/input'))).toBe(false);
  });
});

const OPTIONS = {
  regime: 'fully-live',
  newTopicDefault: { framework: 'codex', model: 'gpt-6', replication: 'local-only' },
  doors: [
    { framework: 'claude-code', label: 'Claude Code', selectable: true, availability: 'available', models: ['claude-opus-5-5', 'claude-opus-5-5-20261001', 'opus'], defaultModel: null },
    { framework: 'codex', label: 'Codex', selectable: true, availability: 'assumed', models: ['gpt-6'], defaultModel: 'gpt-6' },
    { framework: 'grok', label: 'Grok Build', selectable: false, availability: 'unavailable', reason: "isn't installed", models: [], defaultModel: null },
  ],
};
const PROFILE = { resolved: { framework: 'claude-code', model: 'claude-opus-5-5', sources: { framework: 'profile-pin' } }, pin: { updatedBy: 'operator:1' } };
const POOL = {
  selfMachineId: 'm_self',
  machines: [
    { machineId: 'm_self', nickname: 'Studio', online: true },
    { machineId: 'm_peer', nickname: 'Mac Mini', online: true, quotaState: { blocked: true } },
    { machineId: 'm_down', nickname: 'Laptop', online: false, liveness: { state: 'unreachable' } },
    { machineId: 'm_clock', nickname: 'Linux', online: true, clockSkewStatus: 'suspect-clock-removed' },
  ],
};
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const ROW = { tmuxSession: 'echo-topic-7', id: 'sid-1', name: 'Topic', platform: 'telegram', platformId: 7, machineId: 'm_self', machineNickname: 'Studio', model: 'claude-opus-5-5', type: 'interactive', startedAt: '2026-11-05T10:00:00.000Z', protected: false, telemetry: { toolsUsed: ['Read'], subagentsSpawned: [{}, {}], eventCount: 9, lastActivity: '2026-11-05T11:00:00.000Z' } };
const parts = (over: Partial<Parameters<typeof summarizeControls>[0]> = {}): Parameters<typeof summarizeControls>[0] => ({ row: ROW, remote: false, options: ok(OPTIONS), profile: ok(PROFILE), pool: ok(POOL), peerInput: null, ...over });

describe('the words', () => {
  it('match the console', () => {
    expect(modelWords('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelWords('claude-opus-5-5-20261001')).toBe('Opus 5.5');
    expect(modelWords('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelWords(null)).toBeNull();
    expect(modelOptionWords('opus')).toBe('Opus (latest)');
    expect(regimeWords('dry-run')).toContain('recorded as intent');
    expect(regimeWords('fully-live')).toBeNull();
  });
  it('folds a dated model into its twin and says why a door can not be picked', () => {
    const d = doorRows(OPTIONS);
    expect(d[0]!.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'opus']);
    expect(d[1]!.label).toBe('Codex (not verified)');
    expect(d[2]).toMatchObject({ selectable: false, reason: "isn't installed" });
  });
  it('machines: fewer than two is none; a machine that can not be picked says why', () => {
    expect(machineRows({ machines: [{ machineId: 'a', nickname: 'A', online: true }] })).toBeNull();
    const rows = machineRows(POOL)!.rows;
    expect(rows.find((m) => m.machineId === 'm_self')).toMatchObject({ here: true, selectable: true, label: 'Studio (this machine)' });
    expect(rows.find((m) => m.machineId === 'm_peer')).toMatchObject({ selectable: true, label: 'Mac Mini (at usage limit)' });
    expect(rows.find((m) => m.machineId === 'm_down')).toMatchObject({ selectable: false, reason: 'not answering' });
    expect(rows.find((m) => m.machineId === 'm_clock')).toMatchObject({ selectable: false, reason: 'clock out of step' });
  });
  it('two machines under one name are not offered', () => {
    const rows = machineRows({ machines: [{ machineId: 'a', nickname: 'Mac', online: true }, { machineId: 'b', nickname: 'mac', online: true }] })!.rows;
    expect(rows.every((m) => !m.selectable)).toBe(true);
  });
  it('a peer too old names the way forward', () => {
    expect(peerTooOldReason('Mac Mini')).toContain('Mac Mini needs the latest Instar update');
    expect(peerTooOldReason('Mac Mini')).toContain('move it to this machine');
  });
});

describe('the menu', () => {
  it('a Telegram session here: everything on, nothing technical', () => {
    const c = summarizeControls(parts(), { state: 'available' }, 0);
    expect(c.door).toMatchObject({ state: 'ok', topic: '7', framework: 'claude-code', model: 'claude-opus-5-5', now: 'Claude Code · Opus 5.5', source: 'pinned by you' });
    expect(c.move).toMatchObject({ state: 'ok', topic: '7' });
    expect((c.move as { choices: Array<{ machineId: string }> }).choices.map((m) => m.machineId)).toEqual(['m_peer', 'm_down', 'm_clock']);
    expect(c.typing).toEqual({ can: true, reason: null });
    expect(c.session).toMatchObject({ machine: 'Studio', modelWords: 'Opus 5.5', kind: 'a conversation', chat: 'a Telegram topic', backgroundTasks: 2, eventCount: 9 });
  });
  it('a session with no topic says so for both, and can still be typed to', () => {
    const c = summarizeControls(parts({ row: { ...ROW, platform: 'headless', platformId: undefined }, options: null, profile: null }), {}, 0);
    expect(c.door).toMatchObject({ state: 'not-this-chat' });
    expect(c.move).toMatchObject({ state: 'not-this-chat' });
    expect((c.door as { reason: string }).reason).toContain('Telegram');
    expect(c.typing).toEqual({ can: true, reason: null });
  });
  it('a failed read says it cannot read, never that there are none', () => {
    const c = summarizeControls(parts({ options: { status: 503, body: null }, pool: { status: 0, body: null } }), {}, 0);
    expect(c.door).toMatchObject({ state: 'unavailable', reason: "Can't read the engines and models right now." });
    expect(c.move).toMatchObject({ state: 'unavailable', reason: "Can't read the machines right now." });
  });
  it('one machine has nowhere to move to', () => {
    const c = summarizeControls(parts({ pool: ok({ machines: [{ machineId: 'm_self', nickname: 'S', online: true }] }) }), {}, 0);
    expect(c.move).toMatchObject({ state: 'one-machine' });
  });
  it('a session elsewhere: that machine decides typing, and says so', () => {
    const row = { ...ROW, machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true };
    expect(summarizeControls(parts({ row, remote: true, peerInput: true }), {}, 0).typing).toEqual({ can: true, reason: null });
    const off = summarizeControls(parts({ row, remote: true, peerInput: false }), {}, 0);
    expect((off.typing as { can: boolean; reason: string }).can).toBe(false);
    expect((off.typing as { reason: string }).reason).toContain('switched off');
    expect((off.attach as { can: boolean }).can).toBe(false);
    const old = summarizeControls(parts({ row, remote: true, peerInput: null }), {}, 0);
    expect((old.typing as { reason: string }).reason).toContain('needs the latest Instar update');
  });
  it('the close words warn about a protected session', () => {
    expect((summarizeControls(parts({ row: { ...ROW, protected: true } }), {}, 0).close as { confirm: string[] }).confirm).toContain('This one is normally kept running.');
  });
  it('new session options: the default in words, and a failed read still lets it start', () => {
    const o = summarizeNewOptions(ok(OPTIONS), ok(POOL), {}, 0);
    expect(o.defaultWords).toBe('New topics start on Codex (not verified) · GPT-6 (this machine only).');
    expect(o.doorsState).toBe('ok');
    const bad = summarizeNewOptions({ status: 503, body: null }, ok(POOL), {}, 0);
    expect(bad.doorsState).toBe('unavailable');
    expect(bad.doorsReason).toContain('starts on the agent default');
  });
});

describe('what a route answered, in plain words', () => {
  it('a move says moved only when the seat moved', () => {
    expect(moveAnswer(ok({ ok: true, seatMoved: true, action: 'transfer', targetNickname: 'Mac Mini' }), 'x').body).toMatchObject({ ok: true, moved: true });
    const half = moveAnswer(ok({ ok: true, seatMoved: false, action: 'transfer', targetNickname: 'Mac Mini' }), 'x').body as { moved: boolean; message: string };
    expect(half.moved).toBe(false);
    expect(half.message).toContain("hasn't finished");
    expect((moveAnswer(ok({ ok: true, seatMoved: true, action: 'noop' }), 'Mac Mini').body as { message: string }).message).toBe('It is already on Mac Mini.');
  });
  it('a move that needs a yes carries the route prompt and its binding', () => {
    const r = moveAnswer({ status: 409, body: { needsConfirmation: true, prompt: 'A run is going. Move anyway?', confirmationChallenge: 'c'.repeat(64) } }, 'x');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'needs-confirmation', message: 'A run is going. Move anyway?', confirmationChallenge: 'c'.repeat(64) });
  });
  it('a refused move is plain, with no reason codes', () => {
    for (const [status, body, want] of [
      [409, { rejectReason: 'rate-limited' }, 'Wait a minute'],
      [409, { retryRequired: true }, 'Try again'],
      [409, { failedNeedsRetry: true }, 'could not close'],
      [404, { rejectReason: 'unknown-machine-nickname' }, "doesn't know that machine"],
      [503, {}, 'off on this agent'],
      [0, null, "couldn't be reached"],
    ] as Array<[number, unknown, string]>) {
      const m = (moveAnswer({ status, body }, 'x').body as { message: string }).message;
      expect(m).toContain(want);
      expect(m).not.toMatch(/rate-limited|rejectReason|unknown-machine/);
    }
  });
  it('close: as the console says it, here and elsewhere', () => {
    expect(closeAnswer(false, ok({ ok: true })).body).toMatchObject({ ok: true, message: 'Closed.' });
    expect(closeAnswer(false, { status: 404, body: {} }).body).toMatchObject({ ok: true, gone: true });
    expect(closeAnswer(false, { status: 409, body: {} }).status).toBe(409);
    expect(closeAnswer(true, ok({ ok: true, alreadyClosed: true })).body).toMatchObject({ ok: true, gone: true });
    expect(closeAnswer(true, { status: 504, body: { outcomeUnknown: true } }).body).toMatchObject({ ok: false, unknown: true });
    expect(closeAnswer(true, { status: 502, body: { error: 'x' } }).status).toBe(502);
  });
  it('new session: started, unsettled, refused', () => {
    expect((newSessionAnswer(ok({ started: 'requested', machine: { machineId: 'm', nickname: 'Mini' } }), 'Bug', null).body as { message: string }).message).toBe('Starting "Bug" on Mini.');
    expect(newSessionAnswer(ok({ ownership: 'not-confirmed' }), 'Bug', null).body).toMatchObject({ ok: true, warn: true });
    expect(newSessionAnswer(ok({ started: 'unknown' }), 'Bug', null).body).toMatchObject({ ok: true, warn: true });
    expect(newSessionAnswer({ status: 429, body: { error: 'Too many' } }, 'Bug', null).body).toMatchObject({ ok: false, message: 'Too many' });
  });
  it('the create body: an unchanged pick sends nothing, and Slack carries no door', () => {
    const a = (over: Partial<Extract<SessionAction, { kind: 'session-new' }>>): Extract<SessionAction, { kind: 'session-new' }> => ({ kind: 'session-new', target: 'new', name: 'x', platform: 'auto', framework: null, model: null, machine: null, ...over });
    const def = { framework: 'codex', model: 'gpt-6' };
    expect(createBody(a({ framework: 'codex', model: 'gpt-6' }), def)).toEqual({ name: 'x', headless: false });
    expect(createBody(a({ framework: 'codex', model: null }), def)).toEqual({ name: 'x', headless: false, framework: 'codex', model: null });
    expect(createBody(a({ platform: 'slack', framework: 'codex', machine: 'm' }), def)).toEqual({ name: 'x', headless: false, platform: 'slack' });
    expect(createBody(a({ platform: 'headless' }), def)).toEqual({ name: 'x', headless: true, platform: 'headless' });
    expect(createBody(a({ platform: 'telegram', machine: 'm' }), null)).toEqual({ name: 'x', headless: false, platform: 'telegram', machine: 'm' });
  });
});

describe('running an action', () => {
  const calls: Array<{ method: string; path: string; body: unknown; machine: unknown }> = [];
  const deps = (answers: Record<string, RouteAnswer>) => ({
    selfMachineId: () => 'm_self',
    call: async (method: string, path: string, body?: unknown, machine?: string | null) => {
      calls.push({ method, path, body, machine });
      return answers[`${method} ${path}`] ?? { status: 500, body: null };
    },
  });
  const door = (over = {}) => ({ kind: 'session-door', target: '7', framework: 'codex', model: 'gpt-6', machine: null, ...over }) as SessionAction;

  it('a door runs the dashboard route, and the route refusal reaches the phone in its own words', async () => {
    const yes = await runSessionAction(door(), deps({ 'GET /topic-profile/options': ok(OPTIONS), 'POST /topic-profile/7': ok({ ok: true, message: 'Switching to Codex.' }) }));
    expect(yes.body).toMatchObject({ ok: true, message: 'Switching to Codex.' });
    const no = await runSessionAction(door(), deps({ 'GET /topic-profile/options': ok(OPTIONS), 'POST /topic-profile/7': { status: 403, body: { ok: false, reason: 'not-bound-operator', message: 'Only the bound operator can change this topic.' } } }));
    expect(no.status).toBe(403);
    expect(no.body).toMatchObject({ error: 'door-refused', message: 'Only the bound operator can change this topic.' });
  });
  it('refuses what the menu would not offer, before the route', async () => {
    calls.length = 0;
    const r = await runSessionAction(door({ framework: 'grok', model: null }), deps({ 'GET /topic-profile/options': ok(OPTIONS) }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'door-not-offered' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect((await runSessionAction(door({ model: 'gpt-1' }), deps({ 'GET /topic-profile/options': ok(OPTIONS) }))).body).toMatchObject({ error: 'model-not-offered' });
  });
  it('a door on another machine is asked of that machine; naming this machine stays here', async () => {
    calls.length = 0;
    await runSessionAction(door({ machine: 'm_peer' }), deps({ 'GET /topic-profile/options': ok(OPTIONS), 'POST /topic-profile/7': ok({ ok: true }) }));
    expect(calls.every((c) => c.machine === 'm_peer')).toBe(true);
    calls.length = 0;
    await runSessionAction(door({ machine: 'm_self' }), deps({ 'GET /topic-profile/options': ok(OPTIONS), 'POST /topic-profile/7': ok({ ok: true }) }));
    expect(calls.every((c) => c.machine === null)).toBe(true);
  });
  it('a move sends the yes only when it has one, and refuses an offline machine first', async () => {
    calls.length = 0;
    await runSessionAction({ kind: 'session-move', target: '7', to: 'm_peer', confirmation: null }, deps({ 'GET /pool': ok(POOL), 'POST /pool/transfer': ok({ ok: true, seatMoved: true }) }));
    expect(calls.find((c) => c.path === '/pool/transfer')!.body).toEqual({ topic: '7', to: 'm_peer' });
    calls.length = 0;
    const yes = 'c'.repeat(64);
    await runSessionAction({ kind: 'session-move', target: '7', to: 'm_peer', confirmation: yes }, deps({ 'GET /pool': ok(POOL), 'POST /pool/transfer': ok({ ok: true, seatMoved: true }) }));
    expect(calls.find((c) => c.path === '/pool/transfer')!.body).toEqual({ topic: '7', to: 'm_peer', confirm: true, confirmationChallenge: yes });
    calls.length = 0;
    const off = await runSessionAction({ kind: 'session-move', target: '7', to: 'm_down', confirmation: null }, deps({ 'GET /pool': ok(POOL) }));
    expect(off.body).toMatchObject({ error: 'machine-not-available' });
    expect(calls.some((c) => c.path === '/pool/transfer')).toBe(false);
  });
  it('a move names a machine in the roster, and a failed read does not guess', async () => {
    expect((await runSessionAction({ kind: 'session-move', target: '7', to: 'Mac Mini', confirmation: null }, deps({ 'GET /pool': ok(POOL) }))).body).toMatchObject({ error: 'unknown-machine' });
    expect((await runSessionAction({ kind: 'session-move', target: '7', to: 'm_peer', confirmation: null }, deps({ 'GET /pool': { status: 500, body: null } }))).body).toMatchObject({ error: 'machines-unavailable' });
  });
  it('a line naming a machine never runs here on a machine with no mesh id', async () => {
    calls.length = 0;
    const noSelf = { ...deps({}), selfMachineId: () => null };
    expect((await runSessionAction({ kind: 'session-close', target: 'sid-1', tmux: 't', machine: 'm_peer' }, noSelf)).body).toMatchObject({ error: 'machine-unknown' });
    expect((await runSessionAction(door({ machine: 'm_peer' }), noSelf)).body).toMatchObject({ error: 'machine-unknown' });
    expect(calls).toEqual([]);
  });
  it('a close goes to the exact session here, and through the relay elsewhere', async () => {
    calls.length = 0;
    await runSessionAction({ kind: 'session-close', target: 'sid-1', tmux: 'echo-topic-7', machine: null }, deps({ 'DELETE /sessions/sid-1': ok({ ok: true }) }));
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/sessions/sid-1' });
    calls.length = 0;
    await runSessionAction({ kind: 'session-close', target: 'sid-1', tmux: 'echo-topic-7', machine: 'm_peer' }, deps({ 'POST /sessions/echo-topic-7/remote-close': ok({ ok: true }) }));
    expect(calls[0]).toMatchObject({ method: 'POST', body: { machineId: 'm_peer', sessionUuid: 'sid-1' } });
  });
  it('the default saves and clears through its route', async () => {
    calls.length = 0;
    const saved = await runSessionAction({ kind: 'session-default', target: 'new-topic-default', framework: 'codex', model: 'gpt-6' }, deps({ 'POST /topic-profile/new-topic-default': ok({ ok: true }) }));
    expect(calls[0]!.body).toEqual({ framework: 'codex', model: 'gpt-6' });
    expect((saved.body as { message: string }).message).toContain('GPT-6');
    calls.length = 0;
    await runSessionAction({ kind: 'session-default', target: 'new-topic-default', framework: null, model: null }, deps({ 'POST /topic-profile/new-topic-default': ok({ ok: true }) }));
    expect(calls[0]!.body).toEqual({ clear: true });
  });
});

describe('the word for a door', () => {
  it('lives in one place: every phone sentence reads the constant, so a rename is one edit', async () => {
    expect(DOOR).toEqual({ word: 'engine', Word: 'Engine', words: 'engines' });
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../src/server/mobileSessionControlsRoutes.ts', import.meta.url), 'utf8');
    // Sentences (string literals with a space) that spell the word out themselves.
    const spelled = [...src.matchAll(/(['"`])((?:(?!\1)[^\n\\])*)\1/g)].map((m) => m[2].replace(/\$\{[^}]*(\}|$)/g, '')).filter((t) => / /.test(t) && /\b[Dd]oors?\b/.test(t) && !/^\s*[*/]/.test(t));
    expect(spelled).toEqual([]);
  });
});
