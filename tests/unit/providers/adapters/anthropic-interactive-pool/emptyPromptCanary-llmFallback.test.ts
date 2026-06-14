// safe-git-allow: test-tmpdir-cleanup — afterEach removes the per-test mkdtempSync signature-store tmpdir (same pattern as emptyPromptSignaturePersistence.test.ts); SafeFsExecutor migration tracked separately.
/**
 * Tests for the empty-prompt canary's LLM fallback path.
 *
 * The fallback fires when deterministic structural re-derivation
 * cannot extract an empty-prompt signature from the canary's after-
 * buffer — a last-line-of-defense before the canary hard-fails. The
 * canary still needs a real pool/tmux/REPL to exercise end-to-end, so
 * these tests stub the pool's send/capture and exercise the canary
 * function directly with crafted before/after buffers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEmptyPromptCanary } from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptCanary.js';
import { resetSignatureForTests } from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptSignature.js';
import { configFromEnv } from '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js';
import type { CanaryLlmFallback } from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptCanary.js';
import type { InteractivePool, PoolSession } from '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.js';

// Signature-store isolation (same pattern as emptyPromptSignaturePersistence.test.ts).
// Without this, a self-heal in one test PERSISTS the derived signature into the real
// `~/.instar/providers/...`, and every later run (this file or any suite) structurally
// matches on the first try — flipping the expected 'self-healed' outcome to 'pass'.
// That exact pollution made this file order/state-dependent on dev machines.
let sigTmpDir: string;
beforeEach(() => {
  sigTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-canary-llm-'));
  process.env['INSTAR_PROVIDER_STATE_DIR'] = sigTmpDir;
  resetSignatureForTests();
});
afterEach(() => {
  resetSignatureForTests();
  delete process.env['INSTAR_PROVIDER_STATE_DIR'];
  fs.rmSync(sigTmpDir, { recursive: true, force: true });
});

function makeFakePool(overrides: { beforeBuf?: string; afterBuf?: string }): InteractivePool {
  let firstCapture = true;
  const fake = {
    capturePane: vi.fn(async () => {
      if (firstCapture) {
        firstCapture = false;
        return overrides.beforeBuf ?? '';
      }
      return overrides.afterBuf ?? '';
    }),
  } as unknown as InteractivePool;
  return fake;
}

function makeFakeSession(): PoolSession {
  return {
    id: 'fake',
    tmuxName: 'fake-tmux',
    state: 'ready',
    messageCount: 0,
    spawnedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

// Stub the execFile-based send-keys so the canary doesn't try to talk
// to a real tmux. The canary uses execFileAsync internally — we
// short-circuit by overriding through the global env so it never
// reaches a real binary. Easier: mock the entire promisified execFile.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  };
});

describe('emptyPromptCanary — LLM fallback', () => {
  it('falls back to LLM when no empty-prompt line can be derived and reports complete', async () => {
    // Construct an after-buffer that contains PONGXYZ (so canary moves
    // past the "response present" check) but where every line is
    // unrecognizable as a prompt — no `❯`, no clear structural anchor.
    // The legacy idle markers ARE present (to skip status-bar lines),
    // so the bottom-up walk should find SOMETHING — let's craft a buffer
    // where the only non-status-bar non-blank line IS a content line,
    // so derivation succeeds but the pattern doesn't match...
    // Easier path: an after-buffer that's just the welcome banner with
    // PONGXYZ appended, no structural prompt-line at all once status-
    // bar lines are filtered out.
    const afterBuf = [
      '?welcome banner',
      'PONGXYZ',
      'shift+tab to cycle | ? for shortcuts | bypass permissions on',
      'shift+tab to cycle',
    ].join('\n');
    const pool = makeFakePool({ beforeBuf: '', afterBuf });
    const session = makeFakeSession();
    const config = configFromEnv();

    const llmFallback: CanaryLlmFallback = vi.fn(async () => 'complete');

    const result = await runEmptyPromptCanary(pool, session, config, {
      waitMs: 0,
      llmFallback,
    });

    expect(llmFallback).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('llm-confirmed');
    expect(result.details.llmFallbackInvoked).toBe(true);
    expect(result.details.llmFallbackVerdict).toBe('complete');
  });

  it('hard-fails when LLM says not-complete', async () => {
    const afterBuf = [
      'banner',
      'PONGXYZ',
      'shift+tab to cycle',
    ].join('\n');
    const pool = makeFakePool({ beforeBuf: '', afterBuf });
    const session = makeFakeSession();
    const config = configFromEnv();

    const llmFallback: CanaryLlmFallback = vi.fn(async () => 'not-complete');

    const result = await runEmptyPromptCanary(pool, session, config, {
      waitMs: 0,
      llmFallback,
    });

    expect(llmFallback).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('fail');
    expect(result.details.llmFallbackInvoked).toBe(true);
    expect(result.details.llmFallbackVerdict).toBe('not-complete');
  });

  it('treats LLM error as not-complete and hard-fails', async () => {
    const afterBuf = [
      'banner',
      'PONGXYZ',
      'shift+tab to cycle',
    ].join('\n');
    const pool = makeFakePool({ beforeBuf: '', afterBuf });
    const session = makeFakeSession();
    const config = configFromEnv();

    const llmFallback: CanaryLlmFallback = vi.fn(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await runEmptyPromptCanary(pool, session, config, {
      waitMs: 0,
      llmFallback,
    });

    expect(llmFallback).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('fail');
    expect(result.details.llmFallbackVerdict).toBe('error');
  });

  it('does not invoke LLM when structural re-derivation succeeds', async () => {
    // Provide an after-buffer where re-derivation will succeed: contains
    // PONGXYZ and a structurally-locatable empty-prompt line (`▶` glyph).
    const afterBuf = [
      'banner',
      '❯ Reply with the literal text PONGXYZ',
      '⏺ PONGXYZ',
      '─────',
      '▶',
      '─────',
      'shift+tab to cycle | ? for shortcuts',
    ].join('\n');
    const pool = makeFakePool({ beforeBuf: '', afterBuf });
    const session = makeFakeSession();
    const config = configFromEnv();

    const llmFallback: CanaryLlmFallback = vi.fn(async () => 'complete');

    const result = await runEmptyPromptCanary(pool, session, config, {
      waitMs: 0,
      llmFallback,
    });

    expect(llmFallback).not.toHaveBeenCalled();
    expect(result.status).toBe('self-healed');
  });

  it('hard-fails without invoking anything when no LLM fallback is configured and derivation fails', async () => {
    const afterBuf = [
      'banner',
      'PONGXYZ',
      'shift+tab to cycle',
    ].join('\n');
    const pool = makeFakePool({ beforeBuf: '', afterBuf });
    const session = makeFakeSession();
    const config = configFromEnv();

    const result = await runEmptyPromptCanary(pool, session, config, {
      waitMs: 0,
      // No llmFallback configured.
    });

    expect(result.status).toBe('fail');
    expect(result.details.llmFallbackInvoked).toBe(false);
  });
});
