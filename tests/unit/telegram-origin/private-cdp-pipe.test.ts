import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrivateCdpPipe } from '../../../src/messaging/telegram-origin/PrivateCdpPipe.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';

const pipes: PrivateCdpPipe[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(pipes.splice(0).map(pipe => pipe.close()));
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:origin-cdp:cleanup' });
});
function createPipe(requestTimeoutMs = 2000): PrivateCdpPipe {
  const dir = temporaryState(); directories.push(dir);
  const executablePath = path.join(dir, 'browser-fixture');
  writeFileSync(executablePath, `#!${process.execPath}
const fs = require('node:fs');
let buffer = '';
fs.createReadStream(null, {fd: 3}).on('data', chunk => {
 buffer += chunk.toString(); let end;
 while ((end = buffer.indexOf('\\0')) >= 0) {
  const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  if (request.method === 'stall') continue;
  if (request.method === 'malformed') { fs.writeSync(4, 'invalid-json\\0'); continue; }
  fs.writeSync(4, JSON.stringify({id: request.id, result: {echo: request.params, secretInherited: !!process.env.ORIGIN_FAKE_SERVER_SECRET}}) + '\\0');
 }
});
`, { mode: 0o700 });
  const pipe = new PrivateCdpPipe({ executablePath, userDataDir: dir, requestTimeoutMs }); pipes.push(pipe); return pipe;
}
describe('private CDP process custody', () => {
  it('uses real private pipes and excludes unrelated server credentials from the child environment', async () => {
    vi.stubEnv('ORIGIN_FAKE_SERVER_SECRET', 'fixture-not-a-secret');
    const pipe = createPipe();
    expect(await pipe.request('echo', { text: 'hello' })).toEqual({ echo: { text: 'hello' }, secretInherited: false });
  });
  it('terminates a stalled process and rejects future requests after its deadline', async () => {
    const pipe = createPipe(150);
    await expect(pipe.request('stall')).rejects.toThrow('browser-request-deadline');
    await pipe.close();
    await expect(pipe.request('echo')).rejects.toThrow('browser-pipe-closed');
  });
  it('caps concurrent requests and closes all pending work without dangling timers', async () => {
    const pipe = createPipe();
    const pending = Array.from({ length: 32 }, () => pipe.request('stall').catch(error => error.message));
    await expect(pipe.request('echo')).rejects.toThrow('browser-request-capacity');
    await pipe.close();
    expect(await Promise.all(pending)).toEqual(Array(32).fill('browser-pipe-closed'));
  });
  it('rejects an oversized request before writing and retires malformed response streams', async () => {
    const pipe = createPipe();
    await expect(pipe.request('echo', { text: 'a'.repeat(1024 * 1024) })).rejects.toThrow('browser-request-too-large');
    expect(await pipe.request('echo', { valid: true })).toMatchObject({ echo: { valid: true } });
    await expect(pipe.request('malformed')).rejects.toThrow('browser-protocol-malformed');
    await expect(pipe.request('echo')).rejects.toThrow('browser-pipe-closed');
  });
});
