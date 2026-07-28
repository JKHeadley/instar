import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-source-generations.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-generations-'));
  dirs.push(dir);
  const legacy = path.join(dir, 'feedback.jsonl');
  fs.writeFileSync(legacy, [
    JSON.stringify({ feedbackId: 'f1', status: 'unprocessed' }),
    JSON.stringify({ feedbackId: 'f2', status: 'unprocessed' }),
  ].join('\n') + '\n');
  return { dir, legacy, generations: new FeedbackSourceGenerations(dir) };
}

describe('FeedbackSourceGenerations', () => {
  it('publishes a checksummed immutable handoff, retains the old bytes, and redirects later appends', () => {
    const { legacy, generations } = setup();
    const before = fs.readFileSync(legacy);
    const handoff = generations.compact(1234)!;
    expect(handoff).toMatchObject({ fromGenerationId: 'canonical-feedback-v1', finalOffset: before.length, publishedAt: 1234 });
    expect(fs.readFileSync(legacy)).toEqual(before);
    const plan = generations.planFrom('canonical-feedback-v1');
    expect(plan.map((source) => source.generationId)).toEqual(['canonical-feedback-v1', handoff.toGenerationId]);
    generations.append({ feedbackId: 'f3', status: 'unprocessed' });
    expect(fs.readFileSync(legacy)).toEqual(before);
    expect(fs.readFileSync(generations.current().filePath, 'utf8')).toContain('"feedbackId":"f3"');
  });

  it('fails closed when a retained generation or manifest checksum is changed', () => {
    const { dir, legacy, generations } = setup();
    generations.compact(1234);
    fs.appendFileSync(legacy, 'tamper\n');
    expect(() => generations.planFrom('canonical-feedback-v1')).toThrow(/boundary is invalid/);
    const manifestPath = path.join(dir, 'feedback-generations.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.checksum = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => generations.current()).toThrow(/checksum is invalid/);
  });

  it('recovers a generation fence left by a dead process but refuses a live owner', () => {
    const { dir, generations } = setup();
    const lock = path.join(dir, '.feedback-generation.lock');
    fs.writeFileSync(lock, '99999999\n');
    expect(() => generations.append({ feedbackId: 'f3' })).not.toThrow();
    fs.writeFileSync(lock, `${process.pid}\n`);
    expect(() => generations.append({ feedbackId: 'f4' })).toThrow(/busy/);
  });

  it('recovers every compaction publish crash boundary without loss or an invalid handoff', () => {
    for (const point of ['after-generation-fsync', 'after-manifest-fsync', 'after-manifest-publish'] as const) {
      const { generations } = setup();
      expect(() => generations.compact(4321, point)).toThrow(/injected crash/);
      if (point === 'after-manifest-publish') {
        expect(generations.planFrom('canonical-feedback-v1')).toHaveLength(2);
      } else {
        const recovered = generations.compact(4321);
        expect(recovered?.fromGenerationId).toBe('canonical-feedback-v1');
        expect(generations.planFrom('canonical-feedback-v1')).toHaveLength(2);
      }
    }
  });

  it('replays source append crash boundaries without losing or duplicating a projection', () => {
    for (const point of ['before-append', 'after-append', 'after-append-fsync'] as const) {
      const { legacy, generations } = setup();
      const drain = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'k'.repeat(32) });
      try {
        drain.projectSourceGeneration({ filePath: legacy, generationId: 'canonical-feedback-v1', limit: 500 });
        expect(() => generations.append({ feedbackId: `crash-${point}`, sourceRecordId: `source-${point}`, status: 'unprocessed' }, point)).toThrow(/injected crash/);
        const replay = drain.projectSourceGeneration({ filePath: legacy, generationId: 'canonical-feedback-v1', limit: 500 });
        expect(replay.projected).toBe(point === 'before-append' ? 0 : 1);
        expect(drain.projectSourceGeneration({ filePath: legacy, generationId: 'canonical-feedback-v1', limit: 500 }).projected).toBe(0);
      } finally { drain.close(); }
    }
  });

  it('moves the durable SQLite cursor only after the old boundary and replays copied rows exactly once', () => {
    const { legacy, generations } = setup();
    const drain = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'k'.repeat(32) });
    try {
      const first = drain.projectSourceGeneration({ filePath: legacy, generationId: 'canonical-feedback-v1', limit: 500 });
      expect(first).toMatchObject({ projected: 2, lagBytes: 0 });
      const handoff = generations.compact(1234)!;
      drain.acceptSourceHandoff({ fromGenerationId: handoff.fromGenerationId, finalOffset: handoff.finalOffset, toGenerationId: handoff.toGenerationId });
      const copied = drain.projectSourceGeneration({ filePath: generations.current().filePath, generationId: handoff.toGenerationId, limit: 500 });
      expect(copied).toMatchObject({ projected: 0, replayed: 2, lagBytes: 0 });
      generations.append({ feedbackId: 'f3', status: 'unprocessed' });
      expect(drain.projectSourceGeneration({ filePath: generations.current().filePath, generationId: handoff.toGenerationId, limit: 500 }))
        .toMatchObject({ projected: 1, replayed: 0, lagBytes: 0 });
    } finally { drain.close(); }
  });
});
