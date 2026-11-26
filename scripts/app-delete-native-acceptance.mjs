/** Disposable Delete server for one caller-supplied P-256 test public key. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AgentServer } from '../dist/server/AgentServer.js';
import { AppRemovalReadCustody } from '../dist/core/AppRemovalReadCustody.js';
import { InitiativeTracker } from '../dist/core/InitiativeTracker.js';
import { MachineIdentityManager } from '../dist/core/MachineIdentity.js';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';
import { SessionManager } from '../dist/core/SessionManager.js';
import { SingleInstanceLock } from '../dist/core/SingleInstanceLock.js';
import { StateManager } from '../dist/core/StateManager.js';

const [keyFile, ...extra] = process.argv.slice(2);
if (!keyFile || extra.length) throw new Error('Usage: node scripts/app-delete-native-acceptance.mjs <P-256 public key file>');
const publicKey = fs.readFileSync(keyFile, 'utf8').trim();
const raw = Buffer.from(publicKey, 'base64url');
if (raw.length !== 65 || raw[0] !== 4 || raw.toString('base64url') !== publicKey) throw new Error('Invalid uncompressed P-256 public key');
crypto.ECDH.convertKey(raw, 'prime256v1');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-delete-native-'));
const stateDir = path.join(root, '.instar');
const key = crypto.randomUUID();
let agent;
let listener;
let lock;
let stopTask;
let shutdownRequested = false;
function stop() {
  stopTask ??= stopResources();
  return stopTask;
}
async function stopResources() {
  try {
    if (listener?.listening) {
      const closed = once(listener, 'close');
      listener.close();
      listener.closeAllConnections();
      await closed;
    }
    await agent?.stop();
  } finally {
    lock?.release();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'app-delete-native-acceptance:cleanup' });
  }
}

async function initialize() {
  for (const dir of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
  const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Disposable Delete fixture' });
  const config = {
    projectName: 'delete-native-acceptance', projectDir: root, stateDir, port: 0,
    authToken: crypto.randomBytes(32).toString('hex'), developmentAgent: true, workBoard: { enabled: false },
    mobilePairing: { multiRoute: { enabled: false }, native: { enabled: true } },
    sessions: { claudePath: '/usr/bin/false', maxSessions: 1, defaultMaxDurationMinutes: 5, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Fixture owner' },
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const state = new StateManager(stateDir);
  lock = new SingleInstanceLock({ stateDir, env: {} });
  if (!(await lock.acquire()).acquired) throw new Error('Could not acquire disposable writer lock');
  agent = new AgentServer({
    config, state, sessionManager: new SessionManager({ ...config.sessions, stateDir, projectDir: root, projectName: config.projectName,
      tmuxPath: '/usr/bin/false', retainedClaudeBinary: { enabled: false } }, state),
    singleInstanceLock: lock, meshSelfId: identity.machineId, initiativeTracker: new InitiativeTracker(stateDir),
    appRemovalReadAcceptance: (candidate) => candidate === key, appRemovalWriteAcceptance: true, workBoard: () => null,
  });
  const app = agent.getApp();
  const pairing = agent.mobilePairing;
  const conversations = agent.appConversations;
  if (!pairing?.keyLedger || !conversations) throw new Error('Disposable signed conversations did not start');
  pairing.deps.telegramOwnerId = () => 900001;

  const base = `/mobile/chat/app/${key}`;
  const reads = new Set(['/mobile/conversations', base + '/messages', base + '/events', base + '/message-context']);
  let ready = false;
  listener = http.createServer((req, res) => {
    const pathname = req.url?.split('?')[0];
    const allowed = (req.method === 'GET' && reads.has(pathname))
      || (req.method === 'POST' && pathname === base + '/message-removals');
    if (!ready || !allowed) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    app(req, res);
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const host = `127.0.0.1:${listener.address().port}`;
  const registered = pairing.devices.createPending({ deviceName: 'Native acceptance', label: null, publicKey, host });
  if (!registered.ok) throw new Error('Cannot register supplied test key');
  const device = pairing.devices.applyConfirm(registered.device.id, { ok: true, approvedVia: 'telegram-dm' });
  if (!device) throw new Error('Cannot confirm disposable device');
  pairing.keyLedger.recordActivation(device, 'telegram-dm', new Date().toISOString());

  const created = conversations.applyCreate(device.id, `${Date.now()}-${crypto.randomUUID()}`, key, 'Delete acceptance');
  if (created.status !== 200) throw new Error('Cannot create disposable conversation');
  for (const [eventId, text] of [['keep-this-message', 'Keep this message.'], ['delete-this-message', 'Delete this message.']]) {
    conversations.store.append({
      kind: 'message', role: 'agent', eventId, messageId: eventId, conversationKey: key,
      text, machineId: identity.machineId, at: new Date().toISOString(),
    });
  }
  const creation = conversations.store.getCreationRecord(key);
  if (!creation || !new AppRemovalReadCustody(stateDir).record(key, creation)) throw new Error('Cannot retain disposable read custody');
  if (shutdownRequested) return;
  ready = true;
  process.on('SIGHUP', () => { conversations.store.rebuildIndex(); });
  process.stdout.write(`${JSON.stringify({
    type: 'delete-native-acceptance-ready', protocol: 'http', host, pid: process.pid,
    deviceId: device.id, conversationKey: key, custodianMachineId: identity.machineId,
    targetEventId: 'delete-this-message', survivingEventId: 'keep-this-message',
  })}\n`);
}

let startup;
function stopOnSignal() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  const finish = () => stop().then(() => process.exit(0), (error) => {
    process.stderr.write(`Disposable server cleanup failed: ${error.message}\n`);
    process.exit(1);
  });
  void startup.then(finish, finish);
}
process.on('SIGINT', stopOnSignal);
process.on('SIGTERM', stopOnSignal);
startup = initialize();
try {
  await startup;
} catch (error) {
  await stop();
  throw error;
}
