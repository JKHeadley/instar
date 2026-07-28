// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup;
//   execFileSync builds bare-repo fixtures only.

/**
 * Wiring-integrity tests for the Layer 4 detector ↔ AttentionQueue
 * connection.
 *
 * The detector is invoked from `startServer()` in `src/commands/server.ts`
 * AFTER both TelegramAdapter setup blocks, with `telegram.createAttentionItem`
 * passed as the `emitAttention` callback when Telegram is configured (and
 * left undefined to drive the JSONL fallback otherwise).
 *
 * These tests pin the contract between the detector's `AttentionItemInput`
 * shape and TelegramAdapter's `createAttentionItem` signature — if the
 * adapter's `Omit<AttentionItem, ...>` shape ever drifts, this catches it
 * before the wireup silently breaks.
 *
 * Spec reference: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §"Layer 4 —
 * Lifeline detector (in v1, signal only)".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runDetection,
  type AttentionItemInput,
} from '../../src/core/AgentWorktreeDetector.js';
import type { AttentionItem } from '../../src/messaging/TelegramAdapter.js';

interface Fixture {
  bareRepo: string;
  stateDir: string;
  tmpRoot: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture(): Fixture {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awd-wireup-'));
  const bareRepo = path.join(tmpRoot, 'repo');
  execFileSync('git', ['init', '--initial-branch=main', bareRepo], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepo, 'README.md'), '# T\n');
  execFileSync('git', ['-C', bareRepo, 'add', 'README.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'commit', '-m', 'init'], { stdio: 'pipe' });
  const stateDir = path.join(tmpRoot, '.instar');
  fs.mkdirSync(path.join(stateDir, 'audit'), { recursive: true });
  return { bareRepo, stateDir, tmpRoot };
}

function cleanup(fix: Fixture): void {
  fs.rmSync(fix.tmpRoot, { recursive: true, force: true });
}

describe('Layer 4 detector → AttentionQueue wireup', () => {
  let fix: Fixture;
  beforeEach(() => { fix = makeFixture(); });
  afterEach(() => cleanup(fix));

  it('detector emit-item shape is structurally compatible with TelegramAdapter.createAttentionItem input', async () => {
    const misplaced = path.join(fix.tmpRoot, 'misplaced-wt');
    git(['worktree', 'add', '-b', 'feat-shape', misplaced], fix.bareRepo);

    const captured: AttentionItemInput[] = [];
    await runDetection({
      instarRepo: fix.bareRepo,
      stateDir: fix.stateDir,
      safeRoots: [],
      emitAttention: (item) => { captured.push(item); },
    });

    expect(captured).toHaveLength(1);
    const item = captured[0];

    // Pin the exact shape startServer.ts passes through to
    // telegram.createAttentionItem. If TelegramAdapter's
    // `Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status' | 'topicId'>`
    // requirement adds a new mandatory field, the type below catches it
    // at compile time AND this runtime check catches a stale shape.
    const adapterInput: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status' | 'topicId'> = {
      id: item.id,
      title: item.title,
      summary: item.summary,
      description: item.description,
      category: item.category,
      priority: item.priority,
      sourceContext: item.sourceContext,
    };

    expect(adapterInput.id).toMatch(/^worktree-misplaced-summary:[a-f0-9]{16}$/);
    expect(adapterInput.category).toBe('worktree-misplaced');
    expect(['URGENT', 'HIGH', 'NORMAL', 'LOW']).toContain(adapterInput.priority);
    expect(typeof adapterInput.title).toBe('string');
    expect(adapterInput.title.length).toBeGreaterThan(0);
    expect(typeof adapterInput.summary).toBe('string');
    expect(adapterInput.summary.length).toBeGreaterThan(0);
  });

  it('emitAttention callback receives the item and is awaited (async-safe)', async () => {
    const misplaced = path.join(fix.tmpRoot, 'misplaced-async');
    git(['worktree', 'add', '-b', 'feat-async', misplaced], fix.bareRepo);

    let resolveOrder: string[] = [];
    const result = await runDetection({
      instarRepo: fix.bareRepo,
      stateDir: fix.stateDir,
      safeRoots: [],
      emitAttention: async (_item) => {
        // Simulate the AttentionQueue createAttentionItem latency (it does
        // a Telegram API roundtrip). The detector must await this — if it
        // fires-and-forgets, the result.emitted count would race ahead.
        await new Promise((resolve) => setTimeout(resolve, 10));
        resolveOrder.push('emit-complete');
      },
    });

    resolveOrder.push('detector-returned');
    expect(result.emitted).toBe(1);
    // emit-complete must come BEFORE detector-returned — proves the
    // detector awaits the callback rather than fire-and-forget.
    expect(resolveOrder).toEqual(['emit-complete', 'detector-returned']);
  });

  it('falls back to JSONL when emitAttention is undefined (no Telegram configured)', async () => {
    const misplaced = path.join(fix.tmpRoot, 'misplaced-jsonl');
    git(['worktree', 'add', '-b', 'feat-jsonl', misplaced], fix.bareRepo);
    const fallback = path.join(fix.stateDir, 'audit', 'worktree-detector.jsonl');

    const result = await runDetection({
      instarRepo: fix.bareRepo,
      stateDir: fix.stateDir,
      safeRoots: [],
      // emitAttention deliberately omitted — mirrors the no-Telegram
      // branch in startServer.ts where `telegram` is undefined.
      fallbackPath: fallback,
    });

    expect(result.emitted).toBe(1);
    expect(fs.existsSync(fallback)).toBe(true);
    const line = JSON.parse(fs.readFileSync(fallback, 'utf-8').trim());
    expect(line.dedupeKey).toMatch(/^worktree-misplaced-summary:/);
  });
});
