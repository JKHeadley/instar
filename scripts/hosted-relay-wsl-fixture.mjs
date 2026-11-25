#!/usr/bin/env node
// safe-fs-allow: disposable runner — SafeFsExecutor owns its new temporary directory.
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FencedLease } from '../dist/core/FencedLease.js';
import { writeLocalOwnerTicket } from '../dist/core/localOwnerTicket.js';
import { MachineIdentityManager, sign } from '../dist/core/MachineIdentity.js';
import { signOwnerRecordEntry } from '../dist/core/ownerRecord.js';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';
import { StateManager } from '../dist/core/StateManager.js';
import { launchDisposableHostedRelay } from '../dist/hostedRelay/disposableLauncher.js';
import { HostedRelayLeaseAdmission } from '../dist/hostedRelay/leaseAdmission.js';
import { createHostedRelayOwnerLeaseReader } from '../dist/hostedRelay/ownerLeaseReader.js';
import { startVerifiedHostedRelay } from '../dist/hostedRelay/startup.js';
import { AgentServer } from '../dist/server/AgentServer.js';

const args = process.argv.slice(2);
const port = Number(args[0]);
const durationSeconds = args.length === 2 ? Number(args[1]) : 300;
if (args.length < 1 || args.length > 2 || !Number.isInteger(port) || port < 1024 || port > 65535
  || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 600) {
  throw new Error('Usage: node scripts/hosted-relay-wsl-fixture.mjs <local-agent-port> [10-600 seconds]');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wsl-relay-'));
const stateDir = path.join(root, '.instar');
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let db, relay, runtime, agent, server;
let failed = false;
const owned = new Set();
const hostname = 'agent.relay.example';
const controlHostname = 'localhost';
const expiry = Date.now() + durationSeconds * 1000;
const authToken = randomBytes(32).toString('hex');
const fixturePath = '/__relay_fixture/ready';
const timer = setTimeout(stop, Math.max(0, expiry - Date.now()));

function pin(cert) {
  return createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function certificate(name, basename) {
  const certPath = path.join(root, basename + '.crt');
  const keyPath = path.join(root, basename + '.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=' + name, '-addext', 'subjectAltName=DNS:' + name, '-keyout', keyPath, '-out', certPath],
  { stdio: 'ignore', timeout: 10_000 });
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

try {
  for (const dir of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true, mode: 0o700 });
  const config = {
    projectName: 'wsl-relay-fixture', projectDir: root, stateDir, port, host: '127.0.0.1', authToken,
    updates: { autoApply: false }, messaging: [], scheduler: { enabled: false, jobsFile: '' },
    mobilePairing: { enabled: true, multiRoute: { enabled: true }, native: { enabled: true } },
    sessions: { claudePath: '/usr/bin/false', maxSessions: 1, defaultMaxDurationMinutes: 1, protectedSessions: [], monitorIntervalMs: 5000 },
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const identity = new MachineIdentityManager(stateDir);
  const { machineId: holder } = await identity.generateIdentity({ name: 'Disposable WSL relay holder' });
  const machineSign = message => sign(message, identity.loadSigningKey());
  const owner = generateKeyPairSync('ed25519');
  const agentId = 'fixture-' + randomBytes(8).toString('hex');
  const assignment = randomBytes(32).toString('hex');
  const agentTls = certificate(hostname, 'agent');
  const controlTls = certificate(controlHostname, 'control');
  const genesis = signOwnerRecordEntry({ agentId, kind: 'genesis', parents: [],
    signer: { type: 'machine', keyId: holder },
    body: { machineId: holder, publicKey: identity.getSigningPublicKeyPem(holder), level: 'basic', agentProducible: true },
  }, machineSign);
  const ownerEntry = signOwnerRecordEntry({ agentId, kind: 'add-owner-key', parents: [genesis.id],
    signer: { type: 'owner-key', keyId: 'o_fixture' },
    body: { keyId: 'o_fixture', label: 'Disposable fixture', publicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }), proof: 'local-fixture' },
  }, message => sign(message, owner.privateKey));
  const agentPin = pin(agentTls.cert);
  const tlsEntry = signOwnerRecordEntry({ agentId, kind: 'tls-key', parents: [ownerEntry.id],
    signer: { type: 'machine', keyId: holder }, body: { machineId: holder, fingerprint: agentPin, seq: 1 },
  }, machineSign);
  const scope = { hostname, agentId, assignment, pinnedGenesis: genesis.id };
  const unsigned = { holder, epoch: 1, nonce: 1, acquiredAt: new Date().toISOString(), expiresAt: new Date(expiry).toISOString() };
  const committed = { ...unsigned, signature: machineSign(FencedLease.canonicalize(unsigned)) };
  const evidence = {
    registration: name => name === hostname ? { ...scope, entries: [genesis.entry, ownerEntry.entry, tlsEntry.entry] } : undefined,
    committedLease: id => id === agentId && !controller.signal.aborted ? committed : undefined,
    verifyFirstOwnerProof: proof => proof.proof === 'local-fixture',
  };
  db = new Database(path.join(root, 'relay.sqlite'));
  db.pragma('synchronous = FULL');
  relay = await launchDisposableHostedRelay({ ...controlTls, leases: new HostedRelayLeaseAdmission(db, createHostedRelayOwnerLeaseReader(evidence)) });
  const controlPin = pin(controlTls.cert);
  runtime = await startVerifiedHostedRelay({
    enabled: true, stateDir, scope, evidence, signal: controller.signal,
    relay: { origin: 'https://localhost:' + relay.controlPort, spkiSha256: controlPin, ca: controlTls.cert },
    agentTls, holdsLocalAuthority: () => !controller.signal.aborted,
    handlePhoneRequest(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' || req.url !== fixturePath) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ready: true }));
    },
  });
  if (!runtime) throw new Error('Fixture authority did not start');
  const sessionManager = Object.assign(new EventEmitter(), {
    listRunningSessions: () => [], getSession: () => null, getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
  });
  agent = new AgentServer({ config, state: new StateManager(stateDir), sessionManager, desktopRelayPairing: () => runtime });
  // Use the real AgentServer request pipeline without starting background
  // machinery or any configured mesh, tunnel or external integrations.
  server = createServer(agent.getApp());
  server.on('connection', socket => {
    owned.add(socket);
    socket.once('close', () => owned.delete(socket));
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const readyDeadline = Math.min(expiry, Date.now() + 15_000);
  while (!runtime.available() && Date.now() < readyDeadline && !controller.signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!runtime.available()) throw new Error('Fixture relay did not admit');
  writeLocalOwnerTicket(stateDir);
  const receipt = path.join(root, 'fixture.json');
  fs.writeFileSync(receipt, JSON.stringify({
    root, localAgentOrigin: 'http://127.0.0.1:' + port, controlPort: relay.controlPort, controlHostname,
    tlsPort: relay.clientPort, hostname, assignment, agentId, pinnedGenesis: genesis.id,
    controlCaPath: path.join(root, 'control.crt'), controlSpkiSha256: controlPin,
    agentCaPath: path.join(root, 'agent.crt'), agentSpkiSha256: agentPin,
    ownerRecord: [genesis.entry, ownerEntry.entry, tlsEntry.entry], committed, fixturePath,
    expiresAt: new Date(expiry).toISOString(),
  }), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ fixture: receipt, expiresAt: new Date(expiry).toISOString() }));
  await runtime.closed;
} catch {
  failed = true;
  console.error('Disposable relay fixture did not finish startup.');
} finally {
  clearTimeout(timer);
  stop();
  const failures = [];
  async function cleanup(label, operation) {
    try { await operation(); }
    catch { failures.push(label); }
  }
  await cleanup('local listener', async () => {
    if (!server?.listening) return;
    const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of owned) socket.destroy();
    await done;
  });
  await cleanup('agent', () => agent?.stop());
  await cleanup('outbound runtime', () => runtime?.stop());
  await cleanup('relay listeners', () => relay?.stop());
  await cleanup('lease database', () => db?.close());
  await cleanup('fixture files', () => SafeFsExecutor.safeRmSync(root, {
    recursive: true, force: true, operation: 'disposable WSL relay fixture cleanup',
  }));
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (failures.length) {
    console.error('Disposable relay cleanup did not complete for: ' + failures.join(', '));
    failed = true;
  }
}

// The composed application can retain timers even after its unstarted background services stop.
// All owned listeners and state have already been closed before exiting this fixture process.
process.exit(failed ? 1 : 0);
