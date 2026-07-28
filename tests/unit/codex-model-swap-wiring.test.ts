// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Wiring-integrity coverage for the codex model-swap (directive #4b): proves
 * the policy is ACTUALLY wired into SessionManager's spawn paths — not dead
 * code — via two complementary checks:
 *   1. Reflection: SessionManager.resolveCodexLaunchModel exists, reads
 *      config.codex.rateLimitModelSwap, and returns the requested model on the
 *      deterministic fast-paths (non-codex / disabled / no-fallback) WITHOUT
 *      touching disk.
 *   2. Source assertion: BOTH launch paths (headless buildHeadlessLaunch +
 *      interactive buildInteractiveLaunch) take their model from the helper, so
 *      the swap can't be silently disconnected from a spawn path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('codex model-swap wiring — SessionManager.resolveCodexLaunchModel', () => {
  let tmpDir: string;
  let manager: SessionManager;

  function build(swap?: unknown): SessionManager {
    const config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
      ...(swap !== undefined ? { codex: { rateLimitModelSwap: swap } } : {}),
    } as unknown as SessionManagerConfig;
    return new SessionManager(config, new StateManager(path.join(tmpDir, 'state')));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-swap-wiring-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/codex-model-swap-wiring.test.ts:cleanup' });
  });

  // Reflection helper — the method is private by design (internal spawn detail).
  const resolve = (m: SessionManager, fw: string, model: string | undefined) =>
    (m as unknown as { resolveCodexLaunchModel: (f: string, x: string | undefined) => Promise<string | undefined> })
      .resolveCodexLaunchModel(fw, model);

  it('returns the requested model unchanged for a non-codex framework', async () => {
    manager = build({ enabled: true, fallbackModel: 'gpt-5.3-codex-spark' });
    expect(await resolve(manager, 'claude-code', 'opus')).toBe('opus');
  });

  it('returns the requested model when the swap is disabled (default)', async () => {
    manager = build(undefined); // no codex config at all
    expect(await resolve(manager, 'codex-cli', 'gpt-5.5')).toBe('gpt-5.5');
    manager = build({ enabled: false, fallbackModel: 'gpt-5.3-codex-spark' });
    expect(await resolve(manager, 'codex-cli', 'gpt-5.5')).toBe('gpt-5.5');
  });

  it('returns the requested model when enabled but no fallbackModel is configured', async () => {
    manager = build({ enabled: true });
    expect(await resolve(manager, 'codex-cli', 'gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('codex model-swap wiring — both spawn paths consume the helper', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'core', 'SessionManager.ts'),
    'utf-8',
  );

  it('imports the model-swap policy', () => {
    expect(src).toContain('resolveCodexLaunchModelWithUsage');
    expect(src).toContain('codexModelSwapPolicy.js');
  });

  it('defines the private resolveCodexLaunchModel helper', () => {
    expect(src).toMatch(/private async resolveCodexLaunchModel\(/);
  });

  it('headless spawn (buildHeadlessLaunch) launches with the resolved model', () => {
    const idx = src.indexOf('buildHeadlessLaunch(headlessFramework');
    expect(idx).toBeGreaterThan(0);
    // The model is resolved ONCE near the top of spawnSession, then consumed
    // by either the reroute branch (june15-headless-spawn-reroute: the
    // interactive lane reuses the SAME launchModel) or this headless builder.
    // The reroute branch legitimately sits between resolution and this build,
    // so widen the look-back window past it — the invariant is "resolved
    // before, passed as launchModel", not literal proximity.
    const before = src.slice(Math.max(0, idx - 2500), idx);
    expect(before).toContain('this.resolveCodexLaunchModel(headlessFramework');
    // the builder receives the resolved variable, not the raw options.model
    expect(src.slice(idx, idx + 200)).toMatch(/model:\s*launchModel/);
  });

  it('interactive spawn (buildInteractiveLaunch) launches with the resolved model', () => {
    const idx = src.indexOf('buildInteractiveLaunch(framework');
    expect(idx).toBeGreaterThan(0);
    // Same rationale as the headless case above: legitimate code can sit between
    // resolution and the build — e.g. the subscription account-swap lane seeds a
    // pool home's onboarding flags here (ensurePinnedHomeInteractiveReady) before
    // launch, and (WS5.2 Step 8) the §2.10 credentialSource provenance derivation
    // sits between effectiveAccountId and the build. The invariant is "resolved
    // before, passed as launchModel", not literal proximity, so use a widened
    // look-back window (3000 chars — bumped from 2500 for the Step 8 derivation).
    const before = src.slice(Math.max(0, idx - 3000), idx);
    expect(before).toContain('this.resolveCodexLaunchModel(framework');
    expect(src.slice(idx, idx + 250)).toContain('launchDefaultModel');
  });
});
