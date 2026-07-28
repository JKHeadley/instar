import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StandingSshVerifier } from '../../src/core/StandingSshVerifier.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'standing-ssh-verifier.test.ts:cleanup' });
});

describe('StandingSshVerifier', () => {
  it('requires the dedicated client key, pins the host key, and proves exec', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-standing-ssh-'));
    roots.push(root);
    const clientIdentity = new MachineSshIdentity(root, 'agent', 'client').ensure();
    const hostIdentity = new MachineSshIdentity(root, 'agent', 'host').ensure();
    const admitted = utils.parseKey(clientIdentity.clientPublicKey);
    if (admitted instanceof Error) throw admitted;
    const server = new Server({ hostKeys: [fs.readFileSync(hostIdentity.hostPrivateKeyPath)] }, connection => {
      connection.on('authentication', ctx => {
        if (ctx.method === 'publickey' && ctx.key.algo === admitted.type && ctx.key.data.equals(admitted.getPublicSSH())) ctx.accept();
        else ctx.reject();
      });
      connection.on('ready', () => connection.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (info.command === 'printf instar-standing-key-ok') {
            stream.write('instar-standing-key-ok');
            stream.exit(0);
          } else stream.exit(1);
          stream.end();
        });
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test-listener-missing');
      await expect(new StandingSshVerifier().probe({
        host: '127.0.0.1',
        port: address.port,
        username: os.userInfo().username,
        hostPublicKey: hostIdentity.hostPublicKey,
        clientPrivateKeyPath: clientIdentity.clientPrivateKeyPath,
      })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
