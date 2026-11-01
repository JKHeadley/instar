/**
 * Console Sessions page (docs/specs/console-features/work.md, "Sessions", legacy tab
 * `sessions`): every decision in the model on both sides (working / quiet / no reading /
 * starting, a duplicate across machines needs a look, a failed list is "can't tell" and
 * never "nothing running", machines that did not answer are named, the model in words,
 * the exact close / remote-close / create / door-switch requests and their answers in
 * words, the WebSocket frames), and the shipped console in jsdom: the grouped list, an
 * open session streaming into the terminal, the composer and keys over the socket, Stop
 * asked once, Close confirmed in a sheet with the exact request, and a create with the
 * intent header and no PIN anywhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  spanWords, modelWords, sessionKey, sessionTitle, activity, mergeSessions, buildSessions, sessionsHeadline, sessionsFacts,
  partialWords, titleLine, closeRequest, closeConfirmWords, closeResultWords, doorChoices, modelChoices, doorModelWords,
  regimeWords, machineChoices, createBody, createResultWords, defaultWords, profileSourceWords, switchLanded, canSwitchDoor,
  KEYS, STOP_KEY, frame, nextHistoryBatch, streamErrorWords, composerRows, HISTORY_MAX,
  isInternalSession, attachmentMessage, OPERATOR_CREATED,
} from '../../dashboard/console/sessions-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const iso = (ms: number) => new Date(ms).toISOString();
const sess = (over: Record<string, unknown> = {}) => ({
  id: 'uuid-1', name: 'echo-fix', tmuxSession: 'echo-fix', status: 'running', startedAt: iso(NOW - 40 * 60_000), model: 'claude-opus-5-5',
  platform: 'telegram', platformId: 127504, platformName: 'Bug: login loop', protected: false, machineId: 'm-studio', machineNickname: 'Mac Studio',
  telemetry: { lastActivity: iso(NOW - 60_000), toolsUsed: ['Bash', 'Read'], eventCount: 12, subagentsSpawned: [] }, ...over,
});
const poolOf = (sessions: unknown[], pool: Record<string, unknown> = {}) => ok({ sessions, pool: { enabled: false, selfMachineId: 'm-studio', selfMachineNickname: 'Mac Studio', machines: [], failed: [], duplicateTopics: [], ...pool } });

describe('words', () => {
  it('spans and models read plainly; a bare family name says the version was not recorded', () => {
    expect(spanWords(30_000)).toBe('now');
    expect(spanWords(25 * 60_000)).toBe('25 min');
    expect(spanWords(3 * 3600_000)).toBe('3 h');
    expect(spanWords(50 * 3600_000)).toBe('2 days');
    expect(spanWords(-1)).toBeNull();
    expect(modelWords('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelWords('claude-fable-5')).toBe('Fable 5');
    expect(modelWords('opus')).toBe('Opus, version not recorded');
    expect(modelWords('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelWords('')).toBeNull();
    expect(modelWords('weird-model')).toBe('weird-model');
  });
  it('the title is the topic name when there is one; keys never collide across machines', () => {
    expect(sessionTitle(sess())).toBe('Bug: login loop');
    expect(sessionTitle({ name: '[job] digest' })).toBe('digest');
    expect(sessionTitle({ name: 'topic-127504', platform: 'telegram', platformId: 127504 }, { '127504': 'Instar dashboard makeover' })).toBe('Instar dashboard makeover');
    expect(sessionTitle({ name: 'topic-127504', platform: 'telegram', platformId: 127504 })).toBe('Conversation name unavailable');
    expect(sessionTitle({ name: 'C123456', platform: 'slack', platformId: 'C123456' })).toBe('Channel name unavailable');
    expect(sessionKey(sess())).toBe('echo-fix');
    expect(sessionKey(sess({ remote: true, machineId: 'm-mini' }))).toBe('remote:m-mini:echo-fix');
  });
  it('activity: working under 2 min, quiet at 10+ (never "stuck"), no reading without telemetry, starting', () => {
    expect(activity(sess({ telemetry: { lastActivity: iso(NOW - 30_000) } }), NOW)).toMatchObject({ state: 'working', words: 'active now' });
    expect(activity(sess({ telemetry: { lastActivity: iso(NOW - 5 * 60_000) } }), NOW)).toMatchObject({ state: 'calm', words: 'active 5 min ago' });
    expect(activity(sess({ telemetry: { lastActivity: iso(NOW - 9 * 60_000 - 59_000) } }), NOW).state).toBe('calm');
    expect(activity(sess({ telemetry: { lastActivity: iso(NOW - 10 * 60_000) } }), NOW)).toMatchObject({ state: 'quiet', words: 'quiet for 10 min', end: '10 min' });
    expect(activity(sess({ telemetry: null }), NOW).state).toBe('no-reading');
    expect(activity(sess({ status: 'starting' }), NOW).state).toBe('starting');
    expect(JSON.stringify(activity(sess({ telemetry: { lastActivity: iso(NOW - 3 * 3600_000) } }), NOW))).not.toMatch(/stuck/i);
  });
});

describe('the list', () => {
  it('a failed list is "can’t tell" with the reason, never "nothing running"', () => {
    const m = buildSessions(fail('no answer within 8 seconds'), { now: NOW });
    expect(m).toEqual({ ok: false, reason: 'Couldn’t list sessions: no answer within 8 seconds.' });
    expect(sessionsHeadline(m)).toEqual({ text: 'Can’t tell what is running.', tone: 'unknown' });
    expect(sessionsFacts(m)).toEqual([]);
    expect(buildSessions(ok({ nope: 1 }), { now: NOW })).toMatchObject({ ok: false, reason: 'The session list answered without sessions.' });
  });
  it('an empty answer is nothing running; single-machine has no machine fact', () => {
    const m = buildSessions(poolOf([]), { now: NOW });
    expect(m.ok && m.rows).toEqual([]);
    expect(sessionsHeadline(m).text).toBe('Nothing is running.');
    expect(sessionsFacts(m)).toEqual([{ n: 0, label: 'running', tone: null }, { n: 0, label: 'quiet 10+ min', tone: null }]);
  });
  it('quiet and duplicate sessions need a look; the rest are working; rows name their machine', () => {
    const quiet = sess({ tmuxSession: 'drain', name: 'drain', platformName: 'Feedback drain', platformId: 1, startedAt: iso(NOW - 3 * 3600_000), telemetry: { lastActivity: iso(NOW - 25 * 60_000) } });
    const dup = sess({ tmuxSession: 'dup', name: 'dup', platformName: 'Release plan', platformId: 9, remote: true, machineId: 'm-mini', machineNickname: 'Mac Mini' });
    const m = buildSessions(poolOf([sess(), quiet, dup, sess({ tmuxSession: 'old', status: 'completed' })], { duplicateTopics: [{ platform: 'telegram', platformId: 9, sessions: ['dup'] }] }), { now: NOW });
    if (!m.ok) throw new Error('model failed');
    expect(m.rows.map((r) => r.title)).toEqual(['Bug: login loop', 'Release plan', 'Feedback drain']);
    expect(m.needsLook.map((r) => r.title)).toEqual(['Release plan', 'Feedback drain']);
    expect(m.working.map((r) => r.title)).toEqual(['Bug: login loop']);
    expect(m.rows[0].sub).toBe('Mac Studio · 40 min · active 1 min ago');
    expect(m.needsLook[0].sub).toBe('Mac Mini · 40 min · running on two machines at once');
    expect(m.needsLook[1]).toMatchObject({ sub: 'Mac Studio · 3 h · quiet for 25 min', end: '25 min', tone: 'attn' });
    expect(sessionsHeadline(m)).toEqual({ text: '3 sessions running. One is running on two machines at once.', tone: 'bad' });
    const noDup = buildSessions(poolOf([sess(), quiet]), { now: NOW });
    expect(sessionsHeadline(noDup)).toEqual({ text: '2 sessions running. One has been quiet for 25 minutes.', tone: 'attn' });
    expect(sessionsFacts(noDup)[1]).toEqual({ n: 1, label: 'quiet 10+ min', tone: 'attn' });
  });
  it('matches duplicate warnings by conversation even when session keys collide', () => {
    const local = sess({ tmuxSession: 'shared-key', platformId: 10, platformName: 'Different conversation' });
    const remote = sess({ tmuxSession: 'shared-key', platformId: 9, platformName: 'Repeated conversation', remote: true, machineId: 'm-mini' });
    const m = buildSessions(poolOf([local, remote], { duplicateTopics: [{ platform: 'telegram', platformId: 9, sessions: ['shared-key'] }] }), { now: NOW });
    if (!m.ok) throw new Error('model failed');
    expect(m.rows.find((r) => r.title === 'Different conversation')?.duplicate).toBe(false);
    expect(m.rows.find((r) => r.title === 'Repeated conversation')?.duplicate).toBe(true);
  });
  it('the live socket list wins for this machine but keeps the pool read’s protected flag', () => {
    const merged = mergeSessions({ sessions: [sess({ protected: true }), sess({ tmuxSession: 'r', remote: true })] }, [{ tmuxSession: 'echo-fix', name: 'live name', status: 'running', startedAt: iso(NOW) }, { tmuxSession: 'new', status: 'running' }]);
    expect(merged.local.map((s) => s.name)).toEqual(['live name', undefined]);
    expect(merged.local[0].protected).toBe(true);
    expect(merged.remote).toHaveLength(1);
    expect(mergeSessions({ sessions: [sess()] }, null).local).toHaveLength(1);
  });
  it('multi-machine: a machine that did not answer is named; idle machines get one line each', () => {
    const machines = [
      { machineId: 'm-studio', nickname: 'Mac Studio', isSelf: true, sessionCount: 1 },
      { machineId: 'm-mini', nickname: 'Mac Mini', sessionCount: 0, emptyState: { kind: 'unreachable', text: 'unreachable (last seen 6 min ago)', lastSeen: iso(NOW - 6 * 60_000) } },
      { machineId: 'm-laptop', nickname: 'Laptop', sessionCount: 0, emptyState: { kind: 'online', text: 'online — no active sessions', lastSeen: null } },
    ];
    const m = buildSessions(poolOf([sess()], { enabled: true, machines, failed: [{ machineId: 'm-mini', error: 'timeout' }] }), { now: NOW });
    if (!m.ok) throw new Error('model failed');
    expect(m.unanswered).toEqual([{ machineId: 'm-mini', name: 'Mac Mini', words: 'not answering (last seen 6 min ago)' }]);
    expect(m.idleMachines).toEqual([{ machineId: 'm-laptop', name: 'Laptop', words: 'answering, nothing running', ok: true }]);
    expect(partialWords(m)).toBe('Mac Mini did not answer; its sessions are not shown.');
    expect(sessionsFacts(m).at(-1)).toEqual({ n: '2 of 3', label: 'machines answering', tone: 'attn' });
    expect(partialWords(buildSessions(poolOf([sess()]), { now: NOW }))).toBeNull();
  });
  it('the title line says the model in words', () => {
    expect(titleLine({ machineNickname: 'Mac Studio', model: 'claude-opus-5-5' })).toBe('Mac Studio · Opus 5.5');
    expect(titleLine({ machineNickname: 'Mac Studio', model: 'opus', type: 'job' })).toBe('Mac Studio · Opus, version not recorded · scheduled job');
    expect(titleLine({ machineNickname: 'Laptop', model: null })).toBe('Laptop · model not recorded');
  });
});

describe('internal sessions and attachments', () => {
  it('jobs and agent-spawned helpers are internal; conversations and operator-created sessions are not', () => {
    expect(isInternalSession(sess({ jobSlug: 'health-check' }))).toBe(true);
    expect(isInternalSession(sess({ platform: 'headless', platformId: null }))).toBe(true);
    expect(isInternalSession(sess({ platform: 'headless', platformId: null, triggeredBy: OPERATOR_CREATED }))).toBe(false);
    expect(isInternalSession(sess())).toBe(false);
    expect(isInternalSession(sess({ platform: 'slack' }))).toBe(false);
  });
  it('the list hides internal sessions by default, counts them, and shows them on request; an open internal row is still found', () => {
    const res = poolOf([sess(), sess({ id: 'j', name: 'job', tmuxSession: 'echo-job', jobSlug: 'reflection' }), sess({ id: 'h', name: 'helper', tmuxSession: 'echo-helper', platform: 'headless', platformId: null })]);
    const hidden = buildSessions(res, { now: NOW });
    expect(hidden.ok && hidden.rows.length).toBe(1);
    expect(hidden.ok && hidden.internalCount).toBe(2);
    expect(hidden.ok && hidden.allRows.length).toBe(3);
    const shown = buildSessions(res, { now: NOW, showInternal: true });
    expect(shown.ok && shown.rows.length).toBe(3);
  });
  it('an attachment message keeps the text and names each saved file', () => {
    expect(attachmentMessage('look at this', ['/a/x.png'])).toBe('look at this\n[Attached file from the dashboard: /a/x.png (read it to see what I sent)]');
    expect(attachmentMessage('  ', ['/a/x.png', '/a/y.txt']).split('\n')).toHaveLength(2);
  });
});

describe('close', () => {
  const local = { tmuxSession: 'echo fix', id: 'u1', remote: false, protected: false, machineNickname: 'Mac Studio' };
  const remote = { tmuxSession: 'echo-fix', id: 'u2', remote: true, machineId: 'm-mini', machineNickname: 'Mac Mini' };
  it('the exact request: local DELETE by tmux name, another machine through the relay with its uuid', () => {
    expect(closeRequest(local)).toEqual({ method: 'DELETE', path: '/sessions/echo%20fix', body: null });
    expect(closeRequest(remote)).toEqual({ method: 'POST', path: '/sessions/echo-fix/remote-close', body: { machineId: 'm-mini', sessionUuid: 'u2' } });
  });
  it('the confirm names the machine, warns for a protected one, and is honest when protection is unknown', () => {
    expect(closeConfirmWords(local, 'Bug: login loop')).toEqual(['Close “Bug: login loop”? Its conversation is kept.']);
    expect(closeConfirmWords({ ...local, protected: true }, 'X')).toEqual(['Close “X”? Its conversation is kept.', 'This one is normally kept running.']);
    expect(closeConfirmWords(remote, 'X')).toEqual(['Close “X” on Mac Mini? Its conversation is kept.', 'That machine did not say whether this one is normally kept running.']);
    expect(closeConfirmWords({ ...remote, protected: false }, 'X')).toHaveLength(1);
  });
  it('answers in words: closed, already closed, outcome unknown, refused', () => {
    expect(closeResultWords(local, 200, { ok: true })).toEqual({ ok: true, text: 'Closed.' });
    expect(closeResultWords(local, 404, {})).toEqual({ ok: true, gone: true, text: 'Already closed.' });
    expect(closeResultWords(local, 409, {}).ok).toBe(false);
    expect(closeResultWords(local, 0, {}).text).toBe('Not closed: the server could not be reached.');
    expect(closeResultWords(remote, 200, { ok: true })).toEqual({ ok: true, text: 'Closed on Mac Mini.' });
    expect(closeResultWords(remote, 200, { ok: true, alreadyClosed: true })).toMatchObject({ ok: true, gone: true });
    expect(closeResultWords(remote, 504, { outcomeUnknown: true })).toEqual({ ok: false, unknown: true, text: 'Outcome unknown, checking.' });
    expect(closeResultWords(remote, 502, { error: 'unreachable: Mac Mini' }).text).toBe('Not closed: unreachable: Mac Mini.');
  });
});

describe('doors, models, machines, create', () => {
  const options = {
    regime: 'live',
    doors: [
      { framework: 'claude-code', label: 'Claude Code', selectable: true, availability: 'verified', models: ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'opus'], defaultModel: 'claude-opus-5-5' },
      { framework: 'codex-cli', label: 'Codex', selectable: false, reason: 'not installed', chatOnly: true, models: [] },
    ],
    newTopicDefault: { framework: null, model: null },
  };
  it('doors: an unpickable door says why; "Agent default" only when no default is set', () => {
    expect(doorChoices(options, { withAgentDefault: true })).toEqual([
      { value: '', label: 'Agent default', disabled: false },
      { value: 'claude-code', label: 'Claude Code', disabled: false },
      { value: 'codex-cli', label: 'Codex — not installed (you can still pin this in chat)', disabled: true },
    ]);
    expect(doorChoices({ ...options, newTopicDefault: { framework: 'claude-code' } }, { withAgentDefault: true })[0].value).toBe('claude-code');
  });
  it('models: account default first, dated twins folded, the door default preselected', () => {
    const mc = modelChoices(options, 'claude-code');
    expect(mc.choices.map((c) => c.label)).toEqual(['Account default', 'Opus 5.5', 'Haiku 4.5', 'Opus (latest)']);
    expect(mc.value).toBe('claude-opus-5-5');
    expect(modelChoices(options, 'claude-code', 'claude-haiku-4-5-20251001').choices.map((c) => c.value)).toContain('claude-haiku-4-5-20251001');
    expect(modelChoices(options, 'nope')).toMatchObject({ disabled: true });
    expect(doorModelWords(options, 'claude-code', null)).toBe('Claude Code · Account default');
    expect(regimeWords({ regime: 'dry-run' })).toMatch(/recorded as intent/);
    expect(regimeWords(options)).toBeNull();
    expect(defaultWords(options)).toBe('New topics start on the agent default.');
    expect(defaultWords({ ...options, newTopicDefault: { framework: 'claude-code', model: 'claude-opus-5-5', replication: 'local-only' } })).toBe('New topics start on Claude Code · Opus 5.5 (this machine only).');
  });
  it('machines: only with 2+; offline and clock-out disabled; never "offline" without evidence', () => {
    expect(machineChoices(ok({ machines: [{ machineId: 'a' }] }))).toBeNull();
    expect(machineChoices(fail())).toBeNull();
    const mc = machineChoices(ok({ selfMachineId: 'a', machines: [
      { machineId: 'a', nickname: 'Mac Studio', online: true },
      { machineId: 'b', nickname: 'Mac Mini', online: false, liveness: { state: 'unreachable' } },
      { machineId: 'c', nickname: 'Laptop', online: true, clockSkewStatus: 'suspect-clock-removed' },
      { machineId: 'd', nickname: 'PC', online: false },
    ] }))!;
    expect(mc.choices.map((c) => [c.label, c.disabled])).toEqual([
      ['Automatic', false], ['Mac Studio (this machine)', false], ['Mac Mini (not answering)', true], ['Laptop (clock out of step)', true], ['PC (no recent contact)', true],
    ]);
    const duplicates = machineChoices(ok({ selfMachineId: 'a', machines: [
      { machineId: 'a', nickname: 'Scout', online: true },
      { machineId: 'b', nickname: 'scout', online: true },
      { machineId: 'c', nickname: 'Echo', online: true },
    ] }))!;
    expect(duplicates.choices.map((c) => c.disabled)).toEqual([false, true, true, false]);
  });
  it('create: a name is required; an unchanged pick sends nothing; door and machine only for Telegram', () => {
    expect(createBody({ name: '  ' }, options)).toEqual({ ok: false, problems: ['Give it a name.'] });
    expect(createBody({ name: ' Bug ', platform: 'auto' }, options)).toEqual({ ok: true, body: { name: 'Bug', headless: false } });
    expect(createBody({ name: 'B', platform: 'telegram', framework: 'claude-code', model: 'claude-opus-5-5', machine: 'b' }, options)).toEqual({ ok: true, body: { name: 'B', headless: false, platform: 'telegram', framework: 'claude-code', model: 'claude-opus-5-5', machine: 'b' } });
    expect(createBody({ name: 'B', framework: 'claude-code', model: 'claude-opus-5-5' }, { ...options, newTopicDefault: { framework: 'claude-code', model: 'claude-opus-5-5' } })).toEqual({ ok: true, body: { name: 'B', headless: false } });
    expect(createBody({ name: 'B', platform: 'headless', framework: 'claude-code', machine: 'b' }, options)).toEqual({ ok: true, body: { name: 'B', headless: true, platform: 'headless' } });
  });
  it('create answers in words, the server’s own sentence when it is unsettled', () => {
    expect(createResultWords(201, { topicId: 5, profile: { label: 'Claude Code', model: 'claude-opus-5-5' } }, 'B')).toEqual({ ok: true, text: 'Started “B” with a Telegram topic on Claude Code · Opus 5.5.' });
    expect(createResultWords(200, {}, 'B').text).toBe('Started “B” with no chat.');
    expect(createResultWords(200, { started: 'requested', machine: { nickname: 'Mac Mini' } }, 'B').text).toBe('Starting “B” on Mac Mini.');
    expect(createResultWords(200, { ownership: 'not-confirmed', error: 'Ownership unsettled.' }, 'B')).toEqual({ ok: true, warn: true, text: 'Ownership unsettled.' });
    expect(createResultWords(400, { error: 'Name taken' }, 'B')).toEqual({ ok: false, text: 'Name taken' });
    expect(createResultWords(0, {}, 'B').text).toBe('Not created: the server could not be reached.');
  });
  it('door switch: only a local Telegram session; landed only when the launched model shows', () => {
    expect(canSwitchDoor({ platform: 'telegram', platformId: 5, remote: false })).toBe(true);
    expect(canSwitchDoor({ platform: 'telegram', platformId: 5, remote: true })).toBe(false);
    expect(canSwitchDoor({ platform: 'slack', platformId: 5 })).toBe(false);
    const job = { topicId: '5', model: 'claude-fable-5', since: NOW };
    expect(switchLanded([{ platformId: 5, startedAt: iso(NOW - 60_000), model: 'claude-fable-5' }], job)).toBeNull();
    expect(switchLanded([{ platformId: 5, startedAt: iso(NOW + 1000), model: 'claude-opus-5-5' }], job)).toBeNull();
    expect(switchLanded([{ platformId: 5, startedAt: iso(NOW + 1000), model: 'claude-fable-5' }], job)).toMatchObject({ model: 'claude-fable-5' });
    expect(profileSourceWords({ resolved: { sources: { framework: 'profile-pin' } }, pin: { updatedBy: 'api-token' } })).toBe('pinned by you');
    expect(profileSourceWords({ resolved: { sources: { framework: 'profile-pin' } }, pin: { updatedBy: 'system:dashboard-create' } })).toBe('set when it was created');
    expect(profileSourceWords({ resolved: { sources: { framework: 'config' } } })).toBe('the default');
  });
});

describe('terminal frames', () => {
  it('another machine’s session carries its machineId; local ones do not', () => {
    expect(frame('subscribe', { tmuxSession: 'a' })).toEqual({ type: 'subscribe', session: 'a' });
    expect(frame('input', { tmuxSession: 'a', remote: true, machineId: 'm' }, { text: 'hi' })).toEqual({ type: 'input', session: 'a', text: 'hi', machineId: 'm' });
  });
  it('keys: Stop is separate, last, and asks; history stops at the server limit', () => {
    expect(KEYS.map((k) => k.key)).toEqual(['Enter', 'y', 'n', 'Escape', 'Up', 'Down', 'Left', 'Right']);
    expect(KEYS.some((k) => k.key === 'C-c')).toBe(false);
    expect(STOP_KEY).toEqual({ label: 'Stop (Ctrl+C)', key: 'C-c', confirm: 'Interrupt what it is doing?' });
    expect(nextHistoryBatch(2000)).toBe(7000);
    expect(nextHistoryBatch(48_000)).toBe(HISTORY_MAX);
    expect(nextHistoryBatch(HISTORY_MAX)).toBeNull();
    expect(streamErrorWords({ code: 'machine-unreachable' })).toBe('That machine is not answering.');
    expect(streamErrorWords({ code: 'session-transferred', newMachineId: 'Mac Mini' })).toMatch(/moved to Mac Mini/);
    expect(streamErrorWords({ code: 'other' })).toBeNull();
    expect(composerRows('a')).toBe(1);
    expect(composerRows('1\n2\n3\n4\n5\n6\n7\n8')).toBe(6);
  });
  it('the tile and the Home card go to the native page', () => {
    expect(NATIVE_PAGES.sessions).toBe('#/work/sessions');
    expect(tabHref('sessions')).toBe('#/work/sessions');
    expect(GROUPS.find((g) => g.id === 'work')!.tabs.find((t) => t.id === 'sessions')!.label).toBe('Sessions');
  });
});

describe('sessions in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console: grouped list, an open session streaming, composer and keys over the socket, Stop asked once, Close confirmed, a create with no PIN', async () => {
    const writes: Array<{ method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/sessions' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const now = Date.now();
    const sockets: FakeWS[] = [];
    class FakeWS {
      readyState = 0; sent: Record<string, unknown>[] = []; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; url: string;
      constructor(url: string) { this.url = url; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
      send(s: string) { this.sent.push(JSON.parse(s)); }
      close() { this.readyState = 3; }
      push(m: unknown) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
    }
    g.WebSocket = FakeWS;
    const written: string[] = [];
    (dom.window as unknown as Record<string, unknown>).Terminal = class { buffer = { active: { baseY: 0, viewportY: 0 } }; loadAddon() {} open(n: HTMLElement) { n.append(dom.window.document.createElement('canvas')); } onScroll() {} clear() {} write(d: string) { written.push(d); } scrollToBottom() {} dispose() {} };
    (dom.window as unknown as Record<string, unknown>).FitAddon = { FitAddon: class { fit() {} } };
    let list = [
      sess({ startedAt: iso(now - 40 * 60_000), telemetry: { lastActivity: iso(now - 60_000), toolsUsed: ['Bash'], eventCount: 3 } }),
      sess({ tmuxSession: 'drain', name: 'drain', id: 'uuid-2', platformName: 'Feedback drain', platformId: 1, protected: true, startedAt: iso(now - 3 * 3600_000), telemetry: { lastActivity: iso(now - 25 * 60_000) } }),
    ];
    const table: Record<string, { status?: number; body: () => unknown }> = {
      '/sessions': { body: () => list },
      '/sessions?scope=pool': { body: () => ({ sessions: list, pool: { enabled: false, selfMachineId: 'm-studio', selfMachineNickname: 'Mac Studio', machines: [], failed: [], duplicateTopics: [] } }) },
      '/topic-profile/options': { body: () => ({ regime: 'live', doors: [{ framework: 'claude-code', label: 'Claude Code', selectable: true, models: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' }], newTopicDefault: { framework: null, model: null } }) },
      '/pool': { body: () => ({ enabled: false, machines: [] }) },
      '/health': { body: () => ({ project: { name: 'echo' } }) },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = (opts && opts.method) || 'GET';
      if (method !== 'GET') {
        writes.push({ method, url, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: (opts && opts.headers) || {} });
        if (method === 'DELETE') { list = list.filter((s) => !url.endsWith(String(s.tmuxSession))); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
        if (url === '/sessions/create') return { ok: true, status: 201, json: async () => ({ topicId: 7, profile: { label: 'Claude Code', model: null } }) };
      }
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body())) };
    };
    const flush = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await flush();
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('2 sessions running. One has been quiet for 25 minutes.');
    expect([...doc.querySelectorAll('.fact')].map((f) => f.textContent)).toEqual(['2running', '1quiet 10+ min']);
    expect([...doc.querySelectorAll('#sec-look .row-title')].map((n) => n.textContent)).toEqual(['Feedback drain']);
    expect([...doc.querySelectorAll('#sec-working .row-title')].map((n) => n.textContent)).toEqual(['Bug: login loop']);
    expect(doc.querySelector('#sec-working .row-sub')!.textContent).toBe('Mac Studio · 40 min · active 1 min ago');
    expect(doc.querySelector('.stale-banner')).toBeNull(); // the socket is up
    expect(sockets[0].url).toBe('ws://localhost:4040/ws?token=t');
    expect(doc.body.textContent).not.toMatch(/stuck/i);

    // The socket's live list replaces this machine's rows.
    sockets[0].push({ type: 'sessions', sessions: [{ ...list[0], name: 'echo-fix' }] });
    expect(doc.querySelectorAll('.sess-row')).toHaveLength(1);

    // Open a session: full-screen, subscribed, streaming into the terminal.
    (doc.querySelector('.sess-row') as HTMLAnchorElement).click();
    dom.window.location.hash = '#/work/sessions?s=echo-fix';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush();
    expect(doc.querySelector('.sessions-page')!.classList.contains('has-open')).toBe(true);
    expect(doc.querySelector('.sess-title')!.textContent).toBe('Bug: login loop');
    expect(doc.querySelector('.sess-sub')!.textContent).toBe('Mac Studio · Opus 5.5');
    const ws = sockets.at(-1)!;
    expect(ws.sent).toContainEqual({ type: 'subscribe', session: 'echo-fix' });
    ws.push({ type: 'output', session: 'echo-fix', data: 'hello from the pane' });
    expect(written).toContain('hello from the pane');

    // Composer → an input frame; an empty message sends nothing.
    const input = doc.querySelector('.sess-input') as HTMLTextAreaElement;
    (doc.querySelector('button[data-send]') as HTMLButtonElement).click();
    expect(ws.sent.filter((m) => m.type === 'input')).toHaveLength(0);
    input.value = 'line one\nline two';
    (doc.querySelector('button[data-send]') as HTMLButtonElement).click();
    expect(ws.sent).toContainEqual({ type: 'input', session: 'echo-fix', text: 'line one\nline two' });
    expect(input.value).toBe('');

    // Keys tray: Enter goes at once; Stop asks once, then sends C-c.
    (doc.querySelector('button[data-keys]') as HTMLButtonElement).click();
    (doc.querySelector('button[data-key="Enter"]') as HTMLButtonElement).click();
    expect(ws.sent).toContainEqual({ type: 'key', session: 'echo-fix', key: 'Enter' });
    (doc.querySelector('button[data-stop]') as HTMLButtonElement).click();
    expect(ws.sent.some((m) => m.key === 'C-c')).toBe(false);
    expect(doc.querySelector('.keys-stop .confirm-text')!.textContent).toBe('Interrupt what it is doing?');
    (doc.querySelector('button[data-stop-confirm]') as HTMLButtonElement).click();
    expect(ws.sent).toContainEqual({ type: 'key', session: 'echo-fix', key: 'C-c' });

    // A refresh never rebuilds the open terminal.
    const canvas = doc.querySelector('.sess-term canvas');
    sockets.at(-1)!.push({ type: 'sessions', sessions: [{ ...list[0], name: 'echo-fix' }] });
    expect(doc.querySelector('.sess-term canvas')).toBe(canvas);

    // ⋯ → Details hold the engineer facts; Close is quiet and confirmed in one sentence.
    (doc.querySelector('button[data-more]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet details.raw')!.textContent).toContain('Bash');
    expect(doc.querySelector('.sheet button[data-door]')).not.toBeNull();
    (doc.querySelector('.sheet button[data-close]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toBe('Close “Bug: login loop”? Its conversation is kept.');
    expect(writes).toHaveLength(0);
    (doc.querySelector('.sheet button[data-close-confirm]') as HTMLButtonElement).click();
    await flush(10);
    expect(writes[0]).toMatchObject({ method: 'DELETE', url: '/sessions/echo-fix', body: null });
    expect(doc.querySelector('.sheet .sheet-danger .action-status')!.textContent).toBe('Closed.');
    await flush(60);
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(dom.window.location.hash).toBe('#/work/sessions');

    // New session: name required, then the exact body with the intent header; no PIN anywhere.
    await flush();
    (doc.querySelector('button[data-new]') as HTMLButtonElement).click();
    await flush(10);
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('New session');
    (doc.querySelector('.sheet button[data-create]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('Give it a name.');
    (doc.querySelector('.sheet input[aria-label="Name"]') as HTMLInputElement).value = 'Bug: cache';
    (doc.querySelector('.sheet select[aria-label="Where to talk to it"]') as HTMLSelectElement).value = 'telegram';
    const doorSel = doc.querySelector('.sheet select[aria-label="Door"]') as HTMLSelectElement;
    expect(doorSel.value).toBe(''); // no default set: "Agent default", so an untouched create sends no pick
    doorSel.value = 'claude-code';
    doorSel.dispatchEvent(new dom.window.Event('change'));
    (doc.querySelector('.sheet button[data-create]') as HTMLButtonElement).click();
    await flush(10);
    expect(writes[1]).toMatchObject({ method: 'POST', url: '/sessions/create', body: { name: 'Bug: cache', headless: false, platform: 'telegram', framework: 'claude-code', model: 'claude-opus-5-5' } });
    expect(writes[1].headers['X-Instar-Request']).toBe('1');
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('Started “Bug: cache” with a Telegram topic on Claude Code.');
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(writes).toHaveLength(2);
  });

  it('a failed list says "can’t tell" with the reason and never "nothing is running"', async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/sessions' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.WebSocket = class { readyState = 0; constructor() { setTimeout(() => { (this as unknown as { onclose?: () => void }).onclose?.(); }, 0); } send() {} close() {} };
    g.fetch = async (url: string) => {
      if (url === '/sessions') return { ok: true, status: 200, json: async () => [] };
      return { ok: false, status: 500, json: async () => ({}) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Can’t tell what is running.');
    expect(doc.body.textContent).toContain('Couldn’t list sessions: the server answered 500, twice.');
    expect(doc.body.textContent).not.toContain('Nothing is running');
    expect(doc.querySelector('.stale-banner')!.textContent).toBe('Live updates paused, reconnecting.');
  });
});
