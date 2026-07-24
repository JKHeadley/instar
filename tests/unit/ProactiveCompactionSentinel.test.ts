import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ProactiveCompactionSentinel,
  type ProactiveCompactionCandidate,
} from '../../src/monitoring/ProactiveCompactionSentinel.js';

const candidate = (overrides: Partial<ProactiveCompactionCandidate> = {}): ProactiveCompactionCandidate => ({
  sessionName: 'autonomous-1',
  autonomous: true,
  framework: 'claude-code',
  contextRemainingPercent: 15,
  workState: 'idle',
  ...overrides,
});

describe('ProactiveCompactionSentinel', () => {
  it('is dark unless explicitly enabled', async () => {
    const triggerCompact = vi.fn(() => true);
    const listCandidates = vi.fn(async () => [candidate()]);
    const sentinel = new ProactiveCompactionSentinel({ listCandidates, triggerCompact });

    await sentinel.tick();

    expect(listCandidates).not.toHaveBeenCalled();
    expect(triggerCompact).not.toHaveBeenCalled();
  });

  it('dry-runs at 85% used without changing the session', async () => {
    const triggerCompact = vi.fn(() => true);
    const audit = vi.fn();
    const sentinel = new ProactiveCompactionSentinel(
      { listCandidates: async () => [candidate()], triggerCompact, audit, now: () => 50_000 },
      { enabled: true },
    );

    await sentinel.tick();

    expect(triggerCompact).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'would-compact',
      usedPercent: 85,
    }));
  });

  it('only compacts autonomous Claude sessions at an idle turn boundary', async () => {
    const triggerCompact = vi.fn(() => true);
    const sentinel = new ProactiveCompactionSentinel(
      {
        listCandidates: async () => [
          candidate({ sessionName: 'working', workState: 'working' }),
          candidate({ sessionName: 'interactive', autonomous: false }),
          candidate({ sessionName: 'codex', framework: 'codex-cli' }),
          candidate({ sessionName: 'unknown', workState: 'indeterminate' }),
          candidate({ sessionName: 'safe', contextRemainingPercent: 16 }),
          candidate({ sessionName: 'eligible' }),
        ],
        triggerCompact,
      },
      { enabled: true, dryRun: false },
    );

    await sentinel.tick();

    expect(triggerCompact).toHaveBeenCalledTimes(1);
    expect(triggerCompact).toHaveBeenCalledWith('eligible');
  });

  it('cooldown prevents repeated /compact injections on successive ticks', async () => {
    let now = 10_000;
    const triggerCompact = vi.fn(() => true);
    const sentinel = new ProactiveCompactionSentinel(
      { listCandidates: async () => [candidate()], triggerCompact, now: () => now },
      { enabled: true, dryRun: false, cooldownMs: 60_000 },
    );

    await sentinel.tick();
    now += 30_000;
    await sentinel.tick();
    now += 31_000;
    await sentinel.tick();

    expect(triggerCompact).toHaveBeenCalledTimes(2);
  });

  it('is wired dark, dry-run first, to the canonical idle probe and /compact command', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/server.ts'),
      'utf8',
    );

    expect(source).toContain('proactiveCompactionCfg?.enabled === true');
    expect(source).toContain('checkSessionWorkState(session.tmuxSession)');
    expect(source).toContain("'/compact'");
    expect(source).toContain("'proactive-autonomous-compaction'");
  });
});
