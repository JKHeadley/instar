/**
 * SEC-172 — internal judgments routed through the subscription pool ran in a
 * reused, full-permission `claude` REPL that loaded the agent's project
 * instructions. Judgment prompts can carry text from peer agents, Slack
 * members and team members, so the only protection was the model refusing.
 *
 * The fix, pinned here:
 *   1. every pool REPL is spawned with no built-in tools, no MCP servers,
 *      user settings only (no project CLAUDE.md / hooks) and slash commands
 *      off;
 *   2. every pool REPL serves exactly ONE prompt and is then retired and
 *      replaced, so no judgment reads another judgment's text.
 *
 * No real tmux or claude runs: child_process is mocked at module level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const killed: string[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const handle = (args: string[]): { stdout: string; stderr: string } => {
    if (args[0] === 'kill-session') killed.push(String(args[2]));
    return { stdout: '', stderr: '' };
  };
  const execFileMock = vi.fn(
    (_p: string, args: string[], _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      const r = handle(args);
      cb(null, r.stdout, r.stderr);
      return {} as ReturnType<typeof actual.execFile>;
    },
  );
  (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    _p: string,
    args: string[],
  ) => Promise.resolve(handle(args));
  return { ...actual, execFileSync: vi.fn(() => ''), execFile: execFileMock };
});

import { execFileSync } from 'node:child_process';
import {
  InteractivePool,
  buildPoolReplArgs,
  type PoolSession,
} from '../../src/providers/adapters/anthropic-interactive-pool/pool.js';
import { configFromEnv } from '../../src/providers/adapters/anthropic-interactive-pool/config.js';

type PoolInternals = {
  sessions: Map<string, PoolSession>;
  spawnOne: () => Promise<void>;
  waitForReady: () => Promise<boolean>;
  canaryHasRunInCurrentLifetime: boolean;
};

function makePool(overrides: Partial<ReturnType<typeof configFromEnv>> = {}): InteractivePool {
  return new InteractivePool({ ...configFromEnv({}), poolSize: 2, canaryIntervalMs: 0, maxIdleMinutes: 0, ...overrides });
}

function expectLockedDown(argv: string[]): void {
  const tools = argv.indexOf('--tools');
  expect(tools).toBeGreaterThan(-1);
  // An EMPTY tool list, as its own argument (not swallowed by the next flag).
  expect(argv[tools + 1]).toBe('');
  expect(argv).toContain('--strict-mcp-config');
  const src = argv.indexOf('--setting-sources');
  expect(src).toBeGreaterThan(-1);
  expect(argv[src + 1]).toBe('user');
  expect(argv).toContain('--disable-slash-commands');
  // Never a tool allow-list or an MCP config that could re-open the door.
  expect(argv).not.toContain('--allowedTools');
  expect(argv).not.toContain('--mcp-config');
}

beforeEach(() => {
  killed.length = 0;
  vi.mocked(execFileSync).mockClear();
});

describe('SEC-172 — pool REPL argv is locked down', () => {
  it('buildPoolReplArgs: no tools, no MCP, user settings only, slash commands off (with and without a model)', () => {
    for (const model of [undefined, 'haiku']) {
      const argv = buildPoolReplArgs({ claudePath: '/x/claude', model });
      expect(argv[0]).toBe('/x/claude');
      expectLockedDown(argv);
    }
  });

  it('the real spawn path (tmux new-session) carries the lockdown', async () => {
    const pool = makePool({ poolSize: 1, model: 'haiku' });
    const p = pool as unknown as PoolInternals;
    p.waitForReady = async () => true;
    p.canaryHasRunInCurrentLifetime = true;
    await p.spawnOne();
    const spawnCall = vi.mocked(execFileSync).mock.calls.find((c) => (c[1] as string[])[0] === 'new-session');
    expect(spawnCall).toBeDefined();
    const argv = spawnCall![1] as string[];
    const claudeAt = argv.indexOf(configFromEnv({}).claudePath);
    expect(claudeAt).toBeGreaterThan(-1);
    expectLockedDown(argv.slice(claudeAt));
  });
});

describe('SEC-172 — one prompt per REPL (no carried context)', () => {
  it('release() retires the session and spawns a clean replacement instead of returning it to ready', async () => {
    const pool = makePool();
    const p = pool as unknown as PoolInternals;
    const spawn = vi.fn(async () => {});
    p.spawnOne = spawn;
    const s: PoolSession = { id: 'a', tmuxName: 'instar-pool-a', state: 'ready', messageCount: 0, spawnedAt: 0, lastUsedAt: 0 };
    p.sessions.set('a', s);

    const got = await pool.allocate();
    expect(got.id).toBe('a');
    await pool.release(got);

    expect(p.sessions.has('a')).toBe(false);
    expect(s.state).toBe('dead');
    expect(killed).toContain('=instar-pool-a:');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a session is never handed out twice, even when the old maxMessagesPerSession would have allowed reuse', async () => {
    const pool = makePool({ maxMessagesPerSession: 50 });
    const p = pool as unknown as PoolInternals;
    let n = 0;
    p.spawnOne = async () => {
      const id = `fresh-${++n}`;
      const fresh: PoolSession = { id, tmuxName: `instar-pool-${id}`, state: 'ready', messageCount: 0, spawnedAt: 0, lastUsedAt: 0 };
      p.sessions.set(id, fresh);
    };
    p.sessions.set('first', { id: 'first', tmuxName: 'instar-pool-first', state: 'ready', messageCount: 0, spawnedAt: 0, lastUsedAt: 0 });

    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const s = await pool.allocate();
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
      await pool.release(s);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(seen.size).toBe(4);
  });
  it('a caller waiting for a session is served by the clean replacement after a release', async () => {
    const pool = makePool({ poolSize: 1, allocateTimeoutMs: 2000 });
    const p = pool as unknown as PoolInternals & { flushWaiter: (s: PoolSession) => void };
    p.spawnOne = async () => {
      const fresh: PoolSession = { id: 'replacement', tmuxName: 'instar-pool-replacement', state: 'ready', messageCount: 0, spawnedAt: 0, lastUsedAt: 0 };
      p.sessions.set(fresh.id, fresh);
      p.flushWaiter(fresh);
    };
    p.sessions.set('only', { id: 'only', tmuxName: 'instar-pool-only', state: 'ready', messageCount: 0, spawnedAt: 0, lastUsedAt: 0 });

    const first = await pool.allocate();
    const waiting = pool.allocate();
    await pool.release(first);
    const second = await waiting;
    expect(second.id).toBe('replacement');
    expect(second.id).not.toBe(first.id);
  });
});
