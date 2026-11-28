import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
assert.equal(await realpath(process.cwd()), await realpath(repository));
const invocationId = process.env.N82_PROOF_INVOCATION_ID;
assert.match(invocationId ?? '', /^[0-9a-f-]{36}$/);
const receiptPath = path.join(repository, '.instar', 'test-evidence', 'n82-capacity', invocationId, 'receipt.json');
assert.equal(process.env.N82_PROOF_RECEIPT_PATH, receiptPath);
assert.equal(await access(receiptPath).then(() => true, () => false), false, 'receipt must be fresh');
let transportStarts = 0;
const deny = () => { transportStarts++; throw new Error('isolated fixture forbids external transport'); };
globalThis.fetch = async () => deny();
https.request = deny; https.get = deny;
// The normal complete verifier owns checkout/build integrity. Record this
// actual verification tree and the loaded distribution bytes, not an old
// untracked private manifest or a hard-coded pull-request head.
const { SafeGitExecutor } = await import('../../../dist/core/SafeGitExecutor.js');
const verificationTreeHead = SafeGitExecutor.readSync(['rev-parse', 'HEAD'], {
  cwd: repository, operation: 'test:n82-positive-control:read-verification-tree', sourceTreeReadOk: true,
}).trim();
const distFiles = ['messaging/telegram-origin/TelegramOriginBoot.js', 'messaging/telegram-origin/OriginEgressCapacity.js',
  'messaging/telegram-origin/TelegramOriginService.js', 'messaging/telegram-origin/OriginNoticeIpc.js',
  'messaging/telegram-origin/OriginStoreBackend.js', 'server/routes.js', 'server/telegramOriginRoutes.js', 'messaging/TelegramAdapter.js'];
const compiledHashes = Object.fromEntries(await Promise.all(distFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(path.join(repository, 'dist', file))).digest('hex')])));
const { default: express } = await import('express');
const { bootTelegramOrigin } = await import('../../../dist/messaging/telegram-origin/TelegramOriginBoot.js');
const { TelegramAdapter } = await import('../../../dist/messaging/TelegramAdapter.js');
const { createRoutes } = await import('../../../dist/server/routes.js');
const { mountTelegramOriginRoutes } = await import('../../../dist/server/telegramOriginRoutes.js');
const { SafeFsExecutor } = await import('../../../dist/core/SafeFsExecutor.js');
// Keep the protected Unix socket pathname below the kernel's short path limit.
const parent = '/tmp/n82-capacity-fixtures';
await mkdir(parent, { recursive: true, mode: 0o700 });
const root = await mkdtemp(path.join(parent, 'proof-'));
assert.equal(path.dirname(await realpath(root)), await realpath(parent));
const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
const token = '123:synthetic-positive-control';
const config = { projectDir: root, stateDir, projectName: 'n82-fixture', port: 0, authToken: 'synthetic-agent',
  messaging: [{ type: 'telegram', enabled: true, config: { token, chatId: '-100123', lifelineTopicId: 7848 } }] };
await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
const receipt = { invocationId, receiptPath, root, frontPid: process.pid, ownerPid: null, port: null, socketPath: path.join(stateDir, 'origin-notice.sock'),
  verificationTreeHead, compiledHashes, verdict: 'FAIL', transportStarts: 0 };
let owner, boot, adapter, server, failure, cleaning;
const routeIntervals = [];
process.once('SIGTERM', () => { receipt.verdict = 'FAIL'; receipt.error = 'fixture terminated'; void cleanup().finally(() => process.exit(1)); });
receipt.runtime = { node: process.version, abi: process.versions.modules };
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2));
const call = (method, route, body, extra = {}) => new Promise((resolve, reject) => {
  const bytes = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: receipt.port, path: route, method,
    headers: { Authorization: 'Bearer synthetic-agent', ...extra, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}) } }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch(e) { reject(e); } });
  }); req.on('error', reject); req.end(bytes);
});
try {
  owner = fork(path.join(here, 'owner.mjs'), [receipt.socketPath], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/tmp' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  receipt.ownerPid = owner.pid; await save();
  const ready = await Promise.race([once(owner, 'message').then(([m]) => m), once(owner, 'exit').then(() => { throw new Error('owner exited before ready'); })]);
  assert.equal(ready.ready, true); assert.notEqual(owner.pid, process.pid);
  let lifecycle;
  boot = await bootTelegramOrigin({ config, token, noticeOwner: false, holdsLease: () => true,
    isSessionLive: () => true, attachSessionLifecycle: value => lifecycle = value,
    diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  assert.equal(boot.runtime.options.noticeProcess.role, 'client');
  assert.equal(boot.runtime.options.noticeProcess.socketPath, receipt.socketPath);
  const deadline = performance.now() + 20_000;
  for (;;) {
    try { assert.ok(boot.runtime.options.display({ accountId: '123', chatId: '-100123', topicId: '42' }).agent); break; }
    catch (e) { if (performance.now() >= deadline || e.message !== 'origin-display-authority-unavailable') throw e; await delay(50); }
  }
  const sessionToken = await lifecycle.issue({ sessionId: 'isolated-positive-control', harnessId: 'codex-cli', projectDir: root, configuredModel: 'fixture-model' });
  adapter = new TelegramAdapter({ token, chatId: '-100123' }, stateDir, { suppressLifelineAutoCreate: true });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer synthetic-agent') { res.sendStatus(401); return; } next(); });
  const audit = express.Router();
  mountTelegramOriginRoutes(audit, { runtime: () => boot.runtime, verifyOperator: value => value === 'synthetic-operator' });
  app.use(audit);
  // Observe only intervals synchronously created by this exact route factory.
  // Invoke the real timer unchanged; restore registration immediately, and clear
  // these owned handles only after all assertions and HTTP shutdown.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    routeIntervals.push({ timer, delayMs: args[1], refAtCreation: timer.hasRef() });
    return timer;
  };
  try {
  app.use(createRoutes({ state: { getSession: () => undefined }, config, telegramOrigin: boot.runtime, telegram: adapter,
    messagingToneGate: { review: async () => ({ pass: true, latencyMs: 0 }) }, sessionManager: { clearInjectionTracker: () => undefined } }));
  } finally { globalThis.setInterval = realSetInterval; }
  receipt.routeTimersBeforeOperation = routeIntervals.map(({delayMs, refAtCreation, timer}) => ({ delayMs, refAtCreation, refNow: timer.hasRef() }));
  assert.ok(receipt.routeTimersBeforeOperation.some(t => t.delayMs === 300_000 && t.refNow), 'actual referenced plan-relay interval must be observed');
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); receipt.port = server.address().port; await save();
  const fixedNow = Date.now(); boot.runtime.service.options.now = () => fixedNow;
  const response = await call('POST', '/telegram/reply/42', { text: 'Isolated diagnostic refusal proof.' }, { 'X-Instar-Origin-Session': sessionToken });
  assert.equal(response.status, 409); assert.equal(response.body.reason, 'credential-capacity-unavailable');
  const rows = (await boot.runtime.store.listOrigins()).records; assert.equal(rows.length, 1);
  const row = rows[0]; assert.equal(row.attempts.length, 1);
  const attempt = row.attempts[0];
  assert.equal(attempt.outcome, 'known-failed'); assert.equal(attempt.phase, 'dispatched');
  assert.equal(attempt.reason, 'credential-capacity-unavailable'); assert.equal(attempt.nextAttemptAt, fixedNow + 30_000);
  assert.equal(row.children[0].attempts, 0); assert.equal(row.children[0].state, 'queued');
  assert.equal(attempt.capacityEvidenceStatus, 'collected');
  const evidence = attempt.capacityEvidence;
  assert.equal(evidence.authority, 'ipc'); assert.equal(evidence.stage, 'reserve'); assert.equal(evidence.cause, 'lease-not-held');
  assert.equal(evidence.ownerVerdict, 'refused'); assert.equal(evidence.explanation, 'complete');
  assert.ok(Number.isSafeInteger(evidence.reserveStartedAtMs)); assert.ok(evidence.reserveEndedAtMs >= evidence.reserveStartedAtMs);
  assert.ok(Number.isFinite(evidence.reserveDurationMs) && evidence.reserveDurationMs >= 0);
  assert.equal(evidence.consumeStartedAtMs, null); assert.equal(evidence.grantExpiresAtMs, null);
  assert.equal((await call('GET', '/telegram/origins/' + row.record.originId)).status, 403);
  const read = await call('GET', '/telegram/origins/' + row.record.originId, undefined, { 'X-Instar-Operator-Session': 'synthetic-operator' });
  assert.equal(read.status, 200); assert.deepEqual(read.body.attempts[0], attempt);
  assert.equal(transportStarts, 0);
  receipt.observation = { operationId: row.operation.operationId, attempt, fixedNow, httpStatus: response.status, unauthorizedReadStatus: 403, authorizedReadStatus: 200, frontLeaseEligible: true, ownerLeaseEligible: false };
  receipt.activeResourcesBeforeCleanup = process.getActiveResourcesInfo();
  receipt.verdict = 'PASS';
} catch (e) { failure = e; receipt.error = e.stack; }
finally { await cleanup(); }
if (receipt.cleanupErrors?.length && !failure) failure = new Error(receipt.cleanupErrors.join('; '));
if (failure) throw failure;
console.log(JSON.stringify({ verdict: receipt.verdict, operationId: receipt.observation.operationId, transportStarts, receipt: receiptPath }));

function cleanup() {
  return cleaning ??= (async () => {
    const errors = []; receipt.cleanupErrors = errors;
    const step = async (name, fn) => {
      let timer;
      try { await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup deadline')), 5_000); })]); }
      catch (e) { errors.push(name + ': ' + e.message); }
      finally { clearTimeout(timer); }
    };
    await step('http close', async () => { if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } });
    await step('adapter close', async () => { await adapter?.stop(); });
    await step('boot close', async () => { await boot?.close(); });
    await step('owner close', async () => {
      if (owner?.connected) {
        const stopped = once(owner, 'message'); const exited = once(owner, 'exit'); owner.send('close');
        const [state] = await stopped; receipt.ownerStopped = state; const [code, signal] = await exited;
        receipt.ownerExit = { code, signal }; assert.equal(code, 0);
        // Count checks cannot prevent later cleanup, even if startup failed before the operation.
        if (receipt.verdict === 'PASS') { assert.equal(state.reserveCalls, 1); assert.equal(state.consumeCalls, 0); }
      }
    });
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      await step('owned owner termination', async () => { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; });
    }
    await step('owned route timers', async () => {
      receipt.routeTimersAtCleanup = routeIntervals.map(({delayMs, timer}) => ({ delayMs, refNow: timer.hasRef() }));
      for (const {timer} of routeIntervals) clearInterval(timer);
      receipt.routeTimersCleared = routeIntervals.length;
    });
    receipt.transportStarts = transportStarts;
    await step('exact home cleanup', async () => {
      assert.equal(path.dirname(await realpath(root)), await realpath(parent)); assert.ok(path.basename(root).startsWith('proof-'));
      await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:n82-positive-control:exact-cleanup' });
      receipt.homeExistsAfterCleanup = await access(root).then(() => true, () => false); assert.equal(receipt.homeExistsAfterCleanup, false);
    });
    receipt.activeResourcesAfterCleanup = process.getActiveResourcesInfo();
    if (errors.length) receipt.verdict = 'FAIL'; await save();
  })();
}
