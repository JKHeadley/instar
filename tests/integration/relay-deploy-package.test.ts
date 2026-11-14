import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Exercise the actual container input layout and entrypoint. In particular,
// neither docs nor template Markdown nor the agent packager is available.
describe('relay deployment package', () => {
  let root: string;
  const children: ChildProcess[] = [];
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-package-'));
    fs.cpSync(path.resolve('src'), path.join(root, 'src'), {
      recursive: true, filter: file => !file.endsWith('.md'),
    });
    for (const file of ['tsconfig.json', 'tsconfig.relay.json']) {
      fs.copyFileSync(path.resolve(file), path.join(root, file));
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(fs.realpathSync('node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.resolve('scripts/relay-entrypoint.mjs'), path.join(root, 'scripts/relay-entrypoint.mjs'));
    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/typescript-native/bin/tsc'), '--project', 'tsconfig.relay.json',
    ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'dist/cli.js'))).toBe(false);
  }, 40_000);

  afterAll(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    }));
    if (root) SafeFsExecutor.safeRmSync(root, {
      recursive: true, force: true, operation: 'relay-deploy-package.test.ts:cleanup',
    });
  });

  const baseEnv = () => ({
    PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(),
    RELAY_PORT: '0', RELAY_HOST: '127.0.0.1', RELAY_ADMIN_PORT: '0',
    RELAY_DATA_DIR: path.join(root, 'data'),
  });

  it('refuses an absent host secret without generating or logging a key', () => {
    const result = spawnSync(process.execPath, ['scripts/relay-entrypoint.mjs'], {
      cwd: root, env: baseEnv(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be provisioned');
    expect(result.stdout).not.toContain('RELAY_ADMIN_KEY=');
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('starts the compiled relay and reports the baked revision without leaking its secret', async () => {
    const secret = randomBytes(32).toString('hex');
    const revision = '1234567890abcdef1234567890abcdef12345678';
    const child = spawn(process.execPath, ['scripts/relay-entrypoint.mjs'], {
      cwd: root, env: { ...baseEnv(), RELAY_ADMIN_KEY: secret, RELAY_BUILD_REVISION: revision },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay startup timed out')), 10_000);
      const read = (data: Buffer) => {
        output += data.toString();
        const match = output.match(/Relay listening on ws:\/\/127\.0\.0\.1:(\d+)\/v1\/connect/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`relay exited: ${code}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok', buildRevision: revision, registry: { status: 'healthy' },
    });
    expect(output).not.toContain(secret);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(true);
  });
});
