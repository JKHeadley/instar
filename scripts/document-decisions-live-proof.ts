/**
 * Document decisions — live proof runner (docs/specs/document-decisions.md §10).
 *
 *     npx tsx scripts/document-decisions-live-proof.ts
 *
 * One throwaway AgentServer behind a TLS front at its named-tunnel origin, documents on, no Telegram.
 * The owner's phone is paired through the real pairing routes (device key + Face ID presence key,
 * signing exactly as the app does); the owner's computer is linked by the page's QR flow and drives
 * the REAL document page in headless Chromium at 1280×728 and 390×844. The run proves the path the
 * maintainer asked for: Approve on the web page → "Confirm on your phone" → the phone's Face ID
 * decision → the owner's message in the document's conversation (the session receives it) → the
 * document marked "Approved … version 1" on both viewports; then Decline with a note, a new version
 * that asks again, and the refusals. Screenshots and a signed artifact are written to the run folder.
 */
// safe-fs-allow: proof runner — SafeFsExecutor used for throwaway tmpdir cleanup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { AgentServer } from '../src/server/AgentServer.js';
import { StateManager } from '../src/core/StateManager.js';
import { InitiativeTracker } from '../src/core/InitiativeTracker.js';
import { MultiMachineCoordinator } from '../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair, sign as signEd25519, verify as verifyEd25519 } from '../src/core/MachineIdentity.js';
import { MemoryPrivacy } from '../src/users/MemoryPrivacy.js';
import { canonicalString } from '../src/core/MobileDeviceKeys.js';
import { docpageString } from '../src/documents/docpageAuth.js';
import { blobHash } from '../src/documents/blobs.js';
import { canonicalJson } from '../src/documents/chain.js';
import { LiveTestArtifactStore } from '../src/core/LiveTestArtifactStore.js';
import { SafeFsExecutor } from '../src/core/SafeFsExecutor.js';
import { enrollProofMessage } from '../src/server/mobileBrowserDevices.js';
import { setDocumentScopedSend } from '../src/server/mobilePairingRoutes.js';
import { createMockSessionManager } from '../tests/helpers/setup.js';
import { makeDevice } from '../tests/helpers/mobileDevice.js';
import type { InstarConfig } from '../src/core/types.js';
import { permissionPresenceMessage } from '../src/server/mobilePermissionsRoutes.js';
import { pairingApproveLine, pairingApproveMessage } from '../src/server/mobilePairingApproval.js';
import { ScenarioMatrix, check, expectEqual, hostResolverRules, newRunId, sendTemplate } from './documents-live-proof-lib.js';

const FEATURE_ID = 'document-decisions';
const AUTH = `proof-${crypto.randomBytes(8).toString('hex')}`;
const PROJECT = 'decisionsproof';
const PIN = String(100000 + crypto.randomInt(899999));
const HOSTS = { a: 'docs-a.proof.test', b: 'docs-b.proof.test' } as const;
const VIEWPORTS = { narrow: { width: 390, height: 844 }, wide: { width: 1280, height: 728 } } as const;
type Vp = keyof typeof VIEWPORTS;

const runRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'doc-decisions-proof-'));
const shotDir = path.join(runRoot, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
const cleanup: Array<() => Promise<void> | void> = [];
const log = (s: string): void => { process.stdout.write(`${s}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rid = (): string => `${Date.now()}-${crypto.randomUUID()}`;
const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ── Playwright (local dependency, else the global install) ─────────────────────────────────────

async function loadPlaywright(): Promise<typeof import('playwright')> {
  try { return await import('playwright'); } catch { /* not a local dependency */ }
  if (process.env.PLAYWRIGHT_PATH) return createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH) as typeof import('playwright');
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(path.join(root, 'noop.js'));
  return req(path.join(root, 'playwright')) as typeof import('playwright');
}

// ── small HTTP client (the phone and the agent talk to the server's real port) ─────────────────

interface HttpResult { status: number; body: any; text: string; headers: http.IncomingHttpHeaders }

function httpCall(port: number, method: string, p: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(opts.body)) } : {}), ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = null;
        try { body = JSON.parse(text); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout ${method} ${p}`)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const port = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// ── TLS front: ends TLS on loopback and pipes bytes to the agent, as cloudflared does ───────────

function makeCert(dir: string): { key: string; cert: string } {
  const keyPath = path.join(dir, 'tls-key.pem'); const certPath = path.join(dir, 'tls-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${HOSTS.a}`, '-addext', `subjectAltName=DNS:${HOSTS.a},DNS:${HOSTS.b}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') };
}

async function tlsFront(target: number, cert: { key: string; cert: string }): Promise<{ port: number; close: () => void }> {
  const port = await freePort();
  const sockets = new Set<net.Socket>();
  const srv = tls.createServer({ key: cert.key, cert: cert.cert }, (client) => {
    const upstream = net.connect(target, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    const end = (): void => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
  return { port, close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}

// ── throwaway machines ──────────────────────────────────────────────────────────────────────────

const pem = (k: string): string => k.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

interface Delivered { via: 'spawn' | 'inject'; text: string; at: number }

interface Machine {
  name: 'a' | 'b';
  host: string;
  stateDir: string;
  port: number;
  front: number;
  identity: { machineId: string };
  signing: { privateKey: string; publicKey: string };
  server: AgentServer;
  memoryPrivacy: MemoryPrivacy;
  dms: string[];
  delivered: Delivered[];
  sessionManager: any;
}

function machineFiles(name: 'a' | 'b') {
  const dir = path.join(runRoot, `machine-${name}`);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'machine']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  const mgr = new MachineIdentityManager(stateDir);
  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();
  const identity = {
    machineId: generateMachineId(), signingPublicKey: pem(signing.publicKey), encryptionPublicKey: pem(encryption.publicKey), name: `proof-${name}`,
    platform: `${os.platform()}-${os.arch()}`, createdAt: new Date().toISOString(), capabilities: ['sessions'] as string[],
  };
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(stateDir, 'machine', 'signing-private.pem'), signing.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, 'machine', 'encryption-private.pem'), encryption.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as never, name === 'a' ? 'awake' : 'standby');
  return { dir, stateDir, mgr, identity, signing };
}

async function bootMachine(files: ReturnType<typeof machineFiles>, name: 'a' | 'b', peers: () => Array<{ machineId: string; url: string; kind: 'lan' }>, cert: { key: string; cert: string }): Promise<Machine> {
  const port = await freePort();
  const host = HOSTS[name];
  const config = {
    projectName: PROJECT, projectDir: files.dir, stateDir: files.stateDir, port, host: '127.0.0.1', authToken: AUTH, developmentAgent: true,
    dashboardPin: PIN, documents: { enabled: true }, memoryPrivacy: { enabled: true },
    mobilePairing: { multiRoute: { enabled: false } }, tunnel: { enabled: true, type: 'named', token: 'proof-not-a-real-token', hostname: host },
    sessions: { claudePath: '/usr/bin/true', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, threadline: { ownerName: 'Ann' },
    requestTimeoutMs: 30_000, version: '0.0.0-proof',
  } as unknown as InstarConfig;
  const state = new StateManager(files.stateDir);
  const coordinator = new MultiMachineCoordinator(state, { stateDir: files.stateDir });
  coordinator.start();
  cleanup.push(() => coordinator.stop());
  const delivered: Delivered[] = [];
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async (message: string) => { delivered.push({ via: 'spawn', text: String(message), at: Date.now() }); return `proof-session-${delivered.length}`; };
  sessionManager.injectMessage = (_s: string, message: string) => { delivered.push({ via: 'inject', text: String(message), at: Date.now() }); return true; };
  sessionManager.memoryPrivacyStatus = () => ({ enabled: true, sandboxReady: true, multiPerson: true, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (_ref: string, change: () => unknown) => change();
  const memoryPrivacy = new MemoryPrivacy({ stateDir: files.stateDir, instarRoot: path.join(files.dir, 'instar-root'), agentId: PROJECT, config: () => ({ enabled: true }), users: () => [], reachable: () => ({}) });
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${host}`, on: () => undefined } as any;
  const server = new AgentServer({
    config, sessionManager, state, initiativeTracker: new InitiativeTracker(files.stateDir), tunnel, coordinator,
    localSigningKeyPem: files.signing.privateKey, resolvePeerUrls: peers, memoryPrivacy,
  } as never);
  await server.start();
  cleanup.push(async () => { await server.stop(); });
  const dms: string[] = [];
  const svc = server.mobilePairing!;
  // The pairing service checks its own origin answers; here that origin is this server's own port.
  svc.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await httpCall(port, 'GET', u.pathname + u.search, { headers: { Host: host } });
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  svc.deps.ownerDM = async (text: string) => { dms.push(text); return 1; };
  svc.deps.telegramOwnerPresent = () => true;
  const front = await tlsFront(port, cert);
  cleanup.push(() => front.close());
  return { name, host, stateDir: files.stateDir, port, front: front.port, identity: files.identity, signing: files.signing, server, memoryPrivacy, dms, delivered, sessionManager };
}

// ── phones (throwaway P-256 keys signing as the app does) ──────────────────────────────────────

let deviceClock = Date.now();
class Phone {
  constructor(readonly m: Machine, readonly id: string, readonly dev: ReturnType<typeof makeDevice>, readonly label: string) {}
  call(method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown): Promise<HttpResult> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const time = String(Math.max(++deviceClock, Date.now()));
    deviceClock = Number(time);
    const sig = this.dev.sign(canonicalString(this.id, this.m.host, method, p, time, raw === undefined ? undefined : Buffer.from(raw)));
    return httpCall(this.m.port, method, p, { body: raw, headers: { Host: this.m.host, 'X-Instar-Device': this.id, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': sig } });
  }
  /** An instar-docpage-v1 write (or open) signed by this phone's device key (app contract item 2). */
  docpage(target: Machine, docId: string, op: string, payload: Record<string, unknown>, body: unknown = {}, requestId = rid()): Promise<HttpResult> {
    return docpageCall(target, this.id, this.dev.sign, docId, op, payload, body, requestId);
  }
}

function docpageCall(target: Machine, deviceId: string, signer: (m: string) => string, docId: string, op: string, payload: Record<string, unknown>, body: unknown, requestId: string): Promise<HttpResult> {
  const timeMs = String(Date.now());
  const msg = docpageString(deviceId, target.host, docId, op as never, requestId, timeMs, payload);
  const p = op === 'open' ? `/docs/${docId}/session` : `/docs/${docId}/w/${op}`;
  return httpCall(target.port, 'POST', p, { body: JSON.stringify(body), headers: {
    Host: target.host, 'X-Instar-Request': '1', 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': timeMs, 'X-Instar-Request-Id': requestId,
    'X-Instar-Docpage-Sig': signer(msg), 'X-Instar-Docpage-Payload': Buffer.from(canonicalJson(payload)).toString('base64url'),
  } });
}

const bearer = (m: Machine, method: 'GET' | 'POST', p: string, body?: unknown): Promise<HttpResult> =>
  httpCall(m.port, method, p, { body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': PROJECT, Host: m.host } });
const session = (m: Machine, token: string, method: 'GET' | 'POST', p: string, body?: unknown): Promise<HttpResult> =>
  httpCall(m.port, method, p, { body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, Host: m.host } });

async function pairOwner(m: Machine): Promise<Phone> {
  const code = await bearer(m, 'POST', '/mobile/pairing-codes', {});
  check(code.status === 200, 'owner pairing code minted', { status: code.status, body: code.body });
  const dev = makeDevice();
  const r = await httpCall(m.port, 'POST', '/mobile/pairing-codes/redeem', { headers: { Host: m.host }, body: JSON.stringify({ code: code.body.code, deviceName: 'Ann phone', devicePublicKey: dev.publicKey }) });
  check(r.status === 200, 'owner phone redeemed', { status: r.status, body: r.body });
  const phone = new Phone(m, r.body.deviceId, dev, 'owner phone');
  const dm = m.dms.find((t) => /is (\d{3}) (\d{3})\./.test(t));
  check(dm, 'owner confirm code sent by DM', { dms: m.dms });
  const confirm = await phone.call('POST', '/mobile/device/confirm', { code: /is (\d{3}) (\d{3})\./.exec(dm!)!.slice(1).join('') });
  check(confirm.body?.status === 'active', 'owner phone active', { body: confirm.body });
  return phone;
}

async function pairMember(m: Machine, owner: Phone, personKey: string, link: string, label: string): Promise<Phone> {
  const c = new URLSearchParams(String(link).split('#')[1]).get('c');
  const dev = makeDevice();
  const r = await httpCall(m.port, 'POST', '/mobile/pairing-codes/redeem', { headers: { Host: m.host }, body: JSON.stringify({ code: c, deviceName: label, devicePublicKey: dev.publicKey, appCaps: ['standing'] }) });
  check(r.status === 200, `${personKey} phone redeemed`, { status: r.status, body: r.body });
  const phone = new Phone(m, r.body.deviceId, dev, label);
  const waiting = await owner.call('GET', `/mobile/team/invites/${personKey}`);
  const code = waiting.body?.waiting?.[0]?.code;
  check(typeof code === 'string', `${personKey} code held for the owner`, { body: waiting.body });
  const ok = await phone.call('POST', '/mobile/device/confirm', { code: code.replace(/\s/g, '') });
  check(ok.body?.status === 'active', `${personKey} phone active`, { body: ok.body });
  return phone;
}

// ── the page in Chromium ───────────────────────────────────────────────────────────────────────

type Browser = import('playwright').Browser;
type Page = import('playwright').Page;
type Context = import('playwright').BrowserContext;

interface Tab { vp: Vp; ctx: Context; page: Page; consoleErrors: string[]; cspViolations: string[] }

async function openTab(browser: Browser, vp: Vp): Promise<Tab> {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], ignoreHTTPSErrors: true, ...(vp === 'narrow' ? { deviceScaleFactor: 3, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const consoleErrors: string[] = []; const cspViolations: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') { consoleErrors.push(m.text()); if (/Content Security Policy|Trusted Type/i.test(m.text())) cspViolations.push(m.text()); } });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  cleanup.push(async () => { await ctx.close().catch(() => undefined); });
  return { vp, ctx, page, consoleErrors, cspViolations };
}

const shots: string[] = [];
async function shot(t: Tab, step: string): Promise<string> {
  const file = path.join(shotDir, `${String(shots.length + 1).padStart(2, '0')}-${step}-${t.vp}-${VIEWPORTS[t.vp].width}x${VIEWPORTS[t.vp].height}.png`);
  await t.page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  return path.basename(file);
}

/** Select `phrase` inside the document body as a user would (a real DOM selection), and return whether it was found. */
async function selectPhrase(page: Page, phrase: string): Promise<boolean> {
  return page.evaluate((ph) => {
    const art = document.getElementById('doc-body');
    if (!art) return false;
    // The text may be split across highlight marks: search the concatenated text of all nodes.
    const w = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = []; let all = '';
    let n: Node | null;
    while ((n = w.nextNode())) { nodes.push(n as Text); all += (n as Text).data; }
    const i = all.indexOf(ph);
    if (i < 0) return false;
    // (No named inner functions here: the bundler would wrap them in a helper the page doesn't have.)
    const r = document.createRange();
    let acc = 0; let startSet = false;
    for (const t of nodes) {
      const len = t.data.length;
      if (!startSet && i < acc + len) { r.setStart(t, i - acc); startSet = true; }
      if (startSet && i + ph.length <= acc + len) { r.setEnd(t, i + ph.length - acc); break; }
      acc += len;
    }
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    return true;
  }, phrase);
}

const rateLimitWaits: number[] = [];
async function gotoForNonce(t: Tab, url: string): Promise<import('playwright').Response> {
  const nonceResp = t.page.waitForResponse((r) => r.url().endsWith('/docs/_link/nonce') && r.request().method() === 'POST', { timeout: 20_000 });
  await t.page.goto(url);
  return nonceResp;
}

/** The member's computer, freshly opened on the document: shows the QR code; the phone links it. */
async function linkComputer(t: Tab, m: Machine, docId: string, phone: Phone): Promise<{ nonce: string; key: string; linkStatus: number; linkBody: any; fingerprintShown: string; qrMatches: boolean; deviceId: string }> {
  let resp = await gotoForNonce(t, `https://${m.host}/docs/${docId}`);
  if (resp.status() === 429) {
    // The page's own per-address limit (6 codes a minute; every tab here shares 127.0.0.1): wait it out as a person would.
    rateLimitWaits.push(61_000);
    await sleep(61_000);
    resp = await gotoForNonce(t, `https://${m.host}/docs/${docId}`);
  }
  const answer = await resp.json();
  const key = JSON.parse(resp.request().postData() ?? '{}').browserPublicKey as string;
  try { await t.page.waitForSelector('.link-fingerprint', { timeout: 15_000 }); } catch {
    throw new Error(`no link code shown (nonce answer ${resp.status()} ${JSON.stringify(answer).slice(0, 200)}); the page shows: ${((await t.page.textContent('#doc').catch(() => null)) ?? '').trim().slice(0, 200)}`);
  }
  const fingerprintShown = (await t.page.textContent('.link-fingerprint'))?.trim() ?? '';
  // The QR the page drew carries exactly the payload the phone signs (app contract item 8.6).
  const qrMatches = await t.page.evaluate(async (a) => {
    const M = await import('/docs/_assets/doc-page-model.js');
    const Q = await import('/docs/_assets/qr-code.js');
    const payload = M.linkPayload({ browserPublicKey: a.key, nonce: a.nonce, machineId: a.machineId, host: a.host });
    const want = Q.qrSvg(document, payload, { scale: 4, quiet: 4, label: 'Code to scan with the Instar app' });
    const have = document.querySelector('.link-qr svg');
    return !!have && have.outerHTML === want.outerHTML;
  }, { key, nonce: answer.nonce, machineId: answer.machineId, host: answer.host });
  await shot(t, 'link-qr');
  const link = await phone.call('POST', '/mobile/browsers/link', { browserPublicKey: key, nonce: answer.nonce, machineId: answer.machineId, host: answer.host, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  return { nonce: answer.nonce, key, linkStatus: link.status, linkBody: link.body, fingerprintShown, qrMatches, deviceId: link.body?.id };
}

async function waitForDoc(t: Tab, title: string): Promise<void> {
  try {
    await t.page.waitForFunction((ti) => document.querySelector('.doc-header h1')?.textContent === ti, title, { timeout: 25_000 });
  } catch {
    const shown = ((await t.page.textContent('#doc').catch(() => null)) ?? '').trim().slice(0, 300);
    throw new Error(`the page did not open "${title}" (${t.vp}); it shows: ${shown || '(nothing)'}`);
  }
}

/** Comment through the page's own UI: selection → Comment pill (or C key) → sheet → Post. */
async function commentInPage(t: Tab, phrase: string, text: string, how: 'pill' | 'key'): Promise<void> {
  check(await selectPhrase(t.page, phrase), `phrase found in the rendered page: ${phrase}`);
  if (how === 'pill') {
    await t.page.waitForSelector('button.pill:not([hidden])', { timeout: 5_000 });
    await t.page.click('button.pill');
  } else {
    await sleep(350);
    await t.page.keyboard.press('c');
  }
  await t.page.waitForSelector('.sheet textarea', { timeout: 5_000 });
  await t.page.fill('.sheet textarea', text);
  await t.page.click('.sheet button.btn.primary');
  await t.page.waitForFunction((tx) => Array.from(document.querySelectorAll('.threads .thread .body')).some((n) => n.textContent === tx), text, { timeout: 15_000 });
}

/** Wait for the page notice to read `want`; return what it finally read (so a failure shows the words). */
async function waitNotice(t: Tab, want: string | RegExp, timeout = 20_000): Promise<string> {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = ((await t.page.textContent('#doc-notice').catch(() => null)) ?? '').trim();
    if (typeof want === 'string' ? last === want : want.test(last)) return last;
    await sleep(250);
  }
  return last;
}

async function pageText(t: Tab, sel: string): Promise<string[]> {
  return t.page.$$eval(sel, (ns) => ns.map((n) => (n.textContent ?? '').trim()));
}



/**
 * The owner's computer, set up the way the console does it: a non-extractable key made inside
 * Chromium, the setup request signed by it, approved from the owner's phone with Face ID
 * (approvedVia owner-phone), then stored in the console's own IndexedDB record for this address.
 */
async function ownerComputer(t: Tab, m: Machine, owner: Phone, presence: ReturnType<typeof makeDevice>, docId: string): Promise<{ deviceId: string; approvedVia: string | null }> {
  await t.page.goto(`https://${m.host}/docs/${docId}`);
  await t.page.waitForSelector('#doc', { timeout: 15_000 });
  const enrollmentId = rid(); const timeMs = String(Date.now());
  const made = await t.page.evaluate(async (a) => {
    const bd = await import('/dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    await bd.writeRecord({ machineId: a.machineId, keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey), enrollmentId: a.enrollmentId, status: 'enrolling', createdAt: new Date().toISOString(), deviceName: 'Owner laptop', host: a.host });
    const proof = await bd.signText(keyPair.privateKey, bd.enrollText({ host: a.host, publicKey, enrollmentId: a.enrollmentId, timeMs: a.timeMs }));
    return { publicKey, proof };
  }, { machineId: m.identity.machineId, enrollmentId, timeMs, host: m.host });
  const setup = await httpCall(m.port, 'POST', '/mobile/browser-devices', { headers: { Host: m.host, Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': PROJECT, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ publicKey: made.publicKey, enrollmentId, timeMs, proof: made.proof, deviceName: 'Owner laptop' }) });
  check(setup.status === 201 || setup.status === 202, 'owner computer setup requested', { status: setup.status, body: setup.body });
  const deviceId = setup.body?.deviceId ?? setup.body?.id;
  // The owner's phone sees it waiting and approves it with Face ID.
  let row: any = null;
  for (let i = 0; i < 40 && !row; i++) { const w = await owner.call('GET', '/mobile/pairing-requests'); row = (w.body?.waiting ?? []).find((x: any) => x.deviceId === deviceId); if (!row) await sleep(250); }
  check(row, 'the owner phone sees the computer waiting', { deviceId });
  const ch = await owner.call('POST', `/mobile/pairing-requests/${deviceId}/challenge`, { action: 'approve' });
  check(ch.status === 200, 'approval challenge', { status: ch.status, body: ch.body });
  const line = pairingApproveLine('approve', deviceId, row.fingerprint);
  const ok = await owner.call('POST', `/mobile/pairing-requests/${deviceId}/approve`, { challenge: ch.body.challenge, presenceSig: presence.sign(pairingApproveMessage(owner.id, m.host, ch.body.challenge, line)) });
  check(ok.status === 200, 'the owner phone approved the computer', { status: ok.status, body: ok.body });
  await t.page.evaluate(async (a) => {
    const bd = await import('/dashboard/console/browser-device.js');
    const rec = await bd.readRecord(a.machineId);
    await bd.writeRecord({ ...rec, status: 'active', deviceId: a.deviceId, host: a.host });
  }, { machineId: m.identity.machineId, deviceId, host: m.host });
  return { deviceId, approvedVia: m.server.mobilePairing!.devices.get(deviceId)?.approvedVia ?? null };
}

// ── the phone's decision, exactly as the app makes it (DocDecisionFlow) ────────────────────────

const NO_NOTE = '0'.repeat(64);
async function phoneDecides(m: Machine, owner: Phone, presence: ReturnType<typeof makeDevice>, docId: string, verdict: 'approve' | 'decline', note?: string): Promise<{ status: number; body: any; text: string }> {
  const view = await owner.call('GET', `/mobile/docs/${docId}/decision`);
  check(view.status === 200 && view.body?.canDecide === true, 'the app reads the ask itself and may decide', { status: view.status, body: view.body });
  const salt = crypto.randomBytes(16).toString('hex');
  const noteHash = note ? blobHash(salt, note) : NO_NOTE;
  const fields: Record<string, unknown> = { askId: view.body.ask.askId, onVersion: view.body.version.id, verdict, questionHash: view.body.ask.questionHash, noteHash, supersedes: view.body.decision?.rowKey ?? null };
  const ch = await owner.call('POST', `/mobile/docs/${docId}/decision/challenge`, { ...fields, ...(note ? { note: { salt, text: note } } : {}) });
  check(ch.status === 200, 'challenge bound to the exact answer', { status: ch.status, body: ch.body });
  const line = `docs-decision ${docId} ${fields.askId} ${fields.onVersion} ${verdict} ${fields.questionHash} ${noteHash} ${fields.supersedes ?? '-'}`;
  const presenceSig = presence.sign(permissionPresenceMessage(owner.id, m.host, ch.body.challenge, line));
  const d = await owner.call('POST', `/mobile/docs/${docId}/decision`, { ...fields, challenge: ch.body.challenge, presenceSig });
  check(d.status === 201, 'the decision is recorded', { status: d.status, body: d.body });
  const title = String(view.body.title).replace(/[\r\n]/g, ' ').replace(/"/g, "'");
  const link = `https://${m.host}/docs/${docId}`;
  const text = verdict === 'approve' ? `Approved version ${view.body.version.label} of "${title}": ${link}` : `Declined version ${view.body.version.label} of "${title}": ${link}${note ? ` Note: ${note}` : ''}`;
  return { status: d.status, body: d.body, text };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Document decisions live proof — run folder ${runRoot}`);
  const pw = await loadPlaywright();
  const cert = makeCert(runRoot);
  const fa = machineFiles('a');
  const A = await bootMachine(fa, 'a', () => [], cert);
  check(A.port !== 4042 && A.port !== 4062, 'never a live agent port');
  const browser = await pw.chromium.launch({ headless: process.env.PROOF_HEADED !== '1', args: [`--host-resolver-rules=${hostResolverRules({ [HOSTS.a]: A.front })}`] });
  cleanup.push(async () => { await browser.close().catch(() => undefined); });
  const M = new ScenarioMatrix(log);
  const svcA = A.server.mobilePairing!;
  // The phone's push service, captured: what the page's Approve sends to the phone.
  const pushes: any[] = [];
  (svcA as any).push = { receive: async (t: any) => { pushes.push(t); return 'accepted'; }, status: () => ({}), onHubPost: () => undefined, notifyHere: (t: any) => { pushes.push(t); } };

  const owner = await pairOwner(A);
  const presence = makeDevice();
  svcA.devices.setPresenceKey(owner.id, presence.publicKey);
  const conv = await owner.call('POST', '/mobile/conversations', { title: 'Security', requestId: rid() });
  const convKey = conv.body?.conversationKey as string;
  check(convKey, 'conversation created', { body: conv.body });
  const place = `app:${convKey}`;
  const tok = A.memoryPrivacy.issueSessionToken('proof-security-session', { kind: 'place', placeKey: place }, place);
  const TITLE = 'Secret Drop hardening';
  const MD = '# Secret Drop hardening\n\nCheck the web address, and only a request that proves it holds the owner password may start a session.\n\n## What you need to decide\n\nWhether to ship it.\n';
  let docId = '';
  const tabs: Record<string, Tab> = {};

  await M.run({ id: 'ask', description: 'The agent session asks the owner with decision:{question}; the owner phone is notified; Needs-you lists it', riskCategory: 'happy-path' }, async (e) => {
    const r = await session(A, tok, 'POST', '/docs', { title: TITLE, markdown: MD, decision: { question: 'Ship the Secret Drop hardening?' } });
    expectEqual(r.status, 201, 'create with a question');
    docId = r.body.id;
    const waiting = await bearer(A, 'GET', '/docs/decisions/waiting');
    check(waiting.body?.documents?.some((d: { id: string }) => d.id === docId), 'Needs-you source lists it', { body: waiting.body });
    check(pushes.some((p) => p.decide === true && p.itemId === docId), 'the owner phone was asked', { pushes });
    Object.assign(e, { docId, askId: r.body.askId, url: r.body.url, waiting: waiting.body.documents.length, push: pushes.at(-1) });
  });
  if (!docId) throw new Error('no document; nothing else can run');

  await M.run({ id: 'web-shows-approve', description: "The owner's linked computer shows Approve and Decline on the document at 1280×728 and 390×844, saying the phone confirms", riskCategory: 'happy-path' }, async (e) => {
    for (const vp of ['wide', 'narrow'] as const) {
      const t = tabs[vp] = await openTab(browser, vp);
      const c = await ownerComputer(t, A, owner, presence, docId);
      expectEqual(c.approvedVia, 'owner-phone', `the owner's computer was approved from the phone (${vp})`);
      await t.page.goto(`https://${A.host}/docs/${docId}`);
      await waitForDoc(t, TITLE);
      await t.page.waitForSelector('#doc-decision', { timeout: 15_000 });
      const panel = (await t.page.textContent('#doc-decision'))?.trim() ?? '';
      check(/asks for your decision/.test(panel) && panel.includes('Ship the Secret Drop hardening?'), `panel shows the question (${vp})`, { panel });
      const buttons = await pageText(t, '#doc-decision .decision-actions button');
      check(buttons.includes('Approve') && buttons.includes('Decline'), `Approve and Decline on the document (${vp})`, { buttons });
      check(panel.includes('You confirm on your phone with Face ID.'), `says the phone confirms (${vp})`, { panel });
      e[vp] = { panel, buttons, screenshot: await shot(t, 'asked') };
    }
  });

  let approvedRow = '';
  await M.run({ id: 'web-approve-phone-conversation-document', description: 'Approve on the web page → "Confirm on your phone" → the phone decides with Face ID → the owner message reaches the conversation session → the page shows Approved version 1', riskCategory: 'happy-path' }, async (e) => {
    const t = tabs.wide;
    const before = pushes.length;
    const respP = t.page.waitForResponse((r) => r.url().includes('/w/decide-on-phone'), { timeout: 15_000 }).catch(() => null);
    await t.page.click('#doc-decision button:has-text("Approve")');
    const resp = await respP;
    e.decideOnPhone = resp ? { status: resp.status(), body: await resp.text().catch(() => '') } : null;
    log(`decide-on-phone answered ${JSON.stringify(e.decideOnPhone)}`);
    const notice = await waitNotice(t, /^Confirm on your phone/);
    check(/^Confirm on your phone/.test(notice), 'the page says Confirm on your phone', { notice });
    const push = pushes.slice(before).find((p) => p.decide === 'approve');
    check(push, 'the phone was asked with the verdict Approve', { pushes: pushes.slice(before) });
    e.notice = notice; e.push = push; e.screenshotTapped = await shot(t, 'confirm-on-phone');
    // The phone (the app's own sheet → biometric Face ID → presence-signed decision).
    const d = await phoneDecides(A, owner, presence, docId, 'approve');
    approvedRow = d.body.rowKey;
    const deliveredBefore = A.delivered.length;
    // The app posts the owner's own message through the chat route, with the id derived from the decision.
    const chat = await owner.call('POST', `/mobile/chat/app/${convKey}`, { text: d.text, requestId: d.body.decision.messageRequestId });
    check(chat.status === 200, 'the owner message was accepted by the chat route', { status: chat.status, body: chat.body });
    const end = Date.now() + 15_000;
    while (Date.now() < end && !A.delivered.slice(deliveredBefore).some((x) => x.text.includes('Approved version 1'))) await sleep(200);
    const got = A.delivered.slice(deliveredBefore).find((x) => x.text.includes('Approved version 1'));
    check(got, 'the conversation session received the owner message', { delivered: A.delivered.slice(deliveredBefore) });
    const rec = await owner.call('POST', `/mobile/docs/${docId}/decision/delivered`, { rowKey: d.body.rowKey, requestId: d.body.decision.messageRequestId, text: d.text, sendPath: `/mobile/chat/app/${convKey}` });
    expectEqual(rec.status, 200, 'delivered receipt recorded from the chat record');
    // The page updates by itself (it re-reads after asking the phone).
    await t.page.waitForFunction(() => /Approved by you/.test(document.querySelector('#doc-decision')?.textContent ?? ''), null, { timeout: 30_000 });
    const panel = (await t.page.textContent('#doc-decision'))?.trim() ?? '';
    check(/Approved by you · .* · version 1/.test(panel) && panel.includes('Sent to Security.'), 'the document is marked approved, version 1, sent', { panel });
    const n = tabs.narrow; await n.page.reload(); await waitForDoc(n, TITLE);
    const panelN = (await n.page.textContent('#doc-decision'))?.trim() ?? '';
    check(/Approved by you/.test(panelN), 'phone-width page shows the approval', { panelN });
    const agent = await session(A, tok, 'GET', `/docs/${docId}/decision`);
    check(agent.body?.decision?.verdict === 'approve' && agent.body.decision.versionLabel === 1 && agent.body.decision.delivered === true && agent.body.waitingOnOwner === false, 'the agent reads the owner-signed record', { body: agent.body });
    const waiting = await bearer(A, 'GET', '/docs/decisions/waiting');
    check(!waiting.body?.documents?.some((x: { id: string }) => x.id === docId), 'Needs-you cleared', { body: waiting.body });
    Object.assign(e, { rowKey: d.body.rowKey, chatStatus: chat.status, sessionReceived: got!.text.slice(0, 200), via: got!.via, panelWide: panel, panelNarrow: panelN, agentView: agent.body, screenshotWide: await shot(t, 'approved'), screenshotNarrow: await shot(n, 'approved') });
  });

  await M.run({ id: 'decline-then-new-version-asks-again', description: 'A new question; the owner declines with a note from the phone; the agent revises; the page asks again on version 2', riskCategory: 'happy-path' }, async (e) => {
    const ask = await session(A, tok, 'POST', `/docs/${docId}/decision-ask`, { question: 'Turn it on for the fleet this week?' });
    expectEqual(ask.status, 201, 'new question');
    const d = await phoneDecides(A, owner, presence, docId, 'decline', 'Add the rollback test first.');
    check(d.body.decision.verdict === 'decline' && d.body.decision.note === 'Add the rollback test first.', 'decline with note recorded', { body: d.body });
    const rev = await session(A, tok, 'POST', `/docs/${docId}/versions`, { markdown: MD + '\nRollback test added.\n' });
    expectEqual(rev.status, 201, 'agent revises');
    const t = tabs.wide; await t.page.reload(); await waitForDoc(t, TITLE);
    const panel = (await t.page.textContent('#doc-decision'))?.trim() ?? '';
    check(panel.includes('This version has changes') && panel.includes('Turn it on for the fleet this week?'), 'asks again on the new version', { panel });
    const buttons = await pageText(t, '#doc-decision .decision-actions button');
    check(buttons.includes('Approve'), 'buttons back', { buttons });
    const agent = await session(A, tok, 'GET', `/docs/${docId}/decision`);
    check(agent.body?.waitingOnOwner === true && agent.body.decision.latest === false, 'agent sees it waits on the owner again', { body: agent.body });
    Object.assign(e, { panel, screenshot: await shot(t, 'asked-again-v2'), agentView: agent.body });
  });

  await M.run({ id: 'refusals', description: 'The agent session, the bearer and the linked computer cannot decide; a stale version is refused', riskCategory: 'security' }, async (e) => {
    const asAgent = await session(A, tok, 'POST', `/mobile/docs/${docId}/decision`, {});
    check(asAgent.status >= 400 && asAgent.status < 500, 'agent session refused', { status: asAgent.status });
    const asBearer = await bearer(A, 'POST', `/mobile/docs/${docId}/decision`, {});
    check(asBearer.status >= 400 && asBearer.status < 500, 'bearer refused', { status: asBearer.status });
    const rows = (A.server as any).documents.store.rowsOf(docId).filter((r: any) => r.eventKind === 'decision');
    check(rows.every((r: any) => r.actor.type === 'owner-phone' && r.actor.deviceId === owner.id), 'every decision row is the owner phone', { actors: rows.map((r: any) => r.actor.type) });
    Object.assign(e, { agentStatus: asAgent.status, bearerStatus: asBearer.status, decisionRows: rows.length, approvedRow });
  });

  const consoleErrors = Object.fromEntries(Object.entries(tabs).map(([k, t]) => [k, t.consoleErrors]));
  log(`console errors: ${JSON.stringify(consoleErrors)}`);
  const store = new LiveTestArtifactStore({ stateDir: A.stateDir } as never);
  try { (store as any).write?.({ featureId: FEATURE_ID, runId: newRunId(), scenarios: (M as any).rows ?? [], screenshots: shots }); } catch { /* the matrix printout is the record */ }
  log(`screenshots: ${shotDir}`);
  const failed = ((M as any).rows ?? []).filter((r: any) => r.verdict !== 'PASS');
  log(failed.length ? `FAILED scenarios: ${failed.map((r: any) => r.id).join(', ')}` : 'ALL SCENARIOS PASS');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { log(`proof aborted: ${err instanceof Error ? err.stack : String(err)}`); process.exitCode = 1; })
  .finally(async () => { for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } } if (process.env.PROOF_CLEAN === '1') SafeFsExecutor.safeRmSync(runRoot, { recursive: true, force: true, operation: 'scripts/document-decisions-live-proof.ts' }); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
