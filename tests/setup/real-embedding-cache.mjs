/** Pinned real-model test assets, shared across disposable npm-ci worktrees. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_ASSETS = Object.freeze({
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'onnx/model.onnx': '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
});
export function embeddingCacheRoot(env = process.env, home = os.homedir()) {
  const value = env.INSTAR_TEST_EMBEDDING_CACHE ?? path.join(home, '.cache', 'instar', 'test-embeddings-v1');
  if (!path.isAbsolute(value)) throw new Error('INSTAR_TEST_EMBEDDING_CACHE must be an absolute machine-local path');
  return value;
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function cacheComplete(root, assets = MODEL_ASSETS) {
  return Object.entries(assets).every(([name, sha]) => {
    try { return digest(fs.readFileSync(path.join(root, MODEL, name))) === sha; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  });
}
export function requireEmbeddingCache(root = embeddingCacheRoot()) {
  if (!cacheComplete(root)) throw new Error('Real embedding test model is missing or incomplete. Run tests/setup/real-embedding-cache.mjs --prepare before the suite; downloads are forbidden inside test hooks.');
  return root;
}

/** All downloads finish and validate before any worker loads ONNX. No native session here. */
export async function prepareEmbeddingCache({ root = embeddingCacheRoot(), sourceRoot, assets = MODEL_ASSETS, download, budgetMs = 550_000 } = {}) {
  if (cacheComplete(root, assets)) return;
  const deadline = Date.now() + budgetMs;
  if (budgetMs <= 0) throw new Error('Real embedding preparation budget exhausted before acquisition');
  fs.mkdirSync(root, { recursive: true });
  // Existing cross-process lock implementation has heartbeat + stale-lock
  // recovery, so a killed bounded preparation cannot wedge all later runs.
  const release = await lockfile.lock(root, {
    realpath: false, lockfilePath: path.join(root, '.prepare.lock'),
    stale: 30_000, update: 5_000,
    retries: { retries: Math.floor(Math.min(240_000, budgetMs) / 200), minTimeout: 200, maxTimeout: 200, factor: 1 },
  });
  try {
    if (cacheComplete(root, assets)) return;
    for (const [name, sha] of Object.entries(assets)) {
      if (Date.now() >= deadline) throw new Error('Real embedding preparation budget exhausted; no suite was started');
      const target = path.join(root, MODEL, name);
      let bytes;
      try { bytes = fs.readFileSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (bytes && digest(bytes) === sha) continue;
      if (sourceRoot) {
        try { bytes = fs.readFileSync(path.join(sourceRoot, MODEL, name)); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      if (!bytes || digest(bytes) !== sha) bytes = await download(name, Math.max(1, deadline - Date.now()));
      if (digest(bytes) !== sha) throw new Error(`Real embedding model checksum mismatch: ${name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    if (!cacheComplete(root, assets)) throw new Error('Real embedding test model preparation did not complete');
  } finally {
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--prepare') {
  const { env } = await import('@huggingface/transformers');
  await prepareEmbeddingCache({
    sourceRoot: env.cacheDir,
    download: async (name, remainingMs) => {
      const response = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${name}`, { signal: AbortSignal.timeout(Math.min(120_000, remainingMs)) });
      if (!response.ok) throw new Error(`Real embedding model download failed: ${name} HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (length > 100_000_000) throw new Error(`Real embedding model download exceeds asset bound: ${name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 100_000_000) throw new Error(`Real embedding model download exceeds asset bound: ${name}`);
      return bytes;
    },
  });
  console.log('[embedding-test-model] complete pinned model available; suite loads are local only');
}
