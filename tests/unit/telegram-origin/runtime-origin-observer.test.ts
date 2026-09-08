import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
