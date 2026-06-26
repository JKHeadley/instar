import { describe, it, expect } from 'vitest';
import { detectTmuxPath, detectClaudePath, loadConfig } from '../../src/core/Config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Config', () => {
  describe('detectTmuxPath', () => {
    it('finds tmux on this system', () => {
      const tmuxPath = detectTmuxPath();
      // tmux should be installed on the dev machine
      expect(tmuxPath).toBeTruthy();
      expect(tmuxPath).toContain('tmux');
    });
  });

  describe('detectClaudePath', () => {
    it('finds Claude CLI on this system', () => {
      const claudePath = detectClaudePath();
      // Claude CLI may not be installed in CI — only assert format when found
      if (claudePath) {
        expect(claudePath).toContain('claude');
      } else {
        expect(claudePath).toBeNull();
      }
    });
  });

  describe('loadConfig', () => {
    it('respects sessions.claudePath from config.json instead of auto-detecting', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      const customClaudePath = '/usr/local/bin/my-claude-wrapper';
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: { framework: 'claude-code', claudePath: customClaudePath, tmuxPath: '/usr/bin/tmux' },
        }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.claudePath).toBe(customClaudePath);

      // Cleanup
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:48' });
    });

    it('carries sessions.componentFrameworks from config.json into the loaded config (load-path wiring)', () => {
      // REGRESSION (2026-06-06): the per-component framework routing feature
      // read config.sessions.componentFrameworks live (IntelligenceRouter
      // resolveConfig), and the docs told users to set it in
      // `.instar/config.json` — but Config.load never copied the field from
      // the file, so the documented surface was silently DEAD on every
      // deployed agent. This is the exact-gap test: a FILE-loaded config must
      // carry the routing table.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      const routing = {
        categories: { sentinel: 'codex-cli' },
        overrides: { CoherenceReviewer: 'claude-code' },
      };
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: {
            framework: 'claude-code',
            claudePath: '/usr/local/bin/claude',
            tmuxPath: '/usr/bin/tmux',
            componentFrameworks: routing,
          },
        }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.componentFrameworks).toEqual(routing);

      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:componentFrameworks' });
    });

    it('omits componentFrameworks when absent from the file (no phantom field)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: { framework: 'claude-code', claudePath: '/usr/local/bin/claude', tmuxPath: '/usr/bin/tmux' },
        }),
      );
      const config = loadConfig(tmpDir);
      expect(config.sessions.componentFrameworks).toBeUndefined();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:componentFrameworks-absent' });
    });

    it('carries sessions.frameworkDefaultModels from config.json into the loaded config (load-path wiring)', () => {
      // REGRESSION (2026-06-25): the SAME load-path gap class as componentFrameworks
      // above. server.ts builds the pi-cli provider from
      // config.sessions.frameworkDefaultModels['pi-cli'] (the required model pattern),
      // and the docs told users to set it in `.instar/config.json` — but loadConfig
      // never copied the field from the file, so the pattern was ALWAYS undefined at
      // boot, the factory degraded pi-cli to null ("binary missing / not built"), and
      // pi-cli was silently UNAVAILABLE on every deployed agent despite a valid binary.
      // This is the exact-gap test: a FILE-loaded config must carry the model map.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      const models = { 'pi-cli': 'openai-codex/gpt-5.5', 'gemini-cli': 'gemini-2.5-flash' };
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: {
            framework: 'claude-code',
            claudePath: '/usr/local/bin/claude',
            tmuxPath: '/usr/bin/tmux',
            frameworkDefaultModels: models,
          },
        }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.frameworkDefaultModels).toEqual(models);
      expect(config.sessions.frameworkDefaultModels?.['pi-cli']).toBe('openai-codex/gpt-5.5');

      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:frameworkDefaultModels' });
    });

    it('omits frameworkDefaultModels when absent from the file (no phantom field)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: { framework: 'claude-code', claudePath: '/usr/local/bin/claude', tmuxPath: '/usr/bin/tmux' },
        }),
      );
      const config = loadConfig(tmpDir);
      expect(config.sessions.frameworkDefaultModels).toBeUndefined();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:frameworkDefaultModels-absent' });
    });

    it('respects sessions.tmuxPath from config.json instead of auto-detecting', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      const customTmuxPath = '/usr/local/bin/my-tmux-wrapper';
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: { framework: 'claude-code', tmuxPath: customTmuxPath, claudePath: '/usr/bin/claude-stub' },
        }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.tmuxPath).toBe(customTmuxPath);

      // Cleanup
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:69' });
    });

    it('falls back to auto-detected claudePath when config omits it', () => {
      const detected = detectClaudePath();
      if (!detected) {
        // Claude CLI not available (e.g., CI environment) — skip
        return;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({ sessions: { framework: 'claude-code' } }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.claudePath).toBe(detected);

      // Cleanup
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/Config.test.ts:93' });
    });
  });
});
