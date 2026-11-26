#!/usr/bin/env node
/**
 * Gemini pay-per-use lane — the user-role live test of the whole setup flow, and the
 * holder-death drill (docs/specs/gemini-payg-metered-lane.md §8: Run 1 step 2, release
 * check (b); docs/specs/live-user-channel-proof-standard.md §4.4–4.6).
 *
 * Run (from the repo root, after `npm run build`; needs Playwright's Chromium):
 *
 *     node scripts/gemini-payg-live-test.mjs [--out <dir>] [--keep] [--record-into <agentStateDir>]
 *
 * What it does, all on THROWAWAY agents in a temp folder, against a FAKE Google:
 *   - creates four throwaway agents with `instar init --expires-in` under $TMPDIR, with an
 *     isolated HOME (so the global agent registry, ~/.claude and the like are throwaway too)
 *     and a `secret-tool` that always fails (so no key is ever read from or written to the
 *     real OS keyring — the vault uses its per-agent file key):
 *       A + B — one agent's two machines, paired over the local mesh (A holds the lease and
 *               is the designated spender; B is the non-holder);
 *       C     — a fleet-default agent (money off) for the regression row;
 *       D     — a single machine whose apply is made to fail, for the failure row;
 *   - runs each as a REAL `node dist/cli.js server start --foreground` process. This runner
 *     is the supervisor that respawns a server that exits on a restart request (the role
 *     launchd/the lifeline plays on a real agent);
 *   - points each server's Gemini traffic at a local fake Google by a test-only `--import`
 *     preload (scripts/gemini-payg-fake-google-preload.mjs); production code has no base-URL
 *     setting and none is added;
 *   - drives the flow AS THE USER: the fake key goes through a real Secret Drop form and the
 *     documented no-echo transfer (`secret-drop-retrieve.mjs … --run -- secret-set.mjs`), the
 *     plan page is loaded in headless Chromium exactly as the dashboard serves it, at 390x844
 *     and 1280x728, and the PIN commit is made through the dashboard;
 *   - records every scenario with deterministic evidence and writes TWO signed artifacts with
 *     LiveTestArtifactStore into machine A's state folder (signed by A's machine key, which is
 *     the key A's release recorder verifies with):
 *       routingSpend.geminiPaygLane.setupFlow        — the eight risk categories
 *       routingSpend.geminiPaygLane.holderDeathDrill — release check (b)
 *   - then points A's release recorder at the drill artifact through the real forwarded
 *     `POST /routing-spend/release-proof` from B, and records whether check (b) accepted it.
 *
 * `--record-into <agentStateDir>` additionally writes the same drill artifact, signed with
 * THAT agent's machine key, into THAT agent's live-test store (how the coordinator makes a
 * real agent's check (b) see a run done on its test-agent pair). Never the default.
 *
 * Nothing here messages anyone, uses a real key, or touches a real agent's state (unless
 * --record-into names one).
 */
// safe-fs-allow: live-test runner — SafeFsExecutor used for throwaway tmpdir cleanup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ScenarioMatrix, Blocked, check, expectEqual, newRunId, throwawayConfig, handoffBody,
  missingPlanLines, committedMoneyFigures, restartWindow, FEATURE_SETUP_FLOW, FEATURE_HOLDER_DEATH,
} from './gemini-payg-live-test-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const CLI = path.join(DIST, 'cli.js');
const PRELOAD = path.join(REPO, 'scripts', 'gemini-payg-fake-google-preload.mjs');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const KEEP = args.includes('--keep');
const RECORD_INTO = argVal('--record-into');
const TMP = process.env.TMPDIR || os.tmpdir();
const RUN_ID = newRunId();
const OUT = path.resolve(argVal('--out') || path.join(TMP, 'gp-build', 'live-test'));
const ROOT = fs.mkdtempSync(path.join(TMP, 'gplt-'));
const SHOTS = path.join(OUT, `shots-${RUN_ID}`);
fs.mkdirSync(SHOTS, { recursive: true });
const LOG_FILE = path.join(OUT, `run-${RUN_ID}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; process.stdout.write(`${line}\n`); logStream.write(`${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PIN = String(100000 + crypto.randomInt(899999));
const FAKE_KEY = `AIzaSyLT${crypto.randomBytes(16).toString('hex')}`; // fake; never printed
const FAKE_KEY_FP = sha256(Buffer.from(FAKE_KEY, 'utf8'));
const DOOR = 'gemini-api';
const KEY_NAME = 'gemini_api_key_payg';

const dist = async (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { MachineIdentityManager, sign: signEd25519, verify: verifyEd25519 } = await dist('core/MachineIdentity.js');
const { LiveTestArtifactStore } = await dist('core/LiveTestArtifactStore.js');
const { GEMINI_PAYG_FIRST_SCREEN_LINE } = await dist('core/geminiPaygGoLive.js');
const { SafeFsExecutor } = await dist('core/SafeFsExecutor.js');

// ── environment ───────────────────────────────────────────────────────────────────────────

const HOME = path.join(ROOT, 'home');
const SHIM = path.join(ROOT, 'shim');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(SHIM, { recursive: true });
// The vault's OS-keyring path is `secret-tool` on Linux. A shim that always fails keeps every
// throwaway on its per-agent file key and away from the real keyring (including its legacy
// global entry, which the store would otherwise adopt).
fs.writeFileSync(path.join(SHIM, 'secret-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// No real model behind a throwaway: a STAND-IN `claude` CLI (pointed at by each agent's
// sessions.claudePath) answers every one-shot evaluation with the same fixed JSON verdict
// `{"fire":false,...}` and spends nothing. The one place this live test leans on it is the
// Work Board's B25 judge on the agent-written card (whose own judgment is not under test —
// and a money-approval card is not a spec-approval ask, so "no hold" is also the right
// answer). The other model CLIs are shims that fail. The children's environment is an
// allowlist, so no provider credential (ANTHROPIC_*, XAI_*, …) reaches a throwaway.
const STAND_IN_VERDICT = JSON.stringify({ fire: false, issue: '', suggestion: '' });
fs.writeFileSync(path.join(SHIM, 'claude'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: STAND_IN_VERDICT, usage: { input_tokens: 0, output_tokens: 0 } }).replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
for (const cli of ['codex', 'gemini', 'grok']) fs.writeFileSync(path.join(SHIM, cli), '#!/bin/sh\necho "live-test: no model CLI on a throwaway" >&2\nexit 1\n', { mode: 0o755 });

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}
const LAN = lanIp();

// No XDG_RUNTIME_DIR (the user's D-Bus/systemd bus) and a private tmux socket dir: a
// throwaway shares nothing with the operator's own session bus or tmux server.
const ENV_ALLOW = ['LANG', 'LC_ALL', 'TZ', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'];
const TMUX_DIR = path.join(ROOT, 'tmux');
fs.mkdirSync(TMUX_DIR, { recursive: true, mode: 0o700 });
function childEnv(extra = {}) {
  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.HOME = HOME;
  env.TMUX_TMPDIR = TMUX_DIR;
  env.PATH = `${SHIM}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  return { ...env, ...extra };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// ── fake Google ───────────────────────────────────────────────────────────────────────────

const google = { generate: 0, count: 0, models: [], failNext: 0 };
const googleSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    const keyHeader = req.headers['x-goog-api-key'];
    if (keyHeader !== FAKE_KEY) { res.statusCode = 403; res.end(JSON.stringify({ error: { code: 403, message: 'unknown key' } })); return; }
    if (url.includes(':countTokens')) { google.count++; res.end(JSON.stringify({ totalTokens: 20 })); return; }
    google.generate++;
    google.models.push(url.split('/models/')[1]?.split(':')[0] ?? '?');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ready' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 10 } }));
  });
});
await new Promise((r) => googleSrv.listen(0, '127.0.0.1', r));
const GOOGLE_ORIGIN = `http://127.0.0.1:${googleSrv.address().port}`;

// ── agents ────────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, any>} */
const agents = {};

async function initAgent(name, port) {
  const dir = path.join(ROOT, name);
  const r = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--port', String(port), '--expires-in', '6h', `gplt${name}${RUN_ID.slice(-6)}`], {
    cwd: ROOT, env: childEnv(), encoding: 'utf8', timeout: 180_000, input: '',
  });
  if (r.status !== 0) throw new Error(`init ${name} failed: ${(r.stderr || r.stdout || '').slice(-800)}`);
  const stateDir = path.join(dir, '.instar');
  // The vault helper scripts resolve the instar dist from the agent home (`dist/` in a
  // checkout, the shadow install on a deployed agent).
  fs.symlinkSync(DIST, path.join(dir, 'dist'));
  const mgr = new MachineIdentityManager(stateDir);
  const id = mgr.loadIdentity();
  const a = { name, dir, stateDir, port, mgr, id, machineId: id.machineId, child: null, exits: [], logPath: path.join(ROOT, `server-${name}.log`) };
  agents[name] = a;
  return a;
}

function cfgOf(a) { return JSON.parse(fs.readFileSync(path.join(a.stateDir, 'config.json'), 'utf8')); }
function writeCfg(a, c) { fs.writeFileSync(path.join(a.stateDir, 'config.json'), JSON.stringify(c, null, 2)); }
function authOf(a) {
  const t = cfgOf(a).authToken;
  if (typeof t === 'string') return t;
  const r = spawnSync(process.execPath, [path.join(a.stateDir, 'scripts', 'secret-get.mjs'), 'authToken', '--pipe-fd3'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], cwd: a.dir, env: childEnv(), encoding: 'utf8' });
  return r.output?.[3] || r.stdout;
}

/** The two-machine pair: each home registers the other, with a LAN rope (a loopback rope is refused by design). */
function pair(a, b) {
  for (const [self, other, role] of [[a, b, 'standby'], [b, a, 'awake']]) {
    self.mgr.registerMachine(other.id, role);
    self.mgr.storeRemoteIdentity(other.id);
  }
  b.mgr.updateRole(b.machineId, 'standby');
  for (const self of [a, b]) {
    self.mgr.updateNickname(a.machineId, 'LT-Holder');
    self.mgr.updateNickname(b.machineId, 'LT-Peer');
    for (const m of [a, b]) {
      self.mgr.updateMachineUrl(m.machineId, `http://${LAN}:${m.port}`);
      self.mgr.updateMachineEndpoints(m.machineId, [{ kind: 'lan', url: `http://${LAN}:${m.port}` }]);
    }
  }
}

/** The shipped price manifest's gemini-api door, its points verified or not (a reviewed commit flips it in Run 2). */
function seedManifest(a, verified) {
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'routing-prices.manifest.json'), 'utf8'));
  const points = real.points.filter((p) => p.door === DOOR).map((p) => ({ ...p, verified, maxInputTokens: p.maxInputTokens ?? 1_000_000 }));
  fs.mkdirSync(path.join(a.dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'scripts', 'routing-prices.manifest.json'), JSON.stringify({ ...real, doors: { [DOOR]: real.doors[DOOR] }, points }));
}

function startServer(a) {
  const fd = fs.openSync(a.logPath, 'a');
  const child = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, '--max-old-space-size=2048', CLI, 'server', 'start', '--foreground', '--dir', a.dir], {
    cwd: a.dir, env: childEnv({ GPLT_FAKE_GOOGLE_ORIGIN: GOOGLE_ORIGIN }), stdio: ['ignore', fd, fd], detached: false,
  });
  fs.closeSync(fd);
  a.child = child;
  a.startedAt = Date.now();
  child.on('exit', (code, signal) => { a.exits.push({ at: Date.now(), code, signal, pid: child.pid }); if (a.child === child) a.child = null; });
  log(`started ${a.name} (pid ${child.pid}, port ${a.port})`);
  return child;
}

async function waitReady(a, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!a.child) throw new Error(`${a.name} exited while booting (see ${a.logPath})`);
    try {
      const r = await fetch(`http://127.0.0.1:${a.port}/routing-spend/enable-status`, { headers: { Authorization: `Bearer ${authOf(a)}` }, signal: AbortSignal.timeout(5000) });
      // The boot beacon answers early with a typed "starting"; only the real server answers
      // the money surface with 200 and /health with a non-starting status.
      if (r.status === 200) {
        const h = await fetch(`http://127.0.0.1:${a.port}/health`, { signal: AbortSignal.timeout(5000) });
        const hj = await h.json().catch(() => null);
        if (h.ok && hj && hj.status !== 'starting') return Date.now();
      }
    } catch { /* booting */ }
    await sleep(1500);
  }
  throw new Error(`${a.name} did not become ready in ${timeoutMs}ms`);
}

async function waitExit(a, timeoutMs) {
  const t0 = Date.now();
  const n = a.exits.length;
  while (Date.now() - t0 < timeoutMs) {
    if (a.exits.length > n || !a.child) return a.exits[a.exits.length - 1] ?? null;
    await sleep(250);
  }
  return null;
}

async function stopServer(a, signal = 'SIGTERM', timeoutMs = 45_000) {
  if (!a.child) return null;
  const c = a.child;
  c.kill(signal);
  const e = await waitExit(a, timeoutMs);
  if (!e && a.child === c) { c.kill('SIGKILL'); return waitExit(a, 10_000); }
  return e;
}

async function api(a, method, p, body, { auth = true, headers = {}, timeoutMs = 60_000 } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${authOf(a)}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  try {
    const r = await fetch(`http://127.0.0.1:${a.port}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text: json ? '' : text.slice(0, 400) };
  } catch (err) {
    return { status: 0, body: null, text: String(err && err.message ? err.message : err) };
  }
}

/**
 * After A (the holder) boots: the money layer enforcing on A, A's designation echo
 * confirmed by B (the gate's self-fence input), and B knowing who the spender is. Each is
 * read from the real servers; returns what was seen and how long it took.
 */
async function waitPairSettled(A, B, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = {};
  while (Date.now() - t0 < timeoutMs) {
    const st = await api(A, 'GET', '/routing-spend/enable-status');
    const rel = await api(A, 'GET', '/routing-spend/gemini-payg/release');
    const seen = readJson(path.join(B.stateDir, 'state', 'gemini-payg-seen-designation.json'));
    last = { enforcementReady: st.body?.enforcementReady === true, lifecycleState: st.body?.lifecycleState ?? null, failingComponent: st.body?.failingComponent ?? null, leaseConfirmed: rel.body?.lease?.confirmed === true, leaseConfirmedAgoMs: rel.body?.lease?.confirmedAgoMs ?? null, bSeesSpender: seen?.machineId ?? null };
    if (last.enforcementReady && last.leaseConfirmed && last.bSeesSpender === A.machineId) return { ...last, settledAfterMs: Date.now() - t0 };
    await sleep(1500);
  }
  return { ...last, settledAfterMs: null };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const auditRows = (a) => {
  const dir = path.join(a.stateDir, 'state');
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/money-layer-audit.*\.jsonl$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(line)); } catch { /* partial */ } }
  }
  return out;
};
const auditOf = (a, type) => auditRows(a).filter((r) => r.type === type);
const intentPath = (a) => path.join(a.stateDir, 'state', 'money-pending-setup.json');
const capsFile = (a) => readJson(path.join(a.stateDir, 'state', 'routing-spend-caps.json'));

// ── Playwright ────────────────────────────────────────────────────────────────────────────

async function loadPlaywright() {
  const tries = [process.env.GPLT_PLAYWRIGHT, 'playwright', path.join(TMP, 'pw', 'node_modules', 'playwright')].filter(Boolean);
  for (const t of tries) {
    try {
      if (t === 'playwright') return await import('playwright');
      const req = createRequire(path.join(t, 'noop.js'));
      return req(t);
    } catch { /* next */ }
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))(path.join(root, 'playwright'));
  } catch { return null; }
}

/** Playwright's own Chromium, else any installed one (GPLT_CHROMIUM, then ~/.cache/ms-playwright). */
async function launchChromium(pw) {
  try { return await pw.chromium.launch({ headless: true }); } catch (err) {
    const cands = [process.env.GPLT_CHROMIUM].filter(Boolean);
    const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
    try {
      for (const d of fs.readdirSync(cache).sort().reverse()) {
        if (/^chromium_headless_shell-/.test(d)) cands.push(path.join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
        if (/^chromium-\d/.test(d)) cands.push(path.join(cache, d, 'chrome-linux64', 'chrome'));
      }
    } catch { /* no cache */ }
    for (const exe of cands) {
      if (!fs.existsSync(exe)) continue;
      try { const b = await pw.chromium.launch({ headless: true, executablePath: exe }); log(`chromium: ${exe}`); return b; } catch { /* next */ }
    }
    throw err;
  }
}

const VIEWPORTS = { narrow: { width: 390, height: 844 }, wide: { width: 1280, height: 728 } };

async function openDashboard(browser, a, vp) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${a.port}/dashboard?tab=spend`, { waitUntil: 'domcontentloaded' });
  await page.fill('#pinInput', PIN);
  await page.press('#pinInput', 'Enter');
  await page.waitForSelector('#app', { state: 'visible', timeout: 30_000 });
  await page.evaluate(() => { if (typeof window.switchTab === 'function') window.switchTab('spend'); });
  return { ctx, page, errors };
}

async function shot(page, step) {
  const f = path.join(SHOTS, `${step}.png`);
  await page.screenshot({ path: f, fullPage: false });
  return { path: f, sha256: sha256(fs.readFileSync(f)) };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────

const setup = new ScenarioMatrix({ surface: 'dashboard', log });
const drill = new ScenarioMatrix({ surface: 'dashboard', log });
const ctx = {}; // facts carried between scenarios
let browser = null;

async function main() {
  log(`run ${RUN_ID}: root ${ROOT}, out ${OUT}, fake Google ${GOOGLE_ORIGIN}, LAN ${LAN ?? 'none'}`);
  if (!LAN) throw new Error('no RFC1918 LAN address on this machine: the mesh refuses loopback ropes, so a same-host pair needs one');
  const pw = await loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed (set GPLT_PLAYWRIGHT to its package dir)');
  browser = await launchChromium(pw);

  const ports = [await freePort(), await freePort(), await freePort(), await freePort()];
  const A = await initAgent('a', ports[0]);
  const B = await initAgent('b', ports[1]);
  const C = await initAgent('c', ports[2]);
  const D = await initAgent('d', ports[3]);
  for (const x of [A, B, D]) writeCfg(x, throwawayConfig(cfgOf(x), { pin: PIN, pair: x !== D }));
  for (const x of [A, B, C, D]) { const c = cfgOf(x); c.sessions = { ...(c.sessions || {}), claudePath: path.join(SHIM, 'claude') }; writeCfg(x, c); }
  // C keeps the fleet defaults for money (routing spend and the money layer untouched); only
  // the outward pieces are turned off so the throwaway cannot reach anything real.
  { const c = cfgOf(C); c.dashboardPin = PIN; c.tunnel = { enabled: false }; c.updates = { ...(c.updates || {}), autoApply: false }; c.feedback = { ...(c.feedback || {}), enabled: false }; c.dispatches = { ...(c.dispatches || {}), enabled: false }; writeCfg(C, c); }
  pair(A, B);
  seedManifest(A, false);
  seedManifest(D, false);
  log(`agents: A ${A.machineId} :${A.port}, B ${B.machineId} :${B.port}, C :${C.port}, D :${D.port}`);

  // A first, so it takes the lease; then the others, one at a time (the global registry lock).
  startServer(A); await waitReady(A);
  startServer(B); await waitReady(B);
  startServer(C); await waitReady(C);
  startServer(D); await waitReady(D);
  await sleep(5000);

  await setupFlow(A, B);
  await regression(C, B);
  await failedApply(D);

  // ── the signed setup-flow artifact ──
  const setupArt = writeArtifact(A, setup, FEATURE_SETUP_FLOW);
  ctx.setupArtifact = setupArt;

  await holderDeathDrill(A, B);
  const drillArt = writeArtifact(A, drill, FEATURE_HOLDER_DEATH, { fullMatrix: false });
  ctx.drillArtifact = drillArt;
  await releaseCheckB(A, B, drillArt);
  if (RECORD_INTO) recordInto(RECORD_INTO, drillArt);
}

function writeArtifact(a, matrix, featureId, { fullMatrix = true } = {}) {
  const signingKeyPem = fs.readFileSync(path.join(a.stateDir, 'machine', 'signing-key.pem'), 'utf8');
  const publicKeyPem = crypto.createPublicKey({ key: signingKeyPem }).export({ type: 'spki', format: 'pem' }).toString();
  const store = new LiveTestArtifactStore({
    stateDir: a.stateDir, machineId: a.machineId, signerFingerprint: a.machineId,
    sign: (d) => signEd25519(d, signingKeyPem), verify: (d, s) => verifyEd25519(d, s, publicKeyPem),
  });
  const artifact = matrix.toArtifact({ featureId, runId: RUN_ID, runnerFingerprint: a.machineId, createdAt: new Date().toISOString() });
  const entry = store.write(artifact);
  const v = store.verifyEntry(featureId, RUN_ID);
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  const artPath = path.join(a.stateDir, 'live-test-artifacts', safe(featureId), `${safe(RUN_ID)}.json`);
  const copy = path.join(OUT, `${safe(featureId)}-${RUN_ID}.json`);
  fs.copyFileSync(artPath, copy);
  const out = { featureId, runId: RUN_ID, path: artPath, copy, contentHash: entry.contentHash, fileSha256: sha256(fs.readFileSync(artPath)), verified: v.ok, allPass: fullMatrix ? matrix.allPass() : matrix.allRowsPass(), criterion: fullMatrix ? 'every row PASS and all eight risk categories' : 'every row PASS (the release recorder\'s check (b) criterion)', missing: matrix.missingCategories(), rows: matrix.rows.map((r) => `${r.verdict} ${r.riskCategory} ${r.id}`) };
  log(`artifact ${featureId}: ${out.allPass ? 'PASS' : 'NOT PASS'} hash ${entry.contentHash} verified=${v.ok} → ${artPath}`);
  return out;
}

function recordInto(stateDir, art) {
  // Only an all-PASS drill is ever carried into another agent's store, and the copy says
  // where it was run (the throwaway holder) — the record is of a test-agent-pair run.
  if (!art.allPass) { log(`NOT recording into ${stateDir}: the drill artifact is not all-PASS`); return; }
  const mgr = new MachineIdentityManager(stateDir);
  const id = mgr.loadIdentity();
  const pem = mgr.loadSigningKey();
  const pub = crypto.createPublicKey({ key: pem }).export({ type: 'spki', format: 'pem' }).toString();
  const store = new LiveTestArtifactStore({ stateDir, machineId: id.machineId, signerFingerprint: id.machineId, sign: (d) => signEd25519(d, pem), verify: (d, s) => verifyEd25519(d, s, pub) });
  const artifact = { ...JSON.parse(fs.readFileSync(art.path, 'utf8')), recordedFrom: { throwawayHolderMachineId: agents.a?.machineId ?? null, runId: art.runId, sourceContentHash: art.contentHash } };
  const entry = store.write(artifact);
  log(`recorded ${art.featureId}/${art.runId} into ${stateDir} (hash ${entry.contentHash}, verified=${store.verifyEntry(art.featureId, art.runId).ok})`);
}

// ── the setup flow (Run 1 step 2) ─────────────────────────────────────────────────────────

async function storeKeyThroughTheDrop(a, page) {
  const req = await api(a, 'POST', '/secrets/request', { label: 'Gemini pay-per-use key (live test, fake)', fields: [{ name: 'gemini_key', label: 'API key' }] });
  check(req.status === 201 && typeof req.body?.token === 'string', 'the Secret Drop request was refused', { status: req.status, body: req.body, text: req.text });
  const token = req.body.token;
  await page.goto(`http://127.0.0.1:${a.port}/secrets/drop/${token}`, { waitUntil: 'domcontentloaded' });
  await page.fill('[name="gemini_key"]', FAKE_KEY);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => undefined), page.click('button[type="submit"], input[type="submit"]')]);
  await sleep(1000);
  const r = spawnSync(process.execPath, [path.join(a.stateDir, 'scripts', 'secret-drop-retrieve.mjs'), token, 'gemini_key', '--run', '--', process.execPath, path.join(a.stateDir, 'scripts', 'secret-set.mjs'), KEY_NAME], {
    cwd: a.dir, env: childEnv({ INSTAR_PORT: String(a.port) }), encoding: 'utf8', timeout: 60_000,
  });
  const leaked = (r.stdout + r.stderr).includes(FAKE_KEY);
  return { token: `${token.slice(0, 6)}…`, exit: r.status, stdoutBytes: r.stdout.length, stderr: r.stderr.replace(FAKE_KEY, '[key]').slice(-400), valueEchoed: leaked };
}

async function setupFlow(A, B) {
  const narrow = await openDashboard(browser, A, 'narrow');
  ctx.narrow = narrow;

  await setup.run({ id: 'key-handoff-no-echo', description: 'The fake key goes through a real Secret Drop form and the documented no-echo transfer (secret-drop-retrieve --run -- secret-set.mjs) into A\'s vault; the handoff is recorded through the loopback routes after mint-start', riskCategory: 'happy-path' }, async (e) => {
    const mint = await api(A, 'POST', '/routing-spend/key-handoff/mint-start', {});
    expectEqual(mint.status, 200, 'mint-start');
    await sleep(1200);
    const drop = await storeKeyThroughTheDrop(A, narrow.page);
    e.drop = drop;
    expectEqual(drop.exit, 0, 'the no-echo transfer exited non-zero');
    check(!drop.valueEchoed && drop.stdoutBytes === 0, 'the transfer printed the key', drop);
    // The account lane's artifacts: two screenshots (fake PNG bytes) and the lane's transcript.
    const lane = path.join(A.dir, 'account-lane');
    fs.mkdirSync(lane, { recursive: true });
    const mk = (n, bytes) => { const f = path.join(lane, n); fs.writeFileSync(f, bytes); return { path: f, sha256: sha256(fs.readFileSync(f)) }; };
    const shots = { oneKey: mk('one-key.png', `one-key-list ${RUN_ID}`), limit: mk('limit.png', `budget-alert ${RUN_ID}`) };
    const transcript = path.join(lane, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"role":"assistant","text":"stored the key via the no-echo pipe (fingerprint only)"}\n');
    const readAt = new Date().toISOString();
    const h = await api(A, 'POST', '/routing-spend/key-handoff', handoffBody({ keyFingerprint: FAKE_KEY_FP, readAt, shots, transcriptPath: transcript }));
    expectEqual(h.status, 200, `key-handoff: ${JSON.stringify(h.body)}`);
    const fromB = await api(B, 'POST', '/routing-spend/key-handoff', handoffBody({ keyFingerprint: FAKE_KEY_FP, readAt, shots, transcriptPath: transcript }), { headers: { 'X-Forwarded-For': '10.0.0.9' } });
    Object.assign(e, { mintStart: mint.body?.mintStartedAt, handoffStatus: h.status, handoffPath: h.body?.path, forwardedHeaderRefused: fromB.status, keyFingerprint: FAKE_KEY_FP });
    expectEqual(fromB.status, 403, 'a forwarded (non-loopback) handoff must be refused');
  });

  await setup.run({ id: 'proposal-and-card', description: 'The agent proposes the setup on the designated machine (A) and opens one Work Board card for it on the throwaway', riskCategory: 'happy-path' }, async (e) => {
    const p = await api(A, 'POST', '/routing-spend/gemini-payg/proposal', {});
    expectEqual(p.status, 200, `proposal: ${JSON.stringify(p.body)}`);
    ctx.proposalHash = p.body.proposalHash;
    ctx.setup = p.body.setup;
    e.proposalHash = ctx.proposalHash;
    e.designated = p.body.setup.designatedMachineId;
    expectEqual(p.body.setup.designatedMachineId, A.machineId, 'the proposal names A');
    const cardBody = {
      title: 'Approve Gemini pay-per-use (live test)',
      need: `Approve the Gemini pay-per-use setup on the Spend tab of LT-Holder. Proposal ${ctx.proposalHash.slice(0, 16)}.`,
      recommendation: 'Approve: $50 a month, reviews and second opinions only.',
      whyYou: 'Turning on spending is yours to approve.',
      doneWhen: [{ id: 'approved', text: 'The plan is approved with your PIN, or declined.' }],
    };
    // The board answers `work-board-starting` for its first moments after boot.
    let card = await api(A, 'POST', '/work-board/cards', cardBody);
    for (let i = 0; i < 60 && card.status === 503 && card.body?.error === 'work-board-starting'; i++) {
      await sleep(2000);
      card = await api(A, 'POST', '/work-board/cards', cardBody);
    }
    e.cardCreateStatus = card.status;
    e.b25Judge = 'stand-in claude CLI on the throwaway (fixed no-hold verdict; the judge itself is not under test)';
    if (card.status === 503) throw new Blocked('platform-error', `the Work Board is not enabled on the throwaway (${JSON.stringify(card.body)})`);
    check(card.status === 201 && card.body?.cardId, 'the card was not created', { status: card.status, body: card.body });
    const got = await api(A, 'GET', `/work-board/cards/${card.body.cardId}`);
    expectEqual(got.status, 200, 'card read');
    Object.assign(e, { cardId: card.body.cardId, cardTitle: got.body?.card?.title ?? got.body?.title ?? null, linkNote: 'no Spend-tab link on the card: a card link must be https and the throwaway runs without a tunnel (production openCard omits it the same way)' });
    ctx.cardId = card.body.cardId;
  });

  await setup.run({ id: 'proposal-changed-refused', description: 'A changed proposal refuses render and commit against the card\'s old hash with "the proposal changed; a new card is needed"', riskCategory: 'failure-rollback' }, async (e) => {
    const old = ctx.proposalHash;
    const p2 = await api(A, 'POST', '/routing-spend/gemini-payg/proposal', { dailyCapUsd: 9 });
    expectEqual(p2.status, 200, 'second proposal');
    check(p2.body.proposalHash !== old, 'a changed value must change the hash');
    const r = await api(A, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup', expectedProposalHash: old });
    const plan2 = await api(A, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup' });
    const c = await api(A, 'POST', '/routing-spend/money-layer/commit', { pin: PIN, planId: plan2.body?.planId, nonce: plan2.body?.nonce, proposalHash: old });
    Object.assign(e, { oldHash: old, newHash: p2.body.proposalHash, renderStatus: r.status, renderError: r.body?.error, renderMessage: r.body?.message, commitStatus: c.status, commitError: c.body?.error, commitMessage: c.body?.message, intentWritten: fs.existsSync(intentPath(A)) });
    expectEqual(r.status, 409, 'render with the old hash');
    expectEqual(r.body?.error, 'proposal-changed', 'render refusal code');
    check(String(r.body?.message).includes('a new card is needed'), 'render refusal words');
    check(c.status === 409 && c.body?.error === 'proposal-changed', 'commit with the old hash', { status: c.status, body: c.body });
    check(!fs.existsSync(intentPath(A)), 'nothing may be written');
    // Back to the agent's proposal (same struct ⇒ same hash), and the new card for it.
    const p3 = await api(A, 'POST', '/routing-spend/gemini-payg/proposal', {});
    ctx.proposalHash = p3.body.proposalHash;
    ctx.setup = p3.body.setup;
    e.restoredHash = ctx.proposalHash;
    e.restoredEqualsFirst = ctx.proposalHash === old;
  });

  await setup.run({ id: 'render-parity-forwarded', description: 'The plan rendered on A and the plan requested from B (forwarded over the mesh to the designated machine) are the same plan', riskCategory: 'channel-parity' }, async (e) => {
    const local = await api(A, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup' });
    const fwd = await api(B, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup', designatedMachineId: A.machineId });
    Object.assign(e, { localStatus: local.status, forwardedStatus: fwd.status, forwarded: fwd.body?.forwarded, renderedOn: fwd.body?.renderedOn, localHash: local.body?.proposalHash, forwardedHash: fwd.body?.proposalHash, textSha256Local: local.body?.renderedText ? sha256(local.body.renderedText) : null, textSha256Forwarded: fwd.body?.renderedText ? sha256(fwd.body.renderedText) : null, responderMachineId: fwd.body?.renderedOn, parityNote: 'dashboard-only flow: "channel parity" is the plan from either machine of the pair — Telegram/Slack are not surfaces of this feature' });
    expectEqual(local.status, 200, `local render: ${JSON.stringify(local.body)}`);
    expectEqual(fwd.status, 200, `forwarded render: ${JSON.stringify(fwd.body)}`);
    expectEqual(fwd.body.forwarded, true, 'B forwarded');
    expectEqual(fwd.body.renderedOn, A.machineId, 'rendered on A');
    expectEqual(fwd.body.renderedText, local.body.renderedText, 'same plan text');
    expectEqual(fwd.body.proposalHash, local.body.proposalHash, 'same proposal');
    ctx.planText = local.body.renderedText;
  });

  for (const vp of ['narrow', 'wide']) {
    await setup.run({ id: `plan-page-${vp}`, description: `The plan page exactly as A's dashboard serves it (Spend tab, ${VIEWPORTS[vp].width}x${VIEWPORTS[vp].height}): the first-screen line is on the first screen and every committed field is on the page`, riskCategory: 'happy-path' }, async (e) => {
      const d = vp === 'narrow' ? narrow : await openDashboard(browser, A, 'wide');
      if (vp === 'narrow') { await d.page.goto(`http://127.0.0.1:${A.port}/dashboard?tab=spend`); await d.page.evaluate(() => window.switchTab && window.switchTab('spend')); }
      await d.page.waitForSelector('#gpSetupPlan .gp-setup-lead', { timeout: 30_000 });
      const lead = await d.page.$('#gpSetupPlan .gp-setup-lead');
      const leadText = (await lead.textContent()).trim();
      const box = await lead.boundingBox();
      const pageText = await d.page.$eval('#geminiPaygSetup', (n) => n.innerText);
      const missing = missingPlanLines(ctx.planText, pageText);
      const figures = committedMoneyFigures(ctx.setup);
      const missingFigures = figures.filter((f) => !pageText.includes(f));
      const s = await shot(d.page, `plan-page-${vp}`);
      Object.assign(e, { leadText, leadBottomPx: box ? Math.round(box.y + box.height) : null, viewportHeight: VIEWPORTS[vp].height, planLines: ctx.planText.split('\n').length, missingLines: missing, figures, missingFigures, screenshot: s.path, screenshotSha256: s.sha256, pageErrors: d.errors.slice(0, 5) });
      expectEqual(leadText, GEMINI_PAYG_FIRST_SCREEN_LINE, 'the lead is the first-screen line');
      check(box && box.y >= 0 && box.y + box.height <= VIEWPORTS[vp].height, 'the first-screen line is below the fold', { box });
      check(box.x >= 0 && box.x + box.width <= VIEWPORTS[vp].width, 'the first-screen line runs off the side of the screen', { box });
      const widths = await d.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, panel: document.getElementById('geminiPaygSetup').scrollWidth, panelClient: document.getElementById('geminiPaygSetup').clientWidth }));
      e.widths = widths;
      check(widths.panel <= widths.panelClient + 1, 'the plan panel scrolls sideways (text wider than the panel)', { widths });
      check(missing.length === 0, 'plan lines missing from the page', { missing });
      check(missingFigures.length === 0, 'committed figures missing from the page', { missingFigures });
      check(pageText.includes(ctx.setup.designatedMachineId), 'the designated machine is named');
      if (vp === 'wide') ctx.wide = d;
    });
  }

  await setup.run({ id: 'wrong-pin-and-bearer-only-refused', description: 'A wrong PIN typed into the dashboard is refused and nothing is written; a Bearer-only commit (no PIN) is refused', riskCategory: 'permission-volatile' }, async (e) => {
    const page = ctx.wide.page;
    await page.fill('#gpSetupPin', PIN === '999999' ? '999998' : '999999');
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().includes('/routing-spend/money-layer/commit'), { timeout: 30_000 }), page.click('#gpSetupApprove')]);
    await sleep(500);
    const status = await page.$eval('#gpSetupStatus', (n) => n.textContent);
    const plan = await api(A, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup' });
    const bearer = await api(A, 'POST', '/routing-spend/money-layer/commit', { planId: plan.body?.planId, nonce: plan.body?.nonce });
    Object.assign(e, { dashboardCommitStatus: resp.status(), dashboardWords: status, bearerOnlyStatus: bearer.status, bearerOnlyError: bearer.body?.error, intentWritten: fs.existsSync(intentPath(A)), restartFlag: fs.existsSync(path.join(A.stateDir, 'state', 'restart-requested.json')) });
    expectEqual(resp.status(), 401, 'the wrong PIN');
    check(/PIN was not accepted/.test(status), 'the dashboard says the PIN was not accepted', { status });
    expectEqual(bearer.status, 401, 'Bearer without a PIN');
    check(!e.intentWritten && !e.restartFlag, 'nothing may be written by a refused commit');
  });

  // The happy commit IS the concurrency race: the dashboard click and a second commit of the
  // same plan, at the same moment. Exactly one may apply.
  await setup.run({ id: 'pin-commit-race-one-applies', description: 'The PIN commit is made through the dashboard from two tabs at once (two devices, each with its own freshly rendered plan); exactly one applies, one intent is written and one restart is scheduled, and the other tab does not claim nothing changed', riskCategory: 'concurrency' }, async (e) => {
    const tabs = [ctx.narrow.page, ctx.wide.page];
    const plans = [];
    for (const page of tabs) {
      const planWait = page.waitForResponse((r) => r.url().includes('/routing-spend/plan-money-layer') && r.request().method() === 'POST', { timeout: 30_000 });
      await page.goto(`http://127.0.0.1:${A.port}/dashboard?tab=spend`);
      await page.evaluate(() => window.switchTab && window.switchTab('spend'));
      plans.push(await (await planWait).json());
      await page.waitForSelector('#gpSetupApprove', { timeout: 30_000 });
      await page.fill('#gpSetupPin', PIN);
    }
    check(plans[0].planId !== plans[1].planId, 'each tab rendered its own plan');
    ctx.commitAt = Date.now();
    const responses = await Promise.all(tabs.map(async (page) => {
      const [resp] = await Promise.all([page.waitForResponse((r) => r.url().includes('/routing-spend/money-layer/commit'), { timeout: 30_000 }), page.click('#gpSetupApprove')]);
      let body = null;
      try { body = await resp.json(); } catch { /* none */ }
      return { status: resp.status(), body };
    }));
    await sleep(800);
    const words = await Promise.all(tabs.map((page) => page.$eval('#gpSetupStatus', (n) => n.textContent).catch(() => null)));
    const committed = auditOf(A, 'gemini-payg-setup-committed');
    ctx.intentHash = committed[0]?.detail?.intentHash ?? null;
    const restartReq = readJson(path.join(A.stateDir, 'state', 'restart-requested.json'));
    const winner = responses.findIndex((r) => r.status === 200);
    const loser = winner === 0 ? 1 : 0;
    Object.assign(e, { statuses: responses.map((r) => r.status), loserError: responses[loser]?.body?.error ?? null, winnerTab: winner === 0 ? 'narrow-390' : winner === 1 ? 'wide-1280' : 'none', winnerRestart: responses[winner]?.body?.restart ?? null, winnerWords: words[winner] ?? null, loserWords: words[loser] ?? null, commitAuditRows: committed.length, intentHash: committed[0]?.detail?.intentHash ?? null, restartRequestedBy: restartReq?.requestedBy ?? null, restartReason: restartReq?.reason ?? null });
    expectEqual(responses.filter((r) => r.status === 200).length, 1, 'exactly one commit applies');
    expectEqual(committed.length, 1, 'one commit audit row');
    check(fs.existsSync(intentPath(A)) || A.exits.length > 0, 'the intent was written');
    check(restartReq && /gemini-payg/.test(String(restartReq.reason)), 'the commit itself scheduled the supervised restart', { restartReq });
    check(/no second PIN/.test(String(words[winner])), 'the winning tab tells the user no second PIN is needed', { words });
    check(!/Nothing has changed/.test(String(words[loser])), 'the losing tab must not claim nothing changed', { words });
    ctx.intentHash = e.intentHash;
  });

  await setup.run({ id: 'automatic-restart-and-apply', description: 'The commit restarts A by itself (the process exits on the request and the supervisor brings it back); the intent is applied at boot and the door is armed-pending-proof', riskCategory: 'happy-path' }, async (e) => {
    const exit = await waitExit(A, 90_000);
    check(exit, 'A did not exit on the restart request within 90s');
    startServer(A);
    const readyAt = await waitReady(A);
    const w = restartWindow({ commitAt: ctx.commitAt, exitAt: exit.at, readyAt });
    const settled = await waitPairSettled(A, B);
    const applied = auditOf(A, 'gemini-payg-intent-applied');
    const rel = await api(A, 'GET', '/routing-spend/gemini-payg/release');
    const caps = capsFile(A);
    const st = await api(A, 'GET', '/routing-spend/enable-status');
    Object.assign(e, { exit: { code: exit.code, signal: exit.signal, pid: exit.pid }, newPid: A.child?.pid, restart: w, settled, appliedRows: applied.map((r) => r.detail), intentFileGone: !fs.existsSync(intentPath(A)), releaseState: rel.body?.evaluation?.releaseState, blocker: rel.body?.evaluation?.blocker, doorPolicy: caps?.doorPolicy?.[DOOR] ? { releaseState: caps.doorPolicy[DOOR].releaseState, designationEpoch: caps.doorPolicy[DOOR].designationEpoch } : null, monthlyCapUsd: caps?.caps?.[KEY_NAME]?.monthlyCapUsd, enforcementReady: st.body?.enforcementReady, lifecycleState: st.body?.lifecycleState });
    check(exit.signal === null, 'A exited by itself, not by a signal', exit);
    check(applied.length === 1 && applied[0].detail?.outcome === 'applied' && applied[0].detail?.intentHash === ctx.intentHash, 'the committed intent was applied once', { applied });
    check(e.intentFileGone, 'the intent file is deleted after the apply');
    expectEqual(rel.body?.here, true, 'A is the spender');
    expectEqual(e.releaseState, 'armed-pending-proof', 'release state');
    expectEqual(e.monthlyCapUsd, 50, 'the monthly cap');
    check(settled.enforcementReady, 'the money layer is enforcing on A after the restart', { settled });
    check(settled.leaseConfirmed && settled.bSeesSpender === A.machineId, 'the pair settled: echo confirmed, B knows the spender', { settled });
    ctx.firstRestart = { ...w, settled };
  });

  await setup.run({ id: 'dashboard-after-restart', description: 'Back on the dashboard after the restart, the Spend tab says the door is set up and waiting for its proof call, and the setup plan is no longer offered', riskCategory: 'lifecycle' }, async (e) => {
    const d = await openDashboard(browser, A, 'wide');
    await sleep(4000);
    const text = await d.page.$eval('#spendPanel', (n) => n.innerText);
    const offered = await d.page.$eval('#geminiPaygSetup', (n) => getComputedStyle(n).display !== 'none').catch(() => false);
    const s = await shot(d.page, 'spend-after-restart-wide');
    Object.assign(e, { saysWaiting: text.includes('The door is set up and waiting for its proof call.'), setupStillOffered: offered, screenshot: s.path, screenshotSha256: s.sha256 });
    check(e.saysWaiting, 'the Spend tab shows the armed state', { excerpt: text.slice(0, 600) });
    check(!offered, 'the setup plan is not offered again');
    await d.ctx.close();
  });

  await setup.run({ id: 'repeat-commit-no-second-effect', description: 'Repeating the commit after it applied (the same plan) changes nothing: refused, one commit row, one apply row', riskCategory: 'idempotency' }, async (e) => {
    const again = await api(A, 'POST', '/routing-spend/money-layer/commit', { pin: PIN, planId: 'p-replayed', nonce: 'n-replayed', proposalHash: ctx.proposalHash });
    const render = await api(A, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup' });
    Object.assign(e, { replayStatus: again.status, replayError: again.body?.error, renderAfterApplyStatus: render.status, renderAfterApplyError: render.body?.error, commitRows: auditOf(A, 'gemini-payg-setup-committed').length, applyRows: auditOf(A, 'gemini-payg-intent-applied').length, restartFlag: fs.existsSync(path.join(A.stateDir, 'state', 'restart-requested.json')) });
    check(again.status >= 400, 'a replayed commit is refused');
    expectEqual(e.commitRows, 1, 'one commit row');
    expectEqual(e.applyRows, 1, 'one apply row');
  });

  await setup.run({ id: 'second-restart-no-reapply', description: 'A second restart of A boots without re-applying: no new apply row, the applied intent and release state unchanged', riskCategory: 'lifecycle' }, async (e) => {
    const before = capsFile(A);
    await stopServer(A, 'SIGTERM');
    startServer(A);
    await waitReady(A);
    const settled = await waitPairSettled(A, B);
    const after = capsFile(A);
    const rel = await api(A, 'GET', '/routing-spend/gemini-payg/release');
    Object.assign(e, { applyRows: auditOf(A, 'gemini-payg-intent-applied').length, appliedIntentBefore: before?.appliedIntents?.[DOOR]?.intentHash ?? null, appliedIntentAfter: after?.appliedIntents?.[DOOR]?.intentHash ?? null, releaseState: rel.body?.evaluation?.releaseState, settled });
    check(settled.enforcementReady && settled.leaseConfirmed, 'enforcing again after the second restart', { settled });
    expectEqual(e.applyRows, 1, 'no second apply');
    expectEqual(e.appliedIntentAfter, e.appliedIntentBefore, 'the applied intent is unchanged');
    expectEqual(e.releaseState, 'armed-pending-proof', 'still armed');
  });

  // Run 2's price check (d) and reconciliation (c), done the reviewed way on the throwaway:
  // the manifest's points are flipped to verified, and one $0.00 browser-read figure is recorded.
  seedManifest(A, true);
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  const recon = await api(A, 'POST', '/routing-spend/reconciliation', { month, figureUsd: 0 });
  log(`reconciliation ${month}: ${recon.status}`);

  await setup.run({ id: 'non-holder-never-spends', description: 'B holds no money state, no key and no ledger; its second opinion is forwarded to A, which refuses it while the door waits for proof — Google is not called', riskCategory: 'permission-volatile' }, async (e) => {
    const g0 = google.generate;
    const so = await api(B, 'POST', '/intelligence/gemini', { prompt: 'Is this plan sound?', purpose: 'live-test' });
    const bCaps = capsFile(B);
    const bNames = spawnSync(process.execPath, [path.join(B.stateDir, 'scripts', 'secret-get.mjs'), '--names'], { cwd: B.dir, env: childEnv(), encoding: 'utf8' });
    const bLedger = fs.existsSync(path.join(B.stateDir, 'state')) ? fs.readdirSync(path.join(B.stateDir, 'state')).filter((f) => /metered|ledger/i.test(f) && !/live-test/.test(f)) : [];
    Object.assign(e, { secondOpinionStatus: so.status, secondOpinionReason: so.body?.reason ?? so.body?.error, googleCallsDuringIt: google.generate - g0, bHasCapsRecord: !!bCaps?.goLive?.[DOOR], bVaultNamesIncludeKey: bNames.stderr.includes(KEY_NAME), bLedgerFiles: bLedger });
    expectEqual(google.generate - g0, 0, 'no Google call');
    expectEqual(so.body?.reason, 'armed-pending-proof', `the holder refuses the forwarded call while armed (${so.status} ${JSON.stringify(so.body)})`);
    check(!e.bHasCapsRecord, 'B keeps no go-live record');
    check(!e.bVaultNamesIncludeKey, 'the key is not on B');
  });

  await setup.run({ id: 'release-proof-from-non-holder', description: 'POST /routing-spend/release-proof on B is forwarded; A makes the one proof call against the fake Google and settles it; the door then waits only on check (b)', riskCategory: 'happy-path' }, async (e) => {
    const g0 = google.generate;
    const r = await api(B, 'POST', '/routing-spend/release-proof', {}, { timeoutMs: 120_000 });
    const ev = r.body?.evaluation;
    Object.assign(e, { status: r.status, attempt: r.body?.attempt ? { state: r.body.attempt.state, reserveId: r.body.attempt.reserveId, costUsd: r.body.attempt.costUsd, forwardedFrom: r.body.attempt.forwardedFrom, modelId: r.body.attempt.modelId } : null, releaseState: ev?.releaseState, blocker: ev?.blocker, checks: ev?.checks?.map((c) => ({ id: c.id, ok: c.ok })), googleCalls: google.generate - g0, googleModel: google.models[google.models.length - 1] ?? null, responderMachineId: A.machineId });
    expectEqual(r.status, 200, `release-proof: ${JSON.stringify(r.body).slice(0, 400)}`);
    expectEqual(google.generate - g0, 1, 'exactly one paid call');
    expectEqual(r.body?.attempt?.state, 'settled', 'the proof settled');
    expectEqual(r.body?.attempt?.forwardedFrom, B.machineId, 'the proof arrived forwarded from B');
    const byId = Object.fromEntries((ev?.checks ?? []).map((c) => [c.id, c.ok]));
    check(byId['ae-proof-row'] && byId['c-reconciliation'] && byId['d-prices-verified'], 'checks (a)+(e), (c), (d) met', { checks: ev?.checks });
    expectEqual(byId['b-live-test'], false, 'check (b) is the one left');
    expectEqual(ev?.releaseState, 'armed-pending-proof', 'the door waits on (b)');
  });

  await setup.run({ id: 'repeat-proof-one-paid-call', description: 'Repeating the release proof returns the recorded outcome and makes no second paid call', riskCategory: 'idempotency' }, async (e) => {
    const g0 = google.generate;
    const r = await api(B, 'POST', '/routing-spend/release-proof', {}, { timeoutMs: 120_000 });
    const rel = await api(A, 'GET', '/routing-spend/gemini-payg/release');
    Object.assign(e, { status: r.status, googleCalls: google.generate - g0, attempts: rel.body?.attempts?.map((x) => ({ state: x.state, reserveId: x.reserveId })) ?? null });
    expectEqual(r.status, 200, 'repeat');
    expectEqual(google.generate - g0, 0, 'no second paid call');
    expectEqual((rel.body?.attempts ?? []).filter((x) => x.state === 'settled').length, 1, 'one settled attempt');
  });

  await ctx.narrow.ctx.close();
  await ctx.wide.ctx.close();
}

// ── regression: a fleet-default agent (money off) is unchanged ───────────────────────────

async function regression(C, B) {
  await setup.run({ id: 'fleet-default-unchanged', description: 'A fleet-default agent with money off: the lane routes answer honestly (503 / not here / no designation) and a metered key in its vault goes nowhere', riskCategory: 'regression' }, async (e) => {
    const rp = await api(C, 'POST', '/routing-spend/release-proof', {});
    const rel = await api(C, 'GET', '/routing-spend/gemini-payg/release');
    const so = await api(C, 'POST', '/intelligence/gemini', { prompt: 'x', purpose: 'live-test' });
    const set = spawnSync(process.execPath, [path.join(C.stateDir, 'scripts', 'secret-set.mjs'), KEY_NAME], { cwd: C.dir, env: childEnv(), input: FAKE_KEY, encoding: 'utf8' });
    const get = spawnSync(process.execPath, [path.join(C.stateDir, 'scripts', 'secret-get.mjs'), KEY_NAME, '--pipe-fd3'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], cwd: C.dir, env: childEnv(), encoding: 'utf8' });
    const g0 = google.generate;
    const so2 = await api(C, 'POST', '/intelligence/gemini', { prompt: 'x', purpose: 'live-test' });
    Object.assign(e, { releaseProofStatus: rp.status, releaseProofReason: rp.body?.reason ?? rp.body?.error ?? rp.text, releaseView: rel.body, secondOpinionStatus: so.status, keyStored: set.status, secretGetExit: get.status, secretGetStdoutBytes: get.stdout.length, secondOpinionWithKeyStatus: so2.status, googleCalls: google.generate - g0, capsFile: !!capsFile(C), intentFile: fs.existsSync(intentPath(C)) });
    expectEqual(rp.status, 503, 'release-proof refuses');
    check(rel.status === 200 && rel.body?.here === false && rel.body?.holder === null, 'no designation', { rel: rel.body });
    check(so.status >= 400 && so2.status >= 400, 'no second opinion without go-live');
    expectEqual(set.status, 0, 'the vault takes the key');
    expectEqual(get.status, 3, 'secret-get refuses a metered key');
    expectEqual(get.stdout.length, 0, 'and prints nothing');
    expectEqual(google.generate - g0, 0, 'Google is never called');
    check(!e.capsFile && !e.intentFile, 'no money state written');
  });
}

// ── failure: a failed apply leaves the door frozen, no crash loop ────────────────────────

async function failedApply(D) {
  await setup.run({ id: 'failed-apply-frozen-no-crash-loop', description: 'On a single machine, a committed intent that fails validation at boot freezes the door, raises one notice and the server keeps running across further restarts (no crash loop)', riskCategory: 'failure-rollback' }, async (e) => {
    expectEqual((await api(D, 'POST', '/routing-spend/key-handoff/mint-start', {})).status, 200, 'mint-start');
    await sleep(1200);
    const set = spawnSync(process.execPath, [path.join(D.stateDir, 'scripts', 'secret-set.mjs'), KEY_NAME], { cwd: D.dir, env: childEnv(), input: FAKE_KEY, encoding: 'utf8' });
    expectEqual(set.status, 0, 'key stored');
    const lane = path.join(D.dir, 'account-lane');
    fs.mkdirSync(lane, { recursive: true });
    const mk = (n) => { const f = path.join(lane, n); fs.writeFileSync(f, `${n} ${RUN_ID}`); return { path: f, sha256: sha256(fs.readFileSync(f)) }; };
    const transcript = path.join(lane, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"text":"no key here"}\n');
    expectEqual((await api(D, 'POST', '/routing-spend/key-handoff', handoffBody({ keyFingerprint: FAKE_KEY_FP, readAt: new Date().toISOString(), shots: { oneKey: mk('one.png'), limit: mk('limit.png') }, transcriptPath: transcript }))).status, 200, 'handoff');
    const p = await api(D, 'POST', '/routing-spend/gemini-payg/proposal', {});
    expectEqual(p.status, 200, `proposal ${JSON.stringify(p.body)}`);
    const plan = await api(D, 'POST', '/routing-spend/plan-money-layer', { action: 'gemini-payg-setup' });
    expectEqual(plan.status, 200, `render ${JSON.stringify(plan.body)}`);
    const c = await api(D, 'POST', '/routing-spend/money-layer/commit', { pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, proposalHash: plan.body.proposalHash });
    expectEqual(c.status, 200, `commit ${JSON.stringify(c.body)}`);
    const exit = await waitExit(D, 90_000);
    check(exit, 'D did not exit on its restart request');
    // The failure injected between the commit and the boot: the intent's contents no longer
    // match its hash (a disk corruption / a hand edit), so the apply must refuse it.
    const intent = readJson(intentPath(D));
    check(intent, 'the intent is on disk before the boot');
    intent.setup.monthlyCapUsd = 5000;
    fs.writeFileSync(intentPath(D), JSON.stringify(intent));
    startServer(D);
    await waitReady(D);
    await sleep(20_000);
    const alive1 = !!D.child;
    const caps1 = capsFile(D);
    await stopServer(D, 'SIGTERM');
    startServer(D);
    await waitReady(D);
    await sleep(20_000);
    const caps2 = capsFile(D);
    const failure = readJson(path.join(D.stateDir, 'state', 'gemini-payg-apply-failure.json'));
    const applied = auditOf(D, 'gemini-payg-intent-applied');
    const rel = await api(D, 'GET', '/routing-spend/gemini-payg/release');
    const unexpectedExits = D.exits.filter((x) => x.signal === null && x.code !== 0).length;
    Object.assign(e, { aliveAfterFailedBoot: alive1, aliveAfterSecondBoot: !!D.child, frozen: caps1?.caps?.[KEY_NAME]?.frozen === true, frozenBy: caps1?.caps?.[KEY_NAME]?.frozenBy ?? null, frozenStillAfterSecondBoot: caps2?.caps?.[KEY_NAME]?.frozen === true, doorPolicyApplied: !!caps1?.doorPolicy?.[DOOR], failureRecord: failure, applyRows: applied.map((r) => r.detail?.outcome), intentFileGone: !fs.existsSync(intentPath(D)), releaseView: rel.body?.evaluation?.releaseState ?? rel.body, exits: D.exits.map((x) => ({ code: x.code, signal: x.signal })), unexpectedExits });
    check(alive1 && !!D.child, 'the server keeps running');
    check(e.frozen && e.frozenStillAfterSecondBoot, 'the door is frozen');
    check(!e.doorPolicyApplied, 'nothing was applied');
    check(applied.length === 1 && applied[0].detail?.outcome === 'failed', 'one failed apply, not one per boot', { applied: e.applyRows });
    expectEqual(unexpectedExits, 0, 'no crash');
  });
}

// ── the holder-death drill (release check (b)) ───────────────────────────────────────────

async function holderDeathDrill(A, B) {
  const seenPath = path.join(B.stateDir, 'state', 'gemini-payg-seen-designation.json');
  let killedAt = 0;
  await drill.run({ id: 'holder-killed-non-holder-refuses', description: 'With the lane set up on A, A is killed (SIGKILL). B answers holder-unreachable for a second opinion and for the release proof, and never spends locally', riskCategory: 'failure-rollback' }, async (e) => {
    ctx.leaseBeforeKill = (await api(A, 'GET', '/routing-spend/gemini-payg/release')).body?.lease ?? null;
    e.leaseBeforeKill = ctx.leaseBeforeKill;
    check(ctx.leaseBeforeKill?.confirmed === true, 'the lease echo is confirmed before the drill (the lane is live on the holder)', { lease: ctx.leaseBeforeKill });
    const exit = await stopServer(A, 'SIGKILL');
    killedAt = Date.now();
    check(exit && exit.signal === 'SIGKILL', 'A was killed', exit);
    const g0 = google.generate;
    const so = await api(B, 'POST', '/intelligence/gemini', { prompt: 'still there?', purpose: 'live-test-drill' }, { timeoutMs: 90_000 });
    const rp = await api(B, 'POST', '/routing-spend/release-proof', {}, { timeoutMs: 90_000 });
    Object.assign(e, { killedPid: exit.pid, secondOpinion: { status: so.status, reason: so.body?.reason ?? so.body?.error }, releaseProof: { status: rp.status, reason: rp.body?.reason ?? rp.body?.status }, googleCalls: google.generate - g0, bCapsRecord: !!capsFile(B)?.goLive?.[DOOR] });
    expectEqual(so.status, 503, 'second opinion status');
    expectEqual(e.secondOpinion.reason, 'holder-unreachable', 'second opinion reason');
    expectEqual(rp.status, 503, 'release proof status');
    expectEqual(rp.body?.reason, 'holder-unreachable', 'release proof reason');
    expectEqual(e.googleCalls, 0, 'no Google call while the holder is down');
    check(!e.bCapsRecord, 'B took over nothing');
  });

  await drill.run({ id: 'stop-action-queued-while-down', description: 'A reduce-only stop (lower the daily limit) asked on B while A is down is held for the spender, not applied locally', riskCategory: 'permission-volatile' }, async (e) => {
    const r = await api(B, 'POST', '/routing-spend/caps/lower', { dailyCapUsd: 9.5 }, { timeoutMs: 90_000 });
    const pending = readJson(path.join(B.stateDir, 'state', 'gemini-payg-pending-stops.json'));
    Object.assign(e, { status: r.status, reason: r.body?.reason, confirmed: r.body?.confirmed, pendingOnB: Array.isArray(pending) ? pending.length : (pending ? Object.keys(pending).length : 0) });
    expectEqual(r.status, 202, 'held');
    expectEqual(r.body?.reason, 'holder-unreachable', 'reason');
    check(e.pendingOnB >= 1, 'the stop is queued on B');
  });

  await drill.run({ id: 'holder-back-echo-reconfirms', description: 'A is restarted; its designation echo reaches B again (B\'s record of the spender is refreshed after the restart), and the queued stop is delivered and confirmed on A', riskCategory: 'lifecycle' }, async (e) => {
    const restartAt = Date.now();
    startServer(A);
    const readyAt = await waitReady(A);
    const settled = await waitPairSettled(A, B);
    e.settled = settled;
    const firstLease = (await api(A, 'GET', '/routing-spend/gemini-payg/release')).body?.lease ?? null;
    let lease = firstLease;
    let confirmedAt = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      lease = (await api(A, 'GET', '/routing-spend/gemini-payg/release')).body?.lease ?? null;
      if (lease?.confirmed && confirmedAt === null) confirmedAt = Date.now();
      const caps = capsFile(A);
      if (lease?.confirmed && caps?.caps?.[KEY_NAME]?.dailyCapUsd === 9.5) break;
      await sleep(2000);
    }
    const seen = readJson(seenPath);
    const capsA = capsFile(A);
    const pending = readJson(path.join(B.stateDir, 'state', 'gemini-payg-pending-stops.json'));
    Object.assign(e, { downMs: restartAt - killedAt, bootMs: readyAt - restartAt, leaseBeforeKill: ctx.leaseBeforeKill ?? null, leaseAtBoot: firstLease, leaseNow: lease, echoReconfirmedAfterReadyMs: confirmedAt ? confirmedAt - readyAt : null, bSeesSpender: seen, dailyCapOnA: capsA?.caps?.[KEY_NAME]?.dailyCapUsd, pendingLeftOnB: Array.isArray(pending) ? pending.length : (pending ? Object.keys(pending).length : 0), responderMachineId: A.machineId });
    check(lease?.confirmed === true, 'the holder\'s designation echo re-confirmed after the restart', { lease });
    expectEqual(seen?.machineId, A.machineId, 'B names A as the spender');
    expectEqual(e.dailyCapOnA, 9.5, 'the queued stop reached the spender');
    expectEqual(e.pendingLeftOnB, 0, 'nothing left queued');
  });

  await drill.run({ id: 'forwarding-resumes', description: 'After the restart, B\'s forwarded release proof reaches A again and returns the recorded outcome', riskCategory: 'happy-path' }, async (e) => {
    const g0 = google.generate;
    const r = await api(B, 'POST', '/routing-spend/release-proof', {}, { timeoutMs: 120_000 });
    Object.assign(e, { status: r.status, attempt: r.body?.attempt?.state ?? null, releaseState: r.body?.evaluation?.releaseState, googleCalls: google.generate - g0, responderMachineId: A.machineId });
    expectEqual(r.status, 200, `forwarded proof after restart: ${JSON.stringify(r.body).slice(0, 300)}`);
    expectEqual(r.body?.attempt?.state, 'settled', 'the recorded settled proof');
    expectEqual(e.googleCalls, 0, 'no second paid call');
  });
}

async function releaseCheckB(A, B, art) {
  const g0 = google.generate;
  const r = await api(B, 'POST', '/routing-spend/release-proof', { liveTestArtifact: { featureId: art.featureId, runId: art.runId } }, { timeoutMs: 120_000 });
  const ev = r.body?.evaluation;
  const b = ev?.checks?.find((c) => c.id === 'b-live-test');
  ctx.releaseCheckB = { status: r.status, releaseState: ev?.releaseState ?? null, blocker: ev?.blocker ?? null, checkB: b ?? null, paidCallsDuringIt: google.generate - g0 };
  log(`release check (b) with ${art.featureId}/${art.runId}: ${JSON.stringify(ctx.releaseCheckB)}`);
  if (ev?.releaseState === 'live') {
    const g1 = google.generate;
    const so = await api(B, 'POST', '/intelligence/gemini', { prompt: 'One line: is the sky blue?', purpose: 'live-test-after-release' }, { timeoutMs: 120_000 });
    ctx.afterRelease = { secondOpinionFromB: so.status, text: so.body?.text ?? null, googleCalls: google.generate - g1 };
    log(`after release, B's forwarded second opinion: ${JSON.stringify(ctx.afterRelease)}`);
  }
}

// ── teardown + report ─────────────────────────────────────────────────────────────────────

async function teardown() {
  try { await browser?.close(); } catch { /* closing */ }
  for (const a of Object.values(agents)) { try { await stopServer(a, 'SIGTERM'); } catch { /* best effort */ } }
  await new Promise((r) => googleSrv.close(() => r()));
  if (!KEEP) {
    // Keep the artifacts (copied to OUT) and the server logs; drop the throwaway homes.
    for (const a of Object.values(agents)) { try { fs.copyFileSync(a.logPath, path.join(OUT, `server-${a.name}-${RUN_ID}.log`)); } catch { /* none */ } }
    try { SafeFsExecutor.safeRmSync(ROOT, { recursive: true, force: true, operation: 'scripts/gemini-payg-live-test.mjs:teardown' }); } catch (err) { log(`cleanup failed: ${err}`); }
  }
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  log(`RUN ABORTED: ${err && err.stack ? err.stack : err}`);
} finally {
  await teardown();
  const report = {
    runId: RUN_ID,
    root: KEEP ? ROOT : '(removed)',
    aborted: failure ? String(failure.message ?? failure) : null,
    googleCalls: { generate: google.generate, countTokens: google.count, models: google.models },
    firstRestart: ctx.firstRestart ?? null,
    setupFlow: ctx.setupArtifact ?? { rows: setup.rows.map((r) => `${r.verdict} ${r.riskCategory} ${r.id}`), missing: setup.missingCategories() },
    holderDeathDrill: ctx.drillArtifact ?? { rows: drill.rows.map((r) => `${r.verdict} ${r.riskCategory} ${r.id}`) },
    releaseCheckB: ctx.releaseCheckB ?? null,
    afterRelease: ctx.afterRelease ?? null,
    scenarios: { setup: setup.rows, drill: drill.rows },
  };
  const reportPath = path.join(OUT, `report-${RUN_ID}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`report → ${reportPath}`);
  const pass = !failure && ctx.setupArtifact?.allPass && ctx.drillArtifact?.allPass;
  log(pass ? 'RESULT: PASS (both signed artifacts all-PASS)' : 'RESULT: NOT PASS');
  logStream.end();
  process.exit(pass ? 0 : 1);
}
