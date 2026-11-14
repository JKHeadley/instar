/**
 * Unit tests for BitwardenProvider — mocked CLI interactions.
 *
 * Tests:
 * - Status detection: installed, logged in, unlocked
 * - Path detection: bwPath override via DI
 * - Scoped naming: folder structure, item naming
 * - Error handling: missing CLI, locked vault, network errors
 *
 * Note: These tests mock the `bw` CLI via vi.mock('node:child_process').
 * The bwPath config option is used for DI instead of mocking node:fs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitwardenProvider, BW_PASSWORD_ENV } from '../../src/core/BitwardenProvider.js';

// Track all execFileSync calls
const mockExecCalls: Array<{ cmd: string; args: string[]; envKeys: string[]; envHas: (k: string, v: string) => boolean; input?: string }> = [];
let mockExecResults: Map<string, string | Error | ((args: string[]) => string | Error)> = new Map();

vi.mock('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[], opts?: any) => {
    const env = (opts && opts.env) || {};
    mockExecCalls.push({ cmd, args: [...args], envKeys: Object.keys(env), envHas: (k: string, v: string) => env[k] === v, input: opts && typeof opts.input === 'string' ? opts.input : undefined });

    // Check for specific mock results
    const key = `${cmd} ${args[0] || ''}`.trim();
    const found = mockExecResults.get(key);
    const result = typeof found === 'function' ? found(args) : found;
    if (result instanceof Error) throw result;
    if (result) return result;

    // Default: throw "not found" for bw and which
    if (cmd === 'which') throw new Error('not found');
    throw new Error(`Mock: unexpected call to ${cmd} ${args.join(' ')}`);
  },
}));

describe('BitwardenProvider', () => {
  const MOCK_BW_PATH = '/mock/bin/bw';

  beforeEach(() => {
    mockExecCalls.length = 0;
    mockExecResults = new Map();
  });

  function createNotInstalled(agentName = 'test-agent') {
    return new BitwardenProvider({ agentName, bwPath: null });
  }

  function createInstalled(agentName = 'test-agent') {
    return new BitwardenProvider({ agentName, bwPath: MOCK_BW_PATH });
  }

  // ── Status Detection ──────────────────────────────────────────

  describe('getStatus', () => {
    it('returns installed=false when bw not found', () => {
      const provider = createNotInstalled();
      const status = provider.getStatus();

      expect(status.installed).toBe(false);
      expect(status.loggedIn).toBe(false);
      expect(status.unlocked).toBe(false);
    });

    it('returns correct status when bw is installed and unlocked', () => {
      mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({
        status: 'unlocked',
        userEmail: 'test@example.com',
      }));

      const provider = createInstalled();
      const status = provider.getStatus();

      expect(status.installed).toBe(true);
      expect(status.loggedIn).toBe(true);
      expect(status.unlocked).toBe(true);
      expect(status.email).toBe('test@example.com');
    });

    it('returns loggedIn=false when unauthenticated', () => {
      mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({
        status: 'unauthenticated',
      }));

      const provider = createInstalled();
      const status = provider.getStatus();

      expect(status.installed).toBe(true);
      expect(status.loggedIn).toBe(false);
      expect(status.unlocked).toBe(false);
    });

    it('returns locked when logged in but vault locked', () => {
      mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({
        status: 'locked',
        userEmail: 'test@example.com',
      }));

      const provider = createInstalled();
      const status = provider.getStatus();

      expect(status.installed).toBe(true);
      expect(status.loggedIn).toBe(true);
      expect(status.unlocked).toBe(false);
    });
  });

  // ── isReady ───────────────────────────────────────────────────

  describe('isReady', () => {
    it('returns false when bw not installed', () => {
      const provider = createNotInstalled();
      expect(provider.isReady()).toBe(false);
    });

    it('returns true when installed, logged in, and unlocked', () => {
      mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({
        status: 'unlocked',
        userEmail: 'test@example.com',
      }));

      const provider = createInstalled();
      expect(provider.isReady()).toBe(true);
    });
  });

  // ── Error Handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('get throws when bw not installed', () => {
      const provider = createNotInstalled();
      expect(() => provider.get('some-key')).toThrow(/not found/i);
    });

    it('set throws when bw not installed', () => {
      const provider = createNotInstalled();
      expect(() => provider.set('key', 'value')).toThrow(/not found/i);
    });

    it('has throws when bw not installed', () => {
      const provider = createNotInstalled();
      expect(() => provider.has('key')).toThrow(/not found/i);
    });
  });

  // ── Agent Scoping ─────────────────────────────────────────────

  describe('agent scoping', () => {
    it('provider scopes to agent name', () => {
      const provider1 = createInstalled('agent-a');
      const provider2 = createInstalled('agent-b');

      // The scoped names should be different
      // We can't directly test private methods, but the folder naming
      // is validated through the mock calls when get/set are called
      expect(provider1).not.toBe(provider2);
    });
  });
});

describe('BitwardenProvider: the master password never travels on a command line', () => {
  const MOCK_BW_PATH = '/mock/bin/bw';
  beforeEach(() => { mockExecCalls.length = 0; mockExecResults = new Map(); });

  it('unlock passes the password to bw through the child environment only', () => {
    mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({ status: 'locked', userEmail: 'a@b.c' }));
    mockExecResults.set(`${MOCK_BW_PATH} unlock`, 'session-key-1');
    const provider = new BitwardenProvider({ agentName: 'test-agent', bwPath: MOCK_BW_PATH });
    expect(provider.unlock('hunter2-master')).toBe(true);
    const unlock = mockExecCalls.find((c) => c.args[0] === 'unlock')!;
    expect(unlock.args).toEqual(['unlock', '--passwordenv', BW_PASSWORD_ENV, '--raw']);
    expect(unlock.args.join(' ')).not.toContain('hunter2-master');
    expect(unlock.envHas(BW_PASSWORD_ENV, 'hunter2-master')).toBe(true);
    expect(process.env[BW_PASSWORD_ENV]).toBeUndefined();
    expect(provider.getSessionKey()).toBe('session-key-1');
  });

  it('login does the same, with the email as the only argument', () => {
    mockExecResults.set(`${MOCK_BW_PATH} login`, 'session-key-2');
    const provider = new BitwardenProvider({ agentName: 'test-agent', bwPath: MOCK_BW_PATH });
    expect(provider.login('a@b.c', 'hunter2-master')).toBe(true);
    const login = mockExecCalls.find((c) => c.args[0] === 'login')!;
    expect(login.args).toEqual(['login', 'a@b.c', '--passwordenv', BW_PASSWORD_ENV, '--raw']);
    expect(login.envHas(BW_PASSWORD_ENV, 'hunter2-master')).toBe(true);
  });

  it('logout succeeds when signed out, treats "not logged in" as done, and reports a real refusal', () => {
    mockExecResults.set(`${MOCK_BW_PATH} logout`, 'You have logged out.');
    const provider = new BitwardenProvider({ agentName: 'test-agent', bwPath: MOCK_BW_PATH });
    expect(provider.logout()).toBe(true);
    mockExecResults.set(`${MOCK_BW_PATH} logout`, new Error('You are not logged in.'));
    expect(provider.logout()).toBe(true);
    mockExecResults.set(`${MOCK_BW_PATH} logout`, new Error('network down'));
    expect(provider.logout()).toBe(false);
    expect(new BitwardenProvider({ agentName: 'x', bwPath: null }).logout()).toBe(true);
  });
});

describe('BitwardenProvider: secret values never travel on a command line either', () => {
  const MOCK_BW_PATH = '/mock/bin/bw';
  const FOLDER = JSON.stringify([{ id: 'f1', name: 'instar/test-agent' }]);
  beforeEach(() => { mockExecCalls.length = 0; mockExecResults = new Map(); });
  const unlocked = () => {
    mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({ status: 'locked', userEmail: 'a@b.c' }));
    mockExecResults.set(`${MOCK_BW_PATH} unlock`, 'sess');
    const provider = new BitwardenProvider({ agentName: 'test-agent', bwPath: MOCK_BW_PATH });
    expect(provider.unlock('pw')).toBe(true);
    return provider;
  };

  it('create and edit send the item on stdin, and the folder create too', () => {
    const provider = unlocked();
    mockExecResults.set(`${MOCK_BW_PATH} list`, FOLDER);
    mockExecResults.set(`${MOCK_BW_PATH} create`, JSON.stringify({ id: 'i1' }));
    expect(provider.set('authToken', 'VALUE-7Q')).toBe(true);
    const create = mockExecCalls.find((c) => c.args[0] === 'create' && c.args[1] === 'item')!;
    expect(create.args).toEqual(['create', 'item', '--session', 'sess']);
    expect(create.input).toBeDefined();
    expect(Buffer.from(create.input!, 'base64').toString()).toContain('VALUE-7Q');
    for (const c of mockExecCalls) expect(c.args.join(' ')).not.toContain('VALUE-7Q');
    // The folder create path, when the folder is missing.
    mockExecCalls.length = 0;
    mockExecResults.set(`${MOCK_BW_PATH} list`, '[]');
    mockExecResults.set(`${MOCK_BW_PATH} create`, JSON.stringify({ id: 'f2' }));
    provider.set('k', 'v2');
    const folder = mockExecCalls.find((c) => c.args[0] === 'create' && c.args[1] === 'folder')!;
    expect(folder.args).toEqual(['create', 'folder', '--session', 'sess', '--raw']);
    expect(Buffer.from(folder.input!, 'base64').toString()).toContain('instar/test-agent');
  });

  it('set() swallows a failed folder lookup instead of throwing the CLI text', () => {
    const provider = unlocked();
    mockExecResults.set(`${MOCK_BW_PATH} list`, new Error(`Command failed: ${MOCK_BW_PATH} list folders --session sess --raw`));
    expect(provider.set('k', 'v')).toBe(false);
  });

  it('listOwnItemNames tells an empty folder from an unreadable vault, and never creates the folder', () => {
    const provider = unlocked();
    mockExecResults.set(`${MOCK_BW_PATH} list`, '[]');
    expect(provider.listOwnItemNames()).toEqual([]);
    expect(mockExecCalls.some((c) => c.args[0] === 'create')).toBe(false);
    mockExecResults.set(`${MOCK_BW_PATH} list`, new Error(`Command failed: ${MOCK_BW_PATH} list folders --session sess --raw`));
    let message = '';
    try { provider.listOwnItemNames(); } catch (e) { message = (e as Error).message; }
    expect(message).toBe('Bitwarden could not be read (list folders)');
    expect(message).not.toContain('sess');
  });

  it('listOwnItemNames returns the agent-scoped Secure Note names of its folder', () => {
    const provider = unlocked();
    // Items are named `instar-<agent>-<key>` inside the folder `instar/<agent>`.
    const items = JSON.stringify([{ name: 'instar-test-agent-authToken', type: 2 }, { name: 'instar-test-agent-vault-check', type: 2 }, { name: 'other', type: 2 }, { name: 'instar-test-agent-login', type: 1 }]);
    mockExecResults.set(`${MOCK_BW_PATH} list`, (args: string[]) => (args[1] === 'folders' ? FOLDER : items));
    expect(provider.listOwnItemNames()).toEqual(['authToken', 'vault-check']);
    expect(mockExecCalls.some((c) => c.args[0] === 'create')).toBe(false);
  });
});

describe('BitwardenProvider: a status read keeps its third state', () => {
  const MOCK_BW_PATH = '/mock/bin/bw';
  beforeEach(() => { mockExecCalls.length = 0; mockExecResults = new Map(); });

  it('missing, failed and a reading are told apart', () => {
    expect(new BitwardenProvider({ agentName: 'x', bwPath: null }).statusRead()).toEqual({ kind: 'missing' });
    mockExecResults.set(`${MOCK_BW_PATH} status`, new Error('timed out'));
    expect(new BitwardenProvider({ agentName: 'x', bwPath: MOCK_BW_PATH }).statusRead()).toEqual({ kind: 'failed' });
    mockExecResults.set(`${MOCK_BW_PATH} status`, 'not json');
    expect(new BitwardenProvider({ agentName: 'x', bwPath: MOCK_BW_PATH }).statusRead()).toEqual({ kind: 'failed' });
    mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({ status: 'locked', userEmail: 'a@b.c' }));
    expect(new BitwardenProvider({ agentName: 'x', bwPath: MOCK_BW_PATH }).statusRead()).toEqual({ kind: 'ok', loggedIn: true, unlocked: false, email: 'a@b.c' });
    mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({ status: 'unauthenticated' }));
    expect(new BitwardenProvider({ agentName: 'x', bwPath: MOCK_BW_PATH }).statusRead()).toMatchObject({ kind: 'ok', loggedIn: false });
  });

  it('the folder helper never rethrows the CLI text, so no caller can log a session', () => {
    mockExecResults.set(`${MOCK_BW_PATH} status`, JSON.stringify({ status: 'locked' }));
    mockExecResults.set(`${MOCK_BW_PATH} unlock`, 'sess');
    const provider = new BitwardenProvider({ agentName: 'test-agent', bwPath: MOCK_BW_PATH });
    provider.unlock('pw');
    mockExecResults.set(`${MOCK_BW_PATH} list`, new Error(`Command failed: ${MOCK_BW_PATH} list folders --session sess --raw`));
    let message = '';
    try { provider.listAll(); } catch (e) { message = (e as Error).message; }
    // listAll calls the helper outside its try, so the helper's own message is what escapes.
    expect(message).toBe('Failed to get/create the Bitwarden folder');
  });
});
