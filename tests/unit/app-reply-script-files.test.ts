/**
 * app-reply.sh --file (docs/specs/mobile-native-chat-media.md §4.6): with files and no text
 * argument, a piped caption is read with a bounded wait (2 s per line, 10 s in all), so a heredoc
 * caption arrives and a stdin that never closes cannot hang the script.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'app-reply.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-reply-script-files.test.ts' }); });

/** A stand-in for POST /app/session-reply that records each body. */
async function server() {
  const bodies: Array<{ text: string; files?: Array<{ path: string }> }> = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { bodies, port: (srv.address() as AddressInfo).port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

// The script's JSON escaping adds one trailing newline to every message (the server trims text),
// so captions are compared with trailing whitespace removed.

/** Run the script; `feed` writes to its stdin and decides whether stdin is ever closed. */
async function run(port: number, args: string[], feed: (stdin: NodeJS.WritableStream) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appreply-'));
  dirs.push(dir);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  const child = spawn('bash', [SCRIPT, '--file', file, ...args], { cwd: dir, env: { ...process.env, INSTAR_PORT: String(port), INSTAR_AUTH_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const started = Date.now();
  feed(child.stdin);
  const code = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('app-reply.sh blocked on stdin')); }, 20_000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  child.stdin.destroy();
  return { code, stderr, ms: Date.now() - started, file };
}

describe('app-reply.sh --file with a piped caption', () => {
  it('sends a heredoc caption whole, every line', async () => {
    const s = await server();
    try {
      const r = await run(s.port, [], (stdin) => { stdin.end('Here is the report.\nPage two has the totals.\n'); });
      expect(r.code).toBe(0);
      expect(s.bodies[0]!.text.trimEnd()).toBe('Here is the report.\nPage two has the totals.');
      expect(s.bodies[0]!.files).toEqual([{ path: r.file }]);
    } finally { await s.close(); }
  });

  it('keeps a last line with no newline', async () => {
    const s = await server();
    try {
      await run(s.port, [], (stdin) => { stdin.end('no newline at the end'); });
      expect(s.bodies[0]!.text.trimEnd()).toBe('no newline at the end');
    } finally { await s.close(); }
  });

  it('returns within the bounded wait when stdin never closes, and sends no caption', async () => {
    const s = await server();
    try {
      const r = await run(s.port, [], () => { /* stdin left open and silent */ });
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(8_000);
      expect(s.bodies[0]!.text.trimEnd()).toBe('');
      expect(s.bodies[0]!.files).toHaveLength(1);
    } finally { await s.close(); }
  });

  it('sends what arrived and warns when the pipe stalls part way', async () => {
    const s = await server();
    try {
      const r = await run(s.port, [], (stdin) => { stdin.write('first line\n'); });
      expect(r.code).toBe(0);
      expect(s.bodies[0]!.text.trimEnd()).toBe('first line');
      expect(r.stderr).toContain('stopped waiting for more piped caption text');
    } finally { await s.close(); }
  });

  it('a text argument is the caption and stdin is not read', async () => {
    const s = await server();
    try {
      const r = await run(s.port, ['the caption'], () => { /* open stdin */ });
      expect(r.code).toBe(0);
      expect(s.bodies[0]!.text.trimEnd()).toBe('the caption');
    } finally { await s.close(); }
  });
});
