/**
 * Instar Documents — the document page and its signed writes (spec §3.6, §3.6a, §4.2; app contract).
 *
 * These routes carry their own authentication and are exempt from the bearer middleware
 * (middleware.ts DOC_PAGE_PATH):
 *   GET  /docs/_assets/:file                   the page's static files (instar's own; script-src 'self')
 *   GET  /docs/:id                             the HTML shell (no document content in it)
 *   POST /docs/:id/session                     a single-use open code (app) or a signed `open` (browser) → read cookie
 *   GET  /docs/:id/page-data, /page-compare    reads, with the read cookie
 *   POST /docs/:id/w/:op                       writes, each signed by the person's device under instar-docpage-v1
 * and one device-signed phone route (DEVICE_ALLOWLIST): POST /mobile/docs/:id/open.
 *
 * The cookie authorises only reads of its one document and never satisfies dashboard or bearer auth.
 * Every write is device-signed, so a forwarded URL or a stolen cookie can write nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { Router, type Request, type Response } from 'express';
import type { ResolvedPerson } from '../core/MobilePeople.js';
import { checkBlob, type Blob } from '../documents/blobs.js';
import { verifyDocpage, type DocpageOp } from '../documents/docpageAuth.js';
import { latestVersion } from '../documents/fold.js';
import { renderTree } from '../documents/render.js';
import { DocError, type Caller } from '../documents/service.js';
import { isUuid, type Actor, type SignedOrigin } from '../documents/rows.js';
import { isDocumentsEnabled, resolveCaller, type DocumentRouteDeps } from './documentRoutes.js';
import type { Principal } from '../documents/access.js';
import { canonicalJson } from '../documents/chain.js';
import { ActionChallengeStore, permissionPresenceMessage } from './mobilePermissionsRoutes.js';
import { verifyPresenceSignature } from './mobileConsoleTicket.js';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import { ownLoopbackHost } from './documentLinkRoutes.js';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';

/** The CSP every document page response carries (§3.6). */
export const DOC_PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "require-trusted-types-for 'script'",
].join('; ');

const CODE_TTL_MS = 60_000;
const COOKIE_TTL_MS = 30 * 60_000;
const COOKIE = 'instar_doc';

export interface DocPageDeps extends DocumentRouteDeps {
  /** A device by id: its person, client kind and public key (phone or browser). */
  device: (deviceId: string) => { person: ResolvedPerson | null; client: 'phone' | 'browser'; publicKey: string | null; approvedVia: string | null; scope?: 'documents' | 'documents-read' | null } | null;
  /** Is this Host one of this machine's own names? */
  isOwnHost: (host: string) => boolean;
  /** This machine's stable origin for document links, or null (no named tunnel). */
  stableOrigin: () => string | null;
  /** Where the page's static files live (dashboard/docs). */
  assetsDir: string;
  /** Human names for authors, when the team log knows them. */
  personName?: (personKey: string) => string | null;
  /** Words for who can see a conversation ("Only you", "Everyone in Instar Docs", …). */
  audienceWords?: (ref: string, viewerIsOwner: boolean) => string;
  conversationName?: (ref: string) => string | null;
  /** Was this primary conversation removed? (§3.7: the page says so and Send is disabled with that reason) */
  conversationRemoved?: (ref: string) => boolean;
  /** The owner's active phone behind this device-signed request: its presence (Face ID) key and signed Host. */
  ownerPresence?: (req: Request, deviceId: string) => { presenceKey: string; host: string } | null;
  agentName?: () => string;
  ownerName?: () => string | null;
}

interface Session { deviceId: string; docId: string; expiresAt: number }

export function createDocumentPageRoutes(deps: DocPageDeps): Router {
  const router = Router();
  const codes = new Map<string, Session>();
  const sessions = new Map<string, Session>();
  // Docpage request ids used, this process. Ids start with their 13-digit time, so entries older than
  // the device clock window can never be accepted again and are dropped.
  const seenIds = new Map<string, number>();
  const seen = {
    has: (k: string) => seenIds.has(k),
    add: (k: string) => {
      const t = Number(k.split('|')[1]?.slice(0, 13));
      seenIds.set(k, Number.isFinite(t) ? t : Date.now());
      if (seenIds.size > 2048) { const cut = Date.now() - 15 * 60_000; for (const [id, at] of seenIds) if (at < cut) seenIds.delete(id); }
    },
  };
  // At most 30 page sessions a minute per device (each is a signed open or a single-use code).
  const sessionTimes = new Map<string, number[]>();
  const sessionAllowed = (deviceId: string): boolean => {
    const now = Date.now();
    const list = (sessionTimes.get(deviceId) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= 30) { sessionTimes.set(deviceId, list); return false; }
    list.push(now);
    sessionTimes.set(deviceId, list);
    if (sessionTimes.size > 1024) for (const [k, v] of sessionTimes) if (!v.some((t) => now - t < 60_000)) sessionTimes.delete(k);
    return true;
  };
  const prune = (m: Map<string, Session>): void => { const now = Date.now(); for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k); };

  const off = (res: Response): boolean => {
    if (isDocumentsEnabled(deps.config())) return false;
    res.status(503).json({ error: 'documents-off' });
    return true;
  };
  const pageHeaders = (res: Response): void => {
    res.setHeader('Content-Security-Policy', DOC_PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
  };

  /** The caller for a device (cookie session or signed write). */
  const callerForDevice = (deviceId: string, signedOrigin?: SignedOrigin): Caller | null => {
    const d = deps.device(deviceId);
    if (!d || !d.person) return null;
    const access = deps.teamVector();
    const so: SignedOrigin = signedOrigin ?? { keyHash: '', deviceId, domain: 'instar-docpage-v1', payloadB64: '', host: '', timeMs: '', sig: '' };
    if (d.person.role === 'owner') {
      const approvedVia = d.approvedVia ?? (d.client === 'browser' ? 'dashboard-pin' : 'phone');
      const principal: Principal = { kind: 'owner-device', client: d.client, approvedVia };
      return { principal, actor: { type: 'owner-phone', deviceId, signedOrigin: so }, access, reader: { kind: 'owner' } };
    }
    if (d.person.role === 'team' && d.person.userId && d.person.tier) {
      const k = d.person.userId;
      const principal: Principal = { kind: 'person', personKey: k, tier: d.person.tier, client: d.client };
      const actor: Actor = { type: 'person', personKey: k, deviceId, client: d.client, signedOrigin: so };
      return { principal, actor, access, reader: { kind: 'person', personKey: k, grants: [] }, displayName: d.person.name };
    }
    return null;
  };
  const withReader = (c: Caller, docId: string): Caller => {
    if (c.principal.kind !== 'person') return c;
    const f = deps.service()?.facts(docId);
    if (!f) return c;
    const k = c.principal.personKey;
    if (deps.ownsConversation(k, f.primary)) return { ...c, reader: { kind: 'own-conversation', personKey: k } };
    return { ...c, reader: { kind: 'person', personKey: k, grants: deps.grantsOf(k, f.primary) } };
  };
  const cookieOf = (req: Request): string | null => {
    const raw = req.headers.cookie ?? '';
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})`).exec(raw);
    return m ? m[1] : null;
  };
  const sessionCaller = (req: Request, docId: string): Caller | null => {
    prune(sessions);
    const tok = cookieOf(req);
    const s = tok ? sessions.get(tok) : undefined;
    if (!s || s.docId !== docId) return null;
    const c = callerForDevice(s.deviceId);
    return c ? withReader(c, docId) : null;
  };
  const fail = (res: Response, err: unknown): void => {
    if (err instanceof DocError) { res.status(err.status).json({ error: err.code, ...(err.message !== err.code ? { detail: err.message } : {}) }); return; }
    // A row the store refused (its origin, chain or standing) is a refusal, not a server fault.
    if (err instanceof Error && err.message.startsWith('row not applied')) { featureEvidence.record('documents', { kind: 'error', reason: 'write refused by the store' }); res.status(409).json({ error: 'write-refused' }); return; }
    featureEvidence.record('documents', { kind: 'error', reason: 'server error' });
    res.status(500).json({ error: 'documents-error' });
  };
  /**
   * The test-only loopback origin (documents.loopbackOrigin): `http://<host>` for a request on this
   * server's own loopback host from a loopback peer with no forwarding header, else null.
   */
  const loopbackOrigin = (req: Request): string | null => {
    const cfg = deps.config() as { documents?: { loopbackOrigin?: unknown }; port?: unknown };
    if (cfg?.documents?.loopbackOrigin !== true) return null;
    const host = String(req.headers.host ?? '').toLowerCase();
    return ownLoopbackHost(req, host, cfg.port) ? `http://${host}` : null;
  };
  const mintCookie = (res: Response, deviceId: string, docId: string, plainHttp = false): void => {
    const tok = crypto.randomBytes(32).toString('base64url');
    sessions.set(tok, { deviceId, docId, expiresAt: Date.now() + COOKIE_TTL_MS });
    // Secure always, except on the test-only loopback origin, which is plain http on this machine.
    res.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly;${plainHttp ? '' : ' Secure;'} SameSite=Strict; Path=/docs/${docId}; Max-Age=${COOKIE_TTL_MS / 1000}`);
  };

  // ── Static files and the shell ───────────────────────────────────────────────────────

  router.get('/docs/_assets/:file', (req, res) => {
    if (off(res)) return;
    const file = req.params.file;
    if (!/^[a-z0-9-]+\.(js|css)$/.test(file)) { res.status(404).end(); return; }
    const full = path.join(deps.assetsDir, file);
    if (!fs.existsSync(full)) { res.status(404).end(); return; }
    pageHeaders(res);
    res.type(file.endsWith('.js') ? 'application/javascript' : 'text/css');
    res.send(fs.readFileSync(full, 'utf8'));
  });

  router.get('/docs/:id', (req, res, next) => {
    if (!isUuid(req.params.id)) { next(); return; }
    if (off(res)) return;
    pageHeaders(res);
    res.type('html').send(PAGE_SHELL);
  });

  // ── Opening ──────────────────────────────────────────────────────────────────────────

  // Phone (device-signed through DEVICE_ALLOWLIST): a single-use code for the page in the app.
  router.post('/mobile/docs/:id/open', (req, res) => {
    if (off(res)) return;
    const id = req.params.id;
    const r = resolveCaller(req, res, deps);
    const svc = deps.service();
    if (!svc || !r || !isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    const deviceId = (req as Request & { instarPrincipal?: { kind: string; deviceId: string } }).instarPrincipal?.deviceId;
    if (!deviceId) { res.status(404).json({ error: 'unknown-document' }); return; }
    try { svc.read(id, withReader(r, id)); } catch (err) { fail(res, err); return; }
    const origin = deps.stableOrigin() ?? loopbackOrigin(req);
    if (!origin) { res.status(409).json({ error: 'documents-need-a-named-tunnel', detail: 'Documents need a permanent address for your agent. Turn on a named tunnel in Settings.' }); return; }
    prune(codes);
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + CODE_TTL_MS;
    codes.set(code, { deviceId, docId: id, expiresAt });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: `${origin}/docs/${id}`, code, expiresAt: new Date(expiresAt).toISOString() });
  });

  // ── Moving a document (owner phone, Face ID; §3.2, §4.2) ────────────────────────────────
  // The phone asks for a challenge bound to the exact move (document, conversation, the history it
  // showed), confirms with Face ID, and signs that challenge with its presence key.
  const moveChallenges = new ActionChallengeStore();
  const moveLine = (docId: string, primary: string, docDeps: unknown): string =>
    `docs-primary-set ${docId} ${primary} ${crypto.createHash('sha256').update(canonicalJson(docDeps ?? {})).digest('hex')}`;
  const moveGate = (req: Request, res: Response): { deviceId: string; presenceKey: string; host: string; caller: Caller } | null => {
    if (off(res)) return null;
    res.setHeader('Cache-Control', 'no-store');
    const deviceId = (req as Request & { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal?.deviceId;
    if (!deviceId) { res.status(403).json({ error: 'owner-phone-required' }); return null; }
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) { res.status(403).json({ error: 'secure-transport-required' }); return null; }
    const g = deps.ownerPresence?.(req, deviceId) ?? null;
    if (!g) { res.status(403).json({ error: 'owner-phone-required', detail: 'Only your own phone, with Face ID, can move a document.' }); return null; }
    const caller = resolveCaller(req, res, deps);
    if (!caller || caller.principal.kind !== 'owner-device') { res.status(403).json({ error: 'owner-phone-required' }); return null; }
    return { deviceId, ...g, caller };
  };
  const moveBody = (req: Request): { primary: string; docDeps: Record<string, number> } | null => {
    const b = (req.body ?? {}) as { primary?: unknown; docDeps?: unknown };
    if (typeof b.primary !== 'string' || !b.docDeps || typeof b.docDeps !== 'object' || Array.isArray(b.docDeps)) return null;
    const docDeps: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.docDeps as Record<string, unknown>)) { if (typeof v !== 'number') return null; docDeps[k] = v; }
    return { primary: b.primary, docDeps };
  };

  router.post('/mobile/docs/:id/primary/challenge', (req, res) => {
    const g = moveGate(req, res);
    if (!g) return;
    const id = req.params.id;
    const b = moveBody(req);
    if (!isUuid(id) || !b) { res.status(400).json({ error: 'bad-request' }); return; }
    const c = moveChallenges.issue(g.deviceId, g.host, moveLine(id, b.primary, b.docDeps));
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  router.post('/mobile/docs/:id/primary', (req, res) => {
    const g = moveGate(req, res);
    if (!g) return;
    const id = req.params.id;
    const b = moveBody(req);
    const svc = deps.service();
    if (!svc || !isUuid(id) || !b) { res.status(400).json({ error: 'bad-request' }); return; }
    const body = req.body as { challenge?: unknown; presenceSig?: unknown };
    const line = moveLine(id, b.primary, b.docDeps);
    if (!moveChallenges.consume(body.challenge, g.deviceId, g.host, line)) { res.status(401).json({ error: 'challenge-invalid' }); return; }
    if (!verifyPresenceSignature(g.presenceKey, permissionPresenceMessage(g.deviceId, g.host, String(body.challenge), line), body.presenceSig)) { res.status(401).json({ error: 'presence-invalid' }); return; }
    // The row carries the phone's whole device-signed request (body: conversation, history, Face ID
    // challenge), so every machine verifies the move against the phone's replicated key (§3.2).
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const deviceKey = deps.device(g.deviceId)?.publicKey ?? null;
    const payloadB64 = raw ? raw.toString('base64url') : '';
    if (!raw || !deviceKey || payloadB64.length > 2048) { res.status(413).json({ error: 'move-request-too-large' }); return; }
    const signedOrigin: SignedOrigin = { keyHash: deviceKeyHashOf(deviceKey), deviceId: g.deviceId, domain: 'instar-device-v1', payloadB64, host: g.host, timeMs: String(req.headers['x-instar-device-time'] ?? ''), sig: String(req.headers['x-instar-device-sig'] ?? ''), requestId: String(body.challenge) };
    const caller: Caller = { ...g.caller, actor: { type: 'owner-phone', deviceId: g.deviceId, signedOrigin } };
    try { svc.setPrimary(id, caller, b.primary as never, b.docDeps); featureEvidence.record('documents', { kind: 'fired', reason: 'move' }); res.json({ ok: true, primary: b.primary }); } catch (err) { fail(res, err); }
  });

  // The page exchanges a code (app) or a device-signed `open` (browser) for the read cookie.
  router.post('/docs/:id/session', (req, res) => {
    if (off(res)) return;
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const body = (req.body ?? {}) as { code?: unknown };
    if (typeof body.code === 'string') {
      prune(codes);
      const s = codes.get(body.code);
      codes.delete(body.code); // single use, whatever happens next
      if (!s || s.docId !== id) { res.status(401).json({ error: 'doc-session-expired' }); return; }
      mintCookie(res, s.deviceId, id, !!loopbackOrigin(req));
      res.json({ ok: true });
      return;
    }
    const v = verifyFromHeaders(req, id, 'open');
    if (!v.ok) { res.status(401).json({ error: 'doc-session-expired' }); return; }
    if (!sessionAllowed(v.deviceId)) { res.status(429).json({ error: 'too-many-requests' }); return; }
    mintCookie(res, v.deviceId, id, !!loopbackOrigin(req));
    res.json({ ok: true });
  });

  /** Verify a docpage-signed request from its headers; resolves the device's key itself. */
  const verifyFromHeaders = (req: Request, docId: string, expectOp: DocpageOp | null): { ok: true; deviceId: string; op: DocpageOp; payload: Record<string, unknown>; signedOrigin: SignedOrigin } | { ok: false; reason: string } => {
    const deviceId = String(req.headers['x-instar-device'] ?? '');
    const timeMs = String(req.headers['x-instar-device-time'] ?? '');
    const sig = String(req.headers['x-instar-docpage-sig'] ?? '');
    const requestId = String(req.headers['x-instar-request-id'] ?? '');
    const payloadB64 = String(req.headers['x-instar-docpage-payload'] ?? '');
    const op = expectOp ?? String(req.params.op ?? '');
    const host = String(req.headers.host ?? '').toLowerCase();
    const d = deps.device(deviceId);
    if (!d || !d.publicKey) return { ok: false, reason: 'unknown-device' };
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'bad-payload' }; }
    // The agent's own machine (localhost) counts as an own host only for a request that really
    // arrived over loopback with no forwarding header, exactly as loopback browsers are bound (§3.6).
    const loopbackOk = ownLoopbackHost(req, host, (deps.config() as { port?: unknown }).port);
    const ownHost = (h: string): boolean => deps.isOwnHost(h) || (loopbackOk && h === host);
    const v = verifyDocpage({ deviceId, host, docId, op, requestId, timeMs, payload, sigB64url: sig }, d.publicKey, ownHost, seen);
    if (!v.ok) return { ok: false, reason: v.reason };
    return {
      ok: true, deviceId, op: v.op, payload: v.payload,
      signedOrigin: { keyHash: deviceKeyHashOf(d.publicKey), deviceId, domain: 'instar-docpage-v1', payloadB64, host, timeMs, sig, requestId },
    };
  };

  // ── Reads (cookie) ───────────────────────────────────────────────────────────────────

  router.get('/docs/:id/page-data', (req, res) => {
    if (off(res)) return;
    const id = req.params.id;
    pageHeaders(res);
    const svc = deps.service();
    const c = isUuid(id) ? sessionCaller(req, id) : null;
    if (!svc || !c) { res.status(401).json({ error: 'doc-session-expired' }); return; }
    try {
      const versionId = typeof req.query.version === 'string' ? req.query.version : undefined;
      const d = svc.read(id, c, versionId);
      const latest = latestVersion(d.state);
      const blocks = d.version && d.markdown !== null ? renderTree(d.markdown, d.version.projectionVersion) : [];
      const sent = svc.sentKeys(id, c);
      const meKey = c.principal.kind === 'person' ? c.principal.personKey : 'owner';
      const nameOf = (author: string): string => author === meKey ? 'You' : author === 'owner' ? (deps.ownerName?.() ?? 'Owner') : author.startsWith('agent.') ? (deps.agentName?.() ?? 'Echo') : (deps.personName?.(author) ?? author);
      const comments = svc.comments(id, c, 'all').map((x) => ({ ...x, sent: sent.has(x.key), mine: x.author === (c.principal.kind === 'person' ? c.principal.personKey : 'owner'), authorName: nameOf(x.author), replies: x.replies.map((rp) => ({ ...rp, authorName: nameOf(rp.author) })) }));
      const me = c.principal.kind === 'person' ? c.principal.personKey : 'owner';
      const primary = d.state.primary;
      // A removed conversation is reported as missing: no name, no send path, Send off (§3.7).
      const removed = !!primary && !!deps.conversationRemoved?.(primary);
      const sendPath = removed ? null : primary?.startsWith('telegram:') ? `/mobile/chat/${primary.slice(9)}` : primary?.startsWith('app:') ? `/mobile/chat/app/${primary.slice(4)}` : null;
      res.json({
        id, title: d.title,
        primary: { ref: removed ? null : primary, ...(removed ? { removed: true, removedRef: primary } : {}), name: primary && !removed ? deps.conversationName?.(primary) ?? null : null, sendPath, primaryRow: d.state.primaryRowKey },
        agentName: deps.agentName?.() ?? 'Echo',
        audience: primary ? deps.audienceWords?.(primary, c.principal.kind === 'owner-device') ?? null : null,
        version: d.version ? { id: d.version.versionId, label: d.version.label, latest: latest?.versionId === d.version.versionId } : null,
        versions: d.state.versionOrder.map((v) => d.state.versions.get(v)!).filter((v) => !v.pruned).map((v) => ({ id: v.versionId, label: v.label })),
        concurrentEdits: d.heads.length > 1,
        blocks, comments,
        me: { key: me, canComment: svc.can(id, c, 'comment'), canSend: !removed && svc.can(id, c, 'send') },
      });
    } catch (err) { fail(res, err); }
  });

  router.get('/docs/:id/page-compare', (req, res) => {
    if (off(res)) return;
    const id = req.params.id;
    pageHeaders(res);
    const svc = deps.service();
    const c = isUuid(id) ? sessionCaller(req, id) : null;
    if (!svc || !c) { res.status(401).json({ error: 'doc-session-expired' }); return; }
    try { res.json(svc.compare(id, c, String(req.query.from ?? ''), String(req.query.to ?? ''))); } catch (err) { fail(res, err); }
  });

  // ── Writes (each signed by the person's device, instar-docpage-v1) ────────────────────

  router.post('/docs/:id/w/:op', (req, res) => {
    if (off(res)) return;
    const id = req.params.id;
    res.setHeader('Cache-Control', 'no-store');
    const svc = deps.service();
    if (!svc || !isUuid(id) || req.params.op === 'open') { res.status(404).json({ error: 'unknown-document' }); return; }
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const v = verifyFromHeaders(req, id, null);
    if (!v.ok) { res.status(401).json({ error: 'signature-refused', detail: v.reason }); return; }
    const base = callerForDevice(v.deviceId, v.signedOrigin);
    if (!base) { res.status(404).json({ error: 'unknown-document' }); return; }
    // A guest's linked computer reads only (§3.6a).
    if (deps.device(v.deviceId)?.scope === 'documents-read') { res.status(403).json({ error: 'read-only-computer', detail: 'This computer can read documents but not comment. Comment from your phone.' }); return; }
    const c = withReader(base, id);
    const p = v.payload as Record<string, string & number>;
    const blobs = Array.isArray((req.body ?? {}).blobs) ? ((req.body as { blobs: unknown[] }).blobs.filter((b) => checkBlob(b).ok) as Blob[]) : [];
    const text = blobs.map((b) => b.text).join('');
    try {
      res.once('finish', () => { if (res.statusCode < 300) featureEvidence.record('documents', { kind: 'fired', reason: `page ${v.op}` }); });
      switch (v.op) {
        case 'comment': res.status(201).json(svc.comment(id, c, { commentId: p.commentId, onVersion: p.onVersion, start: Number(p.start), end: Number(p.end), body: text, bodyBlobs: blobs, bodyHash: p.bodyHash })); return;
        case 'reply': res.status(201).json(svc.reply(id, c, p.commentKey, text, { replyId: p.replyId, bodyBlobs: blobs, bodyHash: p.bodyHash })); return;
        case 'resolve': case 'reopen': svc.resolve(id, c, p.commentKey, v.op === 'resolve'); res.json({ ok: true }); return;
        case 'edit': svc.editComment(id, c, p.commentKey, text, { bodyBlobs: blobs, bodyHash: p.bodyHash }); res.json({ ok: true }); return;
        case 'reanchor': svc.reanchorComment(id, c, p.commentKey, { onVersion: p.onVersion, start: Number(p.start), end: Number(p.end) }); res.json({ ok: true }); return;
        case 'send': {
          const f = svc.facts(id);
          if (f && deps.conversationRemoved?.(f.primary)) { res.status(409).json({ error: 'conversation-removed', detail: 'This document\'s conversation was removed' }); return; }
          res.status(201).json(svc.recordSend(id, c, { batchId: p.batchId, messageRequestId: p.messageRequestId, primaryRow: p.primaryRow, commentKeysHash: p.commentKeysHash })); return;
        }
        default: res.status(404).json({ error: 'unknown-document' });
      }
    } catch (err) { fail(res, err); }
  });

  return router;
}

/** The HTML shell. No document content, no inline script or style (the CSP forbids both). */
const PAGE_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Document</title>
<link rel="stylesheet" href="/docs/_assets/doc-page.css">
<script type="module" src="/docs/_assets/doc-page.js"></script>
</head>
<body>
<main id="doc" aria-live="polite"><p class="loading">Opening the document…</p></main>
</body>
</html>
`;
