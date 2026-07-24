import fs from 'node:fs';
import { Client, utils } from 'ssh2';

export interface StandingSshTarget {
  host: string;
  port: number;
  username: string;
  hostPublicKey: string;
  clientPrivateKeyPath: string;
}

/** Proves that the dedicated key can execute through the host's real sshd. */
export class StandingSshVerifier {
  probe(target: StandingSshTarget): Promise<void> {
    const expected = utils.parseKey(target.hostPublicKey);
    if (expected instanceof Error || expected.type !== 'ssh-ed25519') throw new Error('standing-ssh-host-key-invalid');
    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        client.end();
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('standing-ssh-timeout')), 8_000);
      client.once('error', error => { clearTimeout(timer); finish(error); });
      client.once('ready', () => client.exec('printf instar-standing-key-ok', (error, stream) => {
        if (error) { clearTimeout(timer); finish(error); return; }
        let stdout = '';
        let stderr = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
        stream.once('close', (code: number | null) => {
          clearTimeout(timer);
          if (code === 0 && stdout === 'instar-standing-key-ok' && stderr === '') finish();
          else finish(new Error('standing-ssh-exec-failed'));
        });
      }));
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: fs.readFileSync(target.clientPrivateKeyPath),
        readyTimeout: 7_500,
        hostVerifier: (key: Buffer) => key.equals(expected.getPublicSSH()),
        algorithms: { serverHostKey: ['ssh-ed25519'], kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'] },
      });
    });
  }
}
