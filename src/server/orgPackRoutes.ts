/**
 * Organization pack routes (docs/specs/org-pack-and-join.md §B, §B2, §C, §F).
 *
 *   POST /org/draft                bearer        parse, try list, store a draft
 *   POST /org/invitations          bearer        an invitation link for the published pack
 *   GET  /org/status               bearer        membership, versions, held update, key code
 *   GET  /org/pack/current         public        the published pack, when shareUpdates is on
 *   POST /mobile/org/publish       owner device  publish a draft
 *   POST /mobile/org/join          owner device  join from a bundle
 *   POST /mobile/org/leave         owner device  leave
 *   POST /mobile/org/update-accept owner device  apply a held update
 *
 * The four device routes refuse the bearer: the agent holds it, so only the person's tap in the
 * app is the designed path (§B2, with its stated trust limit).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Application, type Request, type Response } from 'express';
import { IntentTestHarness } from '../core/IntentTestHarness.js';
import type { ParsedOrgIntent } from '../core/OrgIntentManager.js';
import {
  decodeBundle, encodeBundle, newOrgKeyPair, orgKeyCode, parsePolicy, policyTooLong, sha256Hex, signRecord, validateBundle,
  type MaxIndependence, type OrgBundle, type OrgRecord, type ParsedPolicy,
} from '../core/OrgPack.js';
import { OrgPackStore, type ApplyEffects, type Membership } from '../core/OrgPackStore.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { OrgMembers, newMemberKeyPair, plainName, signPayload } from '../core/OrgMembers.js';
import { makeRecoveryCopy, newRecoveryPhrase, openRecoveryCopy } from '../core/OrgRecovery.js';
import { OrgMemberSide } from '../core/OrgMemberSide.js';
import { orgRequest } from '../core/OrgPackUpdater.js';
import { OrgKeepers, encodeKeeperCode, withPublishLock } from '../core/OrgKeepers.js';

export const ORG_DRAFT_TTL_MS = 24 * 60 * 60_000;

type FanOutFn = (change: { membership: Membership; bundle: OrgBundle | null; op?: 'hold' }) => void;
let lateFanOut: FanOutFn | null = null;
/** Set once the mesh is up (server.ts); the router and the updater send through it (§Multi-machine). */
export function setOrgFanOut(fn: FanOutFn | null): void { lateFanOut = fn; }
export function orgFanOut(change: { membership: Membership; bundle: OrgBundle | null; op?: 'hold' }): void {
  try { lateFanOut?.(change); } catch { /* @silent-fallback-ok — a peer that misses it catches up at its own start */ }
}

/** `org-state-pull`: this machine's membership and applied bundle, for a peer catching up at start. */
export function orgStateForPeer(stateDir: string): { membership: Membership | null; bundle: OrgBundle | null } {
  const store = new OrgPackStore(stateDir, '');
  const membership = store.membership();
  const rec = store.currentRecord();
  if (!membership || membership.state !== 'joined' || !rec) return { membership, bundle: null };
  let policy: string | null = null;
  try { policy = fs.readFileSync(path.join(stateDir, 'org', rec.orgId, `v${rec.version}`, 'policy.md'), 'utf-8'); } catch { /* @silent-fallback-ok — answered without a bundle */ }
  return { membership, bundle: policy === null ? null : { record: rec, policy } };
}

/** The receiving side of `org-apply` (a peer of the same agent). */
export function handleOrgApply(stateDir: string, machineId: string, cmd: { membership: Membership; bundle: OrgBundle | null; op?: 'hold' }, effects: ApplyEffects): { ok: boolean; reason?: string } {
  const store = new OrgPackStore(stateDir, machineId);
  if (cmd.op === 'hold') {
    const m = store.membership();
    if (!m || m.state !== 'joined') return { ok: false, reason: 'not-member' };
    const v = validateBundle(cmd.bundle, store.heldFor(m.orgId));
    if (!v.ok) return { ok: false, reason: v.reason };
    if (v.bundle.record.orgId !== m.orgId) return { ok: false, reason: 'already-member' };
    const dir = path.join(stateDir, 'org', m.orgId, 'held', `v${v.bundle.record.version}`);
    writeAtomic(path.join(dir, 'bundle.json'), JSON.stringify(v.bundle));
    return { ok: true };
  }
  const r = store.reconcile(cmd.membership, cmd.bundle, effects);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}
const INDEPENDENCE = new Set<MaxIndependence>(['careful', 'balanced', 'trusting', 'independent']);

/** Twenty everyday requests: a fixed starter set, then requests made from the policy's own never items. */
const STARTER_TRIES = [
  'Draft a reply to this email from a colleague',
  'Summarize this meeting transcript for the team',
  'Send the meeting notes to our partner organization',
  'Put a reminder in my calendar for Thursday',
  'Delete the old version of the shared budget document',
  'Post an update about our event on social media',
  'Look up recent research on sleep and memory',
  'Accept the meeting invitation from the board chair',
  'Buy the conference tickets with the organization card',
  'Share the participant list with the venue',
  'Write a first draft of the newsletter',
  'Organize my task list for this week',
  'Email a donor to thank them for their gift',
  'Rename the files in the shared project folder',
  'Use a new AI tool I found to transcribe the interviews',
];

interface DraftBase { orgId: string; version: number; policySha256: string; maxIndependence: MaxIndependence }
interface Draft { id: string; orgName: string; policy: string; createdAt: number; tries: TryResult[]; parsed: ParsedPolicy; base?: DraftBase | null }
interface TryResult { request: string; outcome: 'allowed' | 'ask' | 'blocked'; matched?: string }

export interface OrgPackRouteDeps {
  stateDir: string;
  machineId: string;
  /** The agent's stable https origin for updates (§A updateOrigin), when it has one. */
  updateOrigin: () => string | null;
  /** Who publishes (the owner's name). */
  ownerName: () => string;
  /** This agent's own name, reported in check-ins (org-members-and-keepers §A). */
  agentName?: () => string;
  /** Test seam for outgoing calls to an organization's agent. */
  net?: { fetchFn?: typeof fetch; lookup?: (host: string) => Promise<string[]> };
  effects: () => ApplyEffects;
  /** Send a validated change to the agent's other machines (§Multi-machine). Best effort. */
  fanOut?: FanOutFn;
  principalKind: (req: Request) => string;
  journal?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

function intentFrom(name: string, constraints: string[]): ParsedOrgIntent {
  return { name, constraints: constraints.map((text) => ({ text, source: 'org-intent' as const })), goals: [], values: [], tradeoffHierarchy: [], raw: '' };
}

/** §B try list: blocked by a Never item, else ask by an Ask-first item, else allowed. An estimate. */
export function runTryList(orgName: string, p: ParsedPolicy): TryResult[] {
  const requests = [...STARTER_TRIES, ...p.never.slice(0, 5).map((n) => `Please ${n.replace(/^(never|do not|don't)\s+/i, '').replace(/\.$/, '').toLowerCase()}`)].slice(0, 20);
  const never = new IntentTestHarness(intentFrom(orgName, p.never));
  const ask = new IntentTestHarness(intentFrom(orgName, p.askFirst));
  return requests.map((request) => {
    const n = never.testRefusal(request);
    if (n.refused) return { request, outcome: 'blocked', ...(n.matchedConstraint ? { matched: n.matchedConstraint } : {}) };
    const a = ask.testRefusal(request);
    if (a.refused) return { request, outcome: 'ask', ...(a.matchedConstraint ? { matched: a.matchedConstraint } : {}) };
    return { request, outcome: 'allowed' };
  });
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent or unreadable reads as none
}

/** The admin side's published pack, kept apart from this agent's own membership. */
export function publishedPaths(stateDir: string) {
  const root = path.join(stateDir, 'org', 'published');
  return { root, current: path.join(root, 'current.json'), key: (orgId: string) => path.join(root, `${orgId}.signing-key`), drafts: path.join(root, 'drafts') };
}

export function readPublished(stateDir: string): { bundle: OrgBundle; shareUpdates: boolean } | null {
  return readJson<{ bundle: OrgBundle; shareUpdates: boolean }>(publishedPaths(stateDir).current);
}

/**
 * Two-lane counts for the public routes (org-members-and-keepers §D): a request naming a key already
 * on the list counts in that key's lane; anything else counts per source address.
 */
class HourBuckets {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number) {}
  take(key: string, t: number): boolean {
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 3600_000);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return false; }
    arr.push(t); this.hits.set(key, arr);
    if (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

/** The source address: CF-Connecting-IP only from the agent's own tunnel connector (loopback), else the socket. */
export function sourceAddress(req: Request): string {
  const sock = req.socket.remoteAddress ?? 'unknown';
  const loop = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const cf = req.headers['cf-connecting-ip'];
  return loop && typeof cf === 'string' && cf.length < 64 ? `cf:${cf}` : sock;
}

/** GET /org/pack/current, POST /org/checkin and POST /org/pack/propose, mounted before auth (§B; members-and-keepers §A, §D). */
export function mountPublicOrgPackRoutes(app: Application, stateDir: string, now: () => number = Date.now): void {
  const byKey = new HourBuckets(60);
  const byAddr = new HourBuckets(120);
  const checkinPerKey = new HourBuckets(30);
  const proposePerKey = new HourBuckets(10);
  const admit = (req: Request, res: Response, key: unknown, known: (k: string) => boolean): boolean => {
    const t = now();
    const ok = typeof key === 'string' && key.length < 200 && known(key) ? byKey.take(`k:${key}`, t) : byAddr.take(sourceAddress(req), t);
    if (!ok) res.status(429).json({ error: 'too-many-requests' });
    return ok;
  };

  app.get('/org/pack/current', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const p = readPublished(stateDir);
    if (!p || !p.shareUpdates) { res.status(404).json({ error: 'not-found' }); return; }
    res.json(p.bundle);
  });

  app.post('/org/checkin', (req: Request, res: Response) => {
    const p = readPublished(stateDir);
    if (!p || !p.shareUpdates) { res.status(404).json({ error: 'not-found' }); return; }
    const reg = new OrgMembers(stateDir, p.bundle.record.orgId, now);
    const body = (req.body ?? {}) as { memberKey?: unknown };
    if (!admit(req, res, body.memberKey, (k) => !!reg.members()[k])) return;
    if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > 2048) { res.status(413).json({ error: 'too-large' }); return; }
    // The per-key allowance is taken before anything is written, so a refused check-in changes nothing.
    if (typeof body.memberKey === 'string' && reg.members()[body.memberKey] && !checkinPerKey.take(body.memberKey, now())) { res.status(429).json({ error: 'too-many-requests' }); return; }
    try {
      const a = reg.checkin(req.body);
      res.status(a.status).json(a.body);
    } catch (err) { failed(res, '/org/checkin', err); }
  });

  app.post('/org/pack/propose', (req: Request, res: Response) => { void (async () => {
    const p = readPublished(stateDir);
    if (!p || !p.shareUpdates) { res.status(404).json({ error: 'not-found' }); return; }
    const orgId = p.bundle.record.orgId;
    if (readJson(markerPath(stateDir, orgId))) { res.status(409).json({ error: 'publish-after-recovery-first' }); return; }
    const keepers = new OrgKeepers(stateDir, orgId, now);
    const body = (req.body ?? {}) as { keeperKey?: unknown };
    if (!admit(req, res, body.keeperKey, (k) => keepers.list().some((x) => x.publicKey === k))) return;
    let keyPem: string;
    try { keyPem = fs.readFileSync(publishedPaths(stateDir).key(orgId), 'utf-8'); } catch {
      res.status(409).json({ error: 'org-key-elsewhere' }); return;
    }
    const answer = await withPublishLock(stateDir, () => {
      const cur = readPublished(stateDir);
      if (!cur) return { status: 404 as const, body: { error: 'not-found' } };
      const r = keepers.accept(req.body, cur.bundle, keyPem);
      if (r.answer.status === 200 && !proposePerKey.take(String(body.keeperKey), now())) return { status: 429 as const, body: { error: 'too-many-requests' } };
      if (r.bundle) writeAtomic(publishedPaths(stateDir).current, JSON.stringify({ bundle: r.bundle, shareUpdates: cur.shareUpdates }));
      return r.answer;
    });
    res.status(answer.status).json(answer.body);
  })().catch((err) => failed(res, '/org/pack/propose', err)); });
}

// ── Recovery (docs/specs/org-recovery-copy.md) ──
interface RecoveryMarker { copyVersion: number; at: number; stage: 'installing' | 'installed'; source: { kind: 'copy' | 'own' | 'colleague'; label?: string }; orgId: string }
function markerPath(stateDir: string, orgId: string): string { return path.join(publishedPaths(stateDir).root, `${orgId}.recovered.json`); }
export function recoveryMarker(stateDir: string): RecoveryMarker | null {
  const p = readPublished(stateDir);
  return p ? readJson<RecoveryMarker>(markerPath(stateDir, p.bundle.record.orgId)) : null;
}
/** At start, a recovery that stopped mid-install is finished (§B5): the staged files are moved into place. */
export function finishRecoveryInstall(stateDir: string): void {
  const root = publishedPaths(stateDir).root;
  const staging = path.join(root, 'recovery-staging');
  let names: string[] = [];
  try { names = fs.readdirSync(staging); } catch { return; } // @silent-fallback-ok — nothing staged
  const plan = readJson<{ orgId: string }>(path.join(staging, 'plan.json'));
  if (!plan) return;
  const m = readJson<RecoveryMarker>(markerPath(stateDir, plan.orgId));
  if (!m || m.stage !== 'installing') return;
  for (const n of names) if (n !== 'plan.json') fs.renameSync(path.join(staging, n), path.join(root, n));
  writeAtomic(markerPath(stateDir, plan.orgId), JSON.stringify({ ...m, stage: 'installed' }));
  SafeFsExecutor.safeRmSync(staging, { recursive: true, force: true, operation: 'org recovery: staging done' });
}

function failed(res: Response, where: string, err: unknown): void {
  console.error(`[org] ${where} failed:`, err instanceof Error ? err.message : String(err));
  if (!res.headersSent) res.status(500).json({ error: 'internal', detail: 'Something went wrong on the agent. Try again.' });
}

export function createOrgPackRouter(deps: OrgPackRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const store = (): OrgPackStore => new OrgPackStore(deps.stateDir, deps.machineId, now);
  const paths = publishedPaths(deps.stateDir);
  const deviceOnly = (req: Request, res: Response): boolean => {
    if (deps.principalKind(req) === 'device') return true;
    res.status(403).json({ error: 'owner-device-required', detail: 'Open the Instar app to confirm.' });
    return false;
  };

  router.post('/org/draft', (req: Request, res: Response) => { void (async () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const orgName = typeof b.orgName === 'string' ? b.orgName.replace(/[\x00-\x1f\x7f#*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const policy = typeof b.policyMarkdown === 'string' ? b.policyMarkdown : '';
    if (!orgName || !policy.trim()) { res.status(400).json({ error: 'orgName and policyMarkdown are required' }); return; }
    if (Buffer.byteLength(policy, 'utf8') > 64 * 1024) { res.status(413).json({ error: 'policy-too-long' }); return; }
    const parsed = parsePolicy(policy);
    const tooLong = policyTooLong(parsed);
    if (tooLong) { res.status(400).json({ error: 'policy-too-long', detail: tooLong }); return; }
    const tries = runTryList(orgName, parsed);
    // The version this text came from (org-members-and-keepers §D): the published one on the
    // organization's agent; for a keeper, the organization's current version read from its address.
    let base: DraftBase | null = null;
    const pub = readPublished(deps.stateDir);
    if (pub) {
      const r = pub.bundle.record;
      base = { orgId: r.orgId, version: r.version, policySha256: r.policySha256, maxIndependence: r.maxIndependence };
    } else if ((req.body as { asKeeper?: unknown })?.asKeeper === true) {
      const m = store().membership();
      const keeperMeta = m ? readJson<{ origin: string }>(path.join(deps.stateDir, 'org', 'keys', m.orgId, 'keeper-key.json')) : null;
      const origin = keeperMeta?.origin ?? m?.updateOrigin ?? null;
      const got = origin ? await orgRequest(origin, '/org/pack/current', undefined, deps.net ?? {}) : { ok: false as const };
      const held = m ? store().heldFor(m.orgId) : null;
      const v = got.ok && got.status === 200 && held ? validateBundle(got.body, held, { skipMembership: true }) : null;
      if (!v || !v.ok) { res.status(502).json({ error: 'org-unreachable', detail: "I couldn't read your organization's current policy, so I can't start a change." }); return; }
      const r = v.bundle.record;
      base = { orgId: r.orgId, version: r.version, policySha256: r.policySha256, maxIndependence: r.maxIndependence };
    }
    const draft: Draft = { id: crypto.randomUUID(), orgName, policy, createdAt: now(), tries, parsed, base };
    writeAtomic(path.join(paths.drafts, `${draft.id}.json`), JSON.stringify(draft));
    const blocked = tries.filter((t) => t.outcome === 'blocked').length;
    res.json({
      draftId: draft.id, purpose: parsed.purpose, never: parsed.never, askFirst: parsed.askFirst, normally: parsed.normally,
      other: parsed.other, unplaced: parsed.unplaced, tryList: tries, estimate: true,
      ...(blocked > tries.length / 3 ? { warning: `This blocks ${blocked} of ${tries.length} everyday requests. Consider moving some never rules to ask first.` } : {}),
    });
  })().catch((err) => failed(res, '/org/draft', err)); });

  router.post('/org/invitations', (req: Request, res: Response) => {
    const p = readPublished(deps.stateDir);
    if (!p) { res.status(409).json({ error: 'nothing-published', detail: 'Publish the policy first.' }); return; }
    if (recoveryMarker(deps.stateDir)) { res.status(409).json({ error: 'publish-after-recovery-first', detail: 'Publish the recovered policy once before making invitations.' }); return; }
    const label = typeof (req.body as { label?: unknown })?.label === 'string' ? String((req.body as { label: string }).label).slice(0, 80) : null;
    const inv = new OrgMembers(deps.stateDir, p.bundle.record.orgId, now).mintInvite();
    deps.journal?.('org-invitation-made', { orgId: p.bundle.record.orgId, version: p.bundle.record.version, label, invite: inv.id.slice(0, 12) });
    res.json({ link: `https://instar.sh/join#p=${encodeBundle(p.bundle)}&t=${inv.token}`, code: orgKeyCode(p.bundle.record.signerPublicKey), version: p.bundle.record.version, inviteId: inv.id });
  });

  router.get('/org/status', (_req: Request, res: Response) => {
    const s = store();
    const m = s.membership();
    const rec = s.currentRecord();
    const p = readPublished(deps.stateDir);
    res.json({
      membership: m, applied: rec ? { orgName: rec.orgName, version: rec.version, code: orgKeyCode(rec.signerPublicKey), maxIndependence: rec.maxIndependence } : null,
      published: p ? { orgName: p.bundle.record.orgName, version: p.bundle.record.version, code: orgKeyCode(p.bundle.record.signerPublicKey), shareUpdates: p.shareUpdates } : null,
      held: m?.state === 'joined' ? heldVersions(deps.stateDir, m.orgId) : [],
    });
  });

  // ── Work agents page, departure, keepers (org-members-and-keepers §B–D) ──
  const published = (res: Response): { orgId: string; version: number } | null => {
    const p = readPublished(deps.stateDir);
    if (!p) { res.status(409).json({ error: 'nothing-published' }); return null; }
    return { orgId: p.bundle.record.orgId, version: p.bundle.record.version };
  };
  const membersView = (orgId: string, version: number) => ({
    note: 'Names are what each agent reports.',
    members: new OrgMembers(deps.stateDir, orgId, now).list(version).map((m) => ({ ...m, namesAreReported: true })),
  });
  router.get('/org/members', (_req: Request, res: Response) => {
    const p = published(res); if (!p) return;
    res.json(membersView(p.orgId, p.version));
  });
  router.get('/mobile/org/members', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const inv = new OrgMembers(deps.stateDir, p.orgId, now).invites();
    res.json({ ...membersView(p.orgId, p.version),
      invitations: Object.entries(inv).map(([id, e]) => ({ id, createdAt: e.createdAt, uses: e.usedBy.length, maxUses: e.maxUses, revoked: !!e.revokedAt, active: e.active, restored: (e as { restored?: boolean }).restored === true })),
      keepers: new OrgKeepers(deps.stateDir, p.orgId, now).list().map((k) => ({ name: k.name, publicKey: k.publicKey, addedAt: k.addedAt, code: orgKeyCode(k.publicKey) })),
      restoredKeepers: new OrgKeepers(deps.stateDir, p.orgId, now).restored().map((k) => ({ name: k.name, publicKey: k.publicKey, code: orgKeyCode(k.publicKey) })),
      recovery: recoveryMarker(deps.stateDir) });
  });
  router.post('/mobile/org/members/remove', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const r = new OrgMembers(deps.stateDir, p.orgId, now).remove(String((req.body as { memberKey?: unknown })?.memberKey ?? ''));
    if (!r.ok) { res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error }); return; }
    deps.journal?.('org-member-removed', { orgId: p.orgId, removal: r.removal.id });
    res.json(r);
  });
  router.post('/mobile/org/members/restore', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const r = new OrgMembers(deps.stateDir, p.orgId, now).restore(String((req.body as { memberKey?: unknown })?.memberKey ?? ''));
    if (!r.ok) { res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error }); return; }
    res.json(r);
  });
  router.post('/mobile/org/invitations/revoke', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const ok = new OrgMembers(deps.stateDir, p.orgId, now).revokeInvite(String((req.body as { inviteId?: unknown })?.inviteId ?? ''));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not-found' });
  });
  router.post('/mobile/org/keepers/add', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const r = new OrgKeepers(deps.stateDir, p.orgId, now).add(String((req.body as { code?: unknown })?.code ?? ''));
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    deps.journal?.('org-keeper-added', { orgId: p.orgId, nameAsReported: r.keeper.name, code: r.fingerprint });
    res.json(r);
  });
  router.post('/mobile/org/keepers/remove', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const ok = new OrgKeepers(deps.stateDir, p.orgId, now).remove(String((req.body as { publicKey?: unknown })?.publicKey ?? ''));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not-found' });
  });

  /**
   * What the app's organization screens show (owner device): membership, the applied and published
   * policy, the newest draft waiting to be published (with its read-back and try list), and held updates
   * with their full text, so every card shows exactly what a tap would apply.
   */
  router.get('/mobile/org/status', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const s = store();
    const m = s.membership();
    const rec = s.currentRecord();
    const p = readPublished(deps.stateDir);
    let draft: Draft | null = null;
    try {
      for (const f of fs.readdirSync(paths.drafts)) {
        const d = readJson<Draft>(path.join(paths.drafts, f));
        if (d && now() - d.createdAt <= ORG_DRAFT_TTL_MS && (!draft || d.createdAt > draft.createdAt)) draft = d;
      }
    } catch { /* @silent-fallback-ok — no drafts */ }
    const held = m?.state === 'joined' ? heldVersions(deps.stateDir, m.orgId).map((v) => readJson<OrgBundle>(path.join(deps.stateDir, 'org', m.orgId, 'held', `v${v}`, 'bundle.json'))).filter(Boolean) : [];
    const policyOf = (b: OrgBundle) => ({ ...parsePolicy(b.policy), orgName: b.record.orgName, version: b.record.version, maxIndependence: b.record.maxIndependence, code: orgKeyCode(b.record.signerPublicKey) });
    res.json({
      membership: m,
      applied: rec ? { orgName: rec.orgName, version: rec.version, code: orgKeyCode(rec.signerPublicKey), maxIndependence: rec.maxIndependence } : null,
      published: p ? { ...policyOf(p.bundle), shareUpdates: p.shareUpdates } : null,
      draft: draft && (!p || draft.createdAt > Date.parse(p.bundle.record.publishedAt)) ? { draftId: draft.id, orgName: draft.orgName, ...draft.parsed, tryList: draft.tries } : null,
      held: (held as OrgBundle[]).map(policyOf),
      // Check-ins (org-members-and-keepers §A, §C): a removal waiting for the person, and the one-time consent card.
      ...(() => {
        if (!m) return {};
        const side = new OrgMemberSide(deps.stateDir, m.orgId, now).state();
        return {
          removedNotice: side?.pendingRemoval ? { at: side.pendingRemoval.at, orgName: rec?.orgName ?? null } : null,
          checkinConsentNeeded: m.state === 'joined' && !!m.updateOrigin && (!side || side.consent === null),
          // A rejoin the organization refused (a cancelled link): the person needs a new invitation.
          needsNewLink: !!side && side.pendingRejoin && !side.enrolled,
        };
      })(),
    });
  });

  // ── Recovery copy (org-recovery-copy §A–C) ──
  try { finishRecoveryInstall(deps.stateDir); } catch (err) { console.error('[org] finishing a recovery install failed:', err instanceof Error ? err.message : String(err)); }
  const phraseTries: number[] = [];

  router.post('/mobile/org/recovery-copy', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = readPublished(deps.stateDir);
    if (!p) { res.status(409).json({ error: 'nothing-published' }); return; }
    const orgId = p.bundle.record.orgId;
    let keyPem: string;
    try { keyPem = fs.readFileSync(paths.key(orgId), 'utf-8'); } catch { res.status(409).json({ error: 'org-key-elsewhere', detail: 'Make the copy on the computer that publishes this policy.' }); return; }
    const reg = new OrgMembers(deps.stateDir, orgId, now);
    const self = new OrgMemberSide(deps.stateDir, orgId, now).state()?.publicKey ?? null;
    const phrase = newRecoveryPhrase();
    let file: unknown;
    try {
      file = makeRecoveryCopy({ orgId, orgName: p.bundle.record.orgName, fingerprint: orgKeyCode(p.bundle.record.signerPublicKey) },
        { privateKeyPem: keyPem, bundle: p.bundle, selfMemberKey: self, registries: { members: reg.members(), invites: reg.invites(), keepers: new OrgKeepers(deps.stateDir, orgId, now).list() } }, phrase);
    } catch {
      res.status(413).json({ error: 'copy-too-large', detail: 'This organization is too large for a recovery copy.' });
      return;
    }
    deps.journal?.('org-recovery-copy-made', { orgId, version: p.bundle.record.version });
    res.json({ file, phrase, say: 'Write these six words down and keep them apart from the file.' });
  });

  router.post('/mobile/org/recover', (req: Request, res: Response) => { void (async () => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as { file?: unknown; phrase?: unknown; retired?: unknown };
    if (b.retired !== true) { res.status(400).json({ error: 'retirement-required', detail: 'Is your old Mac gone, wiped, or never going to run Instar again? If it might come back, start a new organization instead.' }); return; }
    if (readPublished(deps.stateDir)) { res.status(409).json({ error: 'already-publishes' }); return; }
    const t = now();
    while (phraseTries.length && t - phraseTries[0]! > 3600_000) phraseTries.shift();
    if (phraseTries.length >= 5) { res.status(429).json({ error: 'too-many-tries' }); return; }
    const opened = openRecoveryCopy(b.file, typeof b.phrase === 'string' ? b.phrase : '');
    if (!opened.ok) {
      if (opened.error === 'wrong-phrase') phraseTries.push(t);
      res.status(opened.error === 'wrong-phrase' ? 403 : 400).json({ error: opened.error });
      return;
    }
    const c = opened.contents;
    const header = b.file as { orgId: string; fingerprint: string };
    const bundle = c.bundle as OrgBundle;
    let pub: string;
    try { pub = (crypto.createPublicKey(c.privateKeyPem).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url'); } catch { res.status(400).json({ error: 'malformed' }); return; } // @silent-fallback-ok — reported as a refusal
    if (orgKeyCode(pub) !== header.fingerprint || bundle?.record?.signerPublicKey !== pub || bundle.record.orgId !== header.orgId) { res.status(400).json({ error: 'copy-does-not-match' }); return; }
    const fresh = { pinnedKey: pub, versionFloor: 0, joined: false, joinedVersion: null, joinedHash: null, joinedOrgId: null };
    const check = validateBundle(bundle, fresh, { skipMembership: true });
    if (!check.ok) { res.status(400).json({ error: check.reason }); return; }
    const mine = store().membership();
    if (mine?.state === 'joined' && mine.orgId !== header.orgId) { res.status(409).json({ error: 'member-of-another-organization' }); return; }
    // The old address still serves a record signed by this key: refuse (§B3).
    let note: string | null = null;
    if (bundle.record.updateOrigin) {
      const r = await orgRequest(bundle.record.updateOrigin, '/org/pack/current', undefined, deps.net ?? {});
      const live = r.ok && r.status === 200 ? validateBundle(r.body, fresh, { skipMembership: true }) : null;
      if (live?.ok) { res.status(409).json({ error: 'old-machine-answers', detail: `Your organization's main agent still answers at ${bundle.record.updateOrigin}. Recover only when it's gone; otherwise start a new organization.` }); return; }
    } else {
      note = "There's no address to check, so this relies on your answer that the old Mac is gone.";
    }
    // Start from the newest at hand: the copy, or this agent's own applied version (§B4).
    let start = bundle; let source: RecoveryMarker['source'] = { kind: 'copy' };
    const own = orgStateForPeer(deps.stateDir).bundle;
    if (own && own.record.orgId === header.orgId && own.record.version > bundle.record.version) { start = own; source = { kind: 'own' }; }
    // Staged install, everything at once: files (registries included), then the marker, then into place (§B5),
    // under the publish lock so a first publish can't land in between.
    const orgId = header.orgId;
    const installed = await withPublishLock(deps.stateDir, () => {
      if (readPublished(deps.stateDir)) return false;
      const staging = path.join(paths.root, 'recovery-staging');
      const scratch = path.join(staging, '.build');
      writeAtomic(path.join(staging, `${orgId}.signing-key`), c.privateKeyPem);
      writeAtomic(path.join(staging, 'current.json'), JSON.stringify({ bundle: start, shareUpdates: start.record.updateOrigin !== null }));
      new OrgMembers(scratch, orgId, now).restoreFromCopy(c.registries?.members, c.registries?.invites, c.selfMemberKey);
      new OrgKeepers(scratch, orgId, now).restoreFromCopy(c.registries?.keepers);
      const built = path.join(scratch, 'org', 'published');
      for (const n of fs.readdirSync(built)) fs.renameSync(path.join(built, n), path.join(staging, n));
      SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'org recovery: scratch' });
      writeAtomic(path.join(staging, 'plan.json'), JSON.stringify({ orgId }));
      writeAtomic(markerPath(deps.stateDir, orgId), JSON.stringify({ copyVersion: bundle.record.version, at: now(), stage: 'installing', source, orgId } satisfies RecoveryMarker));
      finishRecoveryInstall(deps.stateDir);
      return true;
    });
    if (!installed) { res.status(409).json({ error: 'already-publishes' }); return; }
    deps.journal?.('org-recovered', { orgId, copyVersion: bundle.record.version, startVersion: start.record.version, source: source.kind });
    res.json({ ok: true, orgName: start.record.orgName, version: start.record.version, source, note,
      say: 'Review the policy text, confirm your work agents, turn keepers and links back on, then publish once.' });
  })().catch((err) => failed(res, '/mobile/org/recover', err)); });

  router.post('/mobile/org/recover-latest', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    withPublishLock(deps.stateDir, () => {
      const m = recoveryMarker(deps.stateDir);
      const cur = readPublished(deps.stateDir);
      if (!m || !cur) { res.status(409).json({ error: 'not-recovering' }); return; }
      const b = (req.body ?? {}) as { bundle?: unknown; label?: unknown };
      const v = validateBundle(b.bundle, { pinnedKey: cur.bundle.record.signerPublicKey, versionFloor: 0, joined: false, joinedVersion: null, joinedHash: null, joinedOrgId: null }, { skipMembership: true });
      if (!v.ok) { res.status(400).json({ error: v.reason }); return; }
      if (v.bundle.record.orgId !== cur.bundle.record.orgId) { res.status(400).json({ error: 'another-organization' }); return; }
      if (v.bundle.record.version <= cur.bundle.record.version) { res.json({ ok: true, kept: cur.bundle.record.version }); return; }
      writeAtomic(paths.current, JSON.stringify({ bundle: v.bundle, shareUpdates: cur.shareUpdates }));
      const label = plainName(typeof b.label === 'string' && b.label.trim() ? b.label : "a colleague's agent") ?? "a colleague's agent";
      writeAtomic(markerPath(deps.stateDir, m.orgId), JSON.stringify({ ...m, source: { kind: 'colleague', label } }));
      res.json({ ok: true, kept: v.bundle.record.version, source: label });
    }).catch((err) => failed(res, '/mobile/org/recover-latest', err));
  });

  router.get('/mobile/org/current-bundle', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const b = orgStateForPeer(deps.stateDir).bundle;
    if (!b) { res.status(404).json({ error: 'not-a-member' }); return; }
    res.json({ bundle: b });
  });

  router.post('/mobile/org/recovery/:what/:act', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const p = published(res); if (!p) return;
    const { what, act } = req.params as { what: string; act: string };
    const body = (req.body ?? {}) as { publicKey?: unknown; inviteId?: unknown; memberKey?: unknown; all?: unknown };
    if (what === 'keepers' && (act === 'reactivate' || act === 'discard')) {
      const k = new OrgKeepers(deps.stateDir, p.orgId, now);
      const key = String(body.publicKey ?? '');
      const r = act === 'reactivate' ? k.reactivate(key) : (k.discardRestored(key) ? { ok: true as const } : { ok: false as const, error: 'not-found' });
      res.status(r.ok ? 200 : 409).json(r); return;
    }
    if (what === 'invitations' && (act === 'reactivate' || act === 'discard')) {
      const reg = new OrgMembers(deps.stateDir, p.orgId, now);
      const id = String(body.inviteId ?? '');
      const ok = act === 'reactivate' ? reg.reactivateInvite(id) : reg.revokeInvite(id);
      res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not-found' }); return;
    }
    if (what === 'members' && act === 'confirm') {
      const n = new OrgMembers(deps.stateDir, p.orgId, now).confirm(body.all === true ? 'all' : String(body.memberKey ?? ''));
      res.json({ ok: true, confirmed: n }); return;
    }
    res.status(404).json({ error: 'not-found' });
  });

  router.post('/mobile/org/checkin-consent', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const m = store().membership();
    if (!m || m.state !== 'joined') { res.status(409).json({ error: 'not-a-member' }); return; }
    const b = (req.body ?? {}) as { allow?: unknown; dismissRemoval?: unknown };
    const side = new OrgMemberSide(deps.stateDir, m.orgId, now);
    if (!side.state()) side.onJoin({ afterLeave: false, consent: false });
    if (b.dismissRemoval === true) side.dismissRemoval();
    if (typeof b.allow === 'boolean') side.setConsent(b.allow);
    res.json({ ok: true });
  });

  // ── The keeper's own agent (org-members-and-keepers §D) ──
  router.post('/mobile/org/keeper-request', (req: Request, res: Response) => { void (async () => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as { invitationLink?: unknown; name?: unknown };
    const m = store().membership();
    let orgId = m?.state === 'joined' ? m.orgId : null;
    let origin = m?.state === 'joined' ? m.updateOrigin : null;
    if (typeof b.invitationLink === 'string') {
      const frag = /#p=([A-Za-z0-9_-]+)/.exec(b.invitationLink);
      const d = frag ? decodeBundle(frag[1]!) : null;
      if (!d || !d.ok) { res.status(400).json({ error: 'link-unreadable' }); return; }
      orgId = d.bundle.record.orgId; origin = d.bundle.record.updateOrigin;
    }
    if (!orgId || !origin) { res.status(409).json({ error: 'organization-address-needed', detail: 'Join the organization, or paste one of its invitation links.' }); return; }
    const name = plainName(typeof b.name === 'string' ? b.name : deps.ownerName());
    if (!name) { res.status(400).json({ error: 'name-not-plain' }); return; }
    const keyFile = path.join(deps.stateDir, 'org', 'keys', orgId, 'keeper-key');
    let publicKey: string;
    const existing = readJson<{ publicKey: string; origin: string }>(`${keyFile}.json`);
    if (existing && fs.existsSync(keyFile)) { publicKey = existing.publicKey; }
    else {
      const kp = newMemberKeyPair();
      writeAtomic(keyFile, kp.privateKeyPem);
      publicKey = kp.publicKey;
    }
    writeAtomic(`${keyFile}.json`, JSON.stringify({ publicKey, origin }));
    res.json({ code: encodeKeeperCode({ orgId, name, publicKey }), fingerprint: orgKeyCode(publicKey),
      say: 'Send this code to the person who publishes your organization\'s policy. They read the key code back to you to check it.' });
  })().catch((err) => failed(res, '/mobile/org/keeper-request', err)); });

  router.post('/mobile/org/keeper-propose', (req: Request, res: Response) => { void (async () => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.readBackConfirmed !== true) { res.status(400).json({ error: 'read-back-required' }); return; }
    const draft = typeof b.draftId === 'string' && /^[0-9a-f-]{36}$/.test(b.draftId) ? readJson<Draft>(path.join(paths.drafts, `${b.draftId}.json`)) : null;
    if (!draft || !draft.base) { res.status(404).json({ error: 'draft-not-found' }); return; }
    const keyFile = path.join(deps.stateDir, 'org', 'keys', draft.base.orgId, 'keeper-key');
    const meta = readJson<{ publicKey: string; origin: string }>(`${keyFile}.json`);
    let pem: string;
    try { pem = fs.readFileSync(keyFile, 'utf-8'); } catch { res.status(409).json({ error: 'not-a-keeper-here' }); return; }
    if (!meta) { res.status(409).json({ error: 'not-a-keeper-here' }); return; }
    const maxIndependence = (typeof b.maxIndependence === 'string' && INDEPENDENCE.has(b.maxIndependence as MaxIndependence) ? b.maxIndependence : draft.base.maxIndependence) as MaxIndependence;
    const proposal = signPayload({ v: 1 as const, orgId: draft.base.orgId, baseVersion: draft.base.version, basePolicySha256: draft.base.policySha256,
      policy: draft.policy, maxIndependence, proposedBy: deps.ownerName(), keeperKey: meta.publicKey, at: now() }, pem);
    const r = await orgRequest(meta.origin, '/org/pack/propose', proposal, deps.net ?? {});
    if (!r.ok) { res.status(502).json({ error: 'org-unreachable', detail: "The organization's main agent isn't reachable right now, so this version can't go out." }); return; }
    res.status(r.status).json(r.body);
  })().catch((err) => failed(res, '/mobile/org/keeper-propose', err)); });

  router.post('/mobile/org/publish', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    // Publish and a keeper's proposal run one at a time (org-members-and-keepers §D).
    // Any throw inside answers 500 instead of leaving the app waiting (Express 4 does not catch async errors).
    withPublishLock(deps.stateDir, () => publish(req, res)).catch((err) => failed(res, 'org publish', err));
  });
  const publish = (req: Request, res: Response): void => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const draft = typeof b.draftId === 'string' && /^[0-9a-f-]{36}$/.test(b.draftId) ? readJson<Draft>(path.join(paths.drafts, `${b.draftId}.json`)) : null;
    if (!draft || now() - draft.createdAt > ORG_DRAFT_TTL_MS) { res.status(404).json({ error: 'draft-not-found', detail: 'Make the draft again; drafts last 24 hours.' }); return; }
    const maxIndependence = (typeof b.maxIndependence === 'string' && INDEPENDENCE.has(b.maxIndependence as MaxIndependence) ? b.maxIndependence : 'balanced') as MaxIndependence;
    const keepers = Array.isArray(b.keepers) ? b.keepers.filter((k): k is string => typeof k === 'string').slice(0, 5) : [];
    const shareUpdates = b.shareUpdates !== false;
    if (b.readBackConfirmed !== true) { res.status(400).json({ error: 'read-back-required', detail: 'Read the policy back to the person before publishing.' }); return; }
    const prev = readPublished(deps.stateDir);
    const recovered = recoveryMarker(deps.stateDir);
    // A draft with no base was made before anything was published (or before this check existed): once
    // something is published it is stale by definition, so it is shown again rather than overwriting.
    if (prev && (!draft.base || draft.base.version !== prev.bundle.record.version || draft.base.policySha256 !== prev.bundle.record.policySha256)) {
      res.status(409).json({ error: 'stale-base', detail: 'The policy changed since this draft (a keeper published a version). Review the newer text first.', current: prev.bundle });
      return;
    }
    const orgId = prev?.bundle.record.orgId ?? `org_${crypto.randomBytes(16).toString('base64url')}`;
    let keyPem: string;
    let publicKey: string;
    if (prev) {
      // Only the machine holding the organization's key publishes (§A).
      try { keyPem = fs.readFileSync(paths.key(orgId), 'utf-8'); } catch {
        res.status(409).json({ error: 'org-key-elsewhere', detail: 'Publish from the computer that first published this policy.' });
        return;
      }
      publicKey = prev.bundle.record.signerPublicKey;
    } else {
      const kp = newOrgKeyPair();
      writeAtomic(paths.key(orgId), kp.privateKeyPem);
      keyPem = kp.privateKeyPem;
      publicKey = kp.publicKey;
    }
    // After a recovery (org-recovery-copy §B7): +1000, and the found record's settings unless changed on screen.
    const pr = prev?.bundle.record;
    const share = recovered && b.shareUpdates === undefined && prev ? prev.shareUpdates : shareUpdates;
    const record: OrgRecord = signRecord({
      v: 1, orgId, orgName: draft.orgName, version: (pr?.version ?? 0) + (recovered ? 1000 : 1), policySha256: sha256Hex(draft.policy),
      maxIndependence: recovered && typeof b.maxIndependence !== 'string' && pr ? pr.maxIndependence : maxIndependence,
      publishedAt: new Date(now()).toISOString(), publishedBy: deps.ownerName(),
      keepers: recovered && !Array.isArray(b.keepers) && pr ? pr.keepers : keepers,
      updateOrigin: share ? deps.updateOrigin() : null, signerPublicKey: publicKey,
    }, keyPem);
    const bundle: OrgBundle = { record, policy: draft.policy };
    // The publisher follows its own policy first; only a pack that applies here is made public.
    const applied = store().apply(bundle, { replaceHandEdit: b.replaceHandEdit === true }, deps.effects());
    if (!applied.ok) {
      if (!prev) SafeFsExecutor.safeUnlinkSync(paths.key(orgId), { operation: 'org publish: unused key' });
      res.status(409).json({ error: applied.reason });
      return;
    }
    writeAtomic(paths.current, JSON.stringify({ bundle, shareUpdates: share }));
    if (recovered) SafeFsExecutor.safeUnlinkSync(markerPath(deps.stateDir, orgId), { operation: 'org recovery: first publish done' });
    // The publisher's own agent is a member without an invitation (members-and-keepers §A).
    const side = new OrgMemberSide(deps.stateDir, orgId, now).onJoin({ afterLeave: false, consent: true });
    new OrgMembers(deps.stateDir, orgId, now).registerSelf(side.publicKey, deps.agentName?.() ?? '', deps.ownerName(), record.version);
    deps.journal?.('org-pack-published', { orgId, version: record.version, draftId: draft.id, readBackConfirmed: true, tries: draft.tries });
    res.json({
      record, code: orgKeyCode(publicKey), applied,
      shared: shareUpdates ? 'Anyone you send an invitation to, and anyone who can reach my address, can read this policy.' : 'Anyone you send an invitation to can read this policy.',
    });
  };

  router.post('/mobile/org/join', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const decoded = decodeBundle(typeof b.bundle === 'string' ? b.bundle : '');
    if (!decoded.ok) { res.status(400).json({ error: decoded.reason }); return; }
    const s = store();
    const before = s.membership();
    const r = s.apply(decoded.bundle, { replaceHandEdit: b.replaceHandEdit === true }, deps.effects());
    if (!r.ok) { res.status(409).json({ error: r.reason }); return; }
    // The member key, the link's token and a rejoin after a leave (org-members-and-keepers §A). The
    // join screen showed what check-ins report, so joining is the consent.
    new OrgMemberSide(deps.stateDir, decoded.bundle.record.orgId, now).onJoin({
      inviteToken: typeof b.inviteToken === 'string' ? b.inviteToken : null,
      afterLeave: before?.orgId === decoded.bundle.record.orgId && before.state === 'left', consent: true,
    });
    const m = s.membership();
    if (m) (deps.fanOut ?? orgFanOut)({ membership: m, bundle: decoded.bundle });
    res.json(r);
  });

  router.post('/mobile/org/leave', (req: Request, res: Response) => { void (async () => {
    if (!deviceOnly(req, res)) return;
    const s = store();
    // One "left" check-in from the membership as it stands before the leave, best effort (§A).
    const was = s.membership();
    if (was?.state === 'joined' && was.updateOrigin) {
      try {
        await new OrgMemberSide(deps.stateDir, was.orgId, now).send(was.updateOrigin,
          { agentName: deps.agentName?.() ?? '', personName: deps.ownerName(), appliedVersion: was.version ?? 0, state: 'left' }, deps.net);
      } catch { /* @silent-fallback-ok — the organization learns of the leave when it next misses a check-in */ }
    }
    const r = s.leave({}, deps.effects());
    if (!r.ok) { res.status(409).json({ error: r.reason }); return; }
    const m = s.membership();
    if (m) (deps.fanOut ?? orgFanOut)({ membership: m, bundle: null });
    res.json(r);
  })().catch((err) => failed(res, '/mobile/org/leave', err)); });

  router.post('/mobile/org/update-accept', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const version = Number((req.body as { version?: unknown })?.version);
    const s = store();
    const m = s.membership();
    if (!m || m.state !== 'joined' || !Number.isSafeInteger(version)) { res.status(409).json({ error: 'not-member' }); return; }
    const held = readJson<OrgBundle>(path.join(deps.stateDir, 'org', m.orgId, 'held', `v${version}`, 'bundle.json'));
    if (!held) { res.status(404).json({ error: 'no-held-update' }); return; }
    const r = s.apply(held, {}, deps.effects());
    if (!r.ok) { res.status(409).json({ error: r.reason }); return; }
    SafeFsExecutor.safeRmSync(path.join(deps.stateDir, 'org', m.orgId, 'held', `v${version}`), { recursive: true, force: true, operation: 'org update accepted' });
    const after = s.membership();
    if (after) (deps.fanOut ?? orgFanOut)({ membership: after, bundle: held });
    res.json(r);
  });

  return router;
}

function heldVersions(stateDir: string, orgId: string): number[] {
  try {
    return fs.readdirSync(path.join(stateDir, 'org', orgId, 'held')).filter((n) => /^v\d+$/.test(n)).map((n) => Number(n.slice(1))).sort((a, b) => a - b);
  } catch { return []; } // @silent-fallback-ok — no held updates
}
