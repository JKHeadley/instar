// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The Codex adapter's compaction channel (context-budget-layered-summaries
 * §9.6 Codex column, §9.1 canary; Phase 1 S16). Rollout lines are shaped like
 * Codex CLI 0.167.0's (measured on real rollouts 2026-11-10, structure only):
 * a `compacted` entry with `window_id` and an empty `message`; a forked rollout
 * copies its parent's `compacted` entries before its first `token_count`.
 *
 * Both sides of every boundary: Codex vs claude-code; below/above 85% of the
 * window; entry present/absent; gate (contextBudget.enabled) off/on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionCanary, CHANNEL_FRESH_MS, ENGINE_CANARY_PROFILES, type CanarySession, type CanaryEngineHooks } from '../../src/monitoring/compactionCanary.js';
import { classifyCodexRolloutEntry, codexRolloutLineMayMatter } from '../../src/monitoring/CodexRolloutParser.js';
import { trackContextUsage, emitPostCompactFromTranscript, rearmContextUsage, createCompactionLifecycle, _resetCompactionState } from '../../src/providers/adapters/openai-codex/control/compactionLifecycle.js';
import { productionCanarySessions, makeCodexRolloutFinder, codexHomeForTmuxSession } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { sessionHandle } from '../../src/providers/types.js';
import type { PostCompactNotice, PreCompactNotice } from '../../src/providers/primitives/control/compactionLifecycle.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/codex-compaction-channel.test.ts';
const SID = '019a0000-1111-7222-8333-444455556666';
const WIN = 258_400;
const iso = (ms: number) => new Date(ms).toISOString();

const meta = (at: number, extra: Record<string, unknown> = {}) => ({ timestamp: iso(at), type: 'session_meta', payload: { id: SID, timestamp: iso(at), cwd: '/p', cli_version: '0.167.0', ...extra } });
const usage = (at: number, used: number, win: number | null = WIN) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: used }, last_token_usage: { input_tokens: used }, ...(win ? { model_context_window: win } : {}) } } });
const compacted = (at: number, windowId: string, before = 240_000) => ({ timestamp: iso(at), type: 'compacted', payload: { message: '', window_id: windowId, first_window_id: 'w0', previous_window_id: 'w0', window_number: 1, replacement_history: [], latest_token_usage_record: { usage: { input_tokens: before } } } });

describe('classifyCodexRolloutEntry (the rollout parser change)', () => {
  it('a compacted entry with a window_id is a compaction; without one it is nothing', () => {
    expect(classifyCodexRolloutEntry(compacted(1_000, 'w1'))).toMatchObject({ kind: 'compacted', windowId: 'w1', at: 1_000, tokensBefore: 240_000 });
    expect(classifyCodexRolloutEntry({ type: 'compacted', payload: { message: '' } })).toBeNull();
  });
  it('token_count yields the context used and the engine-reported window; session_meta the version and fork origin', () => {
    expect(classifyCodexRolloutEntry(usage(1, 100_000))).toEqual({ kind: 'usage', contextUsed: 100_000, contextWindow: WIN });
    expect(classifyCodexRolloutEntry(usage(1, 0))).toEqual({ kind: 'usage', contextUsed: null, contextWindow: WIN });
    expect(classifyCodexRolloutEntry(meta(1, { forked_from_id: 'p' }))).toEqual({ kind: 'meta', version: '0.167.0', forkedFrom: 'p' });
    expect(classifyCodexRolloutEntry({ type: 'response_item', payload: { type: 'message' } })).toBeNull();
  });
  it('the pre-filter admits only the three entry kinds', () => {
    expect(codexRolloutLineMayMatter(JSON.stringify(compacted(1, 'w')))).toBe(true);
    expect(codexRolloutLineMayMatter(JSON.stringify(usage(1, 5)))).toBe(true);
    expect(codexRolloutLineMayMatter('{"type":"response_item","payload":{"type":"reasoning"}}')).toBe(false);
  });
});

describe('trackContextUsage (the synthesized 85% signal) and the post-compaction producer', () => {
  beforeEach(() => _resetCompactionState());

  it('below 85% of the window: no notice; at/above: one notice per cycle; the producer re-arms it', async () => {
    const h = sessionHandle('s-track');
    const lc = createCompactionLifecycle();
    const ac = new AbortController();
    const pre: PreCompactNotice[] = []; const post: PostCompactNotice[] = [];
    void (async () => { for await (const n of lc.subscribePreCompact(h, { signal: ac.signal })) pre.push(n); })();
    void (async () => { for await (const n of lc.subscribePostCompact(h, { signal: ac.signal })) post.push(n); })();
    await new Promise((r) => setImmediate(r));
    expect(trackContextUsage(h, Math.floor(WIN * 0.85) - 1, WIN)).toBe(false);
    expect(trackContextUsage(h, Math.ceil(WIN * 0.85), WIN)).toBe(true);
    expect(trackContextUsage(h, WIN - 1_000, WIN)).toBe(false); // once per cycle
    emitPostCompactFromTranscript(h, { timestamp: iso(5), windowId: 'w9', tokensBefore: 240_000 });
    expect(trackContextUsage(h, Math.ceil(WIN * 0.85), WIN)).toBe(true); // re-armed
    await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(pre).toHaveLength(2);
    expect(pre[0]).toMatchObject({ source: 'synthesized' });
    expect(post).toHaveLength(1);
    // Codex exposes no summary: the event carries none and says so.
    expect(post[0].summary).toBeNull();
    expect(post[0].providerSpecific).toMatchObject({ 'openai-codex': { source: 'transcript', summary: 'absent', windowId: 'w9' } });
  });

  it('rearmContextUsage re-arms without emitting a post-compaction notice', () => {
    const h = sessionHandle('s-rearm');
    expect(trackContextUsage(h, WIN, WIN)).toBe(true);
    expect(trackContextUsage(h, WIN, WIN)).toBe(false);
    rearmContextUsage(h);
    expect(trackContextUsage(h, WIN, WIN)).toBe(true);
  });

  it('no reported window ⇒ the assumed 200K (170K threshold)', () => {
    expect(trackContextUsage(sessionHandle('s-a'), 169_999)).toBe(false);
    expect(trackContextUsage(sessionHandle('s-b'), 170_000)).toBe(true);
  });
});

describe('the canary\'s Codex group', () => {
  let dir: string; let rollout: string; let now: number; let session: CanarySession;
  let usageCalls: number[]; let produced: string[]; let rearmed: number; let fire: boolean;
  const hooks: CanaryEngineHooks = {
    onUsage: (_s, used, win) => { usageCalls.push(used); return fire && used >= (win ?? 200_000) * 0.85; },
    onCompaction: (_s, d) => { produced.push(d.boundaryUuid); },
    onRearm: () => { rearmed += 1; },
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-canary-'));
    rollout = path.join(dir, `rollout-2026-11-10T10-00-00-${SID}.jsonl`);
    now = Date.parse('2026-11-10T10:00:00Z');
    fs.writeFileSync(rollout, `${JSON.stringify(meta(now - 60_000))}\n`);
    session = { topicKey: '200', claudeSessionId: SID, transcriptPath: rollout, engine: 'codex-cli' };
    usageCalls = []; produced = []; rearmed = 0; fire = true;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));
  const canary = () => new CompactionCanary({ stateDir: dir, machineId: 'm1', now: () => now, engineHooks: hooks });
  const append = (...o: object[]) => fs.appendFileSync(rollout, o.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const codexGroup = (c: CompactionCanary, on = true) => c.report(on).groups.find((g) => g.engine === 'codex-cli');

  it('entry ABSENT: no detection; the group (if any) is uninitialized, never diverged', () => {
    const c = canary();
    c.scan([session], true);
    append(usage(now, 100_000));
    c.scan([session], true);
    expect(codexGroup(c)).toBeUndefined(); // nothing to count yet
    expect(c.report(true).groups[0]).toMatchObject({ engine: 'claude-code', state: 'uninitialized' });
    expect(produced).toEqual([]);
  });

  it('entry PRESENT: a compacted entry ALONE is a detection, marked synthesized, counted, never healed by injection; the producer fires', () => {
    const c = canary();
    c.scan([session], true);
    append(usage(now, 120_000), compacted(now + 1_000, 'w1'));
    c.scan([session], true);
    const g = codexGroup(c)!;
    expect(g).toMatchObject({ engine: 'codex-cli', version: '0.167.0', detected: 1, complete: 0, pending: 0, state: 'counted', marking: 'synthesized' });
    expect(g.profile).toEqual(ENGINE_CANARY_PROFILES['codex-cli']);
    expect(g.profile).toMatchObject({ detection: 'supported', postCompactEvent: 'synthesized', healByInjection: false, recoveryVerifiable: false });
    expect(produced).toEqual(['w1']);
    // Long past the artifact grace it still reads counted (no artifact to miss), never diverged.
    now += 60 * 60_000;
    expect(codexGroup(c)!.state).toBe('counted');
  });

  it('switch off ⇒ n/a for the Codex group too', () => {
    const c = canary();
    append(usage(now, 120_000), compacted(now + 1_000, 'w1'));
    c.scan([session], false);
    expect(codexGroup(c, false)!.state).toBe('n/a');
  });

  it('a forked rollout\'s inherited compacted copies (before its first usage) are not counted; one after usage is', () => {
    fs.writeFileSync(rollout, [meta(now - 1_000, { forked_from_id: 'parent' }), meta(now - 1_000, { cli_version: '0.150.0' }), compacted(now, 'inherited-1'), compacted(now, 'inherited-2'), usage(now + 1, 50_000), compacted(now + 2, 'own-1')].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const c = canary();
    c.scan([session], true);
    expect(codexGroup(c)!).toMatchObject({ detected: 1, version: '0.167.0' });
    expect(produced).toEqual(['own-1']);
  });

  it('the same window_id in a second rollout (a fork\'s copy after usage) counts once', () => {
    const other = path.join(dir, 'rollout-other.jsonl');
    fs.writeFileSync(other, [meta(now), usage(now, 10), compacted(now + 5, 'w1')].map((x) => JSON.stringify(x)).join('\n') + '\n');
    append(usage(now, 10), compacted(now + 1, 'w1'));
    const c = canary();
    c.scan([session, { ...session, claudeSessionId: 'other', transcriptPath: other }], true);
    expect(codexGroup(c)!.detected).toBe(1);
  });

  it('usage below 85%: no signal; above: ONE signal per compaction cycle, re-armed by the next detection; never a detection', () => {
    const c = canary();
    append(usage(now, Math.floor(WIN * 0.85) - 1));
    c.scan([session], true);
    expect(c.report(true).groups.find((g) => g.engine === 'codex-cli')).toBeUndefined();
    append(usage(now + 1, Math.ceil(WIN * 0.85)), usage(now + 2, WIN - 20_000));
    c.scan([session], true);
    expect(codexGroup(c)).toMatchObject({ detected: 0, synthesizedSignals: 1, state: 'uninitialized' });
    append(compacted(now + 3, 'w1'), usage(now + 4, 0), usage(now + 5, Math.ceil(WIN * 0.86)));
    c.scan([session], true);
    expect(codexGroup(c)).toMatchObject({ detected: 1, synthesizedSignals: 2, state: 'counted' });
    // the armed flag is durable: a NEW canary instance (a restart) does not fire again for the same cycle
    append(usage(now + 6, WIN - 10_000));
    canary().scan([session], true);
    expect(codexGroup(canary())!.synthesizedSignals).toBe(2);
  });

  it('a historical compaction (older than the fresh window) is counted and re-arms, but is never announced; history gives no signal', () => {
    const old = now - CHANNEL_FRESH_MS - 60_000;
    const c = canary();
    c.scan([], true); // the epoch starts here...
    now += CHANNEL_FRESH_MS + 120_000; // ...and the server then misses ticks past the fresh window
    fs.writeFileSync(rollout, [meta(old), usage(now - CHANNEL_FRESH_MS - 30_000, WIN - 1_000), compacted(now - CHANNEL_FRESH_MS - 20_000, 'late-1')].map((x) => JSON.stringify(x)).join('\n') + '\n');
    c.scan([session], true);
    expect(codexGroup(c)).toMatchObject({ detected: 1, state: 'counted', synthesizedSignals: 0 });
    expect(produced).toEqual([]);
    expect(usageCalls).toEqual([]);
    expect(rearmed).toBe(1);
    void old;
  });

  it('a token_count with no info is a usage reading with nothing to judge (no crash, no signal)', () => {
    append({ timestamp: iso(now), type: 'event_msg', payload: { type: 'token_count', info: null } }, compacted(now + 1, 'w-null'));
    const c = canary();
    c.scan([session], true);
    expect(codexGroup(c)).toMatchObject({ detected: 1, synthesizedSignals: 0 });
    expect(usageCalls).toEqual([]);
  });

  it('gate on, then OFF: the known Codex transcript is dropped at once — no more scanning, detections or side-channels', () => {
    let on = true;
    const c = new CompactionCanary({ stateDir: dir, machineId: 'm1', now: () => now, engineHooks: hooks, engineInScope: (e) => e !== 'codex-cli' || on });
    c.scan([session], true);
    append(usage(now, 10), compacted(now + 1, 'w-on'));
    c.scan([session], true);
    expect(produced).toEqual(['w-on']);
    on = false;
    append(usage(now + 2, 10), compacted(now + 3, 'w-off'));
    c.scan([session], true); // the session is still passed in (and still running): out of scope regardless
    c.scan([], true);
    expect(produced).toEqual(['w-on']);
    expect(codexGroup(c)!.detected).toBe(1);
    // back on: a fresh read from the start, w-on deduped, w-off now counted
    on = true;
    c.scan([session], true);
    expect(codexGroup(c)!.detected).toBe(2);
  });

  it('a Codex-only epoch still shows the Claude Code row', () => {
    append(usage(now, 10), compacted(now + 1, 'w1'));
    const c = canary();
    c.scan([session], true);
    expect(c.report(true).groups.map((g) => g.engine).sort()).toEqual(['claude-code', 'codex-cli']);
  });

  it('a throwing hook never stops the scan', () => {
    const c = new CompactionCanary({ stateDir: dir, machineId: 'm1', now: () => now, engineHooks: { onUsage: () => { throw new Error('x'); }, onCompaction: () => { throw new Error('y'); }, onRearm: () => { throw new Error('z'); } } });
    append(usage(now, WIN), compacted(now + 1, 'w1'));
    c.scan([session], true);
    expect(codexGroup(c)).toMatchObject({ detected: 1, synthesizedSignals: 0 });
  });

  it('claude-code is untouched: its group stays native, verifiable and healable', () => {
    expect(ENGINE_CANARY_PROFILES['claude-code']).toMatchObject({ recoveryVerifiable: true, healByInjection: true, detection: 'supported' });
    const c = canary();
    c.scan([], true);
    expect(c.report(true).groups[0]).toMatchObject({ engine: 'claude-code', marking: 'native', synthesizedSignals: 0 });
  });
});

describe('productionCanarySessions — the contextBudget.enabled gate', () => {
  const sessions = (rows: unknown[]) => ({ listRunningSessions: () => rows as never, killSessionByTmuxName: () => false, configHomeForSession: () => '/tmp/claude-home' });
  const codexRow = { tmuxSession: 'echo-200', telegramTopicId: 200, framework: 'codex-cli', claudeSessionId: SID };
  const claudeRow = { tmuxSession: 'echo-100', telegramTopicId: 100, framework: 'claude-code', claudeSessionId: 'c1' };

  it('gate OFF: exactly Claude Code (no Codex session in scope); gate ON: the Codex rollout joins', () => {
    let on = false;
    const find = (sid: string, home: string) => path.join(home, 'sessions', `rollout-x-${sid}.jsonl`);
    const scope = productionCanarySessions({ sessions: sessions([codexRow, claudeRow]), projectDir: '/p', codex: { enabled: () => on, homeForSession: () => '/codex-home', findRollout: find } });
    expect(scope().map((s) => s.engine)).toEqual(['claude-code']);
    on = true;
    const all = scope();
    expect(all.map((s) => s.engine)).toEqual(['codex-cli', 'claude-code']);
    expect(all[0]).toMatchObject({ topicKey: '200', claudeSessionId: SID, transcriptPath: `/codex-home/sessions/rollout-x-${SID}.jsonl` });
  });

  it('reads a session\'s CODEX_HOME once, not every tick', () => {
    let reads = 0;
    const scope = productionCanarySessions({ sessions: sessions([codexRow]), projectDir: '/p', codex: { enabled: () => true, homeForSession: () => { reads += 1; return '/h'; }, findRollout: () => '/h/r.jsonl' } });
    scope(); scope(); scope();
    expect(reads).toBe(1);
  });

  it('a failed CODEX_HOME read is not cached (retried next tick)', () => {
    let reads = 0;
    const scope = productionCanarySessions({ sessions: sessions([codexRow]), projectDir: '/p', codex: { enabled: () => true, homeForSession: () => { reads += 1; return undefined; }, findRollout: () => '/h/r.jsonl' } });
    scope(); scope();
    expect(reads).toBe(2);
  });

  it('no codex option at all ⇒ today\'s scope', () => {
    expect(productionCanarySessions({ sessions: sessions([codexRow, claudeRow]), projectDir: '/p' })().map((s) => s.engine)).toEqual(['claude-code']);
  });

  it('a Codex session whose rollout is not on disk yet is left out', () => {
    expect(productionCanarySessions({ sessions: sessions([codexRow]), projectDir: '/p', codex: { enabled: () => true, findRollout: () => '' } })()).toEqual([]);
  });
});

describe('makeCodexRolloutFinder / codexHomeForTmuxSession', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: OP }));

  it('finds a rollout in a recent day directory, caches it, and full-walks at most once an hour when not found', () => {
    const day = path.join(home, 'sessions', '2026', '11', '10'); fs.mkdirSync(day, { recursive: true });
    const f = path.join(day, `rollout-2026-11-10T10-00-00-${SID}.jsonl`); fs.writeFileSync(f, '');
    let walks = 0; let t = 0;
    const find = makeCodexRolloutFinder({ now: () => t, fullWalk: () => { walks += 1; return ''; } });
    expect(find(SID, home, '/p')).toBe(f);
    expect(find('missing', home, '/p')).toBe('');
    expect(find('missing', home, '/p')).toBe('');
    expect(walks).toBe(1);
    t += 61 * 60_000;
    find('missing', home, '/p');
    expect(walks).toBe(2);
  });

  it('reads only CODEX_HOME from tmux; anything else is undefined', () => {
    const run = ((_: string, args: string[]) => ({ status: 0, stdout: `${args[3]}=/home/x/.codex-followme-a\n`, stderr: '' })) as never;
    expect(codexHomeForTmuxSession('echo-200', run)).toBe('/home/x/.codex-followme-a');
    expect(codexHomeForTmuxSession('echo-200', (() => ({ status: 1, stdout: '', stderr: 'unknown variable' })) as never)).toBeUndefined();
    expect(codexHomeForTmuxSession('echo-200', (() => ({ status: 0, stdout: '-CODEX_HOME\n', stderr: '' })) as never)).toBeUndefined();
    expect(codexHomeForTmuxSession('bad name;rm', run)).toBeUndefined();
  });
});
