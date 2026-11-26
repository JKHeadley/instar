import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { joinMesh, isPlainHttpRemote } from '../../src/commands/machine.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * SEC-072: two pairing-response fields sit outside the sealed identity envelope. A join whose
 * identity handover does not verify (a wrong or hostile listener) must save neither of them.
 */
describe('instar join saves out-of-envelope fields only after the identity verifies', () => {
  const roots: string[] = [];
  const servers: http.Server[] = [];
  const originalPath = process.env.PATH;
  afterEach(async () => {
    vi.restoreAllMocks(); process.env.PATH = originalPath;
    for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
    for (const r of roots) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'join-persist-after-verify-test-cleanup' });
  });

  it('a listener that offers no valid identity cannot plant introducers or the recovery bearer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'join-persist-'));
    roots.push(root);
    const dir = path.join(root, 'home');
    const fakeBin = path.join(root, 'fakebin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "0.0.0-test (Claude Code)"\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/pair' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'paired',
          ownerIntroducers: [{ name: 'planted', publicKey: 'AAAA' }],
          identityRecoveryBearerToken: 'e'.repeat(64),
          machineIdentity: { machineId: 'm_' + 'f'.repeat(32), name: 'planted-peer', signingPublicKey: 'x', encryptionPublicKey: 'y', createdAt: new Date().toISOString(), capabilities: [] },
          endpoints: [{ url: 'http://198.51.100.7:4040', kind: 'lan' }],
        }));
        return;
      }
      res.writeHead(404); res.end();
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
    const port = (server.address() as AddressInfo).port;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code ?? 0); throw new Error(`exit:${code}`); }) as never);
    await joinMesh(`http://127.0.0.1:${port}`, { code: 'AB-CD-1234', dir, port: 4998 } as never).catch(() => undefined);
    expect(exits).toContain(1); // the join stops instead of reporting success
    // Nothing anywhere in the agent's state names the planted peer.
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(dir, '.instar'))) {
      const body = fs.readFileSync(f, 'utf-8');
      expect(body, f).not.toContain('planted-peer');
      expect(body, f).not.toContain('f'.repeat(32));
    }
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
    expect(config.mobilePairing?.ownerIntroducers).toBeUndefined();
    expect(config.multiMachine?.identityReannounce?.sharedBearerToken).toBeUndefined();
  }, 60_000);

  it('the saves sit inside the verified-identity branch', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/machine.ts'), 'utf-8');
    const ok = src.indexOf('if (agentIdentityOutcome.ok) {\n        // SEC-072');
    expect(ok).toBeGreaterThan(0);
    expect(src.indexOf('identityReannounce.sharedBearerToken = result.identityRecoveryBearerToken')).toBeGreaterThan(ok);
    expect(src.indexOf('joinedConfig.mobilePairing.ownerIntroducers = ')).toBeGreaterThan(ok);
    expect(src).not.toContain('verify the visual symbols match');
  });
});

describe('isPlainHttpRemote', () => {
  it('warns for plain http to another machine only', () => {
    expect(isPlainHttpRemote('http://192.168.1.20:4040')).toBe(true);
    expect(isPlainHttpRemote('http://studio.local:4040')).toBe(true);
    expect(isPlainHttpRemote('https://x.trycloudflare.com')).toBe(false);
    expect(isPlainHttpRemote('http://127.0.0.1:4040')).toBe(false);
    expect(isPlainHttpRemote('http://localhost:4040')).toBe(false);
    expect(isPlainHttpRemote('http://[::1]:4040')).toBe(false);
    expect(isPlainHttpRemote('not a url')).toBe(false);
    expect(isPlainHttpRemote('http://100.101.102.103:4040')).toBe(false); // Tailscale encrypts the link
    expect(isPlainHttpRemote('http://studio.tail1234.ts.net:4040')).toBe(false);
    expect(isPlainHttpRemote('http://agent.localhost:4040')).toBe(false);
    expect(isPlainHttpRemote('http://100.200.1.1:4040')).toBe(true); // outside 100.64/10
  });
});
