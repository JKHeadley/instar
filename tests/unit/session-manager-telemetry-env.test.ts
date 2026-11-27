// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Skill-learning sentinel slice 0, decision 18: every tmux spawn site exports
 * `INSTAR_MACHINE_ID` beside `INSTAR_SESSION_NAME` so the skill-usage telemetry
 * hook can attribute a row to the machine that produced it, and `INSTAR_TOPIC_ID`
 * wherever the spawn knows its topic. The machine id comes from an injected
 * provider (production: the machine identity loader); no provider, a null/undefined
 * answer, or an id outside `^[\w-]{1,64}$` → the export is OMITTED, never blank.
 * tmux is mocked at node:child_process, mirroring session-manager-triage-spawn.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const newSessionArgvs: string[][] = [];
let lastScreen = '';

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'send-keys') {
      if (args.includes('-l')) {
        let at = args.indexOf('-l') + 1;
        if (args[at] === '--') at += 1;
        lastScreen = `${'─'.repeat(80)}\n❯ ${args[at]}\n${'─'.repeat(80)}\n  ⏵⏵ don't ask on (shift+tab to cycle)`;
      }
      return '';
    }
    if (args[0] === 'capture-pane') return lastScreen;
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager, type SessionManagerOptions } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

function makeManager(tmpDir: string, mode: 'off' | 'force', opts: SessionManagerOptions = {}) {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  // Real binaries so the interactive/triage lanes' binary-exists checks pass.
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\n'); fs.chmodSync(claude, 0o755);
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux', claudePath: claude,
    frameworkBinaryPaths: { 'claude-code': claude },
    projectName: 'proj', projectDir: tmpDir, maxSessions: 20, protectedSessions: [], completionPatterns: [],
    authToken: 'agent-token',
    subscriptionPathMode: mode,
    retainedClaudeBinary: { enabled: false },
  } as SessionManagerConfig;
  const manager = new SessionManager(config, state, { bindMaintenanceTickForTesting: () => {}, ...opts });
  (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> }).waitForClaudeReadyWithRetry = async () => true;
  (manager as unknown as { injectAfterReady: () => Promise<void> }).injectAfterReady = async () => {};
  return manager;
}

const envOf = (argv: string[]) => argv.filter((_a, i) => argv[i - 1] === '-e');
const keysOf = (argv: string[]) => envOf(argv).map((kv) => kv.split('=')[0]);

/** The four spawn sites, each driven through its public entry. */
const SITES: Record<string, (m: SessionManager, n: number) => Promise<void>> = {
  'headless (spawnSession, mode off)': async (m, n) => {
    await m.spawnSession({ name: `head-${n}`, prompt: 'go', framework: 'claude-code', topicId: 700 + n });
  },
  'rerouted-interactive (spawnSession, mode force)': async (m, n) => {
    await m.spawnSession({ name: `rr-${n}`, prompt: 'go', framework: 'claude-code', topicId: 800 + n });
  },
  'interactive (spawnInteractiveSession)': async (m, n) => {
    await m.spawnInteractiveSession(undefined, `topic-i${n}`, { telegramTopicId: 900 + n });
  },
  'triage (spawnTriageSession)': async (m, n) => {
    await m.spawnTriageSession(`triage-${n}`, { allowedTools: ['Read'], permissionMode: 'dontAsk' });
  },
};
const modeOf = (site: string): 'off' | 'force' => (site.startsWith('rerouted') ? 'force' : 'off');
const topicOf = (site: string, n: number): number | null =>
  site.startsWith('headless') ? 700 + n : site.startsWith('rerouted') ? 800 + n : site.startsWith('interactive') ? 900 + n : null;

describe('INSTAR_MACHINE_ID / INSTAR_TOPIC_ID tmux exports (skill-learning slice 0, decision 18)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-telemetry-env-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
    lastScreen = '';
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-telemetry-env.test.ts' });
  });

  let n = 0;
  for (const [site, drive] of Object.entries(SITES)) {
    describe(site, () => {
      it('carries INSTAR_MACHINE_ID beside INSTAR_SESSION_NAME when the provider returns a valid id', async () => {
        n += 1;
        const manager = makeManager(tmpDir, modeOf(site), { machineId: () => 'mach_Abc-123' });
        await drive(manager, n);
        const argv = newSessionArgvs.at(-1)!;
        const env = envOf(argv);
        expect(env.some((kv) => kv.startsWith('INSTAR_SESSION_NAME='))).toBe(true);
        expect(env).toContain('INSTAR_MACHINE_ID=mach_Abc-123');
        expect(env.filter((kv) => kv.startsWith('INSTAR_MACHINE_ID='))).toHaveLength(1);
        const topic = topicOf(site, n);
        if (topic !== null) {
          expect(env).toContain(`INSTAR_TOPIC_ID=${topic}`);
        } else {
          expect(keysOf(argv)).not.toContain('INSTAR_TOPIC_ID');
        }
      });

      it('omits INSTAR_MACHINE_ID entirely (no blank export) when the provider returns undefined', async () => {
        n += 1;
        const manager = makeManager(tmpDir, modeOf(site), { machineId: () => undefined });
        await drive(manager, n);
        const argv = newSessionArgvs.at(-1)!;
        expect(keysOf(argv)).not.toContain('INSTAR_MACHINE_ID');
        expect(envOf(argv)).toContain(`INSTAR_SESSION_NAME=${argv[argv.indexOf('-s') + 1]}`);
      });

      it('omits INSTAR_MACHINE_ID when no provider is wired at all', async () => {
        n += 1;
        const manager = makeManager(tmpDir, modeOf(site));
        await drive(manager, n);
        expect(keysOf(newSessionArgvs.at(-1)!)).not.toContain('INSTAR_MACHINE_ID');
      });

      for (const bad of ['', 'has space', 'semi;colon', 'x'.repeat(65), 'dot.ted', '$(rm)']) {
        it(`omits INSTAR_MACHINE_ID for an id that fails ^[\\w-]{1,64}$ (${JSON.stringify(bad.length > 20 ? bad.slice(0, 8) + '…×65' : bad)})`, async () => {
          n += 1;
          const manager = makeManager(tmpDir, modeOf(site), { machineId: () => bad });
          await drive(manager, n);
          const env = envOf(newSessionArgvs.at(-1)!);
          expect(env.filter((kv) => kv.startsWith('INSTAR_MACHINE_ID'))).toEqual([]);
        });
      }
    });
  }

  it('a provider that throws is treated as unavailable (spawn still succeeds, export omitted)', async () => {
    const manager = makeManager(tmpDir, 'off', { machineId: () => { throw new Error('identity.json unreadable'); } });
    await manager.spawnSession({ name: 'throwing-provider', prompt: 'go', framework: 'claude-code' });
    expect(keysOf(newSessionArgvs.at(-1)!)).not.toContain('INSTAR_MACHINE_ID');
  });

  it('confined headless spawn (env -i allowlist) still passes INSTAR_MACHINE_ID through; no topic (cwd-confined spawns refuse topicId)', async () => {
    const manager = makeManager(tmpDir, 'off', { machineId: () => 'conf-mach' });
    const ws = path.join(tmpDir, '.worktrees', 'feedback-x-12345678-a1');
    fs.mkdirSync(ws, { recursive: true });
    await manager.spawnSession({
      name: 'confined-1', prompt: 'go', framework: 'claude-code', cwd: ws, omitAuthEnv: true,
      confinement: { framework: 'claude-code', settingsPath: '/trusted/settings.json', tmpDir: `${ws}-tmp` },
    });
    const argv = newSessionArgvs.at(-1)!;
    const envAt = argv.indexOf('/usr/bin/env');
    expect(envAt).toBeGreaterThan(0);
    expect(argv[envAt + 1]).toBe('-i');
    const allowed = argv.slice(envAt + 2, argv.findIndex((a, i) => i > envAt + 1 && a.endsWith('/claude')));
    expect(allowed).toContain('INSTAR_MACHINE_ID=conf-mach');
    expect(allowed.map((kv) => kv.split('=')[0])).not.toContain('INSTAR_TOPIC_ID');
    // The -e export is present too, so a hook sees the id whichever layer it reads.
    expect(envOf(argv)).toContain('INSTAR_MACHINE_ID=conf-mach');
  });
});
