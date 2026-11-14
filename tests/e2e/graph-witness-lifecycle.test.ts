import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { GraphWitnessClient } from '../../src/core/GraphWitnessClient.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { canonicalHash, verifyCommitCertificate } from '../../src/core/GraphWitnessTypes.js';
import { pem, witnessFixture } from '../unit/graph-witness-fixtures.js';

const children = new Set<ChildProcess>(); const directories: string[] = [];
async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(signal); await exited; children.delete(child);
}
afterEach(async () => {
  for (const child of children) await stop(child, 'SIGKILL');
  for (const directory of directories.splice(0)) SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'graph-witness-lifecycle-fixture-cleanup' });
});
async function freePort() {
  const listener = net.createServer(); await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('fixture-listener-unavailable');
  const port = address.port; await new Promise<void>((resolve) => listener.close(() => resolve())); return port;
}
async function start(configPath: string, port: number) {
  const child = spawn(process.execPath, ['services/graph-witness/start.mjs'], { cwd: process.cwd(),
    env: { PATH: process.env.PATH, GRAPH_WITNESS_CONFIG_FILE: configPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('witness-start-deadline')), 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('witness-process-start-failed')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('witness-process-exited-before-listening')); });
    child.stdout!.on('data', (data: Buffer) => { if (data.toString().includes('Witness service is listening.')) { clearTimeout(timer); resolve(); } });
  });
  return child;
}
describe('production graph witness lifecycle', () => {
  it('boots the shipped entry, survives hard process loss, and keeps erasure dominant after a second crash', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-witness-process-')); directories.push(directory);
    const f = witnessFixture(directory); const configPath = path.join(directory, 'witness-config.json');
    fs.writeFileSync(configPath, JSON.stringify(f.options), { mode: 0o600 });
    const port = await freePort();
    const options = { baseUrl: `http://127.0.0.1:${port}`, agentId: f.membership.agentId, bearerToken: 'test-agent-token',
      ownerPublicKey: pem(f.owner.publicKey),
      witnessId: f.membership.witnessId, witnessPublicKey: pem(f.witness.publicKey), expectedFailureDomain: f.membership.failureDomain,
      allowLoopbackHttpForTests: true, timeoutMs: 10000 };
    const client = new GraphWitnessClient(options);
    let child = await start(configPath, port);
    await client.verifyRemote(); await client.registerMembership(f.membership);
    const request = f.prepareRequest(); await client.prepare(request);
    const certificate = await client.commit(request, f.membership, [f.receipt(request.packet, 0), f.receipt(request.packet, 1)]);
    expect(verifyCommitCertificate(certificate, request.packet, f.membership, pem(f.witness.publicKey))).toBe(true);
    await stop(child, 'SIGKILL');
    child = await start(configPath, port);
    await client.verifyRemote();
    const recovered = await client.recover(request.packet.idempotencyKey);
    expect(recovered.operation.certificate).toEqual(certificate);
    expect(recovered.encryptedSourceBundle).toEqual(request.encryptedSourceBundle);
    const authorizationReceiptHash = canonicalHash({ owner: 'verified-erasure' });
    const fields = {target:request.packet.erasureIdentity, requestId: 'erase-crash', bundleHashes: [request.packet.sourceBundleHash], authorizationReceiptHash };
    const erasure = await client.erase(fields.requestId,fields.target, fields.bundleHashes, authorizationReceiptHash, request.lease, request.originalLease,
      f.actionSignature('erase', fields, request.lease));
    // Crash before the separate checkpoint: SQL logical suppression alone is
    // not counted as physical/WAL or external-backup erasure completion.
    await stop(child, 'SIGKILL');
    child = await start(configPath, port);
    const afterCrash = await client.recover(request.packet.idempotencyKey);
    expect(afterCrash.encryptedSourceBundle).toBeNull(); expect(afterCrash.erasure).toEqual(erasure);
    await expect(client.prepare(request)).rejects.toThrow('source-erased');
    const purge = await client.checkpointErasure(fields.requestId);
    expect(purge.walPurged).toBe(true); expect(purge.externalBackupsVerified).toBe(false);
    expect(afterCrash.operation.packet.coreHash).toBe(request.packet.coreHash);
    await stop(child, 'SIGTERM');
  });
});
