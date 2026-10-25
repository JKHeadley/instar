/**
 * The inject path must not type into a selection MENU — including on the
 * readiness-TIMEOUT branch.
 *
 * 2026-08-22 incident. Codex 0.147 opened every interactive session on a
 * blocking menu whose focused option runs `npm install -g @openai/codex` and
 * EXITS codex. The readiness probe misclassified that menu as `ready`, the
 * spawn path typed the first message plus Enter into it, and the pane died
 * ~18s after spawn.
 *
 * Fixing the probe alone would have been HALF a fix. `handleReadyAndInject`'s
 * not-ready branch blind-injects whenever the pane is merely alive, so a
 * refusal at the ready check just relocates the same Enter to the timeout
 * branch: the update menu would still have killed the session (~90s in rather
 * than ~18s), and codex's trust-directory prompt would still have been
 * auto-answered `Yes, continue`. A delayed identical outcome is not a fix.
 *
 * So the timeout branch consults `classifyPaneState` — which exists precisely
 * for callers whose not-ready branch is destructive — and refuses. The message
 * is retained as a durable pending inject rather than dropped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
/** What capture-pane returns for a live session — set per test. */
let paneContent = '';
/** Every send-keys invocation, so "did we type into the menu?" is observable. */
const sendKeysInvocations: string[][] = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (!mockTmuxSessions.has(target!)) throw new Error(`no session: ${target}`);
      return '';
    }
    if (args[0] === 'capture-pane') {
      const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '');
      return mockTmuxSessions.has(target!) ? paneContent : '';
    }
    if (args[0] === 'send-keys') {
      sendKeysInvocations.push([...args]);
      return '';
    }
    if (args[0] === 'display-message') return 'codex||codex';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as never;
        try {
          const out = handle(args);
          cb?.(null, { stdout: String(out) });
        } catch (err) {
          cb?.(err as Error, { stdout: '' });
        }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

/** Verbatim codex 0.147 startup menu — the pane that killed sessions. */
const CODEX_UPDATE_MENU = [
  '  ✨ Update available! 0.147.0 -> 0.149.0',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '  Press enter to continue',
].join('\n');

/** A pane that is genuinely just still painting — no menu, no prompt. */
const STILL_BOOTING = [
  '  Loading configuration…',
  '  Starting up, please wait',
].join('\n');

describe('handleReadyAndInject: the timeout branch refuses a MENU pane', () => {
  let tmpDir: string;
  let manager: SessionManager;
  const TMUX = 'test-codex-session';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-inject-menu-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    const state = new StateManager(path.join(tmpDir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: path.basename(tmpDir),
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
      framework: 'codex-cli',
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    mockTmuxSessions.add(TMUX);
    sendKeysInvocations.length = 0;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/inject-refuses-menu-pane.test.ts' });
  });

  it('does NOT type into codex\'s update menu after the readiness timeout', async () => {
    paneContent = CODEX_UPDATE_MENU;
    // Short primary timeout; the extended wait still runs, hence the test timeout.
    await expect((manager as unknown as {
      handleReadyAndInject: (t: string, n: string | undefined, m: string, ms: number, o?: unknown) => Promise<void>;
    }).handleReadyAndInject(TMUX, undefined, 'the user first message', 100, {}))
      .rejects.toThrow('Initial message injection refused for menu-bound session');

    // The property that keeps the session alive: nothing was typed. Any
    // send-keys here would land on `1. Update now`, which exits codex.
    expect(sendKeysInvocations).toHaveLength(0);
  }, 60_000);

  it('STILL blind-injects a merely-unrecognised pane — the fallback is not disabled', async () => {
    // Guard against over-correction: the timeout branch exists for genuine
    // prompt-detection false negatives, and must keep working for them.
    paneContent = STILL_BOOTING;
    await (manager as unknown as {
      handleReadyAndInject: (t: string, n: string | undefined, m: string, ms: number, o?: unknown) => Promise<void>;
    }).handleReadyAndInject(TMUX, undefined, 'the user first message', 100, {});

    expect(sendKeysInvocations.length).toBeGreaterThan(0);
  }, 60_000);
});
