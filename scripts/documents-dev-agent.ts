/**
 * Instar Documents — a long-running development agent for the iOS simulator (no tunnel).
 *
 *     npx tsx scripts/documents-dev-agent.ts --port 4799 --dir <folder> \
 *       --owner-key <b64url P-256 point> --owner-device docs-sim-owner \
 *       --member-key <b64url P-256 point> --member-device docs-sim-member [--member-name "Docs Member"]
 *
 * Boots ONE real AgentServer on http://127.0.0.1:<port> (plain http, no tunnel, no peers, no Telegram)
 * with documents, team access, phone pairing and linked computers on, and `documents.loopbackOrigin`
 * so `POST /mobile/docs/:id/open` answers `http://127.0.0.1:<port>/docs/<id>`.
 * State lives in <folder>/.instar and is reused on the next run; seeding happens once and is recorded
 * in <folder>/dev-agent-seed.json (a second run with the same folder only checks and serves).
 *
 * Seeding (first run only):
 *   - the two simulator phones become ACTIVE device records bound to host 127.0.0.1:<port>, through the
 *     same registry and ledger calls the pairing confirm makes (DeviceRegistry.createPending → key-ledger
 *     activation row → applyConfirm → bindTeamPhones). The one step the real flow has no call for is
 *     giving a record a chosen id (the simulators send fixed ids), done through the registry's own
 *     read/write right after createPending, before anything else refers to the device;
 *   - a throwaway owner phone (key generated here, used for setup only, kept on disk in the seed file so a
 *     later run can still act as the owner) signs the real team routes: team on, the owner pin, the member
 *     person, a member grant on a shared app conversation, and the owner's own app conversation;
 *   - two documents through the agent API: one private to the owner (owner's app conversation, bearer),
 *     one in the shared conversation (written by a session token confined to that conversation).
 * The team invite route mints a pairing link and so needs a pairing origin; with no tunnel there is none,
 * so a placeholder named tunnel is switched on in memory for the seeding requests only and switched off
 * before serving (nothing is written to config for it). Creating documents later through `POST /docs`
 * hits the same need (409 documents-need-a-named-tunnel) unless the server learns the loopback origin there too.
 */
// safe-fs-allow: dev agent — creates its own state folder only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { AgentServer } from '../src/server/AgentServer.js';
import { StateManager } from '../src/core/StateManager.js';
import { InitiativeTracker } from '../src/core/InitiativeTracker.js';
import { MachineIdentityManager } from '../src/core/MachineIdentity.js';
import { MemoryPrivacy } from '../src/users/MemoryPrivacy.js';
import { canonicalString, parseDevicePublicKey, type DeviceRecord } from '../src/core/MobileDeviceKeys.js';
import { createMockSessionManager } from '../tests/helpers/setup.js';
import type { InstarConfig } from '../src/core/types.js';

// ── arguments ───────────────────────────────────────────────────────────────────────────────────

function args(): { port: number; dir: string; ownerKey: string; ownerDevice: string; memberKey: string; memberDevice: string; memberName: string } {
  const a = process.argv.slice(2);
  const get = (k: string): string | undefined => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const need = (k: string): string => { const v = get(k); if (!v) { console.error(`missing --${k}`); process.exit(2); } return v; };
  const port = Number(need('port'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4062) { console.error('--port must be 1024-65535 and not the live agent port 4062'); process.exit(2); }
  const out = { port, dir: path.resolve(need('dir')), ownerKey: need('owner-key'), ownerDevice: need('owner-device'), memberKey: need('member-key'), memberDevice: need('member-device'), memberName: get('member-name') ?? 'Docs Member' };
  for (const [k, v] of [['owner-key', out.ownerKey], ['member-key', out.memberKey]] as const) if (!parseDevicePublicKey(v)) { console.error(`--${k} is not an uncompressed P-256 public key (base64url, 65 bytes starting 0x04)`); process.exit(2); }
  for (const [k, v] of [['owner-device', out.ownerDevice], ['member-device', out.memberDevice]] as const) if (!/^[A-Za-z0-9-]{8,64}$/.test(v)) { console.error(`--${k} must be 8-64 letters, digits or dashes`); process.exit(2); }
  if (out.ownerKey === out.memberKey || out.ownerDevice === out.memberDevice) { console.error('owner and member need different keys and device ids'); process.exit(2); }
  return out;
}

// ── a tiny HTTP client for the setup requests (the real routes on the real port) ────────────────

interface Res { status: number; body: any }
function call(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b: any = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
/** A P-256 signature as the app makes it: DER, low S, base64url. */
function signLowS(privateKeyPem: string, msg: string): string {
  const p = crypto.sign('sha256', Buffer.from(msg), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  const r = BigInt('0x' + p.subarray(0, 32).toString('hex'));
  let s = BigInt('0x' + p.subarray(32).toString('hex'));
  if (s > N / 2n) s = N - s;
  const enc = (v: bigint): Buffer => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
  const body = Buffer.concat([enc(r), enc(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
}
function newP256(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

let clock = Date.now();
function deviceCall(port: number, host: string, deviceId: string, privateKeyPem: string, method: 'GET' | 'POST', p: string, body?: unknown): Promise<Res> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  clock = Math.max(clock + 1, Date.now());
  const time = String(clock);
  const sig = signLowS(privateKeyPem, canonicalString(deviceId, host, method, p, time, raw === undefined ? undefined : Buffer.from(raw)));
  return call(port, method, p, { 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': sig }, raw);
}
const rid = (): string => `${Date.now()}-${crypto.randomUUID()}`;

// ── seed record ─────────────────────────────────────────────────────────────────────────────────

interface Seed {
  version: 1;
  port: number;
  authToken: string;
  setupOwner: { deviceId: string; publicKey: string; privateKeyPem: string };
  ownerDevice: { id: string; publicKey: string };
  memberDevice: { id: string; publicKey: string };
  ownerPersonKey: string;
  memberPersonKey: string;
  memberName: string;
  ownerConversation: string;
  sharedConversation: string;
  ownerDocId: string;
  sharedDocId: string;
  seededAt: string;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = args();
  const host = `127.0.0.1:${o.port}`;
  const stateDir = path.join(o.dir, '.instar');
  const seedFile = path.join(o.dir, 'dev-agent-seed.json');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  if (!fs.existsSync(path.join(stateDir, 'config.json'))) fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  if (!fs.existsSync(path.join(stateDir, 'users.json'))) fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  const idm = new MachineIdentityManager(stateDir);
  if (!idm.hasIdentity()) await idm.generateIdentity({ name: 'docs dev agent' });
  let seed: Seed | null = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) as Seed : null;
  if (seed) {
    // The same folder must be served the same way: the devices are bound to this host and these keys.
    const mismatch = [
      seed.port !== o.port && `port ${seed.port} (devices are bound to 127.0.0.1:${seed.port})`,
      seed.ownerDevice.id !== o.ownerDevice && `owner device ${seed.ownerDevice.id}`,
      seed.ownerDevice.publicKey !== o.ownerKey && 'a different owner key',
      seed.memberDevice.id !== o.memberDevice && `member device ${seed.memberDevice.id}`,
      seed.memberDevice.publicKey !== o.memberKey && 'a different member key',
    ].filter(Boolean);
    if (mismatch.length) { console.error(`This folder was seeded with ${mismatch.join(', ')}. Use those, or a new --dir.`); process.exit(2); }
  }
  const authToken = seed?.authToken ?? `dev-${crypto.randomBytes(16).toString('hex')}`;

  const config = {
    projectName: 'docsdev', projectDir: o.dir, stateDir, port: o.port, host: '127.0.0.1', authToken, developmentAgent: true,
    documents: { enabled: true, loopbackOrigin: true }, memoryPrivacy: { enabled: true },
    mobilePairing: { multiRoute: { enabled: false }, browser: { enabled: true } },
    sessions: { claudePath: '/usr/bin/true', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, threadline: { ownerName: 'Owner' },
    requestTimeoutMs: 30_000, version: '0.0.0-docs-dev',
  } as unknown as InstarConfig & { tunnel?: unknown };

  // Messages people send reach "the agent" here: a stand-in session manager that logs them.
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async (message: string) => { console.log(`[dev-agent] message for the agent: ${String(message).slice(0, 300)}`); return `docs-dev-session-${Date.now()}`; };
  sessionManager.injectMessage = (_s: string, message: string) => { console.log(`[dev-agent] message for the agent: ${String(message).slice(0, 300)}`); return true; };
  sessionManager.memoryPrivacyStatus = () => ({ enabled: true, sandboxReady: true, multiPerson: true, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (_ref: string, change: () => unknown) => change();
  const memoryPrivacy = new MemoryPrivacy({ stateDir, instarRoot: path.join(o.dir, 'instar-root'), agentId: 'docsdev', config: () => ({ enabled: true }), users: () => [], reachable: () => ({}) });
  // A tunnel object that is off; seeding switches a placeholder on in memory (see the header).
  const tunnel = { lifecycleState: { lastState: 'stopped', activeProvider: null as string | null }, url: null as string | null, on: () => undefined } as any;

  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, memoryPrivacy } as never);
  await server.start();
  const svc = server.mobilePairing;
  if (!svc || !svc.keyLedger) throw new Error('phone pairing did not start (no pairing service or key ledger)');
  svc.deps.ownerDM = async () => 1;
  svc.deps.telegramOwnerPresent = () => false;

  /** Register a phone as an active device with a chosen id, through the registry and ledger the confirm uses. */
  const registerPhone = (id: string, publicKey: string, name: string, person: { userId: string | null; role: 'owner' | 'team' }): DeviceRecord => {
    const existing = svc.devices.get(id);
    if (existing) {
      if (existing.publicKey !== publicKey || existing.status !== 'active') throw new Error(`device ${id} exists with another key or status ${existing.status}`);
      return existing;
    }
    const created = svc.devices.createPending({ deviceName: name, label: null, publicKey, host, userId: person.userId, role: person.role });
    if (!created.ok) throw new Error(`could not register ${id}: ${created.reason}`);
    // The one step pairing has no call for: the simulator sends a fixed device id.
    const reg = svc.devices as unknown as { read(): { devices: DeviceRecord[] }; write(f: unknown): void };
    const f = reg.read();
    const d = f.devices.find((x) => x.id === created.device.id)!;
    d.id = id;
    reg.write(f);
    const approvedAt = new Date().toISOString();
    // Ledger row first, registry second, then the team binding: exactly the confirm's order.
    if (!svc.keyLedger!.recordActivation({ ...d, id }, 'owner-agent', approvedAt)) throw new Error(`ledger activation for ${id} not written`);
    const after = svc.devices.applyConfirm(id, { ok: true, approvedVia: 'owner-agent', approvedAt });
    if (after?.status !== 'active') throw new Error(`${id} did not become active`);
    svc.bindTeamPhones();
    return after;
  };

  if (!seed) {
    const say = (s: string): void => console.log(`[dev-agent] seeding: ${s}`);
    const expect = (r: Res, ok: number[], what: string): Res => { if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r; };
    // Placeholder pairing origin for the seeding requests only (team invites mint a pairing link).
    config.tunnel = { enabled: true, type: 'named', token: 'placeholder', hostname: 'docs-dev-seeding.invalid' };
    tunnel.lifecycleState = { lastState: 'active', activeProvider: 'cloudflare-named' };
    tunnel.url = 'https://docs-dev-seeding.invalid';
    try {
      const setupKey = newP256();
      const setupOwner = registerPhone(`docs-setup-owner-${crypto.randomBytes(4).toString('hex')}`, setupKey.publicKey, 'Setup owner (dev agent)', { userId: null, role: 'owner' });
      const owner = (m: 'GET' | 'POST', p: string, b?: unknown): Promise<Res> => deviceCall(o.port, host, setupOwner.id, setupKey.privateKeyPem, m, p, b);
      // Team access asks the owner's phone to have a Face ID (presence) key, so it can be turned off later.
      if (svc.devices.setPresenceKey(setupOwner.id, newP256().publicKey) !== 'set') throw new Error('setup owner presence key not set');
      say(`setup owner phone ${setupOwner.id}`);
      const ownerConv = expect(await owner('POST', '/mobile/conversations', { title: 'My notes', requestId: rid() }), [200, 201], 'owner conversation').body.conversationKey as string;
      const sharedConv = expect(await owner('POST', '/mobile/conversations', { title: 'Docs shared room', requestId: rid() }), [200, 201], 'shared conversation').body.conversationKey as string;
      const memberKey = 'docs-member';
      const ownerPersonKey = 'docs-owner';
      expect(await owner('POST', '/mobile/team/invites', { events: [
        { type: 'team-on' }, { type: 'owner-pin', personKey: ownerPersonKey },
        { type: 'person-add', personKey: memberKey, name: o.memberName, role: 'member' },
        { type: 'grant', personKey: memberKey, ref: sharedConv, access: 'use' },
      ] }), [200], 'team on + member invite');
      say(`member person ${memberKey} with use of ${sharedConv}`);
      registerPhone(o.ownerDevice, o.ownerKey, 'Simulator (owner)', { userId: null, role: 'owner' });
      registerPhone(o.memberDevice, o.memberKey, `Simulator (${o.memberName})`, { userId: memberKey, role: 'team' });
      say(`simulator phones ${o.ownerDevice} (owner) and ${o.memberDevice} (${memberKey}) active on ${host}`);

      const bearer = { Authorization: `Bearer ${authToken}`, 'X-Instar-AgentId': 'docsdev' };
      const ownDoc = expect(await call(o.port, 'POST', '/docs', bearer, JSON.stringify({ title: 'Owner notes (private)', primary: `app:${ownerConv}`, markdown: [
        '# Owner notes', '', 'These notes are private to the owner.', '', 'Nobody else on the team can open this document.', '',
      ].join('\n') })), [201], 'owner document').body.id as string;
      const place = `app:${sharedConv}`;
      const tok = memoryPrivacy.issueSessionToken('docs-dev-shared-seed', { kind: 'place', placeKey: place }, place);
      const sharedDoc = expect(await call(o.port, 'POST', '/docs', { Authorization: `Bearer ${tok}` }, JSON.stringify({ title: 'Onboarding plan', markdown: [
        '# Onboarding plan', '',
        'We welcome every new client with a short call in the first week.', '',
        'The kickoff checklist lives in the shared drive and is reviewed monthly.', '',
        'Invoices go out on the first business day of each month.', '',
        'Support hours are nine to five on weekdays.', '',
      ].join('\n') })), [201], 'shared document').body.id as string;
      say(`documents ${ownDoc} (owner) and ${sharedDoc} (shared)`);
      seed = {
        version: 1, port: o.port, authToken, setupOwner: { deviceId: setupOwner.id, publicKey: setupKey.publicKey, privateKeyPem: setupKey.privateKeyPem },
        ownerDevice: { id: o.ownerDevice, publicKey: o.ownerKey }, memberDevice: { id: o.memberDevice, publicKey: o.memberKey },
        ownerPersonKey, memberPersonKey: memberKey, memberName: o.memberName, ownerConversation: ownerConv, sharedConversation: sharedConv,
        ownerDocId: ownDoc, sharedDocId: sharedDoc, seededAt: new Date().toISOString(),
      };
      fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2), { mode: 0o600 });
    } finally {
      delete config.tunnel;
      tunnel.lifecycleState = { lastState: 'stopped', activeProvider: null };
      tunnel.url = null;
    }
  } else {
    // A later run: the devices and people are already in the state folder; just check them.
    for (const id of [seed.ownerDevice.id, seed.memberDevice.id]) {
      const d = svc.devices.get(id);
      if (!d || d.status !== 'active' || d.host !== host) throw new Error(`seeded device ${id} is missing or not active on ${host}; use a new --dir`);
    }
    svc.bindTeamPhones();
  }

  const standing = svc.teamStanding(seed.memberPersonKey);
  console.log([
    '',
    '════ Instar Documents dev agent ════',
    `url:                 http://${host}`,
    `port:                ${o.port}`,
    `state folder:        ${stateDir}`,
    `owner device:        ${seed.ownerDevice.id}`,
    `member device:       ${seed.memberDevice.id}`,
    `owner person key:    ${seed.ownerPersonKey}`,
    `member person key:   ${seed.memberPersonKey} (${seed.memberName}, tier ${standing?.tier ?? 'unknown'})`,
    `owner conversation:  ${seed.ownerConversation}`,
    `shared conversation: ${seed.sharedConversation}`,
    `owner document:      ${seed.ownerDocId}  http://${host}/docs/${seed.ownerDocId}`,
    `shared document:     ${seed.sharedDocId}  http://${host}/docs/${seed.sharedDocId}`,
    `agent API token:     ${authToken}   (Authorization: Bearer …, X-Instar-AgentId: docsdev)`,
    'serving until killed (Ctrl-C)',
  ].join('\n'));

  const stop = async (): Promise<void> => { console.log('[dev-agent] stopping'); try { await server.stop(); } finally { process.exit(0); } };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}

main().catch((err) => { console.error(`[dev-agent] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); process.exit(1); });
