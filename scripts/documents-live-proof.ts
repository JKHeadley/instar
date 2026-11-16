/**
 * Instar Documents — live user-role proof runner (docs/specs/instar-document-viewer.md §10,
 * docs/specs/live-user-channel-proof-standard.md §4.4–4.6).
 *
 * Run (from the repo root; needs Playwright's Chromium, global or local):
 *
 *     npx tsx scripts/documents-live-proof.ts
 *
 * Options (env): PROOF_CLEAN=1 removes the run folder afterwards (screenshots and the signed artifact are
 * copied out first); by default the whole folder, with both throwaway agents' state, is kept for review.
 * PROOF_HEADED=1 shows the browser.
 *
 * What it does:
 *   - boots TWO throwaway AgentServers (machine A awake, machine B standby) on random loopback ports,
 *     each with its own temp state folder, its own machine identity, documents + team access + phone
 *     pairing + linked computers on, and NO Telegram (owner messages are captured in memory);
 *   - puts a TLS front in front of each (the same shape as cloudflared ending TLS on loopback), and
 *     maps each machine's named-tunnel hostname to it inside Chromium, so the page is opened at its
 *     real https origin (`https://docs-a.proof.test/docs/<id>`);
 *   - pairs the owner's phone and invites a member, a guest and an outsider through the real pairing
 *     and team routes, with throwaway P-256 phone keys signing exactly as the app does;
 *   - drives the REAL document page in headless Chromium at 390×844 and 1280×728: the member links each
 *     browser by the page's QR nonce, selects a passage, comments, Sends, sees the agent's reply and new
 *     version, compares, resolves; the agent side uses a confined session token for the conversation;
 *   - records every §10 scenario as a ScenarioRow (surface 'dashboard') with HTTP statuses, row ids,
 *     message ids and rendered DOM text, a screenshot per viewport per key step, and writes the signed
 *     artifact with LiveTestArtifactStore into machine A's state folder.
 * Scenarios that cannot run here (the iOS app, a real named tunnel, a real phone) are BLOCKED rows with
 * the reason; nothing is ever marked PASS without its evidence.
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
import { ScenarioMatrix, check, expectEqual, hostResolverRules, newRunId, sendTemplate } from './documents-live-proof-lib.js';

const FEATURE_ID = 'instar-document-viewer';
const AUTH = `proof-${crypto.randomBytes(8).toString('hex')}`;
const PROJECT = 'docsproof';
const AGENT_NAME = 'Docsproof';
const PIN = String(100000 + crypto.randomInt(899999));
const HOSTS = { a: 'docs-a.proof.test', b: 'docs-b.proof.test' } as const;
const VIEWPORTS = { narrow: { width: 390, height: 844 }, wide: { width: 1280, height: 728 } } as const;
type Vp = keyof typeof VIEWPORTS;

const runRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'docs-live-proof-'));
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

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Instar Documents live proof — run folder ${runRoot}`);
  const pw = await loadPlaywright();
  const cert = makeCert(runRoot);
  const fa = machineFiles('a'); const fb = machineFiles('b');
  fa.mgr.registerMachine(fb.identity as never, 'standby'); fa.mgr.storeRemoteIdentity(fb.identity as never);
  fb.mgr.registerMachine(fa.identity as never, 'awake'); fb.mgr.storeRemoteIdentity(fa.identity as never);
  const urls: Record<string, string> = {};
  const A = await bootMachine(fa, 'a', () => [{ machineId: fb.identity.machineId, url: urls.b, kind: 'lan' }], cert);
  urls.a = `http://127.0.0.1:${A.port}`;
  const B = await bootMachine(fb, 'b', () => [{ machineId: fa.identity.machineId, url: urls.a, kind: 'lan' }], cert);
  urls.b = `http://127.0.0.1:${B.port}`;
  // Both machines run in this one process, and the linked-computer send check is a module-level hook
  // that each server sets at boot (B last). In production each machine is its own process; the
  // phones and computers in this run talk to A, so point the hook back at A's own check.
  setDocumentScopedSend((d, p, raw) => (A.server as unknown as { documentScopedSendOk(d: unknown, p: string, r: Buffer | undefined): boolean }).documentScopedSendOk(d, p, raw));
  log(`machine A ${A.identity.machineId} on :${A.port} (https front :${A.front}), machine B ${B.identity.machineId} on :${B.port} (https front :${B.front})`);
  check(A.port !== 4062 && B.port !== 4062, 'never the live agent port');

  const browser = await pw.chromium.launch({ headless: process.env.PROOF_HEADED !== '1', args: [`--host-resolver-rules=${hostResolverRules({ [HOSTS.a]: A.front, [HOSTS.b]: B.front })}`] });
  cleanup.push(async () => { await browser.close().catch(() => undefined); });

  const M = new ScenarioMatrix(log);
  const svcA = A.server.mobilePairing!; const svcB = B.server.mobilePairing!;

  // ── people: owner, Mia (member, in the conversation), Gus (guest, in it), Sam (member, outside it) ──
  const owner = await pairOwner(A);
  svcA.devices.setPresenceKey(owner.id, makeDevice().publicKey);
  const sharedConv = await owner.call('POST', '/mobile/conversations', { title: 'Client work', requestId: rid() });
  const otherConv = await owner.call('POST', '/mobile/conversations', { title: 'Sam project', requestId: rid() });
  const shared = sharedConv.body?.conversationKey as string; const other = otherConv.body?.conversationKey as string;
  check(shared && other, 'conversations created', { shared: sharedConv.body, other: otherConv.body });
  const invite = await owner.call('POST', '/mobile/team/invites', { events: [
    { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
    { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }, { type: 'grant', personKey: 'mia', ref: shared, access: 'use' },
  ] });
  check(invite.status === 200, 'Mia invited', { status: invite.status, body: invite.body });
  const mia = await pairMember(A, owner, 'mia', invite.body.link, 'Mia phone');
  const invG = await owner.call('POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'gus', name: 'Gus', role: 'guest' }, { type: 'grant', personKey: 'gus', ref: shared, access: 'read' }] });
  check(invG.status === 200, 'Gus invited', { status: invG.status, body: invG.body });
  const gus = await pairMember(A, owner, 'gus', invG.body.link, 'Gus phone');
  const invS = await owner.call('POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }, { type: 'grant', personKey: 'sam', ref: other, access: 'use' }] });
  check(invS.status === 200, 'Sam invited', { status: invS.status, body: invS.body });
  const sam = await pairMember(A, owner, 'sam', invS.body.link, 'Sam phone');
  log(`people: owner ${owner.id}, mia ${mia.id}, gus ${gus.id}, sam ${sam.id}; shared conversation ${shared}`);

  // The agent's session in the shared conversation (confined to that place), and one in Sam's.
  const placeShared = `app:${shared}`;
  const tokShared = A.memoryPrivacy.issueSessionToken('proof-shared-session', { kind: 'place', placeKey: placeShared }, placeShared);
  const tokOther = A.memoryPrivacy.issueSessionToken('proof-other-session', { kind: 'place', placeKey: `app:${other}` }, `app:${other}`);

  const MD1 = [
    '# Onboarding plan', '',
    'We welcome every new client with a short call in the first week.', '',
    'The kickoff checklist lives in the shared drive and is reviewed monthly.', '',
    'Invoices go out on the first business day of each month.', '',
    'Support hours are nine to five on weekdays.', '',
  ].join('\n');
  const TITLE = 'Onboarding plan';
  let docId = '';
  let v1 = '';
  const tabs: Record<string, Tab> = {};
  const miaComments: Record<string, string> = {};

  // ═══ Happy path ═══════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'hp-create-in-conversation', description: 'The agent session in the shared conversation creates a document there; it is listed for the conversation and in its session-context block', riskCategory: 'happy-path' }, async (e) => {
    const r = await session(A, tokShared, 'POST', '/docs', { title: TITLE, markdown: MD1 });
    expectEqual(r.status, 201, 'POST /docs from the conversation session');
    docId = r.body.id; v1 = r.body.versionId;
    expectEqual(r.body.url, `https://${HOSTS.a}/docs/${docId}`, 'link is on the named-tunnel origin');
    const list = await session(A, tokShared, 'GET', `/docs?conversation=${placeShared}`);
    check(list.body?.documents?.some((d: { id: string }) => d.id === docId), 'listed in its conversation', { body: list.body });
    const ctx = await session(A, tokShared, 'GET', '/docs/session-context');
    check(String(ctx.body?.text).includes(`/docs/${docId}`), 'session-context names it', { body: ctx.body });
    Object.assign(e, { docId, versionId: v1, createStatus: r.status, url: r.body.url, listStatus: list.status, sessionContext: ctx.body.text });
  });
  if (!docId) throw new Error('document was not created; nothing else can run');

  await M.run({ id: 'hp-link-computer-and-open-both-viewports', description: 'Mia opens the link on two computers (1280×728 and 390×844); each shows the QR code, her phone links it, and the real page opens with the document', riskCategory: 'happy-path' }, async (e) => {
    for (const vp of ['wide', 'narrow'] as const) {
      const t = tabs[`mia-${vp}`] = await openTab(browser, vp);
      const l = await linkComputer(t, A, docId, mia);
      expectEqual(l.linkStatus, 201, `link (${vp})`);
      expectEqual(l.linkBody.scope, 'documents', `scope (${vp})`);
      check(l.qrMatches, `the QR code encodes exactly the nonce, key, machine and host (${vp})`);
      check(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(l.fingerprintShown), 'fingerprint shown', { fingerprint: l.fingerprintShown });
      await waitForDoc(t, TITLE);
      const discussed = await pageText(t, '.doc-header .discussed');
      check(discussed[0] === 'Discussed in: Client work', 'header names the conversation', { discussed });
      const shot1 = await shot(t, 'opened');
      e[`link_${vp}`] = { status: l.linkStatus, deviceId: l.deviceId, fingerprint: l.fingerprintShown, qrMatches: l.qrMatches, header: discussed[0], screenshot: shot1 };
    }
  });

  await M.run({ id: 'hp-comment-select-and-post', description: 'Mia selects a passage and comments through the page: the Comment pill at 1280×728 and the C key at 390×844; each creates exactly one comment row with the server-cut quote', riskCategory: 'happy-path' }, async (e) => {
    const wide = tabs['mia-wide']; const narrow = tabs['mia-narrow'];
    check(wide && narrow, 'both computers linked');
    await commentInPage(wide, 'short call in the first week', 'Can we make it the first two days?', 'pill');
    e.screenshotWide = await shot(wide, 'commented');
    await narrow.page.reload(); await waitForDoc(narrow, TITLE);
    await commentInPage(narrow, 'nine to five on weekdays', 'Clients in Asia need later hours.', 'pill');
    e.screenshotNarrow = await shot(narrow, 'commented');
    const api = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`);
    const cs = api.body?.comments ?? [];
    const c1 = cs.find((c: any) => c.body === 'Can we make it the first two days?');
    const c2 = cs.find((c: any) => c.body === 'Clients in Asia need later hours.');
    check(c1 && c2 && cs.length === 2, 'exactly two comments, by Mia', { comments: cs });
    expectEqual(c1.quote, 'short call in the first week', 'quote 1 cut by the server');
    expectEqual(c2.quote, 'nine to five on weekdays', 'quote 2 cut by the server');
    check(c1.author === 'mia' && c2.author === 'mia', 'authored by Mia', { c1, c2 });
    miaComments.week = c1.key; miaComments.hours = c2.key;
    Object.assign(e, { commentKeys: [c1.key, c2.key], quotes: [c1.quote, c2.quote], authors: [c1.author, c2.author] });
  });

  await M.run({ id: 'cl-comment-labelled-from-computer', description: 'A comment written from a linked computer is labelled "from Mia\'s computer" to people (and originClient browser for the agent)', riskCategory: 'happy-path' }, async (e) => {
    const ownerOpen = await owner.call('POST', `/mobile/docs/${docId}/open`, {});
    expectEqual(ownerOpen.status, 200, 'owner open code');
    const t = tabs['owner-narrow'] = await openTab(browser, 'narrow');
    await t.page.goto(`${ownerOpen.body.url}#code=${ownerOpen.body.code}`);
    await waitForDoc(t, TITLE);
    const cards = await pageText(t, '.threads .thread');
    e.ownerSees = cards; e.screenshot = await shot(t, 'owner-sees-comments');
    const api = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`);
    e.agentFields = Object.keys(api.body?.comments?.[0] ?? {});
    check(cards.some((c) => /from Mia(’|')s computer/.test(c)), 'the owner sees "from Mia\'s computer" on her comment', { cards });
    check((api.body?.comments ?? []).every((c: any) => c.originClient === 'browser'), 'the agent sees originClient: browser', { fields: e.agentFields });
  });

  await M.run({ id: 'hp-send-exactly-one-message', description: 'Send comments from the 1280×728 page: exactly one templated message reaches the conversation and the agent, and both comments show as sent', riskCategory: 'happy-path' }, async (e) => {
    const t = tabs['mia-wide'];
    await t.page.reload(); await waitForDoc(t, TITLE);
    const before = A.delivered.length;
    const btn = `button:has-text("Send comments to ${AGENT_NAME}")`;
    await t.page.waitForSelector(`${btn}:not([disabled])`, { timeout: 10_000 });
    const responses: Array<{ url: string; status: number; body: string }> = [];
    const onResp = async (r: import('playwright').Response): Promise<void> => {
      if (r.request().method() === 'POST' && (r.url().includes('/mobile/chat/') || r.url().includes('/w/send'))) responses.push({ url: new URL(r.url()).pathname, status: r.status(), body: (await r.text().catch(() => '')).slice(0, 300) });
    };
    t.page.on('response', onResp);
    const sentBodies: Array<{ path: string; device: string; body: string }> = [];
    t.page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/mobile/chat/')) sentBodies.push({ path: new URL(r.url()).pathname, device: r.headers()['x-instar-device'] ?? '', body: r.postData() ?? '' }); });
    await t.page.click(btn);
    const notice = await waitNotice(t, `Sent to ${AGENT_NAME}.`);
    t.page.off('response', onResp);
    e.httpResponses = responses; e.notice = notice;
    e.screenshot = await shot(t, 'sent');
    if (notice !== `Sent to ${AGENT_NAME}.`) e.scopedSendDiagnosis = await diagnoseScopedSend(A, t, sentBodies);
    expectEqual(notice, `Sent to ${AGENT_NAME}.`, 'page says it was sent');
    const expectedText = sendTemplate(2, TITLE, 1, `https://${HOSTS.a}`, docId);
    const msgs = await owner.call('GET', `/mobile/chat/app/${shared}/messages`);
    const matching = (msgs.body?.messages ?? []).filter((m: any) => m.text === expectedText);
    expectEqual(matching.length, 1, 'exactly one Send message in the conversation');
    const reached = A.delivered.slice(before).filter((d) => d.text.includes(expectedText));
    expectEqual(reached.length, 1, 'exactly one delivery to the agent session');
    const badges = await pageText(t, '.threads .badges');
    check(badges.length === 2 && badges.every((b) => b === `Sent to ${AGENT_NAME}`), 'both comments marked sent', { badges });
    const sendRows = rowsOf(A, docId).filter((r) => r.includes('"eventKind":"send"')).length;
    expectEqual(sendRows, 1, 'one send row');
    Object.assign(e, { messageIds: matching.map((m: any) => String(m.messageId ?? m.id)), channelId: placeShared, senderId: 'mia', messageText: expectedText, deliveredVia: reached.map((d) => d.via), sendRows, badges });
  });

  let v2 = '';
  await M.run({ id: 'hp-agent-reply-revise-compare-reanchor-resolve', description: 'The agent reads the comments, replies and writes version 2; the page shows the reply, Compare shows the change, the comment is re-anchored, and Mia resolves it', riskCategory: 'happy-path' }, async (e) => {
    const open = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`);
    expectEqual(open.status, 200, 'agent reads comments');
    const reply = await session(A, tokShared, 'POST', `/docs/${docId}/comments/${encodeURIComponent(miaComments.week)}/replies`, { body: 'Done: changed to the first two days.' });
    expectEqual(reply.status, 201, 'agent reply');
    const MD2 = MD1.replace('We welcome every new client with a short call in the first week.', 'A note before anything else: every client gets a named contact.\n\nWe welcome every new client with a short call in the first week, ideally within two days.');
    const rev = await session(A, tokShared, 'POST', `/docs/${docId}/versions`, { markdown: MD2, note: 'Two-day kickoff', addresses: [miaComments.week] });
    expectEqual(rev.status, 201, 'agent revision');
    v2 = rev.body.versionId;
    expectEqual(rev.body.label, 2, 'version 2');
    const t = tabs['mia-wide'];
    await t.page.reload(); await waitForDoc(t, TITLE);
    const replies = await pageText(t, '.threads .entry.reply .body');
    check(replies.includes('Done: changed to the first two days.'), 'reply shown in the page', { replies });
    const versionWords = (await pageText(t, '.version-words'))[0];
    await t.page.click('button:has-text("Compare")');
    await t.page.waitForSelector('.diff-text ins', { timeout: 10_000 });
    const ins = await pageText(t, '.diff-text ins');
    const added = ins.join(' ');
    check(added.includes('named') && added.includes('contact') && added.includes('ideally within two days'), 'Compare shows the added text', { ins });
    e.screenshotCompare = await shot(t, 'compare');
    const after = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`);
    const week = after.body.comments.find((c: any) => c.key === miaComments.week);
    const before = open.body.comments.find((c: any) => c.key === miaComments.week);
    check(week.anchorState === 'ok' && week.start > before.start, 're-anchored onto version 2 (moved down)', { before: { start: before.start }, after: week });
    const marks = await t.page.$$eval(`mark.hl`, (ns) => ns.map((n) => n.getAttribute('data-keys')));
    check(marks.some((k) => (k ?? '').split(' ').includes(miaComments.week)), 'highlight still on the passage in version 2', { marks });
    await t.page.click('button:has-text("Hide changes")');
    const card = t.page.locator(`.threads [data-key="${miaComments.week}"]`);
    await card.locator('button:has-text("Resolve")').click();
    await t.page.waitForSelector('details.resolved', { timeout: 10_000 });
    e.screenshotResolved = await shot(t, 'resolved');
    const resolved = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=resolved`);
    check(resolved.body.comments.some((c: any) => c.key === miaComments.week), 'resolved in the store', { body: resolved.body });
    Object.assign(e, { replyId: reply.body.replyId, versionId: v2, versionWords, insertions: ins, reanchored: { from: before.start, to: week.start, state: week.anchorState }, resolvedKey: miaComments.week });
  });

  // ═══ Channel parity: the same page through the app's code and through a linked computer ════════
  await M.run({ id: 'parity-app-code-vs-linked-computer', description: 'The page opened with an app open code (owner, as the app does) and the page opened by a linked computer render the same document text and comment set', riskCategory: 'channel-parity' }, async (e) => {
    const o = tabs['owner-narrow']; const m = tabs['mia-narrow'];
    const ownerOpen = await owner.call('POST', `/mobile/docs/${docId}/open`, {});
    await o.page.goto('about:blank'); // a hash-only change would not load the page again
    await o.page.goto(`${ownerOpen.body.url}#code=${ownerOpen.body.code}`); await waitForDoc(o, TITLE);
    await m.page.reload(); await waitForDoc(m, TITLE);
    const bodyO = (await pageText(o, '#doc-body')).join(''); const bodyM = (await pageText(m, '#doc-body')).join('');
    expectEqual(bodyO, bodyM, 'same document text');
    const quotesO = (await pageText(o, '.threads .quote')).sort(); const quotesM = (await pageText(m, '.threads .quote')).sort();
    expectEqual(JSON.stringify(quotesO), JSON.stringify(quotesM), 'same comment quotes');
    check(!o.page.url().includes('#code='), 'the app code is removed from the address');
    Object.assign(e, { textSha256: sha256(bodyO), quotes: quotesO, ownerUrl: o.page.url(), screenshotOwner: await shot(o, 'parity-owner'), screenshotMember: await shot(m, 'parity-member') });
  });

  // ═══ Anchors ══════════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'anchor-edited-orphaned-reattach', description: 'Editing a commented passage marks the comment edited; deleting it orphans the comment, which stays listed under "Passage changed or removed" and can be re-attached', riskCategory: 'regression' }, async (e) => {
    // A fresh comment on the invoices line (signed by Mia's phone, as the app's native composer does).
    const page = await pageData(A, mia, docId);
    const proj = projectionOfPage(page);
    const phrase = 'first business day of each month';
    const at = proj.indexOf(phrase);
    check(at >= 0, 'phrase in projection');
    const kInv = await phoneComment(A, mia, docId, page.version.id, at, at + phrase.length, 'Should this be the last day?');
    expectEqual(kInv.status, 201, 'comment');
    const kChk = await phoneComment(A, mia, docId, page.version.id, proj.indexOf('reviewed monthly'), proj.indexOf('reviewed monthly') + 'reviewed monthly'.length, 'Quarterly is enough.');
    expectEqual(kChk.status, 201, 'second comment');
    const cur = (await session(A, tokShared, 'GET', `/docs/${docId}/data`)).body.markdown as string;
    const MD3 = cur.replace('Invoices go out on the first business day of each month.', 'Invoices go out on the second business day of each month.').replace('The kickoff checklist lives in the shared drive and is reviewed monthly.\n\n', '');
    const rev = await session(A, tokShared, 'POST', `/docs/${docId}/versions`, { markdown: MD3, note: 'edit and delete' });
    expectEqual(rev.status, 201, 'revision');
    const cs = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`)).body.comments;
    const inv = cs.find((c: any) => c.key === kInv.body.key); const chk = cs.find((c: any) => c.key === kChk.body.key);
    expectEqual(inv?.anchorState, 'edited', 'edited passage');
    expectEqual(chk?.anchorState, 'orphaned', 'deleted passage');
    const t = tabs['mia-wide'];
    await t.page.reload(); await waitForDoc(t, TITLE);
    const sub = await pageText(t, '.threads .threads-sub');
    const notes = await pageText(t, '.threads .anchor-note');
    check(sub.includes('Passage changed or removed'), 'orphaned section shown', { sub });
    check(notes.includes('The passage this comment was on was removed') && notes.includes('The passage changed since this comment'), 'anchor notes shown', { notes });
    e.screenshot = await shot(t, 'anchors');
    // Re-attach the orphaned comment to a passage of the newest version (its author, signed).
    const p2 = await pageData(A, mia, docId);
    const proj2 = projectionOfPage(p2);
    const s = proj2.indexOf('Support hours');
    const re = await mia.docpage(A, docId, 'reanchor', { docId, commentKey: kChk.body.key, onVersion: p2.version.id, start: s, end: s + 'Support hours'.length });
    expectEqual(re.status, 200, 're-attach');
    const cs2 = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`)).body.comments;
    const chk2 = cs2.find((c: any) => c.key === kChk.body.key);
    check(chk2.anchorState === 'ok' && chk2.quote === 'Support hours', 're-attached', { chk2 });
    Object.assign(e, { editedKey: kInv.body.key, orphanedKey: kChk.body.key, states: { edited: inv.anchorState, orphaned: chk.anchorState, reattached: chk2.anchorState }, reanchorStatus: re.status, pageSections: sub, pageNotes: notes });
  });

  await M.run({ id: 'anchor-fabricated-quote-refused', description: 'A comment whose position is not in the signed version (a fabricated quote) is refused 422; an unknown version is refused; nothing is stored', riskCategory: 'failure-rollback' }, async (e) => {
    const page = await pageData(A, mia, docId);
    const n = projectionOfPage(page).length;
    const rowsBefore = rowsOf(A, docId).length;
    const far = await phoneComment(A, mia, docId, page.version.id, n + 10, n + 40, 'Fabricated');
    const bad = await phoneComment(A, mia, docId, crypto.randomUUID(), 0, 5, 'Unknown version');
    expectEqual(far.status, 422, 'position outside the version');
    expectEqual(far.body?.error, 'quote-not-in-document', 'error code');
    check(bad.status === 404 || bad.status === 422, 'unknown version refused', { status: bad.status, body: bad.body });
    expectEqual(rowsOf(A, docId).length, rowsBefore, 'no row written');
    Object.assign(e, { fabricated: { status: far.status, error: far.body?.error }, unknownVersion: { status: bad.status, error: bad.body?.error }, rows: rowsBefore });
  });

  // ═══ Permission ══════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'perm-guest-reads-not-comments', description: 'Gus (guest) reads the page but gets no comment control, and a signed comment from his phone is refused', riskCategory: 'permission-volatile' }, async (e) => {
    const open = await gus.call('POST', `/mobile/docs/${docId}/open`, {});
    expectEqual(open.status, 200, 'guest open code');
    const t = tabs['gus-wide'] = await openTab(browser, 'wide');
    await t.page.goto(`${open.body.url}#code=${open.body.code}`);
    await waitForDoc(t, TITLE);
    await selectPhrase(t.page, 'Support hours');
    await sleep(500);
    const pillVisible = await t.page.$('button.pill:not([hidden])');
    const hint = await pageText(t, '.hint');
    const pd = await pageData(A, gus, docId);
    const c = await phoneComment(A, gus, docId, pd.version.id, 0, 5, 'Guest comment');
    check(!pillVisible && hint.length === 0, 'no Comment control for a guest', { hint });
    expectEqual(pd.me.canComment, false, 'canComment false');
    check(c.status === 404 || c.status === 403, 'guest comment refused', { status: c.status, body: c.body });
    Object.assign(e, { openStatus: open.status, canComment: pd.me.canComment, commentStatus: c.status, commentError: c.body?.error, screenshot: await shot(t, 'guest') });
  });

  await M.run({ id: 'perm-outsider-404-everywhere', description: 'Sam (member outside the conversation) gets 404/nothing on the page, the list, the graph, session-context and a forwarded URL', riskCategory: 'permission-volatile' }, async (e) => {
    const summary = await sam.call('GET', `/mobile/docs/${docId}/summary`);
    const open = await sam.call('POST', `/mobile/docs/${docId}/open`, {});
    const list = await sam.call('GET', `/mobile/docs?conversation=${placeShared}`);
    const openSigned = await sam.docpage(A, docId, 'open', { docId });
    let pageDataStatus: number | null = null;
    if (openSigned.status === 200) {
      const cookie = String(openSigned.headers['set-cookie']?.[0] ?? '').split(';')[0];
      pageDataStatus = (await httpCall(A.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: A.host, Cookie: cookie } })).status;
    }
    const graphOther = await session(A, tokOther, 'GET', `/docs/graph?from=doc:${docId}`);
    const dataOther = await session(A, tokOther, 'GET', `/docs/${docId}/data`);
    const ctxOther = await session(A, tokOther, 'GET', `/docs/session-context?conversation=${placeShared}`);
    const listOther = await session(A, tokOther, 'GET', `/docs?conversation=${placeShared}`);
    // A forwarded URL in Sam's (unlinked) browser: the page offers to link, shows no document text.
    const t = await openTab(browser, 'narrow');
    await t.page.goto(`https://${A.host}/docs/${docId}`);
    await t.page.waitForSelector('.link-computer, .page-message', { timeout: 15_000 });
    const pageShown = (await t.page.textContent('#doc')) ?? '';
    e.screenshot = await shot(t, 'forwarded-url');
    const leaks = [summary, open, list, graphOther, dataOther, ctxOther, listOther].filter((r) => r.text.includes(docId) || r.text.includes(TITLE));
    Object.assign(e, { summary: summary.status, open: open.status, list: { status: list.status, body: list.body }, signedOpen: openSigned.status, pageData: pageDataStatus, graphFromOtherPlace: graphOther.status, dataFromOtherPlace: dataOther.status, sessionContextOtherPlace: { status: ctxOther.status, text: ctxOther.body?.text ?? null }, listOtherPlace: listOther.body, forwardedUrlShowsText: pageShown.includes('short call') });
    expectEqual(summary.status, 404, 'summary');
    expectEqual(open.status, 404, 'open');
    check(list.status === 404 || (list.status === 200 && !list.text.includes(docId)), 'list', { list: list.body });
    check(openSigned.status !== 200 || pageDataStatus === 404, 'page data with a signed open', { openSigned: openSigned.status, pageDataStatus });
    expectEqual(graphOther.status, 404, 'graph from another place');
    expectEqual(dataOther.status, 404, 'data from another place');
    check(leaks.length === 0, 'no response names the document', { leaks: leaks.map((l) => l.text.slice(0, 200)) });
    check(!pageShown.includes('short call'), 'forwarded URL shows no document text');
  });

  await M.run({ id: 'perm-owner-reach-metadata-only', description: 'An owner-reach caller (the bearer token, no session) gets the document\'s metadata but not its text or comment text', riskCategory: 'permission-volatile' }, async (e) => {
    const d = await bearer(A, 'GET', `/docs/${docId}/data`);
    const c = await bearer(A, 'GET', `/docs/${docId}/comments?status=all`);
    Object.assign(e, { dataStatus: d.status, metadataOnly: d.body?.metadataOnly ?? null, commentsStatus: c.status });
    check(d.body?.metadataOnly === true && !d.text.includes('short call'), 'metadata only', { body: d.body });
    check(c.status === 404 && !c.text.includes('Clients in Asia'), 'no comment text', { status: c.status });
  });

  await M.run({ id: 'perm-revocation-stops-next-request', description: 'Removing Gus\'s grant stops his open page on its next request (page data 404) without a restart', riskCategory: 'permission-volatile' }, async (e) => {
    const open = await gus.call('POST', `/mobile/docs/${docId}/open`, {});
    const sess = await httpCall(A.port, 'POST', `/docs/${docId}/session`, { headers: { Host: A.host, 'X-Instar-Request': '1' }, body: JSON.stringify({ code: open.body.code }) });
    const cookie = String(sess.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const before = await httpCall(A.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: A.host, Cookie: cookie } });
    const lowered = await bearer(A, 'POST', '/team/people/gus/lower', { ref: shared });
    const after = await httpCall(A.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: A.host, Cookie: cookie } });
    const t = tabs['gus-wide'];
    await t.page.reload();
    await t.page.waitForSelector('.page-message', { timeout: 15_000 });
    const words = (await t.page.textContent('.page-message')) ?? '';
    Object.assign(e, { before: before.status, lower: lowered.status, after: after.status, afterError: after.body?.error, pageWords: words.trim(), screenshot: await shot(t, 'guest-revoked') });
    expectEqual(before.status, 200, 'before');
    expectEqual(lowered.status, 200, 'lower');
    expectEqual(after.status, 404, 'next request after revocation');
    check(!words.includes('short call'), 'page shows no text after revocation', { words });
  });

  await mspScenario(M, A, owner, docId);

  // ═══ Idempotency ═════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'idem-double-comment-retried-send', description: 'A double-tapped comment (same comment id, two requests) makes one row; a retried Send (same batch id) makes one message and one send row', riskCategory: 'idempotency' }, async (e) => {
    const page = await pageData(A, mia, docId);
    const proj = projectionOfPage(page);
    const s = proj.indexOf('Invoices go out');
    const commentId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const text = 'Double tap check.';
    const payload = { docId, commentId, onVersion: page.version.id, start: s, end: s + 'Invoices go out'.length, bodyHash: blobHash(salt, text) };
    const rows0 = rowsOf(A, docId).length;
    const [r1, r2] = await Promise.all([mia.docpage(A, docId, 'comment', payload, { blobs: [{ salt, text }] }), mia.docpage(A, docId, 'comment', payload, { blobs: [{ salt, text }] })]);
    const rows1 = rowsOf(A, docId).length;
    check(r1.status === 201 && r2.status === 201 && r1.body.key === r2.body.key, 'both answered with the same key', { r1: r1.body, r2: r2.body });
    expectEqual(rows1 - rows0, 1, 'one comment row for two taps');
    // Send twice with the same batch: chat route twice with one requestId, send row twice.
    const sum = await mia.call('GET', `/mobile/docs/${docId}/summary`);
    const batchId = rid();
    const textMsg = sendTemplate(sum.body.myOpenComments, TITLE, sum.body.version, `https://${HOSTS.a}`, docId);
    const m1 = await mia.call('POST', `/mobile/chat/app/${shared}`, { text: textMsg, requestId: batchId });
    const m2 = await mia.call('POST', `/mobile/chat/app/${shared}`, { text: textMsg, requestId: batchId });
    const keysHash = sha256(canonicalJson([...sum.body.myOpenCommentKeys].sort()));
    const sp = { docId, batchId, commentKeysHash: keysHash, primaryRow: sum.body.primary.primaryRow, messageRequestId: batchId };
    const s1 = await mia.docpage(A, docId, 'send', sp);
    const s2 = await mia.docpage(A, docId, 'send', sp);
    const msgs = await owner.call('GET', `/mobile/chat/app/${shared}/messages`);
    const same = (msgs.body?.messages ?? []).filter((m: any) => m.text === textMsg);
    const sendRows = rowsOf(A, docId).filter((r) => r.includes(batchId) && r.includes('"eventKind":"send"')).length;
    Object.assign(e, { commentKey: r1.body.key, commentRowsAdded: rows1 - rows0, chat: [m1.status, m2.status], sendRow: [s1.status, s2.status], messageIds: same.map((m: any) => String(m.messageId ?? m.id)), sendRows });
    check(m1.status >= 200 && m1.status < 300 && m2.status >= 200 && m2.status < 300, 'both chat posts answered', { m1: m1.body, m2: m2.body });
    expectEqual(same.length, 1, 'one message for the retried Send');
    check(s1.status === 201 && s2.status === 201, 'send row answered twice', { s1: s1.body, s2: s2.body });
    expectEqual(sendRows, 1, 'one send row for the retried Send');
  });

  // ═══ Concurrency ═════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'concurrency-two-computers-comment-at-once', description: 'Mia\'s two computers post comments at the same moment through the page; both are stored with distinct keys and both pages show both', riskCategory: 'concurrency' }, async (e) => {
    const w = tabs['mia-wide']; const n = tabs['mia-narrow'];
    await Promise.all([w.page.reload(), n.page.reload()]);
    await Promise.all([waitForDoc(w, TITLE), waitForDoc(n, TITLE)]);
    const before = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`)).body.comments.length;
    await Promise.all([commentInPage(w, 'Support hours are nine', 'Concurrent from the big screen.', 'pill'), commentInPage(n, 'second business day', 'Concurrent from the small screen.', 'pill')]);
    const cs = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=open`)).body.comments;
    const a = cs.find((c: any) => c.body === 'Concurrent from the big screen.'); const b = cs.find((c: any) => c.body === 'Concurrent from the small screen.');
    check(a && b && a.key !== b.key && cs.length === before + 2, 'two distinct comments', { before, after: cs.length });
    await w.page.reload(); await waitForDoc(w, TITLE);
    const bodies = await pageText(w, '.threads .thread .body');
    check(bodies.includes('Concurrent from the small screen.'), 'the other computer\'s comment shows', { bodies });
    Object.assign(e, { keys: [a.key, b.key], countBefore: before, countAfter: cs.length, screenshot: await shot(w, 'concurrent') });
  });

  // ═══ Multi-machine (before any computer is forgotten or person removed) ═══════════════════════
  await multiMachine(M, A, B, svcA, svcB, owner, tokShared, browser, docId, shared);

  // ═══ Lifecycle: the read cookie expires ═══════════════════════════════════════════════════════
  await M.run({ id: 'lifecycle-cookie-expired-reopens', description: 'When the page\'s read cookie is gone (expired), a linked computer re-opens the document with its own key, without being linked again', riskCategory: 'lifecycle' }, async (e) => {
    const t = tabs['mia-wide'];
    await t.page.goto(`https://${A.host}/docs/${docId}`); await waitForDoc(t, TITLE);
    await t.ctx.clearCookies();
    const opens: number[] = [];
    const onResp = (r: import('playwright').Response): void => { if (r.url().endsWith(`/docs/${docId}/session`) && r.request().method() === 'POST') opens.push(r.status()); };
    t.page.on('response', onResp);
    await t.page.reload(); await waitForDoc(t, TITLE);
    t.page.off('response', onResp);
    const qrShown = await t.page.$('.link-qr');
    Object.assign(e, { signedOpenStatuses: opens, qrShownAgain: !!qrShown, title: (await pageText(t, '.doc-header h1'))[0], screenshot: await shot(t, 'reopened-after-cookie-loss') });
    check(opens.includes(200) && !qrShown, 'reopened with its key, no new link', { opens });
  });

  // ═══ Failure ═════════════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'fail-message-send-fails-no-send-row', description: 'When the chat send fails, no send row is written, the comments stay "Not sent yet" and the page shows the error', riskCategory: 'failure-rollback' }, async (e) => {
    const t = tabs['mia-wide'];
    await t.page.reload(); await waitForDoc(t, TITLE);
    await commentInPage(t, 'nine to five', 'A new comment to send.', 'pill');
    const sendRowsBefore = rowsOf(A, docId).filter((r) => r.includes('"eventKind":"send"')).length;
    await t.page.route('**/mobile/chat/app/**', (r) => r.abort('connectionrefused'));
    await t.page.click(`button:has-text("Send comments to ${AGENT_NAME}")`);
    await t.page.waitForFunction(() => /couldn.t be reached/.test(document.getElementById('doc-notice')?.textContent ?? ''), undefined, { timeout: 15_000 });
    const notice = (await t.page.textContent('#doc-notice'))?.trim();
    e.screenshot = await shot(t, 'send-failed');
    await t.page.unroute('**/mobile/chat/app/**');
    const sendRowsAfter = rowsOf(A, docId).filter((r) => r.includes('"eventKind":"send"')).length;
    await t.page.reload(); await waitForDoc(t, TITLE);
    const badges = await pageText(t, '.threads .badges');
    Object.assign(e, { notice, sendRowsBefore, sendRowsAfter, badges });
    expectEqual(sendRowsAfter, sendRowsBefore, 'no send row');
    check(badges.some((b) => b.includes('Not sent yet')), 'comments show unsent', { badges });
  });

  await M.run({ id: 'fail-conversation-removed-send-disabled', description: 'When the document\'s conversation is removed, the page says so and Send is disabled with that reason', riskCategory: 'failure-rollback' }, async (e) => {
    await conversationRemovedScenario(e, A, owner, mia, browser, tabs, tokShared);
  });

  // ═══ Computer linking ════════════════════════════════════════════════════════════════════════
  await M.run({ id: 'cl-refusals-mismatched-person-and-reused-nonce', description: 'A link is refused for a reused nonce, for another person\'s phone taking a key already linked, and for the owner\'s phone (owners use the console flow)', riskCategory: 'permission-volatile' }, async (e) => {
    const t = await openTab(browser, 'wide');
    let resp = await gotoForNonce(t, `https://${A.host}/docs/${docId}`);
    if (resp.status() === 429) { rateLimitWaits.push(61_000); await sleep(61_000); resp = await gotoForNonce(t, `https://${A.host}/docs/${docId}`); }
    const ans = await resp.json(); e.nonceStatus = resp.status(); const key = JSON.parse(resp.request().postData() ?? '{}').browserPublicKey;
    const body = (over: Record<string, unknown> = {}) => ({ browserPublicKey: key, nonce: ans.nonce, machineId: ans.machineId, host: ans.host, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over });
    const byOwner = await owner.call('POST', '/mobile/browsers/link', body());
    const bySam = await sam.call('POST', '/mobile/browsers/link', body());
    const reuse = await mia.call('POST', '/mobile/browsers/link', body());
    const fpBefore = (await pageText(t, '.link-fingerprint'))[0];
    Object.assign(e, { ownerPhone: { status: byOwner.status, error: byOwner.body?.error }, otherPersonFirst: { status: bySam.status, scope: bySam.body?.scope }, reusedNonce: { status: reuse.status, error: reuse.body?.error }, fingerprint: fpBefore, screenshot: await shot(t, 'link-refusals') });
    expectEqual(byOwner.status, 403, 'owner phone');
    // Sam's phone links it to Sam (his own); the same nonce then can't be used again by anyone.
    expectEqual(bySam.status, 201, 'first scan wins');
    expectEqual(reuse.status, 410, 'reused nonce');
    const forgetSam = await sam.call('POST', `/mobile/browsers/${bySam.body.id}/forget`, {});
    e.cleanupForget = forgetSam.status;
  });

  await M.run({ id: 'cl-forget-and-removal-stop-next-write', description: '"Forget this computer" stops that computer\'s next write; removing the person stops her other computer\'s next write', riskCategory: 'permission-volatile' }, async (e) => {
    const list = await mia.call('GET', '/mobile/browsers');
    const browsers = list.body?.browsers ?? [];
    check(browsers.length === 2, 'two linked computers listed', { browsers });
    const n = tabs['mia-narrow']; const w = tabs['mia-wide'];
    const narrowId = await n.page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('instar-docs', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all: any[] = await new Promise((res) => { const q = db.transaction('device').objectStore('device').getAll(); q.onsuccess = () => res(q.result); });
      return all.find((x) => x.status === 'active')?.deviceId ?? null;
    });
    check(narrowId && browsers.some((b: any) => b.id === narrowId), 'narrow computer found', { narrowId });
    await n.page.reload(); await waitForDoc(n, TITLE);
    await commentInPage(n, 'Support hours', 'Written just before forgetting.', 'pill');
    const forget = await mia.call('POST', `/mobile/browsers/${narrowId}/forget`, {});
    expectEqual(forget.status, 200, 'forget');
    await n.page.reload();
    await n.page.waitForSelector('.link-computer, .page-message, .doc-header', { timeout: 20_000 });
    const narrowAfter = ((await n.page.textContent('#doc')) ?? '').trim().slice(0, 200);
    e.screenshotForgotten = await shot(n, 'forgotten');
    // The wide computer still writes, until Mia is removed.
    await w.page.goto(`https://${A.host}/docs/${docId}`); await waitForDoc(w, TITLE);
    await commentInPage(w, 'Support hours', 'Still allowed before removal.', 'pill');
    const removed = await bearer(A, 'POST', '/team/people/mia/lower', { remove: true });
    expectEqual(removed.status, 200, 'remove');
    check(await selectPhrase(w.page, 'second business day'), 'select');
    const pill = await w.page.$('button.pill:not([hidden])');
    let refusedWords = '';
    if (pill) {
      await w.page.click('button.pill');
      await w.page.fill('.sheet textarea', 'After removal.');
      await w.page.click('.sheet button.btn.primary');
      await sleep(1500);
      refusedWords = ((await w.page.textContent('.sheet .error').catch(() => '')) ?? '').trim();
    }
    e.screenshotRemoved = await shot(w, 'after-removal');
    const stored = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=all`)).body?.comments ?? [];
    Object.assign(e, { browsersListed: browsers.length, forgetStatus: forget.status, narrowPageAfterForget: narrowAfter, removeStatus: removed.status, afterRemovalUi: refusedWords || 'no comment control', storedAfterRemoval: stored.some((c: any) => c.body === 'After removal.') });
    check(!narrowAfter.includes('short call'), 'forgotten computer no longer opens the document', { narrowAfter });
    check(!stored.some((c: any) => c.body === 'After removal.'), 'no write after removal');
  });

  await M.run({ id: 'mm-history-of-forgotten-computer-replicates', description: 'Comments written by a computer before it was forgotten (and by a person before removal) still reach machine B, so both machines show the same comments', riskCategory: 'lifecycle' }, async (e) => {
    for (const row of svcA.keyLedger!.rows()) svcB.keyLedger!.ingestReplicated(row); // the ledger rides the journal in production
    await svcB.teamPuller?.tick();
    await (B.server as any).documentPuller?.tick();
    (B.server as any).documents?.store.recheckPending();
    const tokB = B.memoryPrivacy.issueSessionToken('proof-shared-b3', { kind: 'place', placeKey: placeShared }, placeShared);
    const onA = (await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=all`)).body?.comments ?? [];
    const onB = (await session(B, tokB, 'GET', `/docs/${docId}/comments?status=all`)).body?.comments ?? [];
    const healthB = (await bearer(B, 'GET', '/docs/health')).body;
    const missing = onA.filter((c: any) => !onB.some((x: any) => x.key === c.key)).map((c: any) => ({ key: c.key, body: c.body }));
    const hiddenOnB = Object.fromEntries([...(((B.server as any).documents?.store.hidden as Map<string, string>) ?? new Map()).entries()]);
    let refusedOnB: unknown[] = [];
    try { refusedOnB = fs.readFileSync(path.join(B.stateDir, 'documents', 'refused.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { refusedOnB = []; }
    Object.assign(e, { commentsOnA: onA.length, commentsOnB: onB.length, missingOnB: missing, healthB, hiddenOnB, refusedOnB, rowsA: rowsOf(A, docId).length, rowsB: rowsOf(B, docId).length, responderMachineId: B.identity.machineId });
    check(missing.length === 0, 'every comment on A is on B', { missing, healthB });
  });

  await M.run({ id: 'cl-owner-pin-browser-reads-not-writes', description: 'A browser approved only with the dashboard PIN (owner) can open and read the document but every write is refused', riskCategory: 'permission-volatile' }, async (e) => {
    await pinBrowserScenario(e, A, browser, docId, svcA);
  });


  // ═══ No named tunnel, fleet config (regression of the switch) ══════════════════════════════
  await M.run({ id: 'fail-no-named-tunnel-plain-refusal', description: 'An agent with no named tunnel refuses to create a document with the plain words, and the app open answers the same', riskCategory: 'failure-rollback' }, async (e) => {
    const r = await bareAgent({ developmentAgent: true });
    Object.assign(e, r);
    expectEqual(r.createStatus, 409, 'create');
    expectEqual(r.createError, 'documents-need-a-named-tunnel', 'error');
    check(/permanent address/.test(String(r.createDetail)), 'plain words', { detail: r.createDetail });
  });
  await M.run({ id: 'regression-fleet-config-dark', description: 'On a fleet config (no developmentAgent, documents not enabled) every documents route answers 503 documents-off, including the page assets', riskCategory: 'regression' }, async (e) => {
    const r = await bareAgent({});
    Object.assign(e, r);
    expectEqual(r.createStatus, 503, 'create');
    expectEqual(r.assetStatus, 503, 'page asset');
  });
  await M.run({ id: 'regression-page-csp-clean', description: 'Every page load in this run kept the strict CSP: no CSP or Trusted Types violation and no script error in any browser tab', riskCategory: 'regression' }, async (e) => {
    const all = Object.entries(tabs).map(([k, t]) => ({ tab: k, errors: t.consoleErrors.filter((x) => !/Failed to load resource/.test(x)), csp: t.cspViolations }));
    const csp = await httpCall(A.port, 'GET', `/docs/${docId}`, { headers: { Host: A.host } });
    Object.assign(e, { tabs: all.map((x) => ({ tab: x.tab, errors: x.errors.length, csp: x.csp.length })), cspHeader: csp.headers['content-security-policy'] });
    check(String(csp.headers['content-security-policy']).includes("require-trusted-types-for 'script'"), 'CSP header');
    check(all.every((x) => x.csp.length === 0), 'no CSP violations', { all });
    check(all.every((x) => x.errors.length === 0), 'no script errors', { all });
  });

  // ═══ Cannot run here ═══════════════════════════════════════════════════════════════════════
  M.blocked({ id: 'app-ios-simulator', description: 'In the iOS simulator against this agent: the conversation lists its documents, a document opens in the app, a comment and Send work, the push opens the right comment, and the owner\'s share sheet creates the shared conversation with Face ID', riskCategory: 'lifecycle' },
    'platform-error', 'The Instar iOS app and an iOS simulator are not available to this runner (no Xcode simulator runtime or app build in this environment); the app half is owned by echo-instar-app and must be driven there.', { checked: probeSimulator() });
  M.blocked({ id: 'phone-real-device', description: 'The same flows on Justin\'s real phone, including a member scanning the QR code with the app camera and Face ID', riskCategory: 'lifecycle' },
    'credential-unavailable', 'A real paired iPhone with Face ID cannot be driven from this runner; member phones here are throwaway P-256 keys signing exactly as the app does.');
  M.blocked({ id: 'tunnel-real-named-cloudflare', description: 'The page through a real named Cloudflare tunnel hostname', riskCategory: 'lifecycle' },
    'credential-unavailable', 'No Cloudflare named-tunnel credential is provisioned for throwaway agents; the run used a local TLS front on loopback (the same shape: TLS ends before the agent) with the hostname mapped in Chromium.');
  M.blocked({ id: 'push-20-replies-one-push', description: '20 replies in one pass produce one push', riskCategory: 'concurrency' },
    'credential-unavailable', 'Push delivery needs an APNs-registered device token from the real app; the throwaway phones have none, so the one-push fold cannot be observed end to end.');

  // ── write the signed artifact ──────────────────────────────────────────────────────────────
  const runId = newRunId(Date.now(), crypto.randomBytes(3).toString('hex'));
  const publicKeyPem = crypto.createPublicKey({ key: A.signing.privateKey }).export({ type: 'spki', format: 'pem' }).toString();
  const store = new LiveTestArtifactStore({
    stateDir: A.stateDir, machineId: A.identity.machineId, signerFingerprint: A.identity.machineId,
    sign: (d) => signEd25519(d, A.signing.privateKey), verify: (d, s) => verifyEd25519(d, s, publicKeyPem), logger: log,
  });
  const artifact = M.artifact({ featureId: FEATURE_ID, runId, runnerFingerprint: A.identity.machineId, createdAt: new Date().toISOString() });
  const entry = store.write(artifact);
  const verified = store.verifyEntry(FEATURE_ID, runId);
  const counts = M.counts();
  const cov = M.coverage();
  const artifactPath = path.join(A.stateDir, 'live-test-artifacts', FEATURE_ID, `${runId}.json`);
  log('');
  log('════ Instar Documents live proof ════');
  log(`artifact:    ${artifactPath}`);
  log(`ledger:      ${path.join(A.stateDir, `live-test-ledger.${A.identity.machineId}.jsonl`)} (hash ${entry.contentHash.slice(0, 16)}…, verify ${verified.ok ? 'ok' : verified.reason})`);
  log(`featureId:   ${FEATURE_ID}`);
  log(`runId:       ${runId}`);
  log(`counts:      PASS ${counts.PASS}  FAIL ${counts.FAIL}  BLOCKED ${counts.BLOCKED}`);
  log(`covered:     ${cov.covered.join(', ')}`);
  log(`uncovered:   ${cov.uncovered.join(', ') || '(none)'}`);
  log(`screenshots: ${shotDir}`);
  for (const r of M.rows) log(`  ${r.verdict.padEnd(7)} ${r.riskCategory.padEnd(19)} ${r.id}`);
  for (const r of M.rows.filter((x) => x.verdict === 'FAIL')) log(`\nFAIL ${r.id} evidence: ${JSON.stringify(r.evidence).slice(0, 1500)}`);
  if (rateLimitWaits.length) log(`\n(note: waited ${rateLimitWaits.length}× 61 s for the page's own per-address link-code limit)`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

// ── scenario helpers ────────────────────────────────────────────────────────────────────────────

function rowsOf(m: Machine, docId: string): string[] {
  const docs = (m.server as unknown as { documents: { store: { rowsOf(id: string): unknown[] } } | null }).documents;
  return (docs?.store.rowsOf(docId) ?? []).map((r) => JSON.stringify(r));
}

/** Page data as a person's phone sees it (an open code, then the read cookie). */
async function pageData(m: Machine, phone: Phone, docId: string): Promise<any> {
  const open = await phone.call('POST', `/mobile/docs/${docId}/open`, {});
  check(open.status === 200, 'open code', { status: open.status, body: open.body });
  const sess = await httpCall(m.port, 'POST', `/docs/${docId}/session`, { headers: { Host: m.host, 'X-Instar-Request': '1' }, body: JSON.stringify({ code: open.body.code }) });
  const cookie = String(sess.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const r = await httpCall(m.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: m.host, Cookie: cookie } });
  check(r.status === 200, 'page data', { status: r.status, body: r.body });
  return r.body;
}

function projectionOfPage(page: any): string {
  return (page.blocks ?? []).map((b: any) => b.runs.map((r: any) => r.text).join('')).join('\n');
}

async function phoneComment(m: Machine, phone: Phone, docId: string, onVersion: string, start: number, end: number, text: string): Promise<HttpResult> {
  const salt = crypto.randomBytes(16).toString('hex');
  return phone.docpage(m, docId, 'comment', { docId, commentId: crypto.randomUUID(), onVersion, start, end, bodyHash: blobHash(salt, text) }, { blobs: [{ salt, text }] });
}

/** Why the server refused a linked computer's Send: each condition of its scoped-send check, read from the same server. */
async function diagnoseScopedSend(A: Machine, _t: Tab, sent: Array<{ path: string; device: string; body: string }>): Promise<Record<string, unknown>> {
  const last = sent[sent.length - 1];
  if (!last) return { note: 'no chat request was made' };
  const svc = A.server.mobilePairing!;
  const d = svc.devices.get(last.device);
  const { scopedSendTarget, linkStillValid } = await import('../src/server/documentLinkRoutes.js');
  const body = JSON.parse(last.body);
  const target = scopedSendTarget(body.text, last.path.toLowerCase());
  return {
    path: last.path, text: body.text, bodyKeys: Object.keys(body), deviceScope: d?.scope ?? null, deviceHost: d?.host ?? null,
    linkStillValid: d ? linkStillValid(d, svc, Date.now()) : null, browserOn: svc.browserOn(), target,
    pairingOrigin: svc.pairingOrigin()?.origin ?? null,
    serverCheck: d ? (A.server as any).documentScopedSendOk(d, last.path.toLowerCase(), Buffer.from(last.body)) : null,
    // What the check sees when it reads the document as this person: with no grant rows (as the check
    // builds its reader) and with the person's real grant rows (as the page routes build theirs).
    readAsPersonNoGrants: readAs(A, target?.docId ?? '', d?.userId ?? '', false),
    readAsPersonWithGrants: readAs(A, target?.docId ?? '', d?.userId ?? '', true),
  };
}

function readAs(A: Machine, docId: string, personKey: string, withGrants: boolean): Record<string, unknown> {
  try {
    const srv = A.server as any;
    const standing = A.server.mobilePairing!.teamStanding(personKey);
    const f = srv.documents.service.facts(docId);
    const grants = withGrants ? srv.documentRouteDeps({ config: { stateDir: A.stateDir } }).grantsOf(personKey, f.primary) : [];
    const caller = { principal: { kind: 'person', personKey, tier: standing?.tier, client: 'browser' }, actor: { type: 'machine' }, access: {}, reader: { kind: 'person', personKey, grants } };
    const r = srv.documents.service.read(docId, caller);
    return { title: r.title, versions: r.state.versions.size, myOpenComments: [...r.state.comments.values()].filter((c: any) => c.author === personKey && !c.resolved).length, grants: grants.length };
  } catch (err) { return { throws: (err as { code?: string }).code ?? (err as Error).message }; }
}

function probeSimulator(): string {
  try { return execFileSync('xcrun', ['simctl', 'list', 'runtimes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim().slice(0, 300) || 'no runtimes listed'; } catch (err) { return `xcrun simctl unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`; }
}

async function mspScenario(M: ScenarioMatrix, A: Machine, owner: Phone, docId: string): Promise<void> {
  await M.run({ id: 'perm-msp-phone-no-standing', description: 'A legacy msp phone gets 404 on a document', riskCategory: 'permission-volatile' }, async (e) => {
    const inv = await owner.call('POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'max', name: 'Max', role: 'member', relationship: 'msp' }] });
    e.inviteStatus = inv.status; e.inviteError = inv.body?.error ?? null;
    check(inv.status === 200, 'msp person added through the owner\'s phone', { body: inv.body });
    const max = await pairMember(A, owner, 'max', inv.body.link, 'Max phone');
    const s = await max.call('GET', `/mobile/docs/${docId}/summary`);
    const o = await max.call('POST', `/mobile/docs/${docId}/open`, {});
    Object.assign(e, { summary: s.status, open: o.status });
    expectEqual(s.status, 404, 'summary'); expectEqual(o.status, 404, 'open');
  });
}

async function conversationRemovedScenario(e: Record<string, unknown>, A: Machine, owner: Phone, mia: Phone, browser: Browser, tabs: Record<string, Tab>, _tok: string): Promise<void> {
  // A second conversation shared with Mia, holding its own document; then the owner removes the conversation.
  const conv = await owner.call('POST', '/mobile/conversations', { title: 'Temp room', requestId: rid() });
  const key = conv.body?.conversationKey as string;
  const g = await owner.call('POST', '/mobile/team/grants', { events: [{ type: 'grant', personKey: 'mia', ref: key, access: 'use' }] });
  check(g.status === 200, 'grant', { body: g.body });
  const tok = A.memoryPrivacy.issueSessionToken('proof-temp-session', { kind: 'place', placeKey: `app:${key}` }, `app:${key}`);
  const d = await session(A, tok, 'POST', '/docs', { title: 'Temp doc', markdown: '# Temp\n\nA passage to comment on here.\n' });
  check(d.status === 201, 'temp doc', { body: d.body });
  const pd = await pageData(A, mia, d.body.id);
  const s = projectionOfPage(pd).indexOf('passage');
  const c = await phoneComment(A, mia, d.body.id, pd.version.id, s, s + 7, 'Unsent comment');
  check(c.status === 201, 'comment', { body: c.body });
  const del = await owner.call('DELETE', `/mobile/conversations/${key}`, { requestId: rid() });
  e.deleteStatus = del.status; e.deleteBody = del.body;
  check(del.status === 200, 'the owner removes the conversation through a phone route', { status: del.status, body: del.body });
  const t = tabs['mia-wide'];
  await t.page.goto(`https://${A.host}/docs/${d.body.id}`);
  await t.page.waitForSelector('.doc-header', { timeout: 20_000 });
  const discussed = await pageText(t, '.doc-header .discussed');
  const btn = await t.page.$(`button:has-text("Send comments to ${AGENT_NAME}")`);
  const disabled = btn ? await btn.isDisabled() : null;
  const title = btn ? await btn.getAttribute('title') : null;
  Object.assign(e, { docId: d.body.id, discussed, sendDisabled: disabled, sendTitle: title, screenshot: await shot(t, 'conversation-removed') });
  check(discussed.includes('This document\'s conversation was removed'), 'page says the conversation was removed', { discussed });
  check(disabled === true && title === 'This document\'s conversation was removed', 'Send disabled with the reason', { disabled, title });
}

async function pinBrowserScenario(e: Record<string, unknown>, A: Machine, browser: Browser, docId: string, svc: NonNullable<AgentServer['mobilePairing']>): Promise<void> {
  // The console's approved-browser flow with no Telegram owner: the PIN session approves it (approvedVia dashboard-pin).
  const unlock = await httpCall(A.port, 'POST', '/dashboard/unlock', { headers: { Host: A.host }, body: JSON.stringify({ pin: PIN }) });
  check(unlock.status === 200 && unlock.body?.operatorSessionToken, 'dashboard unlocked with the PIN', { status: unlock.status });
  const ownerPresent = svc.deps.telegramOwnerPresent;
  svc.deps.telegramOwnerPresent = () => false; // no Telegram owner: the PIN path approves
  const dev = makeDevice();
  const enrollmentId = rid(); const timeMs = String(Date.now());
  const proof = dev.sign(enrollProofMessage(A.host, dev.publicKey, enrollmentId, timeMs));
  const setup = await httpCall(A.port, 'POST', '/mobile/browser-devices', { headers: { Host: A.host, Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': PROJECT, 'X-Instar-Operator-Session': unlock.body.operatorSessionToken, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ publicKey: dev.publicKey, enrollmentId, timeMs, proof, deviceName: 'Owner laptop (PIN)' }) });
  svc.deps.telegramOwnerPresent = ownerPresent;
  e.setupStatus = setup.status; e.setupError = setup.body?.error ?? null;
  check(setup.status === 201, 'PIN browser set up', { body: setup.body });
  const deviceId = setup.body.deviceId ?? setup.body.id;
  e.approvedVia = svc.devices.get(deviceId)?.approvedVia ?? null;
  expectEqual(e.approvedVia, 'dashboard-pin', 'approved with the PIN');
  // The owner's own (never shared) document: a PIN browser may read it (§3.6) but never write.
  const own = await bearer(A, 'POST', '/docs', { title: 'Owner notes', markdown: '# Owner notes\n\nOnly the owner reads this plan.\n', primary: 'telegram:7' });
  check(own.status === 201, 'owner-only document', { body: own.body });
  const ownId = own.body.id as string;
  const open = await docpageCall(A, deviceId, dev.sign, ownId, 'open', { docId: ownId }, {}, rid());
  e.openStatus = open.status;
  expectEqual(open.status, 200, 'the PIN browser opens the owner-only document');
  const cookie = String(open.headers['set-cookie']?.[0] ?? '');
  const t = await openTab(browser, 'wide');
  const m = /instar_doc=([^;]+)/.exec(cookie)!;
  await t.ctx.addCookies([{ name: 'instar_doc', value: m[1], domain: A.host, path: `/docs/${ownId}`, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  await t.page.goto(`https://${A.host}/docs/${ownId}`);
  await t.page.waitForSelector('.doc-header h1, .page-message, .link-computer', { timeout: 20_000 });
  const shown = ((await t.page.textContent('#doc')) ?? '').trim();
  const pd = await httpCall(A.port, 'GET', `/docs/${ownId}/page-data`, { headers: { Host: A.host, Cookie: cookie.split(';')[0] } });
  const salt = crypto.randomBytes(16).toString('hex');
  const w = pd.body?.version ? await docpageCall(A, deviceId, dev.sign, ownId, 'comment', { docId: ownId, commentId: crypto.randomUUID(), onVersion: pd.body.version.id, start: 0, end: 5, bodyHash: blobHash(salt, 'PIN write') }, { blobs: [{ salt, text: 'PIN write' }] }, rid()) : null;
  // And the shared document: a PIN session sees no shared content at all (it is no proof of the owner).
  const sharedOpen = await docpageCall(A, deviceId, dev.sign, docId, 'open', { docId }, {}, rid());
  const sharedCookie = String(sharedOpen.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const sharedPd = sharedOpen.status === 200 ? await httpCall(A.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: A.host, Cookie: sharedCookie } }) : null;
  const hint = await t.page.$('.hint');
  Object.assign(e, { ownerOnlyDoc: ownId, pageShows: shown.slice(0, 200), pageDataStatus: pd.status, canComment: pd.body?.me?.canComment ?? null, commentControl: !!hint, writeStatus: w?.status ?? null, writeError: w?.body?.error ?? null, sharedDocPageData: sharedPd?.status ?? sharedOpen.status, screenshot: await shot(t, 'pin-browser') });
  expectEqual(pd.status, 200, 'reads');
  check(shown.includes('Only the owner reads this plan.'), 'the page renders the text', { shown: shown.slice(0, 200) });
  check(w !== null && (w.status === 404 || w.status === 403), 'write refused', { status: w?.status, body: w?.body });
  expectEqual(pd.body.me.canComment, false, 'no comment control');
  check(!hint, 'no comment hint in the page');
  check(sharedPd === null || sharedPd.status === 404, 'shared document hidden from a PIN session', { status: sharedPd?.status });
}

async function multiMachine(M: ScenarioMatrix, A: Machine, B: Machine, svcA: any, svcB: any, owner: Phone, tokShared: string, browser: Browser, docId: string, shared: string): Promise<void> {
  const pullDocs = async (m: Machine) => (m.server as any).documentPuller?.tick();
  const placeShared = `app:${shared}`;
  let synced = false;
  await M.run({ id: 'mm-comment-on-a-appears-on-b', description: 'A comment made on machine A appears on machine B after B pulls over the real signed machine route, and B\'s page renders it', riskCategory: 'lifecycle' }, async (e) => {
    for (const row of svcA.keyLedger!.rows()) svcB.keyLedger!.ingestReplicated(row); // the ledger rides the journal in production
    const team = await svcB.teamPuller?.tick();
    await svcA.teamPuller?.tick();
    const pulled = await pullDocs(B);
    e.teamPull = team?.outcomes?.[0] ?? null; e.docPull = pulled ?? null;
    check((B.server as any).documentPuller, 'B has a document puller');
    const tokB = B.memoryPrivacy.issueSessionToken('proof-shared-b', { kind: 'place', placeKey: placeShared }, placeShared);
    const onB = await session(B, tokB, 'GET', `/docs/${docId}/comments?status=all`);
    const onA = await session(A, tokShared, 'GET', `/docs/${docId}/comments?status=all`);
    e.commentsOnA = onA.body?.comments?.length; e.commentsOnB = onB.body?.comments?.length; e.statusB = onB.status;
    expectEqual(onB.status, 200, 'B answers');
    expectEqual(onB.body.comments.length, onA.body.comments.length, 'same comment count on B');
    const bodiesB = new Set(onB.body.comments.map((c: any) => c.body));
    check(onA.body.comments.every((c: any) => bodiesB.has(c.body)), 'every comment of A is on B');
    // B's own page, opened by Lea's phone key (bound on A, verified on B from the replicated binding).
    e.responderMachineId = B.identity.machineId;
    synced = true;
  });

  await M.run({ id: 'mm-300kib-version-complete-on-b', description: 'A 300 KiB version written on A reaches B complete (all chunks, content hash matches)', riskCategory: 'lifecycle' }, async (e) => {
    check(synced, 'machines synced');
    const para = (i: number) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(20)}`;
    let big = '# Onboarding plan\n\n'; let i = 0;
    while (Buffer.byteLength(big) < 300 * 1024) big += `${para(i++)}\n\n`;
    // Its own document, so the rest of the run keeps the onboarding plan's text.
    const made = await session(A, tokShared, 'POST', '/docs', { title: 'Large reference', markdown: '# Large reference\n\nStarts small.\n' });
    expectEqual(made.status, 201, 'second document on A');
    const bigId = made.body.id as string;
    const rev = await session(A, tokShared, 'POST', `/docs/${bigId}/versions`, { markdown: big, note: 'big' });
    expectEqual(rev.status, 201, 'big version on A');
    const pulled = await pullDocs(B);
    const tokB = B.memoryPrivacy.issueSessionToken('proof-shared-b2', { kind: 'place', placeKey: placeShared }, placeShared);
    const onB = await session(B, tokB, 'GET', `/docs/${bigId}/data`);
    const health = await bearer(B, 'GET', '/docs/health');
    Object.assign(e, { docId: bigId, bytes: Buffer.byteLength(big), versionId: rev.body.versionId, pull: pulled ?? null, bVersion: onB.body?.version ?? null, bSha256: onB.body?.markdown ? sha256(onB.body.markdown) : null, aSha256: sha256(big), healthB: health.body, responderMachineId: B.identity.machineId });
    expectEqual(onB.body?.version?.id, rev.body.versionId, 'B shows the new version');
    expectEqual(sha256(onB.body.markdown), sha256(big), 'B holds the whole text');
  });

  await M.run({ id: 'mm-a-cookie-refused-on-b', description: 'A page cookie minted on A is refused on B (cookies are machine-local)', riskCategory: 'permission-volatile' }, async (e) => {
    const open = await owner.call('POST', `/mobile/docs/${docId}/open`, {});
    const sess = await httpCall(A.port, 'POST', `/docs/${docId}/session`, { headers: { Host: A.host, 'X-Instar-Request': '1' }, body: JSON.stringify({ code: open.body.code }) });
    const cookie = String(sess.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const onA = await httpCall(A.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: A.host, Cookie: cookie } });
    const onB = await httpCall(B.port, 'GET', `/docs/${docId}/page-data`, { headers: { Host: B.host, Cookie: cookie } });
    Object.assign(e, { onA: onA.status, onB: onB.status, onBError: onB.body?.error });
    expectEqual(onA.status, 200, 'A accepts its own cookie');
    expectEqual(onB.status, 401, 'B refuses A\'s cookie');
  });

  M.blocked({ id: 'mm-send-via-standby-follows-chat', description: 'A Send from a phone talking to a standby follows the existing chat send behaviour and its send row reaches every machine', riskCategory: 'lifecycle' },
    'platform-error', 'Phones in this run are paired on machine A only (multi-route own names off, no second tunnel); a phone talking to the standby needs the multi-route pairing of a real phone to machine B, which the throwaway phone keys cannot get without the app.');
}

/** A third throwaway agent with no named tunnel (or a fleet config), for the refusal paths. */
async function bareAgent(extra: Record<string, unknown>): Promise<{ createStatus: number; createError: string | null; createDetail: string | null; assetStatus: number }> {
  const dir = fs.mkdtempSync(path.join(runRoot, 'bare-'));
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'proof bare' });
  const port = await freePort();
  const config = {
    projectName: 'bare', projectDir: dir, stateDir, port, host: '127.0.0.1', authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/true', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
  } as unknown as InstarConfig;
  const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
  await server.start();
  try {
    const r = await httpCall(port, 'POST', '/docs', { headers: { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'bare' }, body: JSON.stringify({ title: 'x', markdown: 'y', primary: 'telegram:7' }) });
    const a = await httpCall(port, 'GET', '/docs/_assets/doc-page.js');
    return { createStatus: r.status, createError: r.body?.error ?? null, createDetail: r.body?.detail ?? null, assetStatus: a.status };
  } finally { await server.stop(); }
}

main().catch((err) => {
  log(`runner error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 2;
}).finally(async () => {
  for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } }
  if (process.env.PROOF_CLEAN === '1') {
    // Keep the screenshots and the signed artifact: copy them out before removing the agents.
    const keep = path.join(process.env.TMPDIR ?? os.tmpdir(), `docs-live-proof-kept-${path.basename(runRoot)}`);
    try {
      fs.mkdirSync(keep, { recursive: true });
      fs.cpSync(shotDir, path.join(keep, 'screenshots'), { recursive: true });
      const a = path.join(runRoot, 'machine-a', '.instar');
      for (const f of fs.readdirSync(a)) if (f.startsWith('live-test-')) fs.cpSync(path.join(a, f), path.join(keep, f), { recursive: true });
      log(`kept screenshots and the signed artifact in ${keep}`);
      SafeFsExecutor.safeRmSync(runRoot, { recursive: true, force: true, operation: 'scripts/documents-live-proof.ts' });
    } catch (err) { log(`cleanup: ${String(err)}`); }
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
});
