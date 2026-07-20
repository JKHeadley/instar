import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-drain-performance-worker.mjs');
const viteNode = path.resolve('node_modules', '.bin', 'vite-node');
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-150k.test.ts' }); });

describe('Feedback Factory 150k reference envelope', () => {
  it('processes the bounded 500-row slice under the 90s / 512MiB envelope and exposes lag', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-150k-')); dirs.push(dir);
    const evidence = await new Promise<{ processed: number; durationMs: number; rssBytes: number; sourceLagBytes: number; projectionLag: number; queued: number; completed: number; wouldCreate: number; completedWithinTicks: number | null; firstClaimedWorkKey: string | null; authoritativeReadBack: boolean; tickResult: string }>((resolve, reject) => {
      const child = spawn(viteNode, [worker, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`performance worker exited ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
    });
    expect(evidence.processed).toBe(500);
    expect(evidence.durationMs).toBeLessThan(90_000);
    expect(evidence.rssBytes).toBeLessThan(512 * 1024 * 1024);
    expect(evidence.projectionLag).toBeGreaterThanOrEqual(149_500);
    expect(evidence.tickResult).toBe('succeeded');
    expect(evidence.completed).toBeGreaterThanOrEqual(2);
    expect(evidence.firstClaimedWorkKey).toBe('feedback-work:oldest-eligible:1');
    expect(evidence.authoritativeReadBack).toBe(true);
    expect(evidence.completedWithinTicks).toBeLessThanOrEqual(10);
  }, 100_000);
});
