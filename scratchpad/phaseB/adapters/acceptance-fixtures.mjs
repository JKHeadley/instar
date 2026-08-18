import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function absolute(root, rel) {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes isolated root: ${rel}`);
  }
  return resolved;
}
export function read(root, rel) {
  return fs.readFileSync(absolute(root, rel), 'utf8');
}

export function write(root, rel, text) {
  const target = absolute(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

export function replaceOnce(root, rel, before, after) {
  const content = read(root, rel);
  const first = content.indexOf(before);
  const last = content.lastIndexOf(before);
  if (first === -1 || first !== last) {
    throw new Error(`${rel}: expected one replacement target; first=${first} last=${last}`);
  }
  write(root, rel, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
}

export function replaceThroughMarker(root, rel, startToken, endToken, replacement, fromToken = null) {
  const content = read(root, rel);
  const from = fromToken === null ? 0 : content.indexOf(fromToken);
  if (from < 0) throw new Error(`${rel}: anchor missing: ${fromToken}`);
  const start = content.indexOf(startToken, from);
  if (start < 0) throw new Error(`${rel}: start token missing after anchor: ${startToken}`);
  const end = content.indexOf(endToken, start + startToken.length);
  if (end < 0) throw new Error(`${rel}: end token missing after start: ${endToken}`);
  write(root, rel, `${content.slice(0, start)}${replacement}${content.slice(end)}`);
}

export function commentAll(root, rel) {
  write(root, rel, read(root, rel).split('\n').map((line) => `// ${line}`).join('\n'));
}

export function checksResult(checks) {
  return { ok: checks.every((item) => item.passed), checks };
}

export function includesChecks(root, rel, included = [], excluded = []) {
  const content = read(root, rel);
  return checksResult([
    ...included.map((token) => ({ check: `${rel} includes ${JSON.stringify(token)}`, passed: content.includes(token) })),
    ...excluded.map((token) => ({ check: `${rel} excludes ${JSON.stringify(token)}`, passed: !content.includes(token) })),
  ]);
}

export function writeVitestConfig(root) {
  write(root, '.b0-fix-verifier.vitest.config.mjs', `export default {\n  test: {\n    environment: 'node',\n    fileParallelism: false,\n    testTimeout: 20_000,\n    hookTimeout: 20_000,\n  },\n};\n`);
}

export function run(root, argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

export function structuredRelevance(mode, checks) {
  return {
    status: checks.every((item) => item.passed) ? 'proven' : 'unknown',
    mode,
    checks,
  };
}
