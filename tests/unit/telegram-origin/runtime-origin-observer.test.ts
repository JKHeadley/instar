import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import type { OriginHarness, OriginSessionBinding } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';

const native = '11111111-1111-4111-8111-111111111111';
const fixtures = path.resolve('tests/fixtures/telegram-origin-native');
const binding = (harnessId: OriginHarness): OriginSessionBinding => ({
  agentId: 'agent', machineId: 'host', sessionId: 'instar-session', sessionIncarnation: 'incarnation',
  issuedAt: '2026-09-06T00:00:00Z', harnessId, projectDir: '/fixture', configuredModel: 'requested-only', nativeSessionId: native,
});
describe('RuntimeOriginObserver native file controls', () => {
  let directory: string;
  let observer: RuntimeOriginObserver;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'origin-observer-')); observer = new RuntimeOriginObserver(); });
  afterEach(async () => { observer.stop(); await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'test:runtime-origin-observer:cleanup' }); });
  async function enroll(harness: OriginHarness, fixture: string): Promise<string> {
    const file = path.join(directory, fixture);
    await copyFile(path.join(fixtures, fixture), file);
    let eventsPath: string | undefined;
    if (harness === 'grok-build') {
      eventsPath = path.join(directory, 'events.jsonl');
      await copyFile(path.join(fixtures, 'grok-events.jsonl'), eventsPath);
    }
    observer.track(binding(harness), { path: file, nativeSessionId: native, eventsPath });
    await observer.refresh('instar-session');
    return file;
  }
  it.each([
    ['codex-cli', 'codex.jsonl', 'gpt-native-second'],
    ['claude-code', 'claude.jsonl', 'claude-native-second'],
    ['gemini-cli', 'gemini.json', 'gemini-native-second'],
    ['pi-cli', 'pi.jsonl', 'pi-native-second'],
    ['grok-build', 'grok-history.jsonl', 'grok-4.6-build'],
  ] as const)('%s observes the current authored model instead of requested configuration', async (harness, fixture, model) => {
    await enroll(harness, fixture);
    expect(observer.get('instar-session')).toMatchObject({ configuredModel: 'requested-only', model: { status: 'observed', value: model } });
  });
  it.each([
    ['codex-cli', 'codex.jsonl', { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }],
    ['claude-code', 'claude.jsonl', { type: 'user', sessionId: native, uuid: 'new-turn', message: { role: 'user', content: 'New' } }],
    ['pi-cli', 'pi.jsonl', { type: 'message', id: 'new-turn', parentId: 'answer-b', message: { role: 'user', content: 'New' } }],
    ['grok-build', 'grok-history.jsonl', { type: 'user', prompt_index: 3, content: 'New' }],
  ] as const)('%s cannot carry a previous observation into a new turn', async (harness, fixture, row) => {
    const file = await enroll(harness, fixture);
    await appendFile(file, `${JSON.stringify(row)}\n`);
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'configured', value: 'requested-only' });
  });
  it('Gemini snapshot replacement invalidates prior-turn model and rejects foreign UUID', async () => {
    const file = await enroll('gemini-cli', 'gemini.json');
    await writeFile(file, JSON.stringify({ sessionId: native, messages: [{ id: 'new', type: 'user' }, { id: 'synthetic', type: 'gemini' }] }));
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
    await writeFile(file, JSON.stringify({ sessionId: 'foreign', messages: [{ id: 'new', type: 'user' }, { type: 'gemini', model: 'forged' }] }));
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
  });
  it('Codex rejects an old turn_context after a new task_started', async () => {
    const file = await enroll('codex-cli', 'codex.jsonl');
    await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } }) + '\n' +
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-b', model: 'stale' } }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')).toMatchObject({ turnId: 'new', model: { status: 'configured' } });
  });
  it('Claude tool results and helper records do not replace the parent author', async () => {
    const file = await enroll('claude-code', 'claude.jsonl');
    await appendFile(file, JSON.stringify({ type: 'user', sessionId: native, uuid: 'tool', message: { content: [{ type: 'tool_result' }] } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: native, isSidechain: true, message: { model: 'helper-model' } }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.value).toBe('claude-native-second');
  });
  it('Pi selects the active parent chain rather than the latest other-branch model', async () => {
    const file = await enroll('pi-cli', 'pi.jsonl');
    await appendFile(file, JSON.stringify({ type: 'message', id: 'branch-tool', parentId: 'answer-a', message: { role: 'toolResult' } }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.value).toBe('pi-native-first');
    await appendFile(file, JSON.stringify({ type: 'model_change', id: 'configured', parentId: 'branch-tool', modelId: 'not-generated' }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
  });
  it('Grok turn-start invalidates history evidence without promoting requested model', async () => {
    await enroll('grok-build', 'grok-history.jsonl');
    await appendFile(path.join(directory, 'events.jsonl'), JSON.stringify({ type: 'turn_started', session_id: native, turn_number: 99, model_id: 'requested-new' }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'configured', value: 'requested-only' });
  });
  it('incomplete records, truncation and native replacement cannot expose stale evidence', async () => {
    const file = await enroll('codex-cli', 'codex.jsonl');
    await appendFile(file, '{"type":');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'wrong-native' } }) + '\n');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
    observer.bindNative('instar-session', 'replacement');
    expect(observer.get('instar-session')).toMatchObject({ nativeSessionId: 'replacement', turnId: null, model: { status: 'configured' } });
  });
  it('bounded backlog stays unavailable until caught up; get performs no source read', async () => {
    observer.stop(); observer = new RuntimeOriginObserver({ maxBytesPerRefresh: 256 });
    const file = await enroll('codex-cli', 'codex.jsonl');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
    for (let i = 0; i < 8; i++) await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.value).toBe('gpt-native-second');
    await SafeFsExecutor.safeRm(file, { operation: 'test:runtime-origin-observer:remove-transcript' });
    expect(observer.get('instar-session')?.model.value).toBe('gpt-native-second');
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.status).toBe('configured');
  });
  // Operator report 2026-11-12: a Claude Code footer read "unknown" model. One transcript record larger
  // than a single read (a screenshot or a big tool result) used to poison the whole session as
  // "malformed-native-record" forever, and a send-time read of a backlog answered "unknown".
  const claudeRow = (row: Record<string, unknown>) => JSON.stringify({ sessionId: native, ...row }) + '\n';
  it('a Claude record larger than one read is joined across reads, not treated as malformed', async () => {
    observer.stop(); observer = new RuntimeOriginObserver({ maxBytesPerRefresh: 1024 });
    const file = await enroll('claude-code', 'claude.jsonl');
    for (let i = 0; i < 4; i++) await observer.refresh('instar-session');
    const big = 'x'.repeat(10_000);
    await appendFile(file, claudeRow({ type: 'user', uuid: 'tool-big', message: { role: 'user', content: [{ type: 'tool_result', content: big }] } }) +
      claudeRow({ type: 'assistant', uuid: 'answer-c', message: { role: 'assistant', model: 'claude-after-big-record', content: [] } }));
    for (let i = 0; i < 20; i++) await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'observed', value: 'claude-after-big-record' });
    expect(observer.get('instar-session')?.model.reason).toBeUndefined();
  });
  it('a record over the per-record bound is skipped; the next turn is observed again', async () => {
    observer.stop(); observer = new RuntimeOriginObserver({ maxBytesPerRefresh: 1024, maxRecordBytes: 4096 });
    const file = await enroll('claude-code', 'claude.jsonl');
    await appendFile(file, claudeRow({ type: 'user', uuid: 'tool-huge', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(20_000) }] } }) +
      claudeRow({ type: 'assistant', uuid: 'answer-d', message: { role: 'assistant', model: 'same-turn-after-skip', content: [] } }));
    await observer.refresh('instar-session', { catchUp: true });
    // What the skipped record held is unseen, so this turn reads configured, never a guessed observation.
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'configured', value: 'requested-only' });
    await appendFile(file, claudeRow({ type: 'user', uuid: 'user-e', message: { role: 'user', content: 'Next prompt' } }) +
      claudeRow({ type: 'assistant', uuid: 'answer-e', message: { role: 'assistant', model: 'claude-next-turn', content: [] } }));
    await observer.refresh('instar-session', { catchUp: true });
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'observed', value: 'claude-next-turn' });
  });
  it('a send-time catch-up refresh reads the whole backlog in one call; the poll step stays bounded', async () => {
    observer.stop(); observer = new RuntimeOriginObserver({ maxBytesPerRefresh: 256 });
    observer.track(binding('claude-code'), { path: path.join(directory, 'claude-backlog.jsonl'), nativeSessionId: native });
    const rows = [claudeRow({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Prompt' } })];
    for (let i = 0; i < 40; i++) rows.push(claudeRow({ type: 'assistant', uuid: `a${i}`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } }));
    await writeFile(path.join(directory, 'claude-backlog.jsonl'), rows.join(''));
    await observer.refresh('instar-session');
    expect(observer.get('instar-session')?.model.reason).toBe('source-backlog-or-partial-record');
    await observer.refresh('instar-session', { catchUp: true });
    expect(observer.get('instar-session')?.model).toMatchObject({ status: 'observed', value: 'claude-opus-5-5' });
  });
  // Live 2026-11-12 (Mac Studio): sessions spawned in a topic worktree, then re-enrolled after a
  // server restart with the agent home as projectDir, read "source-unreadable" for life: Claude Code
  // keeps the transcript under the worktree folder, and the missing path was never looked up again.
  it('finds a Claude transcript in a sibling project folder, and looks again after a missing file', async () => {
    let now = 1_000_000;
    observer.stop(); observer = new RuntimeOriginObserver({ now: () => now });
    const home = path.join(directory, 'claude-home');
    const b = { ...binding('claude-code'), configHome: home, projectDir: '/agents/echo' };
    observer.track(b);
    await observer.refresh(b.sessionId);
    expect(observer.get(b.sessionId)?.model).toMatchObject({ status: 'configured', reason: 'native-source-unavailable' });
    const folder = path.join(home, 'projects', '-agents-echo--instar-worktrees-topic-42');
    await mkdir(folder, { recursive: true });
    await copyFile(path.join(fixtures, 'claude.jsonl'), path.join(folder, `${native}.jsonl`));
    now += 6_000; // past the discovery throttle
    await observer.refresh(b.sessionId, { catchUp: true });
    expect(observer.get(b.sessionId)?.model).toMatchObject({ status: 'observed', value: 'claude-native-second' });
  });
  it('a cached path that disappears is rediscovered instead of read forever', async () => {
    let now = 1_000_000;
    observer.stop(); observer = new RuntimeOriginObserver({ now: () => now });
    const home = path.join(directory, 'claude-home-2');
    const exact = path.join(home, 'projects', '-agents-echo');
    await mkdir(exact, { recursive: true });
    await copyFile(path.join(fixtures, 'claude.jsonl'), path.join(exact, `${native}.jsonl`));
    const b = { ...binding('claude-code'), configHome: home, projectDir: '/agents/echo' };
    observer.track(b);
    await observer.refresh(b.sessionId);
    expect(observer.get(b.sessionId)?.model.status).toBe('observed');
    const moved = path.join(home, 'projects', '-agents-echo-moved');
    await mkdir(moved, { recursive: true });
    await rename(path.join(exact, `${native}.jsonl`), path.join(moved, `${native}.jsonl`));
    await appendFile(path.join(moved, `${native}.jsonl`), '');
    now += 1;
    await observer.refresh(b.sessionId);
    expect(observer.get(b.sessionId)?.model.reason).toBe('source-unreadable');
    now += 6_000;
    await observer.refresh(b.sessionId, { catchUp: true });
    expect(observer.get(b.sessionId)?.model).toMatchObject({ status: 'observed', value: 'claude-native-second' });
  });
  // Live 2026-11-12: Codex homes on the Mac Studio hold 5,039 to 8,083 rollout files. The old
  // breadth-first walk spent its 5,000-entry budget on old days, so new sessions read
  // "native-source-unavailable".
  it('finds today\'s Codex rollout in a home with more old rollouts than the walk budget', async () => {
    const home = path.join(directory, 'codex-home');
    const old = path.join(home, 'sessions', '2025', '01', '01');
    await mkdir(old, { recursive: true });
    await Promise.all(Array.from({ length: 5200 }, (_, i) => writeFile(path.join(old, `rollout-2025-01-01T00-00-00-old-${i}.jsonl`), '')));
    const today = path.join(home, 'sessions', '2026', '11', '12');
    await mkdir(today, { recursive: true });
    await copyFile(path.join(fixtures, 'codex.jsonl'), path.join(today, `rollout-2026-11-12T10-00-00-${native}.jsonl`));
    const b = { ...binding('codex-cli'), configHome: home };
    observer.track(b);
    await observer.refresh(b.sessionId, { catchUp: true });
    expect(observer.get(b.sessionId)?.model).toMatchObject({ status: 'observed', value: 'gpt-native-second' });
  });
  it('unknown stays explicit without configuration and expired observations degrade', async () => {
    let now = 100_000;
    observer.stop(); observer = new RuntimeOriginObserver({ now: () => now, freshnessMs: 100 });
    await enroll('codex-cli', 'codex.jsonl');
    now += 101;
    expect(observer.get('instar-session')?.model.reason).toBe('observation-stale');
    const b = binding('pi-cli'); delete b.configuredModel; delete b.nativeSessionId;
    observer.track(b); await observer.refresh(b.sessionId);
    expect(observer.get(b.sessionId)?.model).toMatchObject({ status: 'unknown', value: null, reason: 'native-session-unbound' });
  });
});
