/**
 * Unit tests for the pool lifecycle hardening from the live-wiring review:
 *   - poolSize validation at construction (loud at boot, not at call time)
 *   - idle-retirement sweep (maxIdleMinutes was dead config before)
 *   - retire(..., { replace: false }) skips respawn (idle path)
 *   - allocate() grows the pool on demand when below poolSize
 *   - orphan recovery: start() kills stale `<prefix>-*` sessions from a
 *     crashed previous process, scoped to OUR prefix only
 *   - sessionPrefix flows into the tmux session name
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const killCalls: string[][] = [];
let listSessionsStdout = '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const handle = (args: string[]): { stdout: string; stderr: string } => {
    if (args[0] === 'list-sessions') return { stdout: listSessionsStdout, stderr: '' };
    if (args[0] === 'kill-session') {
      killCalls.push(args);
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const execFileMock = vi.fn(
    (
      _path: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const { stdout, stderr } = handle(args);
      cb(null, stdout, stderr);
      return {} as ReturnType<typeof actual.execFile>;
    },
  );
  // promisify(execFile) in pool.ts resolves to { stdout, stderr } via the
  // custom-promisify symbol on the REAL execFile — mirror that contract so
  // `const { stdout } = await execFileAsync(...)` destructures correctly.
  (execFileMock as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = (_path: string, args: string[]) => Promise.resolve(handle(args));
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execFile: execFileMock,
  };
});

import { execFileSync } from 'node:child_process';
import { InteractivePool, type PoolSession } from '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.js';
import { configFromEnv } from '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js';

function makePool(overrides: Partial<ReturnType<typeof configFromEnv>> = {}): InteractivePool {
  return new InteractivePool({ ...configFromEnv({}), poolSize: 2, canaryIntervalMs: 0, ...overrides });
}

function seedSession(pool: InteractivePool, id: string, lastUsedAt: number, state: PoolSession['state'] = 'ready'): PoolSession {
  const sess: PoolSession = {
    id,
    tmuxName: `instar-pool-${id}`,
    state,
    messageCount: 0,
    spawnedAt: lastUsedAt,
    lastUsedAt,
  };
  (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set(id, sess);
  return sess;
}

beforeEach(() => {
  killCalls.length = 0;
  listSessionsStdout = '';
  vi.mocked(execFileSync).mockClear();
});

describe('InteractivePool — poolSize validation', () => {
  it.each([0, -1, NaN])('refuses construction with poolSize=%s', (size) => {
    expect(() => makePool({ poolSize: size as number })).toThrow(/poolSize/);
  });

  it('accepts poolSize=1', () => {
    expect(() => makePool({ poolSize: 1 })).not.toThrow();
  });
});

describe('InteractivePool — idle retirement', () => {
  it('retires ready sessions idle past maxIdleMinutes WITHOUT respawning', async () => {
    const pool = makePool({ maxIdleMinutes: 30 });
    const stale = seedSession(pool, 'stale', Date.now() - 31 * 60_000);
    const fresh = seedSession(pool, 'fresh', Date.now() - 1 * 60_000);
    const busy = seedSession(pool, 'busy', Date.now() - 90 * 60_000, 'busy');

    const spawn = vi.fn(async () => {});
    (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;

    (pool as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();
    // retire() is async; give it a tick.
    await new Promise((r) => setTimeout(r, 10));

    const sessions = (pool as unknown as { sessions: Map<string, PoolSession> }).sessions;
    expect(sessions.has(stale.id)).toBe(false); // idle-retired
    expect(sessions.has(fresh.id)).toBe(true); // under the cutoff — kept
    expect(sessions.has(busy.id)).toBe(true); // busy is NEVER idle-retired
    expect(spawn).not.toHaveBeenCalled(); // replace: false — no churn
  });

  it('busy-path retirement (maxMessages) still respawns a replacement', async () => {
    const pool = makePool();
    const sess = seedSession(pool, 's1', Date.now());
    const spawn = vi.fn(async () => {});
    (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;

    await pool.retire(sess); // default replace: true
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('InteractivePool — on-demand growth in allocate()', () => {
  it('an empty (idle-shrunk) pool spawns on allocate instead of waiting out the timeout', async () => {
    const pool = makePool({ poolSize: 1, allocateTimeoutMs: 2_000 });
    const spawn = vi.fn(async () => {
      const sess = seedSession(pool, 'on-demand', Date.now());
      (pool as unknown as { flushWaiter: (s: PoolSession) => void }).flushWaiter(sess);
    });
    (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;

    const got = await pool.allocate();
    expect(got.id).toBe('on-demand');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('InteractivePool — orphan recovery at start()', () => {
  it('kills stale sessions matching OUR prefix and leaves other prefixes alone', async () => {
    const pool = makePool({ poolSize: 1, sessionPrefix: 'instar-pool-echo' });
    listSessionsStdout = [
      'instar-pool-echo-deadbeef', // ours, stale → kill
      'instar-pool-otheragent-cafe', // other agent's pool → MUST survive
      'echo-telegram-1234', // unrelated session → MUST survive
    ].join('\n');
    const spawn = vi.fn(async () => {});
    (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;

    await pool.start();

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]).toContain('=instar-pool-echo-deadbeef:');
  });

  it('start() proceeds cleanly when no tmux server is running', async () => {
    const pool = makePool({ poolSize: 1, sessionPrefix: 'instar-pool-echo' });
    listSessionsStdout = ''; // mock returns empty; real failure path returns too
    const spawn = vi.fn(async () => {});
    (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;
    await expect(pool.start()).resolves.toBeUndefined();
    expect(killCalls).toHaveLength(0);
  });
});

describe('InteractivePool — sessionPrefix in spawn argv', () => {
  it('spawned tmux sessions carry the configured prefix', async () => {
    const pool = makePool({ poolSize: 1, sessionPrefix: 'instar-pool-myagent' });
    (pool as unknown as { waitForReady: () => Promise<boolean> }).waitForReady = async () => true;
    (pool as unknown as { canaryHasRunInCurrentLifetime: boolean }).canaryHasRunInCurrentLifetime = true;
    await (pool as unknown as { spawnOne: () => Promise<void> }).spawnOne();
    const calls = vi.mocked(execFileSync).mock.calls;
    const newSession = calls.find((c) => (c[1] as string[])[0] === 'new-session');
    expect(newSession).toBeDefined();
    const args = newSession![1] as string[];
    const nameIdx = args.indexOf('-s') + 1;
    expect(args[nameIdx]).toMatch(/^instar-pool-myagent-/);
  });
});
