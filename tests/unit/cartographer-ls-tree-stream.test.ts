// safe-git-allow: fixture-only git commands create temporary repositories.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { LsTreeNulParser, readCurrentOids } from '../../src/core/cartographerDetect.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function repoWith(files: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stream-'));
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return repo;
}

function fakeChild(chunks: Buffer[], close: { code: number | null; signal: NodeJS.Signals | null }): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr });
  queueMicrotask(() => {
    for (const chunk of chunks) stdout.write(chunk);
    stdout.end();
    child.emit('close', close.code, close.signal);
  });
  return child;
}

describe('streaming git ls-tree', () => {
  it('parses a NUL exactly at a chunk edge and a UTF-8 record spanning 3+ chunks', () => {
    const records: string[] = [];
    const parser = new LsTreeNulParser((record) => records.push(record));
    const first = Buffer.from('100644 blob aaa\ta.ts\0');
    parser.push(first); // NUL is the final byte of this chunk
    for (const part of [Buffer.from('100'), Buffer.from('644 blob bbb\tunic'), Buffer.from('od'), Buffer.from('é.ts\0')]) {
      parser.push(part);
    }
    parser.finish();
    expect(records).toEqual(['100644 blob aaa\ta.ts', '100644 blob bbb\tunicodé.ts']);
  });

  it('is shape/order-identical to the former buffered parse on a real fixture tree', async () => {
    const repo = repoWith({ 'a.txt': 'a', 'dir/b.txt': 'b', 'dir/c.txt': 'c' });
    try {
      const expected = new Map<string, string>();
      expected.set('', git(repo, ['rev-parse', 'HEAD^{tree}']).trim());
      for (const entry of git(repo, ['ls-tree', '-r', '-t', '-z', 'HEAD']).split('\0')) {
        if (!entry) continue;
        const [meta, name] = entry.split('\t');
        expected.set(name, meta.split(' ')[2]);
      }
      expect([...await readCurrentOids(repo, 1)]).toEqual([...expected]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns a clean root-only result for an empty tree', async () => {
    const repo = repoWith({ '.gitkeep': '' });
    try {
      git(repo, ['rm', '-q', '.gitkeep']);
      git(repo, ['commit', '-q', '-m', 'empty']);
      const result = await readCurrentOids(repo, 1);
      expect([...result.keys()]).toEqual(['']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('streams output larger than the deprecated maxBuffer value', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`large/f-${i.toString().padStart(4, '0')}.txt`] = `${i}`;
    const repo = repoWith(files);
    try {
      const result = await readCurrentOids(repo, 1);
      expect(result.size).toBeGreaterThan(400);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a child killed mid-stream and exposes no partial map', async () => {
    const repo = repoWith({ 'a.txt': 'a' });
    try {
      const partial = Buffer.from('100644 blob deadbeef\tlooks-complete.txt\0');
      await expect(readCurrentOids(repo, 1, () => fakeChild([partial], { code: null, signal: 'SIGKILL' })))
        .rejects.toThrow(/SIGKILL/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a non-zero exit after complete-looking partial records', async () => {
    const repo = repoWith({ 'a.txt': 'a' });
    try {
      const partial = Buffer.from('100644 blob deadbeef\tlooks-complete.txt\0');
      await expect(readCurrentOids(repo, 1, () => fakeChild([partial], { code: 128, signal: null })))
        .rejects.toThrow(/exit 128/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a spawn error through the same all-or-nothing boundary', async () => {
    const repo = repoWith({ 'a.txt': 'a' });
    try {
      const spawnFailure = new Error('spawn unavailable');
      const spawn = (): ChildProcess => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => {
          child.emit('error', spawnFailure);
          child.emit('close', null, null);
        });
        return child;
      };
      await expect(readCurrentOids(repo, 1, spawn)).rejects.toThrow('spawn unavailable');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
