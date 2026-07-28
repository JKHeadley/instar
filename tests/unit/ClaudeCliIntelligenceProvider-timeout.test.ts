/**
 * Unit tests — ClaudeCliIntelligenceProvider honors IntelligenceOptions.timeoutMs.
 *
 * Regression for the two-walls conformance-gate timeout bug
 * (docs/specs/conformance-gate-timeout.md): the provider used to hardcode the
 * child-process timeout at 30s and ignore the caller's budget, so an LLM-backed
 * caller on a synchronous path (the standards-conformance gate reviewing a full
 * spec) was killed at 30s regardless. `timeout` is an execFile *option*, not an
 * argv flag, so we assert it behaviorally with a slow fake binary: a short
 * budget must kill the call; a generous budget (and the unchanged 30s default)
 * must let it finish.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { clearClaudeForbidden } from '../../src/core/claudeForbiddenGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let slowClaudePath: string;

beforeAll(() => {
  clearClaudeForbidden(); // ensure the codex-only guard isn't tripped from another test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provider-timeout-'));
  // Sleeps 1s, then prints — slow enough to be killed by a 100ms budget but
  // comfortably under both a 5s budget and the 30s default.
  slowClaudePath = path.join(tmpDir, 'slow-claude');
  fs.writeFileSync(slowClaudePath, '#!/bin/sh\nsleep 1\necho "OK"\nexit 0\n', { mode: 0o755 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/ClaudeCliIntelligenceProvider-timeout.test.ts:afterAll',
  });
});

describe('ClaudeCliIntelligenceProvider — per-call timeout (IntelligenceOptions.timeoutMs)', () => {
  it('honors a short timeoutMs — kills a slow call (pre-fix this budget was ignored)', async () => {
    const provider = new ClaudeCliIntelligenceProvider(slowClaudePath);
    await expect(provider.evaluate('hi', { timeoutMs: 100 })).rejects.toThrow();
  });

  it('a generous timeoutMs lets the same slow call finish', async () => {
    const provider = new ClaudeCliIntelligenceProvider(slowClaudePath);
    await expect(provider.evaluate('hi', { timeoutMs: 5000 })).resolves.toContain('OK');
  });

  it('without timeoutMs the 30s default is unchanged — a sub-default call still resolves', async () => {
    const provider = new ClaudeCliIntelligenceProvider(slowClaudePath);
    await expect(provider.evaluate('hi')).resolves.toContain('OK');
  });
});
