import { renderAccounts } from '/dashboard/console/accounts.js';
import { createLifecycle } from '/dashboard/console/page-lifecycle.js';
import { closeSheet, operatorSession, sheet } from '/dashboard/console/ui.js';
import { generateDeviceKey } from '/dashboard/console/browser-device.js';
import { liveCredential, saveCredential } from '/dashboard/local-access.js';

const {keyPair} = await generateDeviceKey();
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const credentialId = 'invented-local-credential';
const agentName = 'invented-agent';
const publicData = {publicJwk, credentialId, agentName, origin: location.origin};
await saveCredential({
  credentialId, agentName, origin: location.origin, privateKey: keyPair.privateKey,
  expiresAt: Date.now() + 120_000,
});
const stored = await liveCredential();
if (!stored || stored.credentialId !== credentialId || stored.privateKey.extractable) throw Error('Disposable browser credential did not round-trip safely');

const api = new Map();
const calls = [];
const pending = new Map();
const hold = (path) => new Promise((resolve) => pending.set(path, resolve));
const reply = (data) => new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});
api.set('/dashboard/unlock-check', () => reply({accepted: true}));
api.set('/local-access/v1/use-challenge', hold);
api.set('/dashboard/unlock', hold);
api.set('/subscription-relogin/configure-pool', () => reply({results: [{ok: true, machineId: 'fixture-studio', mode: 'unattended'}]}));
window.fetch = async (path, options) => {
  if (typeof path !== 'string' || !api.has(path)) throw new Error('Denied unexpected fixture API route');
  calls.push({path, method: options?.method ?? 'GET', credentials: options?.credentials ?? null, body: options?.body ? JSON.parse(options.body) : null});
  return await api.get(path)(path);
};

const row = {
  id: 'fixture-account', nickname: 'Fixture Account', email: 'fixture@example.test', framework: 'claude-code',
  status: 'needs-reauth', machineId: 'fixture-studio', machineNickname: 'Fixture Studio',
};
const config = {
  machineId: 'fixture-studio', machineNickname: 'Fixture Studio', mode: 'approval',
  revision: 'fixture-revision', verifiedPoolEmails: ['fixture@example.test'],
};
const data = new Map([
  ['/subscription-pool?scope=pool', {enabled: true, accounts: [row], pool: {failed: []}}],
  ['/subscription-relogin?scope=pool', {enabled: true, episodes: [], blockers: [], config}],
  ['/subscription-pool/in-use', {}],
  ['/pool', {machines: []}],
]);
const life = createLifecycle();
const main = document.querySelector('main');
const ctx = life.begin('capacity/accounts');
await renderAccounts(main, {...ctx, get: async (path) => {
  if (!data.has(path)) throw Error('Unexpected fixture Accounts read');
  return {ok: true, data: data.get(path)};
}});
window.pinFixture = {
  calls, publicData,
  waiting: (path) => pending.has(path),
  release(path, data) {
    const resolve = pending.get(path);
    if (!resolve) throw Error('Endpoint is not pending');
    pending.delete(path);
    resolve(reply(data));
  },
  leave() {
    const ownPanel = document.querySelector('[role=dialog]');
    life.dispose();
    closeSheet();
    const next = document.createElement('main');
    next.textContent = 'Conversations';
    main.replaceWith(next);
    sheet({title: 'Replacement dialog'}, 'Current page');
    return !ownPanel.isConnected && !ctx.isCurrent();
  },
  sessionPresent: () => Boolean(operatorSession()),
};
