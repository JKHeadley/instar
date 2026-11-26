import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MODEL, MODEL_ASSETS, embeddingCacheRoot, cacheComplete, requireEmbeddingCache, prepareEmbeddingCache } from '../setup/real-embedding-cache.mjs';
import { needsEmbeddingModel } from '../setup/real-embedding-model.globalSetup.js';

const roots: string[] = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-cache-test-')); roots.push(p); return p; };
const bytes = Buffer.from('known fixture model bytes');
const assets = { 'onnx/model.onnx': crypto.createHash('sha256').update(bytes).digest('hex') };
afterEach(() => {
  for (const p of roots.splice(0)) SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'test-model:unit-cleanup' });
});

describe('real embedding model test preparation', () => {
  it('uses a stable per-user cache rather than a disposable node_modules directory', () => {
    expect(embeddingCacheRoot({}, '/home/example')).toBe('/home/example/.cache/instar/test-embeddings-v1');
    expect(embeddingCacheRoot({ INSTAR_TEST_EMBEDDING_CACHE: '/machine/cache' }, '/unused')).toBe('/machine/cache');
    expect(() => embeddingCacheRoot({ INSTAR_TEST_EMBEDDING_CACHE: 'relative' })).toThrow('absolute');
    expect(MODEL_ASSETS['onnx/model.onnx']).toBe('759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e');
  });

  it('refuses missing or partial production assets without silently downloading or skipping', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, MODEL, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(root, MODEL, 'onnx/model.onnx.tmp.123'), bytes);
    expect(cacheComplete(root)).toBe(false);
    expect(() => requireEmbeddingCache(root)).toThrow('downloads are forbidden inside test hooks');
  });

  it('acquires a cold fixture once and reuses only checksum-verified bytes', async () => {
    const root = temp(); let downloads = 0;
    const download = async () => { downloads++; return bytes; };
    await prepareEmbeddingCache({ root, assets, download });
    await prepareEmbeddingCache({ root, assets, download });
    expect(cacheComplete(root, assets)).toBe(true);
    expect(downloads).toBe(1);
    expect(fs.existsSync(path.join(root, '.prepare.lock'))).toBe(false);
  });

  it('seeds from complete installed assets without a network request', async () => {
    const root = temp(); const sourceRoot = temp();
    fs.mkdirSync(path.join(sourceRoot, MODEL, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, MODEL, 'onnx/model.onnx'), bytes);
    await prepareEmbeddingCache({ root, sourceRoot, assets, download: async () => { throw new Error('unexpected network'); } });
    expect(cacheComplete(root, assets)).toBe(true);
  });

  it('rejects corrupt source and downloaded bytes, then releases its own lock', async () => {
    const root = temp(); const sourceRoot = temp();
    fs.mkdirSync(path.join(sourceRoot, MODEL, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, MODEL, 'onnx/model.onnx'), 'incomplete');
    await expect(prepareEmbeddingCache({ root, sourceRoot, assets, download: async () => Buffer.from('wrong') })).rejects.toThrow('checksum mismatch');
    expect(cacheComplete(root, assets)).toBe(false);
    expect(fs.existsSync(path.join(root, '.prepare.lock'))).toBe(false);
  });

  it('does not leave a lock after a failed acquisition', async () => {
    const root = temp();
    await expect(prepareEmbeddingCache({ root, assets, download: async () => { throw new Error('hub unavailable'); } })).rejects.toThrow('hub unavailable');
    expect(fs.existsSync(path.join(root, '.prepare.lock'))).toBe(false);
  });

  it('recovers a stale preparation lock left by a killed worker', async () => {
    const root = temp(); const lock = path.join(root, '.prepare.lock');
    fs.mkdirSync(lock);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);
    await prepareEmbeddingCache({ root, assets, download: async () => bytes });
    expect(cacheComplete(root, assets)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('fails an exhausted acquisition budget before creating a lock', async () => {
    const root = temp();
    await expect(prepareEmbeddingCache({ root, assets, budgetMs: 0, download: async () => bytes })).rejects.toThrow('budget exhausted');
    expect(fs.existsSync(path.join(root, '.prepare.lock'))).toBe(false);
  });

  it('serializes concurrent preparation and never exposes partial bytes as complete', async () => {
    const root = temp(); let downloads = 0; let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const download = async () => { downloads++; entered(); await gate; return bytes; };
    const first = prepareEmbeddingCache({ root, assets, download });
    await started;
    expect(cacheComplete(root, assets)).toBe(false);
    const second = prepareEmbeddingCache({ root, assets, download });
    release(); await Promise.all([first, second]);
    expect(downloads).toBe(1);
    expect(cacheComplete(root, assets)).toBe(true);
  });
});

describe('real-model setup selection', () => {
  it.each([
    [[], true],
    [['run', 'tests/unit/vector-search.test.ts'], true],
    [['run', './tests/unit/vector-search.test.ts'], true],
    [['run', path.resolve('tests/unit/vector-search.test.ts')], true],
    [['run', 'tests/integration/hybrid-search.test.ts'], true],
    [['run', 'tests/e2e/hybrid-search-lifecycle.test.ts'], true],
    [['run', 'tests/unit/grok-build-adapter-policy.test.ts'], false],
    [['run', 'tests/unit/real-embedding-test-cache.test.ts'], false],
    [['run', 'tests/**/*.test.ts'], true],
    [['list', 'tests/unit/vector-search.test.ts'], false],
    [['related', 'src/memory/EmbeddingProvider.ts'], true],
    [['run', '--changed', 'HEAD'], true],
  ])('prepares only selected executable model coverage: %j', (argv, expected) => {
    expect(needsEmbeddingModel(argv as string[])).toBe(expected);
  });
});
