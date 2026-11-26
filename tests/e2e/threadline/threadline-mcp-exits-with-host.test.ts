/**
 * When the app closes threadline-mcp's stdin (it quit, or restarted the server), the server exits and
 * releases the state dir's owner lock. Before 0.5.1 it lingered: the replacement the app started was not
 * the pairing owner and could not pair, and the old process kept this identity's relay connection.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk'));

describe.skipIf(!hasDeps)('threadline-mcp exits with its host', () => {
  it('exits and releases the owner lock when stdin closes', async () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-exit-'));
    const child = spawn(process.execPath, [path.join(pkg, 'dist', 'server.js')], {
      env: { ...process.env, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    const lock = path.join(sd, 'threadline', 'owner.lock');
    for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(lock)).toBe(true);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('still running'), 5000))]);
    if (code === 'still running') child.kill('SIGKILL');
    expect(code).toBe(0);
    expect(stderr).toMatch(/stdin closed; exiting|transport closed; exiting/);
    expect(fs.existsSync(lock)).toBe(false);
  }, 60_000);
});
