#!/usr/bin/env node
/**
 * Local-route trust drill (threadline.localRouteTrust, CMT-1141).
 *
 * Two THROWAWAY agents on this machine, in a temp folder with their own HOME,
 * never the operator's channels: no Telegram, no Slack, no tunnel, no relay
 * network. The receiver runs dry-run local-route trust with its relay switched
 * on but pointed at a dead local address (so it has a trust manager and never
 * reaches the real relay). The sender has its relay off and NO trust profile on
 * the receiver, so the same-machine route is its only way in.
 *
 * Proves, through the real CLI-started servers:
 *   1. the receiver reports the check on, in dry-run, with a trust manager;
 *   2. the send goes over the local route and is accepted;
 *   3. the receiver counts a would-refuse AND writes a durable would-refuse row
 *      in logs/feature-evidence.jsonl naming the sender and the reason;
 *   4. delivery is not silently lost: the message is in the receiver's inbox;
 *   5. the would-refuse row can be graded through POST /maturation/evidence;
 *   6. GET /maturation/ladder on the receiver shows the new bars.
 *
 * Usage: node scripts/drills/local-route-trust-drill.mjs [--keep]
 *   Needs a built dist/ (npm run build). Exits 0 only when every step passes.
 *   --keep leaves the temp folder (and stops the servers) for inspection.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'dist', 'cli.js');
const KEEP = process.argv.includes('--keep');
const FEATURE = 'threadline.localRouteTrust';

if (!fs.existsSync(CLI)) {
  console.error(`drill: ${CLI} is missing — build first (npm run build)`);
  process.exit(2);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lrt-drill-')));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const suffix = Math.random().toString(36).slice(2, 8);
const RECV = `lrt-drill-recv-${suffix}`;
const SEND = `lrt-drill-send-${suffix}`;

// A hermetic environment: the throwaways never see the operator's HOME, agent
// identity, Claude login or instar session variables.
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const k of Object.keys(env)) if (k.startsWith('INSTAR_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];

const children = [];
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function init(name, port) {
  const dir = path.join(root, name);
  const r = spawnSync(process.execPath, [CLI, 'init', name, '--dir', dir, '--port', String(port), '--expires-in', '2h'], {
    env, cwd: root, encoding: 'utf-8', timeout: 180_000, input: '',
  });
  if (r.status !== 0) throw new Error(`init ${name} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-800)}`);
  return dir;
}

function patchConfig(dir, patch) {
  const p = path.join(dir, '.instar', 'config.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const merged = {
    ...c,
    developmentAgent: true,
    bindHost: '127.0.0.1',
    messaging: [],
    dispatches: null,
    tunnel: { enabled: false },
    updates: { ...(c.updates ?? {}), autoApply: false },
    scheduler: { ...(c.scheduler ?? {}), enabled: false },
    // Nothing leaves this machine: no feedback forwarding to the maintainers' webhook.
    feedback: { ...(c.feedback ?? {}), enabled: false },
    ...patch,
    threadline: { ...(c.threadline ?? {}), ...(patch.threadline ?? {}) },
  };
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  return merged;
}

function authOf(dir) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
  if (typeof c.authToken === 'string' && c.authToken && !c.authToken.startsWith('secret:')) return c.authToken;
  const r = spawnSync(process.execPath, [path.join(dir, '.instar', 'scripts', 'secret-get.mjs'), 'authToken'], { env, cwd: dir, encoding: 'utf-8' });
  const t = (r.stdout || '').trim();
  if (!t) throw new Error(`no auth token for ${dir}`);
  return t;
}

function start(name, dir) {
  const log = fs.openSync(path.join(root, `${name}.log`), 'a');
  const child = spawn(process.execPath, [CLI, 'server', 'start', '--foreground', '--no-telegram'], {
    env, cwd: dir, stdio: ['ignore', log, log], detached: false,
  });
  children.push(child);
  return child;
}

// The boot beacon answers /health before the server is up, so readiness is an
// authed route that only the full server serves.
async function waitHealthy(port, auth, ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${port}/messages/inbox?limit=1`, { headers: { Authorization: `Bearer ${auth}` } }); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const api = async (port, auth, p, init = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, 'X-Instar-Request': '1', ...(init.headers ?? {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
};

async function cleanup() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  await new Promise(r => setTimeout(r, 1500));
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (KEEP) console.log(`drill: kept ${root}`);
  else {
    const { SafeFsExecutor } = await import(path.join(REPO, 'dist', 'core', 'SafeFsExecutor.js'));
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'scripts/drills/local-route-trust-drill.mjs:cleanup' });
  }
}

async function main() {
  const [recvPort, sendPort, deadPort] = [await freePort(), await freePort(), await freePort()];
  console.log(`drill: throwaways ${RECV} (:${recvPort}) and ${SEND} (:${sendPort}) in ${root}`);

  const recvDir = init(RECV, recvPort);
  const sendDir = init(SEND, sendPort);
  patchConfig(recvDir, { threadline: { relayEnabled: true, relayUrl: `ws://127.0.0.1:${deadPort}`, localRouteTrust: { dryRun: true } } });
  patchConfig(sendDir, { threadline: { relayEnabled: false } });
  const recvAuth = authOf(recvDir);
  const sendAuth = authOf(sendDir);

  // One at a time: both register in the shared same-machine registry, which is locked per write.
  start(RECV, recvDir);
  const recvUp = await waitHealthy(recvPort, recvAuth);
  if (recvUp) start(SEND, sendDir);
  if (!step('both throwaway servers start', recvUp && (await waitHealthy(sendPort, sendAuth)))) return;

  const health = async () => (await api(recvPort, recvAuth, '/health')).body?.threadline?.localRouteTrust ?? null;
  const h0 = await health();
  step('receiver: check on, dry-run, trust manager wired', !!h0 && h0.enabled === true && h0.dryRun === true && h0.trustManagerWired === true, JSON.stringify(h0));

  // The sender learns same-machine peers the way threadline_discover does: the
  // real AgentDiscovery.discoverLocal(), run as the sender (its HOME, its state).
  const disc = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { AgentDiscovery } = await import(${JSON.stringify(path.join(REPO, 'dist', 'threadline', 'AgentDiscovery.js'))});
    const d = new AgentDiscovery({ stateDir: ${JSON.stringify(path.join(sendDir, '.instar'))}, selfPath: ${JSON.stringify(sendDir)}, selfName: ${JSON.stringify(SEND)}, selfPort: ${sendPort} });
    const found = await d.discoverLocal();
    console.log(JSON.stringify(found.map(a => a.name)));
  `], { env, cwd: sendDir, encoding: 'utf-8', timeout: 60_000 });
  step('sender discovers the receiver on this machine', (disc.stdout || '').includes(RECV), (disc.stdout || disc.stderr || '').trim().slice(0, 300));

  const text = `drill message ${suffix}`;
  let sent = null;
  // The sender learns the receiver from the shared same-machine registry; give it a few tries while it registers.
  for (let i = 0; i < 20; i++) {
    sent = await api(sendPort, sendAuth, '/threadline/relay-send', { method: 'POST', body: JSON.stringify({ targetAgent: RECV, message: text }) });
    if (sent.body?.deliveryPath === 'local') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  step('send went over the same-machine route and was accepted', sent?.status === 200 && sent.body?.success === true && sent.body?.deliveryPath === 'local' && sent.body?.accepted !== false,
    `${sent?.status} ${JSON.stringify(sent?.body ?? {}).slice(0, 300)}`);

  const h1 = await health();
  step('receiver counted a would-refuse (and refused nothing)', !!h1 && h1.wouldRefuse >= 1 && h1.refused === 0, JSON.stringify(h1));

  const evPath = path.join(recvDir, 'logs', 'feature-evidence.jsonl');
  const rows = fs.existsSync(evPath)
    ? fs.readFileSync(evPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const row = rows.find(r => r.featureId === FEATURE && r.reason === 'would-refuse' && r.context?.sender === SEND);
  step('durable would-refuse row names the sender and the reason', !!row && row.kind === 'fired' && typeof row.subject === 'string' && !!row.context?.refuseReason,
    row ? `subject=${row.subject} refuseReason=${row.context.refuseReason} eventId=${row.eventId}` : `${rows.length} rows, none matched`);

  // The harm bar is fed by grades: grade this would-refuse (an unprofiled stranger
  // refused a message is the intended verdict) through the real route.
  if (row) {
    const g = await api(recvPort, recvAuth, '/maturation/evidence', { method: 'POST', body: JSON.stringify({
      featureId: FEATURE, kind: 'outcome', reason: 'would-refuse', outcome: 'right', gradesEventId: row.eventId, gradedBy: 'local-route-trust-drill',
    }) });
    step('the would-refuse row can be graded (POST /maturation/evidence)', g.status === 200 && typeof g.body?.eventId === 'string', `${g.status} ${JSON.stringify(g.body)}`);
  }

  let inbox = null;
  for (let i = 0; i < 10; i++) {
    inbox = await api(recvPort, recvAuth, `/messages/inbox?fromAgent=${encodeURIComponent(SEND)}`);
    if ((inbox.body?.messages ?? []).length) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const delivered = (inbox?.body?.messages ?? []).some(m => JSON.stringify(m).includes(text));
  step('delivery not silently lost: the message is in the receiver\'s inbox', delivered, `${(inbox?.body?.messages ?? []).length} message(s) from ${SEND}`);

  const ladder = await api(recvPort, recvAuth, `/maturation/ladder?id=${FEATURE}`);
  const entry = (ladder.body?.features ?? []).find(f => f.id === FEATURE);
  const metricIds = (entry?.metrics ?? []).map(m => m.id);
  step('GET /maturation/ladder shows the new bars', ladder.status === 200 && ['distinct-senders', 'would-refuse', 'would-refuse-graded-wrong'].every(id => metricIds.includes(id)),
    `status ${ladder.status}, metrics ${JSON.stringify(metricIds)}${entry ? '' : ` ${JSON.stringify(ladder.body).slice(0, 300)}`}`);
}

let failed = false;
try {
  await main();
} catch (err) {
  step('drill ran', false, err instanceof Error ? err.message : String(err));
}
failed = results.some(r => !r.ok) || results.length === 0;
if (failed) {
  for (const n of [RECV, SEND]) {
    const p = path.join(root, `${n}.log`);
    if (fs.existsSync(p)) console.log(`--- ${n}.log (tail) ---\n${fs.readFileSync(p, 'utf-8').split('\n').slice(-25).join('\n')}`);
  }
}
await cleanup();
console.log(failed ? 'drill: FAILED' : `drill: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
