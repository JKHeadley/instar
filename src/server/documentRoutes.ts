/**
 * Instar Documents — the agent API, the phone reads, session context and health
 * (spec docs/specs/instar-document-viewer.md §3.7, §3.9, §4.2).
 *
 * Dark-gated (`documents.enabled`, dev-agent gate): every route answers 503 `documents-off` when
 * the switch resolves off. Every call resolves its principal (device signature, session token or
 * bearer), applies `mayDoDocument` through the service, and answers `404 unknown-document` for
 * anything the caller may not see, so nobody can probe.
 */
import { projectText } from '../documents/projection.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { Router, type Request, type Response } from 'express';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { ResolvedPerson } from '../core/MobilePeople.js';
import type { Principal } from '../documents/access.js';
import type { Reader, ReaderGrant } from '../documents/fold.js';
import { DocError, type Caller, type DocumentService } from '../documents/service.js';
import { isConversationRef, isNodeRef, isUuid, LINK_KINDS, type Actor, type ConversationRef, type LinkKind, type NodeRef, type Vector } from '../documents/rows.js';
import type { DocumentStore } from '../documents/store.js';
import type { SessionTokenRecord } from '../users/MemoryPrivacy.js';

export interface DocumentsConfig {
  enabled?: boolean;
  agentMayResolve?: boolean;
  /**
   * Test-only (the iOS simulator against a development agent with no named tunnel): when true and
   * there is no stable origin, a phone's open answered on this server's own loopback host (from a
   * loopback peer, no forwarding header) gets `http://127.0.0.1:<port>` (or `localhost:<port>`).
   * Default off; never written by the migrator.
   */
  loopbackOrigin?: boolean;
}

export function documentsConfig(config: unknown): DocumentsConfig {
  return ((config as { documents?: DocumentsConfig } | null)?.documents) ?? {};
}

/** The dev-agent dark gate (DEV_GATED_FEATURES: documents). */
export function isDocumentsEnabled(config: unknown): boolean {
  return resolveDevAgentGate(documentsConfig(config).enabled, config as Parameters<typeof resolveDevAgentGate>[1]);
}

export interface DocumentRouteDeps {
  config: () => unknown;
  service: () => DocumentService | null;
  store: () => DocumentStore | null;
  /** This machine's head of the folded team log (the vector rows are decided under). */
  teamVector: () => Vector;
  /** The team-log grant rows that give this person this conversation (for the 2b reader). */
  grantsOf: (personKey: string, ref: ConversationRef) => ReaderGrant[];
  /** A person's own conversation (decided from its record). */
  ownsConversation: (personKey: string, ref: ConversationRef) => boolean;
  /** The owner's own app conversation, else the owner's Telegram operator topic, for bearer creates. */
  ownerConversation: () => ConversationRef | null;
  /** Device record facts for a device-signed request. */
  deviceApprovedVia: (deviceId: string) => string | null;
  /** What a session in this conversation knew of the team log (§3.4 sessionAccess); null = current vector. */
  sessionAccessFor?: (ref: ConversationRef) => Vector | null;
  /** Tell the comment's author's phones there is an answer (push kind `document`, app contract 6). */
  notifyDocumentAnswer?: (docId: string, commentKey: string) => void;
  /** The permanent origin people open documents on (a named tunnel), or null when there is none. Absent: not checked. */
  linkOrigin?: () => string | null;
}

/** The conversation a session's place key belongs to, when it is one conversation (§3.3). */
export function conversationOfPlace(placeKey: string): ConversationRef | null {
  const topic = /^telegram:topic:(-?\d{1,20})$/.exec(placeKey);
  if (topic) return `telegram:${topic[1]}`;
  const app = /^app:([0-9a-f-]{36})$/.exec(placeKey);
  if (app) return `app:${app[1]}`;
  return null;
}

type Locals = { memorySession?: SessionTokenRecord };
type DeviceReq = Request & { instarDevicePerson?: ResolvedPerson; instarDeviceClient?: 'browser'; instarPrincipal?: { kind: string; deviceId: string } };

/** Resolve who is calling. Never throws. */
export function resolveCaller(req: Request, res: Response, deps: DocumentRouteDeps): Caller | null {
  const access = deps.teamVector();
  const session = (res.locals as Locals).memorySession;
  if (session) {
    const placeKey = session.placeKey ?? '';
    const ownerReach = session.audience.kind === 'open' || session.audience.kind === 'owner';
    // The session's launch-time team vector, stamped by the server, never supplied by the session.
    const ref = conversationOfPlace(placeKey);
    const sessionAccess = (ref && deps.sessionAccessFor?.(ref)) || access;
    return { principal: { kind: 'agent', placeKey, ownerReach }, actor: { type: 'agent', placeKey }, access, sessionAccess, reader: ownerReach ? { kind: 'owner' } : { kind: 'place' } };
  }
  const dreq = req as DeviceReq;
  const person = dreq.instarDevicePerson;
  // A device-signed request, or a push's notification read token (it reads as that same phone, never as the agent).
  const deviceId = dreq.instarPrincipal?.kind === 'device' || dreq.instarPrincipal?.kind === 'device-notify' ? dreq.instarPrincipal.deviceId : null;
  if (dreq.instarPrincipal && !deviceId) return null;
  if (person && deviceId) {
    const client = dreq.instarDeviceClient === 'browser' ? 'browser' : 'phone';
    // Device reads carry no signed write payload; writes from devices go through the page's signed routes.
    const signedOrigin = { keyHash: '', deviceId, domain: 'instar-device-v1' as const, payloadB64: '', host: '', timeMs: '', sig: '' };
    if (person.role === 'owner') {
      // A browser whose approval can't be read is treated as PIN-approved: fail closed (§3.6).
      const approvedVia = deps.deviceApprovedVia(deviceId) ?? (client === 'browser' ? 'dashboard-pin' : 'phone');
      const principal: Principal = { kind: 'owner-device', client, approvedVia };
      return { principal, actor: { type: 'owner-phone', deviceId, signedOrigin }, access, reader: { kind: 'owner' } };
    }
    if (person.role === 'team' && person.userId && person.tier) {
      const principal: Principal = { kind: 'person', personKey: person.userId, tier: person.tier, client };
      const actor: Actor = { type: 'person', personKey: person.userId, deviceId, client, signedOrigin };
      return { principal, actor, access, reader: { kind: 'person', personKey: person.userId, grants: [] }, displayName: person.name };
    }
    return { principal: { kind: 'msp' }, actor: { type: 'machine' }, access, reader: { kind: 'place' } };
  }
  return { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'owner-reach' }, access, reader: { kind: 'owner' } };
}

/** The person reader for one document: own conversation, or by grant (team 2b, §3.4). */
function readerFor(caller: Caller, primary: ConversationRef | null, deps: DocumentRouteDeps): Reader {
  if (caller.principal.kind !== 'person' || !primary) return caller.reader;
  const k = caller.principal.personKey;
  if (deps.ownsConversation(k, primary)) return { kind: 'own-conversation', personKey: k };
  return { kind: 'person', personKey: k, grants: deps.grantsOf(k, primary) };
}

function fail(res: Response, err: unknown): void {
  if (err instanceof DocError) { res.status(err.status).json({ error: err.code, ...(err.message !== err.code ? { detail: err.message } : {}) }); return; }
  // A row the store refused (its origin, chain or standing) is a refusal, not a server fault.
  if (err instanceof Error && err.message.startsWith('row not applied')) { featureEvidence.record('documents', { kind: 'error', reason: 'write refused by the store' }); res.status(409).json({ error: 'write-refused' }); return; }
  featureEvidence.record('documents', { kind: 'error', reason: 'server error' });
  res.status(500).json({ error: 'documents-error' });
}

export function createDocumentRoutes(deps: DocumentRouteDeps): Router {
  const router = Router();

  const ready = (req: Request, res: Response): { svc: DocumentService; caller: Caller } | null => {
    if (req.method === 'POST') res.once('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300 && isDocumentsEnabled(deps.config())) featureEvidence.record('documents', { kind: 'fired', reason: `agent ${req.path.replace(/[0-9a-f-]{36}/g, ':id')}` }); });
    if (!isDocumentsEnabled(deps.config())) { res.status(503).json({ error: 'documents-off' }); return null; }
    const svc = deps.service();
    if (!svc) { res.status(503).json({ error: 'documents-unavailable', detail: 'Documents need this machine to have an identity.' }); return null; }
    const caller = resolveCaller(req, res, deps);
    if (!caller) { res.status(401).json({ error: 'unauthenticated' }); return null; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return { svc, caller };
  };

  /** Per-document caller, with the reader set from the document's primary. */
  const forDoc = (svc: DocumentService, caller: Caller, id: string): Caller => {
    const f = svc.facts(id);
    return { ...caller, reader: readerFor(caller, f?.primary ?? null, deps) };
  };

  // ── Agent API (§3.9) ──────────────────────────────────────────────────────────────

  router.post('/docs', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const body = (req.body ?? {}) as { title?: unknown; markdown?: unknown; primary?: unknown; derivedFrom?: unknown };
    if (typeof body.title !== 'string' || typeof body.markdown !== 'string') { res.status(400).json({ error: 'title-and-markdown-required' }); return; }
    let primary: ConversationRef | null = null;
    if (body.primary !== undefined) {
      if (!isConversationRef(body.primary)) { res.status(400).json({ error: 'bad-primary' }); return; }
      primary = body.primary;
    } else if (r.caller.principal.kind === 'agent' && !r.caller.principal.ownerReach) {
      // A session's documents default to its own conversation (§3.9).
      primary = conversationOfPlace(r.caller.principal.placeKey);
      if (!primary) { res.status(400).json({ error: 'primary-required', detail: 'Name the conversation this session belongs to.' }); return; }
    } else {
      primary = deps.ownerConversation();
    }
    if (!primary) { res.status(409).json({ error: 'documents-need-a-conversation', detail: 'Documents need the Instar app or Telegram. Share this as a read-only page instead.' }); return; }
    // People open documents through a permanent address; without one, share a read-only page instead (§3.9).
    const origin = deps.linkOrigin ? deps.linkOrigin() : undefined;
    if (origin === null) { res.status(409).json({ error: 'documents-need-a-named-tunnel', detail: 'Documents need a permanent address for this agent (a named tunnel). Share this as a read-only page instead.' }); return; }
    try {
      const derived = typeof body.derivedFrom === 'string' && isUuid(body.derivedFrom.replace(/^doc:/, '')) ? body.derivedFrom.replace(/^doc:/, '') : null;
      if (derived) {
        // Copying never widens: the copy lands in the source's conversation (§3.7).
        const src = r.svc.read(derived, forDoc(r.svc, r.caller, derived));
        primary = src.state.primary;
      }
      const out = r.svc.create(r.caller, { title: body.title, markdown: body.markdown, primary: primary!, createdFrom: derived ? (`doc:${derived}` as NodeRef) : primary! });
      res.status(201).json({ id: out.id, versionId: out.versionId, url: `${origin ?? ''}/docs/${out.id}` });
    } catch (err) { fail(res, err); }
  });

  router.get('/docs', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const conversation = typeof req.query.conversation === 'string' ? req.query.conversation : null;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
    // No conversation: every document this caller may see (the console's list, a title search).
    if (!conversation) { try { res.json({ documents: r.svc.listAll(r.caller, q) }); } catch (err) { fail(res, err); } return; }
    if (!isConversationRef(conversation)) { res.status(400).json({ error: 'conversation-required' }); return; }
    try { res.json({ documents: r.svc.listForConversation(conversation, r.caller) }); } catch (err) { fail(res, err); }
  });

  router.get('/docs/session-context', (req, res) => {
    const r = ready(req, res); if (!r) return;
    // A session gets its own conversation's documents: the parameter is ignored for session callers (§3.7).
    const session = (res.locals as Locals).memorySession;
    const fromSession = session ? conversationOfPlace(session.placeKey ?? '') : null;
    const asked = typeof req.query.conversation === 'string' ? req.query.conversation : null;
    const conversation = session ? (fromSession ?? (asked && isConversationRef(asked) ? asked : null)) : asked;
    if (!conversation || !isConversationRef(conversation)) { res.status(400).json({ error: 'conversation-required' }); return; }
    try { res.json(renderSessionContext(conversation, r.svc.listForConversation(conversation, r.caller))); } catch (err) { fail(res, err); }
  });

  router.get('/docs/health', (req, res) => {
    const r = ready(req, res); if (!r) return;
    if (r.caller.principal.kind !== 'bearer' && !(r.caller.principal.kind === 'agent' && r.caller.principal.ownerReach)) { res.status(404).json({ error: 'unknown-document' }); return; }
    const store = deps.store();
    res.json({ ok: true, ...(store ? store.health() : {}) });
  });

  router.get('/docs/:id/data', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    try {
      const c = forDoc(r.svc, r.caller, id);
      const versionId = typeof req.query.version === 'string' ? req.query.version : undefined;
      const d = r.svc.read(id, c, versionId);
      res.json({
        id, title: d.title, primary: d.state.primary, markdown: d.markdown,
        version: d.version ? { id: d.version.versionId, label: d.version.label, projectionVersion: d.version.projectionVersion } : null,
        // The plain-text projection comment offsets index into (§3.5): the app cuts quotes from it.
        projection: d.version && d.markdown !== null ? projectText(d.markdown, d.version.projectionVersion).text : null,
        concurrentEdits: d.heads.length > 1,
      });
    } catch (err) {
      // Owner-reach callers get metadata for documents they can't read (§3.3).
      if (err instanceof DocError && err.status === 404) {
        try { return void res.json({ metadataOnly: true, ...r.svc.metadata(id, r.caller) }); } catch { /* fall through to 404 */ }
      }
      fail(res, err);
    }
  });

  router.get('/docs/:id/versions', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    try {
      const d = r.svc.read(id, forDoc(r.svc, r.caller, id));
      res.json({ versions: d.state.versionOrder.map((v) => d.state.versions.get(v)!).map((v) => ({ id: v.versionId, label: v.label, parents: v.parents, pruned: v.pruned, author: v.author })) });
    } catch (err) { fail(res, err); }
  });

  router.post('/docs/:id/versions', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    const body = (req.body ?? {}) as { markdown?: unknown; note?: unknown; addresses?: unknown };
    if (!isUuid(id) || typeof body.markdown !== 'string') { res.status(400).json({ error: 'markdown-required' }); return; }
    try {
      const addresses = Array.isArray(body.addresses) ? body.addresses.filter((x): x is string => typeof x === 'string').slice(0, 2000) : [];
      res.status(201).json(r.svc.revise(id, forDoc(r.svc, r.caller, id), { markdown: body.markdown, note: typeof body.note === 'string' ? body.note : undefined, addresses }));
    } catch (err) { fail(res, err); }
  });

  router.get('/docs/:id/compare', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    const from = String(req.query.from ?? ''); const to = String(req.query.to ?? '');
    if (!isUuid(id) || !isUuid(from) || !isUuid(to)) { res.status(400).json({ error: 'from-and-to-required' }); return; }
    try { res.json(r.svc.compare(id, forDoc(r.svc, r.caller, id), from, to)); } catch (err) { fail(res, err); }
  });

  router.get('/docs/:id/comments', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    const status = req.query.status === 'all' || req.query.status === 'resolved' ? req.query.status : 'open';
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    try { res.json({ comments: r.svc.comments(id, forDoc(r.svc, r.caller, id), status) }); } catch (err) { fail(res, err); }
  });

  router.post('/docs/:id/comments/:key/replies', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    const body = (req.body ?? {}) as { body?: unknown };
    if (!isUuid(id) || typeof body.body !== 'string') { res.status(400).json({ error: 'body-required' }); return; }
    // Only the agent replies through this route; people reply through the page's signed routes.
    if (r.caller.principal.kind !== 'agent' && r.caller.principal.kind !== 'bearer') { res.status(404).json({ error: 'unknown-document' }); return; }
    try {
      const out = r.svc.reply(id, forDoc(r.svc, r.caller, id), req.params.key, body.body);
      res.status(201).json(out);
      // The push goes only to the comment author's phones that may read the document (fail closed).
      try { deps.notifyDocumentAnswer?.(id, req.params.key); } catch { /* @silent-fallback-ok — a missed push never undoes the reply; the page shows it */ }
    } catch (err) { fail(res, err); }
  });

  // The link graph (§3.7): never passes through, counts or names a node the caller can't see.
  router.get('/docs/graph', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const from = String(req.query.from ?? '');
    const depth = req.query.depth === '2' ? 2 : 1;
    if (!isNodeRef(from)) { res.status(400).json({ error: 'bad-ref' }); return; }
    const visible = (ref: string): boolean => {
      if (r.caller.principal.kind === 'agent' && !r.caller.principal.ownerReach && !ref.startsWith('doc:')) return conversationOfPlace(r.caller.principal.placeKey) === ref;
      return linkTargetVisible(r.svc, r.caller, ref as NodeRef, deps);
    };
    if (!visible(from)) { res.status(404).json({ error: 'unknown-document' }); return; }
    const nodes = new Map<string, { ref: string; title?: string | null }>();
    const edges: Array<{ from: string; to: string; kind: string; reason?: string }> = [];
    const seenEdge = new Set<string>();
    const addEdge = (a: string, b: string, kind: string, reason?: string | null): void => {
      const k = `${a}|${b}|${kind}`;
      if (seenEdge.has(k)) return;
      seenEdge.add(k);
      edges.push({ from: a, to: b, kind, ...(reason ? { reason } : {}) });
    };
    const docNode = (id: string) => {
      try { return r.svc.read(id, forDoc(r.svc, r.caller, id)); } catch { return null; } // @silent-fallback-ok — an unreadable document is not in the graph
    };
    const expand = (ref: string): string[] => {
      const next: string[] = [];
      if (ref.startsWith('doc:')) {
        const d = docNode(ref.slice(4));
        if (!d) return next;
        nodes.set(ref, { ref, title: d.title });
        if (d.state.primary && visible(d.state.primary)) { addEdge(ref, d.state.primary, 'primary'); next.push(d.state.primary); }
        for (const l of d.state.links.values()) {
          if (!visible(l.to)) continue;
          addEdge(ref, l.to, l.kind, r.svc.linkReason(ref.slice(4), l.reasonHash));
          next.push(l.to);
        }
        return next;
      }
      nodes.set(ref, { ref });
      // Documents that live in, or point at, this node.
      for (const id of r.svc.allDocIds()) {
        const f = r.svc.facts(id);
        if (!f) continue;
        const d = docNode(id);
        if (!d) continue;
        const dref = `doc:${id}`;
        if (d.state.primary === ref) { addEdge(dref, ref, 'primary'); next.push(dref); }
        for (const l of d.state.links.values()) if (l.to === ref) { addEdge(dref, ref, l.kind, r.svc.linkReason(id, l.reasonHash)); next.push(dref); }
      }
      return next;
    };
    let frontier = [from];
    const done = new Set<string>();
    for (let level = 0; level <= depth && frontier.length; level++) {
      const nextFrontier: string[] = [];
      for (const ref of frontier) {
        if (done.has(ref)) continue;
        done.add(ref);
        if (level < depth) nextFrontier.push(...expand(ref));
        else if (!nodes.has(ref)) nodes.set(ref, ref.startsWith('doc:') ? { ref, title: docNode(ref.slice(4))?.title ?? null } : { ref });
      }
      frontier = nextFrontier;
    }
    res.json({ from, depth, nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) });
  });

  router.get('/docs/:id/links', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    try {
      const d = r.svc.read(id, forDoc(r.svc, r.caller, id));
      // A link is shown only when the caller may see its other end too (§3.7).
      const links = [...d.state.links.values()].filter((l) => linkTargetVisible(r.svc, r.caller, l.to as NodeRef, deps));
      res.json({ primary: d.state.primary, links: links.map((l) => ({ to: l.to, kind: l.kind })) });
    } catch (err) { fail(res, err); }
  });

  router.post('/docs/:id/links', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    const body = (req.body ?? {}) as { to?: unknown; kind?: unknown; reason?: unknown };
    if (!isUuid(id) || !isNodeRef(body.to) || !LINK_KINDS.includes(body.kind as LinkKind)) { res.status(400).json({ error: 'bad-link' }); return; }
    try {
      r.svc.link(id, forDoc(r.svc, r.caller, id), { to: body.to, kind: body.kind as LinkKind, reason: typeof body.reason === 'string' ? body.reason : undefined }, (to) => linkTargetVisible(r.svc, r.caller, to, deps));
      res.status(201).json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // ── Phone reads (§4.2) ───────────────────────────────────────────────────────────

  router.get('/mobile/docs', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const conversation = typeof req.query.conversation === 'string' ? req.query.conversation : null;
    if (!conversation || !isConversationRef(conversation)) { res.status(400).json({ error: 'conversation-required' }); return; }
    try {
      const docs = r.svc.listForConversation(conversation, r.caller);
      res.json({ documents: docs.map((d) => ({ id: d.id, title: d.title, version: d.version, openComments: d.openComments })), more: false });
    } catch (err) { fail(res, err); }
  });

  router.get('/mobile/docs/:id/summary', (req, res) => {
    const r = ready(req, res); if (!r) return;
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ error: 'unknown-document' }); return; }
    try {
      const c = forDoc(r.svc, r.caller, id);
      const d = r.svc.read(id, c);
      const open = [...d.state.comments.values()].filter((x) => !x.resolved);
      const me = c.principal.kind === 'person' ? (c.principal as { personKey: string }).personKey : 'owner';
      const myOpen = open.filter((x) => x.author === me).map((x) => x.key).sort();
      const mine = myOpen.length;
      const heads: Record<string, number> = {};
      const store = deps.store();
      for (const row of store?.rowsOf(id) ?? []) heads[`${row.origin}/${row.incarnation}`] = Math.max(heads[`${row.origin}/${row.incarnation}`] ?? 0, row.seq);
      // A notification read token gets the title only (what the alert shows; app contract 6).
      if ((req as DeviceReq).instarPrincipal?.kind === 'device-notify') { res.json({ id, title: d.title }); return; }
      res.json({ id, title: d.title, version: d.version?.label ?? null, versionId: d.version?.versionId ?? null, openComments: open.length, myOpenComments: mine, myOpenCommentKeys: myOpen, shared: r.svc.facts(id)?.everShared ?? false, primary: { ref: d.state.primary, primaryRow: d.state.primaryRowKey }, heads });
    } catch (err) { fail(res, err); }
  });

  return router;
}

function linkTargetVisible(svc: DocumentService, caller: Caller, to: NodeRef, deps: DocumentRouteDeps): boolean {
  if (to.startsWith('doc:')) {
    const id = to.slice(4);
    try { svc.read(id, { ...caller, reader: readerFor(caller, svc.facts(id)?.primary ?? null, deps) }); return true; } catch { return false; } // @silent-fallback-ok — an unreadable target is simply not shown
  }
  if (to.startsWith('project:') || to.startsWith('initiative:') || to.startsWith('spec:')) {
    return caller.principal.kind === 'bearer' || caller.principal.kind === 'owner-device' || (caller.principal.kind === 'agent' && caller.principal.ownerReach);
  }
  // Conversation nodes: the caller's own view of that conversation.
  if (caller.principal.kind === 'person') return deps.ownsConversation(caller.principal.personKey, to) || deps.grantsOf(caller.principal.personKey, to).length > 0;
  if (caller.principal.kind === 'agent' && !caller.principal.ownerReach) return false;
  return true;
}

/** The session-start block: at most 10 lines and 1,600 characters, with an overflow line (§3.7). */
export function renderSessionContext(conversation: string, docs: Array<{ id: string; title: string | null; version: number | null; openComments: number }>): { text: string; total: number } {
  if (docs.length === 0) return { text: '', total: 0 };
  const lines: string[] = ['Documents in this conversation:'];
  let used = lines[0].length;
  let shown = 0;
  for (const d of docs) {
    const title = d.title ? `"${d.title.length > 60 ? d.title.slice(0, 59) + '…' : d.title}"` : 'a document';
    const line = `- ${title}, version ${d.version ?? '?'}, ${d.openComments} open comment${d.openComments === 1 ? '' : 's'}: /docs/${d.id}`;
    if (shown >= 10 || used + line.length + 1 > 1600) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < docs.length) lines.push(`…and ${docs.length - shown} more documents in this conversation: GET /docs?conversation=${conversation}`);
  return { text: lines.join('\n'), total: docs.length };
}
