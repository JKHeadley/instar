import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.js';

const dirs: string[] = [];
const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-source-generation-worker.mjs');
const viteNode = path.resolve('node_modules', '.bin', 'vite-node');
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-source-generation-multiprocess.test.ts' });
});

function run(dir: string, mode: 'append' | 'compact', value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(viteNode, [worker, dir, mode, value], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

describe('feedback source generation multi-process fence', () => {
  it('serializes concurrent append and compaction without losing an accepted record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-generation-process-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'feedback.jsonl'), `${JSON.stringify({ feedbackId: 'seed', status: 'unprocessed' })}\n`);
    await Promise.all([
      run(dir, 'compact', '1234'),
      ...Array.from({ length: 12 }, (_, index) => run(dir, 'append', `concurrent-${index}`)),
    ]);
    const generations = new FeedbackSourceGenerations(dir);
    const currentRows = fs.readFileSync(generations.current().filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { feedbackId: string });
    expect(new Set(currentRows.map((row) => row.feedbackId))).toEqual(new Set(['seed', ...Array.from({ length: 12 }, (_, index) => `concurrent-${index}`)]));
    expect(generations.planFrom('canonical-feedback-v1')).toHaveLength(2);
  }, 20_000);
});
