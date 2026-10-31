// Windows CI only: exercise the shipped PowerShell hop against a real
// companion process started by the workflow. No screen or input is touched.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const port = Number(process.env.INSTAR_DESKTOP_TEST_PORT);
const secretPath = process.env.INSTAR_DESKTOP_TEST_SECRET;
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !secretPath) throw new Error('test setup invalid');
const secret = fs.readFileSync(secretPath);
if (secret.length !== 32) throw new Error('test secret invalid');
const body = '{}';
const time = String(Date.now());
const nonce = randomBytes(24).toString('base64url');
const digest = createHash('sha256').update(body).digest('hex');
const mac = createHmac('sha256', secret)
  .update(`instar-windows-desktop-v1\nprobe\n${time}\n${nonce}\n${digest}`)
  .digest('base64url');
const line = JSON.stringify({ body, time, nonce, mac }) + '\n';
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', 'scripts/windows-desktop-local-transport.ps1', '-Address', '127.0.0.1',
  '-Port', String(port), '-Operation', 'probe'],
{ input: line, encoding: 'utf8', timeout: 6_000, maxBuffer: 2_000_000 });
if (result.error || result.status !== 0) throw new Error('transport process failed');
let reply;
try { reply = JSON.parse(result.stdout.trim()); }
catch { throw new Error('transport reply invalid'); }
if (reply.status !== 200 || reply.type !== 'application/json') {
  throw new Error(`transport probe failed (status=${reply.status}, phase=${reply.error ?? 'none'})`);
}
let probe;
try { probe = JSON.parse(Buffer.from(reply.body, 'base64').toString('utf8')); }
catch { throw new Error('companion probe invalid'); }
if (typeof probe.screenPermission !== 'boolean' || typeof probe.sessionActive !== 'boolean') {
  throw new Error('companion probe shape invalid');
}
console.log('Windows-local signed companion probe passed');
