/**
 * Integration tests — Config.loadConfig with framework routing.
 *
 * Verifies the v1.0.0 boot path: when `.instar/config.json` declares
 * `sessions.framework = "codex-cli"` (or `INSTAR_FRAMEWORK` env var
 * selects it), loadConfig must:
 *
 *   1. Not throw "Claude CLI not found" — codex-cli installs need to
 *      boot even when claude is absent (covered by the prerequisite
 *      check in checkFrameworkPrerequisite, exercised here against
 *      the full loadConfig flow).
 *   2. Set `sessions.claudePath` to the codex binary (the field is
 *      kept for backwards-compat with spawn paths; carries the
 *      configured framework's binary).
 *   3. Preserve `sessions.framework` in the returned config.
 *
 * These tests run on dev machines that have at least one of the two
 * framework binaries installed; they DO NOT mock detectClaudePath /
 * detectCodexPath because the prerequisite check is real and we want
 * to verify the real boot path, not a mocked one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  detectClaudePath,
  detectCodexPath,
} from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const claudePresent = detectClaudePath() !== null && detectClaudePath() !== '';
const codexPresent = detectCodexPath() !== null && detectCodexPath() !== '';

describe('loadConfig — framework routing (v1.0.0)', () => {
  let tmpDir: string;
  let projectDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-framework-routing-'));
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    savedEnv = process.env['INSTAR_FRAMEWORK'];
    delete process.env['INSTAR_FRAMEWORK'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['INSTAR_FRAMEWORK'];
    else process.env['INSTAR_FRAMEWORK'] = savedEnv;
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/config-framework-routing.test.ts:54',
    });
  });

  function writeConfig(body: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify(body, null, 2),
    );
  }

  it.skipIf(!claudePresent)(
    'sessions.framework="claude-code" sets claudePath to the claude binary',
    () => {
      writeConfig({ sessions: { framework: 'claude-code' } });
      const cfg = loadConfig(projectDir);
      expect(cfg.sessions.claudePath).toBeTruthy();
      expect(cfg.sessions.claudePath).not.toContain('codex');
    },
  );

  it.skipIf(!codexPresent)(
    'sessions.framework="codex-cli" sets claudePath to the codex binary',
    () => {
      writeConfig({ sessions: { framework: 'codex-cli' } });
      const cfg = loadConfig(projectDir);
      expect(cfg.sessions.claudePath).toBeTruthy();
      expect(cfg.sessions.claudePath).toContain('codex');
    },
  );

  it.skipIf(!codexPresent)(
    'INSTAR_FRAMEWORK=codex-cli env var selects codex when config omits framework',
    () => {
      writeConfig({});
      process.env['INSTAR_FRAMEWORK'] = 'codex-cli';
      const cfg = loadConfig(projectDir);
      expect(cfg.sessions.claudePath).toContain('codex');
    },
  );

  it.skipIf(!codexPresent)(
    'config-level framework wins over INSTAR_FRAMEWORK env',
    () => {
      writeConfig({ sessions: { framework: 'codex-cli' } });
      process.env['INSTAR_FRAMEWORK'] = 'claude-code';
      const cfg = loadConfig(projectDir);
      // config.json picked codex-cli, so claudePath should be the codex binary
      expect(cfg.sessions.claudePath).toContain('codex');
    },
  );

  it.skipIf(!claudePresent)(
    'no framework declared anywhere → defaults to claude-code',
    () => {
      writeConfig({});
      const cfg = loadConfig(projectDir);
      // claude-code is the default; claudePath is the claude binary
      expect(cfg.sessions.claudePath).toBeTruthy();
      expect(cfg.sessions.claudePath).not.toContain('codex');
    },
  );

  it('framework alias "codex" (env) normalizes to codex-cli', () => {
    if (!codexPresent) return;
    writeConfig({});
    process.env['INSTAR_FRAMEWORK'] = 'codex';
    const cfg = loadConfig(projectDir);
    expect(cfg.sessions.claudePath).toContain('codex');
  });

  it('framework alias "claude" (env) normalizes to claude-code', () => {
    if (!claudePresent) return;
    writeConfig({});
    process.env['INSTAR_FRAMEWORK'] = 'claude';
    const cfg = loadConfig(projectDir);
    expect(cfg.sessions.claudePath).toBeTruthy();
    expect(cfg.sessions.claudePath).not.toContain('codex');
  });
});
