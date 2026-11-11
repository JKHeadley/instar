// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The synthetic press (context-budget-layered-summaries §9.1): the canary's
 * positive control on THROWAWAY sessions only. A channel-bound topic session,
 * a job, a protected session or any session without the reserved name is
 * refused; a throwaway is pressed through the control-command path, recorded
 * through `recordSyntheticPress` first, and the boundary it produces counts as
 * a synthetic positive that lets the canary reach `healthy`. Bounded by the
 * gate: one hour apart, three per day.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionCanary, RECOVERY_MARKER } from '../../src/monitoring/compactionCanary.js';
import { SyntheticPress, pressTargetRefusal, pressTopicKey, PRESS_TARGET_PREFIX, type PressCandidate } from '../../src/monitoring/syntheticPress.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { recordPostCompact } from '../../src/monitoring/PostCompactStore.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/synthetic-press.test.ts';
const MIN = 60_000;

const throwaway: PressCandidate = { id: 'inst-p1', name: `${PRESS_TARGET_PREFIX}canary`, tmuxSession: 'echo-cb-press-canary', framework: 'claude-code', claudeSessionId: 'press-sid' };
const topic: PressCandidate = { id: 'inst-t1', name: 'cb-press-looks-throwaway', tmuxSession: 'echo-141133', framework: 'claude-code', claudeSessionId: 'topic-sid', telegramTopicId: 141133 };

describe('press target refusal', () => {
  it('refuses a channel-bound topic session even with the reserved name; allows a throwaway', () => {
    expect(pressTargetRefusal(topic)).toBe('channel-bound');
    expect(pressTargetRefusal({ ...throwaway, slackChannelId: 'C1' })).toBe('channel-bound');
    expect(pressTargetRefusal(throwaway, { channelFor: () => 141133 })).toBe('channel-bound'); // the adapter maps a topic to it
    expect(pressTargetRefusal(throwaway, { channelFor: () => { throw new Error('adapter down'); } })).toBe('channel-bound');
    expect(pressTargetRefusal(throwaway)).toBeNull();
  });
  it('refuses a non-throwaway name, a job, another engine, an unknown engine session and a protected session', () => {
    expect(pressTargetRefusal({ ...throwaway, name: 'echo-work' })).toBe('not-throwaway');
    expect(pressTargetRefusal({ ...throwaway, jobSlug: 'nightly' })).toBe('job-session');
    expect(pressTargetRefusal({ ...throwaway, framework: 'codex-cli' })).toBe('not-claude-code');
    expect(pressTargetRefusal({ ...throwaway, claudeSessionId: undefined })).toBe('no-engine-session');
    expect(pressTargetRefusal(throwaway, { isProtected: () => true })).toBe('protected');
    expect(pressTargetRefusal(throwaway, { isProtected: () => { throw new Error('x'); } })).toBe('protected');
  });
  it('files a throwaway under a press key, never a topic number', () => {
    expect(pressTopicKey('inst-p1')).toBe('press-inst-p1');
    expect(pressTopicKey('../x')).toBeNull();
  });
});

describe('SyntheticPress', () => {
  let stateDir: string; let now: number; let canary: CompactionCanary; let store: InMemorySelfHealEpisodeStore;
  let candidates: PressCandidate[]; let idle: boolean; let pressed: string[]; let on: boolean;

  const make = () => new SyntheticPress({
    stateDir, machineId: 'm_self', canary, now: () => now, episodeStore: store,
    switchOn: () => on, candidates: () => candidates, checks: {}, isIdle: () => idle,
    press: (t) => { pressed.push(t); return true; },
    admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }),
    consumeToken: () => ({ proceed: true, valid: true }),
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-press-'));
    now = Date.parse('2026-11-10T08:00:00Z');
    canary = new CompactionCanary({ stateDir, machineId: 'm_self', now: () => now });
    canary.scan([], true);
    store = new InMemorySelfHealEpisodeStore();
    candidates = [topic, throwaway]; idle = true; pressed = []; on = true;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('switch off ⇒ presses nothing', async () => {
    on = false;
    expect(await make().tick()).toBe('off');
    expect(pressed).toEqual([]);
  });

  it('presses the throwaway, never the topic session listed before it', async () => {
    expect(await make().tick()).toBe('pressed');
    expect(pressed).toEqual(['echo-cb-press-canary']);
  });

  it('only a channel-bound topic session ⇒ no target, nothing pressed', async () => {
    candidates = [topic];
    expect(await make().tick()).toBe('no-target');
    expect(pressed).toEqual([]);
  });

  it('a busy throwaway is not pressed', async () => {
    idle = false;
    expect(await make().tick()).toBe('no-target');
    expect(pressed).toEqual([]);
  });

  it('bounded: a press waiting for its boundary blocks another; then 1 h apart and 3 per day', async () => {
    const p = make();
    expect(await p.tick()).toBe('pressed');
    now += 5 * MIN; expect(await p.tick()).toBe('pending');
    now += 10 * MIN; expect(await p.tick()).toBe('bounded'); // the 1 h backoff
    now += 50 * MIN; expect(await p.tick()).toBe('pressed');
    now += 61 * MIN; expect(await p.tick()).toBe('pressed');
    now += 61 * MIN; expect(await p.tick()).toBe('bounded'); // 3 per day
    now += 61 * MIN; expect(await p.tick()).toBe('bounded');
    expect(pressed).toHaveLength(3);
  });

  it('the press is the positive control: its boundary with both artifacts lets the canary reach healthy', async () => {
    const transcript = path.join(stateDir, 'press.jsonl'); fs.writeFileSync(transcript, '');
    const scan = () => canary.scan([{ topicKey: 'press-inst-p1', claudeSessionId: 'press-sid', transcriptPath: transcript, engine: 'claude-code' }], true);
    const compaction = (uuid: string, trigger: string) => {
      fs.appendFileSync(transcript, [
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: new Date(now).toISOString(), compactMetadata: { trigger }, version: '2.1.321' }),
        JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', command: 'bash ".instar/hooks/instar/session-start.sh"', stdout: RECOVERY_MARKER, content: RECOVERY_MARKER, exitCode: 0 } }),
      ].join('\n') + '\n');
      recordPostCompact(stateDir, { topicKey: 'press-inst-p1', instarSessionId: 'inst-p1', claudeSessionId: 'press-sid', trigger, summary: 's', receivedAt: now + 500 });
      scan();
    };
    compaction('n1', 'auto'); now += 20 * MIN; compaction('n2', 'auto'); now += 20 * MIN; compaction('n3', 'auto');
    now += 20 * MIN; scan();
    expect(canary.report(true).groups[0].state).toBe('accruing'); // three complete, no positive control
    expect(await make().tick()).toBe('pressed');
    now += 30_000; compaction('p1', 'manual');
    now += 1 * MIN; scan();
    const g = canary.report(true).groups[0];
    expect(g).toMatchObject({ synthetic: 1, state: 'healthy' });
    now += 2 * 60 * MIN;
    expect(await make().tick()).toBe('not-needed');
  });
});
