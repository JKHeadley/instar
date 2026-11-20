/**
 * Identity A4, GPT review 5: `instar mobile add-phone` (src/commands/mobileAddPhone.ts) stops when the agent
 * no longer knows its setup (a restart ends every setup) instead of polling a 404 for 30 minutes, and never
 * reports success when the phone did not finish.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Piped input: the PIN, then the number.
const lines: string[] = [];
vi.mock('node:readline', () => {
  const createInterface = () => ({
    question: (_q: string, cb: (l: string) => void) => cb(lines.shift() ?? ''),
    close: () => undefined,
    [Symbol.asyncIterator]: () => ({ next: async () => (lines.length ? { done: false, value: lines.shift()! } : { done: true, value: undefined }) }),
  });
  return { default: { createInterface }, createInterface };
});

const { addPhone } = await import('../../src/commands/mobileAddPhone.js');

const dirs: string[] = [];
const servers: http.Server[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-add-phone-cli.test.ts' }); });
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))); process.exitCode = undefined; vi.restoreAllMocks(); });

/** A stand-in agent: answers the setup start, then each GET from the script `gets`. */
async function agent(gets: Array<{ status: number; body: Record<string, unknown> }>, last: { status: number; body: Record<string, unknown> }) {
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, b: Record<string, unknown>) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'POST' && req.url === '/mobile/phone-setup') return send(200, { setupId: 's1', link: 'https://instar.sh/pair#v=2', approval: 'computer', address: {} });
      if (req.method === 'POST' && req.url === '/mobile/phone-setup/s1/number') return send(200, { state: 'number-accepted' });
      if (req.method === 'POST' && req.url === '/mobile/phone-setup/s1/cancel') return send(200, { state: 'ended' });
      const g = gets.shift() ?? last;
      // -1: the agent is down mid-restart (the connection drops with no answer).
      if (g.status === -1) { req.socket.destroy(); return; }
      return send(g.status, g.body);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'addphone-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'Wintest', port, authToken: 'tok-1' }));
  return { dir, calls };
}

describe('instar mobile add-phone after the agent restarts', () => {
  it('a 404 while waiting for the phone ends the command with an error at once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const a = await agent([], { status: 404, body: { error: 'unknown-setup' } });
    lines.splice(0, lines.length, '482915');
    await addPhone({ dir: a.dir, pollMs: 1 });
    expect(process.exitCode).toBe(1);
    expect(a.calls.filter((c) => c.startsWith('GET')).length).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/restarted/);
  });

  it('a 404 after the number ends the command with an error, not a success', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const a = await agent([{ status: 200, body: { state: 'waiting-number', phone: { name: 'p', key: 'k' } } }], { status: 404, body: { error: 'unknown-setup' } });
    lines.splice(0, lines.length, '482915', '123456');
    await addPhone({ dir: a.dir, pollMs: 1 });
    expect(process.exitCode).toBe(1);
    expect(a.calls.filter((c) => c.startsWith('GET')).length).toBe(2);
    expect(err.mock.calls.flat().join(' ')).toMatch(/restarted/);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/phone is added/);
  });

  it('a poll that finds the agent down (restarting) asks again instead of crashing, then stops on the 404', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const a = await agent([{ status: -1, body: {} }], { status: 404, body: { error: 'unknown-setup' } });
    lines.splice(0, lines.length, '482915');
    await addPhone({ dir: a.dir, pollMs: 1 });
    expect(process.exitCode).toBe(1);
    expect(a.calls.filter((c) => c.startsWith('GET')).length).toBe(2);
    expect(err.mock.calls.flat().join(' ')).toMatch(/restarted/);
  });

  it('a phone that never finishes after the number is reported as not added (exit 1)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const a = await agent([{ status: 200, body: { state: 'waiting-number', phone: {} } }], { status: 200, body: { state: 'number-accepted' } });
    lines.splice(0, lines.length, '482915', '123456');
    await addPhone({ dir: a.dir, pollMs: 0 });
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/not added/);
    expect(a.calls).toContain('POST /mobile/phone-setup/s1/cancel');
  }, 30_000);
});
