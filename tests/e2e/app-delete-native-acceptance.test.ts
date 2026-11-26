import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('serves signed Delete and epoch reset through the persistent loopback launcher', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'app-delete-native-client-'));
  const keyFile = path.join(fixture, 'public-key');
  const device = makeDevice();
  fs.writeFileSync(keyFile, device.publicKey);
  const child = spawn(process.execPath, ['scripts/app-delete-native-acceptance.mjs', keyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try {
    let ready: { host: string; deviceId: string; conversationKey: string; custodianMachineId: string;
      targetEventId: string; survivingEventId: string } | undefined;
    lines.on('line', (line) => {
      if (line.startsWith('{"type":"delete-native-acceptance-ready"')) ready = JSON.parse(line);
    });
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`Disposable launcher exited: ${stderr}`);
      expect(ready).toBeDefined();
    }, { timeout: 20_000 });
    const { host, deviceId, conversationKey, custodianMachineId, targetEventId, survivingEventId } = ready!;
    const origin = 'http://' + host;
    const base = `/mobile/chat/app/${conversationKey}`;
    let tick = 0;
    const send = async (method: string, target: string, input?: object) => {
      const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
      const time = String(Date.now() + tick++);
      const signature = device.sign(canonicalString(deviceId, host, method, target, time, body));
      const response = await fetch(new URL(target, origin), { method, body,
        headers: { 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': signature,
          ...(body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const firstHistory = await send('GET', base + '/messages?limit=1');
    expect(firstHistory.status).toBe(200);
    expect(firstHistory.body).toMatchObject({ hasOlder: true, messages: [expect.any(Object)] });
    expect((await send('GET', base + '/messages?limit=101')).status).toBe(400);
    expect((await send('GET', base + '/messages?limit=1&limit=2')).status).toBe(400);
    const first = await send('GET', base + '/events');
    expect(first.status).toBe(200);
    const intent = { custodianMachineId, eventId: targetEventId, requestId: `${Date.now()}-${crypto.randomUUID()}` };
    const removed = await send('POST', base + '/message-removals', intent);
    expect(removed.status).toBe(200);
    expect((await send('POST', base + '/message-removals', intent)).body).toEqual(removed.body);
    const next = await send('GET', base + '/events?cursor=' + encodeURIComponent(first.body.cursor));
    expect(next.body.changes).toContainEqual({ kind: 'message-removed', conversationKey,
      eventId: removed.body.removalEventId, targetEventId });
    const history = await send('GET', base + '/messages?limit=100');
    expect(history.status).toBe(200);
    expect(history.body.messages.map((row: { eventId: string }) => row.eventId)).toEqual([survivingEventId]);
    child.kill('SIGHUP');
    await vi.waitFor(async () => {
      const reset = await send('GET', base + '/events?cursor=' + encodeURIComponent(next.body.cursor));
      expect(reset.status).toBe(409);
      expect(reset.body.epoch).not.toBe(next.body.epoch);
    });
    expect((await send('GET', '/health')).status).toBe(404);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    try {
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 5000 });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
      SafeFsExecutor.safeRmSync(fixture, { recursive: true, force: true, operation: 'app-delete-native-acceptance-test:cleanup' });
    }
  }
}, 35_000);
