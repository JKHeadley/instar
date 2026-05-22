/**
 * Tests for the framework-spawn portability fix.
 *
 * Bug: messaging a codex-cli-only agent spawned a Claude Code
 * session. Two root causes:
 *   1. SessionManager.spawnInteractiveSession hardcoded the framework
 *      default to 'claude-code' (it didn't read config or env, unlike
 *      spawnSession).
 *   2. The wizard/init persists the framework choice as top-level
 *      `enabledFrameworks`, but the runtime resolution
 *      (resolveConfiguredFramework) only read `sessions.framework` +
 *      INSTAR_FRAMEWORK — neither of which the wizard sets. So a
 *      codex-cli agent had no runtime framework signal and defaulted
 *      to claude-code.
 *
 * Fix:
 *   - resolveConfiguredFramework now takes enabledFrameworks as a 3rd
 *     input (precedence: sessions.framework > env > enabledFrameworks[0]
 *     > claude-code).
 *   - Config.load derives the runtime framework and stores it on
 *     SessionManagerConfig.framework.
 *   - Both spawnInteractiveSession and spawnSession resolve from
 *     config.framework (per-call override still wins).
 *
 * These tests pin the resolution precedence + the wiring shape.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfiguredFramework } from '../../src/core/Config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('resolveConfiguredFramework precedence', () => {
  it('1. sessions.framework wins over everything', () => {
    expect(resolveConfiguredFramework('codex-cli', 'claude-code', ['claude-code'])).toBe('codex-cli');
    expect(resolveConfiguredFramework('claude-code', 'codex-cli', ['codex-cli'])).toBe('claude-code');
  });

  it('2. INSTAR_FRAMEWORK env wins over enabledFrameworks when sessions.framework unset', () => {
    expect(resolveConfiguredFramework(undefined, 'codex-cli', ['claude-code'])).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, 'codex', ['claude-code'])).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, 'claude-code', ['codex-cli'])).toBe('claude-code');
  });

  it('3. enabledFrameworks[0] is honored when config + env are unset (THE bug fix)', () => {
    // This is the exact codey case: enabledFrameworks: ['codex-cli'],
    // no sessions.framework, no INSTAR_FRAMEWORK env.
    expect(resolveConfiguredFramework(undefined, undefined, ['codex-cli'])).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, undefined, ['claude-code'])).toBe('claude-code');
    expect(resolveConfiguredFramework(undefined, undefined, ['claude-code', 'codex-cli'])).toBe('claude-code');
  });

  it('4. defaults to claude-code when nothing is set (historical behavior)', () => {
    expect(resolveConfiguredFramework(undefined, undefined, undefined)).toBe('claude-code');
    expect(resolveConfiguredFramework(undefined, undefined, [])).toBe('claude-code');
    expect(resolveConfiguredFramework(undefined, '', undefined)).toBe('claude-code');
  });

  it('ignores garbage env values and falls through to enabledFrameworks', () => {
    expect(resolveConfiguredFramework(undefined, 'nonsense', ['codex-cli'])).toBe('codex-cli');
  });
});

describe('SessionManager spawn paths read config.framework', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/core/SessionManager.ts'),
    'utf-8',
  );

  it('spawnInteractiveSession no longer hardcodes claude-code', () => {
    // The old line was: const framework = options?.framework ?? 'claude-code';
    expect(src).not.toMatch(/const framework: IntelligenceFramework = options\?\.framework \?\? 'claude-code'/);
  });

  it('spawnInteractiveSession resolves via resolveInteractiveFramework + config.framework', () => {
    // Both spawn paths should now go through resolveInteractiveFramework
    // with configFramework: this.config.framework.
    const matches = src.match(/configFramework:\s*this\.config\.framework/g) ?? [];
    // One for spawnSession (headless), one for spawnInteractiveSession.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('spawnSession no longer passes configFramework: undefined', () => {
    expect(src).not.toMatch(/configFramework:\s*undefined/);
  });
});

describe('Config.load derives + stores the runtime framework', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/core/Config.ts'),
    'utf-8',
  );

  it('resolveConfiguredFramework is called with enabledFrameworks', () => {
    expect(src).toMatch(/resolveConfiguredFramework\([\s\S]*?enabledFrameworks/);
  });

  it('SessionManagerConfig sessions object sets framework: configuredFramework', () => {
    expect(src).toMatch(/framework:\s*configuredFramework/);
  });
});
