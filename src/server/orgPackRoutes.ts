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
import { hiddenCharIn, readStandardPolicy, standardizePolicy } from '../core/OrgPolicyGrammar.js';

/** A stored policy for display: the standard reading, or (an older pack from before the standard form) the loose one. */
function standardOrLoose(policy: string): ParsedPolicy {
  const s = readStandardPolicy(policy);
  return s.ok ? s.parsed : parsePolicy(policy);
}
import { OrgPackStore, type ApplyEffects, type Membership } from '../core/OrgPackStore.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

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

interface Draft { id: string; orgName: string; policy: string; createdAt: number; tries: TryResult[]; parsed: ParsedPolicy }
interface TryResult { request: string; outcome: 'allowed' | 'ask' | 'blocked'; matched?: string }

export interface OrgPackRouteDeps {
  stateDir: string;
  machineId: string;
  /** The agent's stable https origin for updates (§A updateOrigin), when it has one. */
  updateOrigin: () => string | null;
  /** Who publishes (the owner's name). */
  ownerName: () => string;
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

/** GET /org/pack/current, mounted before auth (§B). */
export function mountPublicOrgPackRoutes(app: Application, stateDir: string): void {
  app.get('/org/pack/current', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const p = readPublished(stateDir);
    if (!p || !p.shareUpdates) { res.status(404).json({ error: 'not-found' }); return; }
    res.json(p.bundle);
  });
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

  router.post('/org/draft', (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const orgName = typeof b.orgName === 'string' ? b.orgName.replace(/[\x00-\x1f\x7f#*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const policy = typeof b.policyMarkdown === 'string' ? b.policyMarkdown : '';
    if (!orgName || !policy.trim()) { res.status(400).json({ error: 'orgName and policyMarkdown are required' }); return; }
    if (Buffer.byteLength(policy, 'utf8') > 64 * 1024) { res.status(413).json({ error: 'policy-too-long' }); return; }
    // The draft is rewritten into the one standard form, or refused with the reason (SEC-077/078):
    // what the admin reads back, signs, members see on the join screen and the agent applies is that text.
    const std = standardizePolicy(policy);
    if (!std.ok) { res.status(400).json({ error: 'policy-not-standard', detail: std.detail }); return; }
    if (/<!--|-->/.test(orgName)) { res.status(400).json({ error: 'policy-not-standard', detail: 'The organization name can\'t contain <!-- or -->.' }); return; }
    if (hiddenCharIn(orgName)) { res.status(400).json({ error: 'policy-not-standard', detail: 'The organization name has a character nobody can see. Retype it.' }); return; }
    const parsed = std.parsed;
    const tooLong = policyTooLong(parsed);
    if (tooLong) { res.status(400).json({ error: 'policy-too-long', detail: tooLong }); return; }
    const tries = runTryList(orgName, parsed);
    const draft: Draft = { id: crypto.randomUUID(), orgName, policy: std.text, createdAt: now(), tries, parsed };
    writeAtomic(path.join(paths.drafts, `${draft.id}.json`), JSON.stringify(draft));
    const blocked = tries.filter((t) => t.outcome === 'blocked').length;
    res.json({
      draftId: draft.id, policyMarkdown: std.text, purpose: parsed.purpose, never: parsed.never, askFirst: parsed.askFirst, normally: parsed.normally,
      other: parsed.other, unplaced: parsed.unplaced, tryList: tries, estimate: true,
      ...(blocked > tries.length / 3 ? { warning: `This blocks ${blocked} of ${tries.length} everyday requests. Consider moving some never rules to ask first.` } : {}),
    });
  });

  router.post('/org/invitations', (req: Request, res: Response) => {
    const p = readPublished(deps.stateDir);
    if (!p) { res.status(409).json({ error: 'nothing-published', detail: 'Publish the policy first.' }); return; }
    const label = typeof (req.body as { label?: unknown })?.label === 'string' ? String((req.body as { label: string }).label).slice(0, 80) : null;
    deps.journal?.('org-invitation-made', { orgId: p.bundle.record.orgId, version: p.bundle.record.version, label });
    res.json({ link: `https://instar.sh/join#p=${encodeBundle(p.bundle)}`, code: orgKeyCode(p.bundle.record.signerPublicKey), version: p.bundle.record.version });
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
    const policyOf = (b: OrgBundle) => ({ ...standardOrLoose(b.policy), orgName: b.record.orgName, version: b.record.version, maxIndependence: b.record.maxIndependence, code: orgKeyCode(b.record.signerPublicKey) });
    res.json({
      membership: m,
      applied: rec ? { orgName: rec.orgName, version: rec.version, code: orgKeyCode(rec.signerPublicKey), maxIndependence: rec.maxIndependence } : null,
      published: p ? { ...policyOf(p.bundle), shareUpdates: p.shareUpdates } : null,
      draft: draft && (!p || draft.createdAt > Date.parse(p.bundle.record.publishedAt)) ? { draftId: draft.id, orgName: draft.orgName, ...draft.parsed, tryList: draft.tries } : null,
      held: (held as OrgBundle[]).map(policyOf),
    });
  });

  router.post('/mobile/org/publish', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const draft = typeof b.draftId === 'string' && /^[0-9a-f-]{36}$/.test(b.draftId) ? readJson<Draft>(path.join(paths.drafts, `${b.draftId}.json`)) : null;
    if (!draft || now() - draft.createdAt > ORG_DRAFT_TTL_MS) { res.status(404).json({ error: 'draft-not-found', detail: 'Make the draft again; drafts last 24 hours.' }); return; }
    const maxIndependence = (typeof b.maxIndependence === 'string' && INDEPENDENCE.has(b.maxIndependence as MaxIndependence) ? b.maxIndependence : 'balanced') as MaxIndependence;
    const keepers = Array.isArray(b.keepers) ? b.keepers.filter((k): k is string => typeof k === 'string').slice(0, 5) : [];
    const shareUpdates = b.shareUpdates !== false;
    if (b.readBackConfirmed !== true) { res.status(400).json({ error: 'read-back-required', detail: 'Read the policy back to the person before publishing.' }); return; }
    const prev = readPublished(deps.stateDir);
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
    const record: OrgRecord = signRecord({
      v: 1, orgId, orgName: draft.orgName, version: (prev?.bundle.record.version ?? 0) + 1, policySha256: sha256Hex(draft.policy),
      maxIndependence, publishedAt: new Date(now()).toISOString(), publishedBy: deps.ownerName(), keepers,
      updateOrigin: shareUpdates ? deps.updateOrigin() : null, signerPublicKey: publicKey,
    }, keyPem);
    const bundle: OrgBundle = { record, policy: draft.policy };
    // The publisher follows its own policy first; only a pack that applies here is made public.
    const applied = store().apply(bundle, { replaceHandEdit: b.replaceHandEdit === true }, deps.effects());
    if (!applied.ok) {
      if (!prev) SafeFsExecutor.safeUnlinkSync(paths.key(orgId), { operation: 'org publish: unused key' });
      res.status(409).json({ error: applied.reason });
      return;
    }
    writeAtomic(paths.current, JSON.stringify({ bundle, shareUpdates }));
    deps.journal?.('org-pack-published', { orgId, version: record.version, draftId: draft.id, readBackConfirmed: true, tries: draft.tries });
    res.json({
      record, code: orgKeyCode(publicKey), applied,
      shared: shareUpdates ? 'Anyone you send an invitation to, and anyone who can reach my address, can read this policy.' : 'Anyone you send an invitation to can read this policy.',
    });
  });

  router.post('/mobile/org/join', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const decoded = decodeBundle(typeof b.bundle === 'string' ? b.bundle : '');
    if (!decoded.ok) { res.status(400).json({ error: decoded.reason }); return; }
    const s = store();
    const r = s.apply(decoded.bundle, { replaceHandEdit: b.replaceHandEdit === true }, deps.effects());
    if (!r.ok) { res.status(409).json({ error: r.reason }); return; }
    const m = s.membership();
    if (m) (deps.fanOut ?? orgFanOut)({ membership: m, bundle: decoded.bundle });
    res.json(r);
  });

  router.post('/mobile/org/leave', (req: Request, res: Response) => {
    if (!deviceOnly(req, res)) return;
    const s = store();
    const r = s.leave({}, deps.effects());
    if (!r.ok) { res.status(409).json({ error: r.reason }); return; }
    const m = s.membership();
    if (m) (deps.fanOut ?? orgFanOut)({ membership: m, bundle: null });
    res.json(r);
  });

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
