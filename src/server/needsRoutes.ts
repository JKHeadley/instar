/**
 * The Needs-you list: one read for every surface (docs/specs/work-front-doors.md, decision 2, §7 stage 1).
 *
 *   GET /needs          the console and the agent (bearer)
 *   GET /mobile/needs   the phone apps and the Mac app (device signature; same answer)
 *
 * Built from exactly what the console's Home counts today: the attention queue (Home's own rule),
 * promises due soon, and every source in `NEED_SOURCES` (dashboard/console/needs-model.js), each read
 * over this server's own loopback with its own token and turned into rows by the console's own pure
 * models. So the console, the phones and the Mac app cannot disagree with each other or with the page
 * a row opens.
 *
 * Filtered per viewer. The owner (bearer, the console, the owner's phone) sees every source. A team
 * person's phone (member or guest) sees only the work board, read as that person, so it shows only
 * cards they may read; every owner-only source is left out for them and named `not-for-viewer`,
 * never "could not check" and never counted.
 *
 * Honest emptiness: `complete` is true only when every source this viewer gets answered (or is
 * switched off). A failed or unreadable source is listed in `couldNotCheck` with a plain label, so a
 * surface can say "could not check <source>" and mark its badge incomplete instead of showing zero.
 *
 * This route is a signal, not an authority: it reads and lists; it never approves, hides or changes
 * anything. Every row's action opens the source's own page, where the existing authorization applies.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Request, Response, Router } from 'express';
import { ownerOrBearer } from './mobileCapacityRoutes.js';
import { deviceAdmissionIdentity, devicePersonOf, DEVICE_ALLOWLIST } from './mobilePairingRoutes.js';
import { tierAtLeast } from '../permissions/TeamAccess.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';
import { operatorError } from '../core/storageMachineName.js';

export const NEEDS_SCHEMA_VERSION = 1;
/** One answer is shared by every caller for this long (the phones, the console and the Mac app poll). */
export const NEEDS_CACHE_MS = 10_000;
/** The most rows one answer carries; the count still counts them all. */
export const NEEDS_MAX_ITEMS = 100;
/** How many of this server's own routes the read asks at once. */
export const NEEDS_MAX_CONCURRENT_READS = 6;
/** Each self-read's own deadline (the console's MIN_TIMEOUT_MS). */
export const NEEDS_READ_TIMEOUT_MS = 20_000;
/** A source whose read failed keeps its last good rows this long (the console's own grace). */
export const NEEDS_GRACE_MS = 120_000;
const TITLE_MAX = 200;
const DETAIL_MAX = 400;

type Rec = Record<string, unknown>;
/** One of this server's own routes, read with its own token; status 0 = no answer at all. */
export interface NeedsSelfRead { status: number; body: unknown }

/** Plain words for "could not check <source>", by NEED_SOURCES id (plus the two Home reads). */
export const NEED_SOURCE_LABELS: Record<string, string> = {
  attention: 'the attention queue',
  promises: 'promises waiting on you',
  health: 'the agent’s health',
  repos: 'repositories with no copy anywhere else',
  merging: 'pull request merging',
  'shipping-approvals': 'pull requests waiting for approval',
  feedback: 'the feedback queue',
  accounts: 'accounts and sign-ins',
  agents: 'other agents',
  approvals: 'permission requests',
  'trust-requests': 'changes waiting for approval',
  plans: 'plans',
  'chief-of-staff': 'the Chief of Staff',
  workBoard: 'the work board',
  secrets: 'passwords and keys',
  spending: 'spending',
  'skill-learning-proposals': 'learned skills',
  'learned-pending': 'skills waiting for your OK',
  context: 'conversation summaries',
  'document-decisions': 'documents waiting for your decision',
};

/**
 * Multi-machine posture of every source (spec §4.5): any one machine must return the person's full
 * list from its own replicas or its own merged read. A source that is machine-local says why, and
 * whether that can hide a need that lives on another machine.
 */
export const NEED_SOURCE_POSTURE: Record<string, { posture: 'replicated' | 'pool-merged' | 'lease-holder' | 'machine-local'; why: string }> = {
  attention: { posture: 'pool-merged', why: 'read with scope=pool: every online machine answers, and one that did not is named.' },
  promises: { posture: 'replicated', why: 'CommitmentsSync replicas merged on read (scope=mesh), each with its age.' },
  repos: { posture: 'pool-merged', why: 'read with scope=pool: each machine answers live, an unreachable one from its replicated owned-repo records, else it is named unknown.' },
  health: { posture: 'machine-local', why: 'by design: the health of the machine answering (mobile-health-issues.md); the phone asks every machine it can reach.' },
  merging: { posture: 'machine-local', why: 'the merge watcher works on the lease holder; a non-holder shows its own snapshot (green-pr-automerge-enforcement.md).' },
  'shipping-approvals': { posture: 'machine-local', why: 'as merging.' },
  feedback: { posture: 'machine-local', why: 'read only where the merge watcher answers (maintainer agents), exactly as Home; the two authority proposals read the local drain copy.' },
  accounts: { posture: 'pool-merged', why: 'read with scope=pool; sign-in repair stays on the machine with the browser (hardware-bound).' },
  agents: { posture: 'machine-local', why: 'pending pairings and invites are tied to the relay holder and its in-memory secret (threadline-standalone-pairing.md).' },
  'trust-requests': { posture: 'replicated', why: 'trustJourney request records replicate to every machine; current app eligibility is read only on the serving holder and is unknown elsewhere.' },
  approvals: { posture: 'machine-local', why: 'by design (OPERATOR-AUTHORIZATION-REQUEST-SPEC FD-6): the grant lands on the holder; its pending-approval item reaches every machine through the pooled attention read.' },
  plans: { posture: 'machine-local', why: 'initiatives replicate only where git-sync carries them; blockers are local until their replicated store is built.' },
  'chief-of-staff': { posture: 'replicated', why: 'chief-of-staff-record journal replicates to every peer.' },
  workBoard: { posture: 'replicated', why: 'work-card-record journal replicates; a machine that is behind says so.' },
  secrets: { posture: 'machine-local', why: 'by design: pending secret requests live in memory only and never touch disk (SecretDrop).' },
  spending: { posture: 'machine-local', why: 'by design: money is single-writer on one PIN-designated machine (physical-credential-locality).' },
  'skill-learning-proposals': { posture: 'replicated', why: 'git-synced skills and ledgers; each machine builds its own status from them.' },
  'learned-pending': { posture: 'replicated', why: 'as skill-learning-proposals.' },
  context: { posture: 'machine-local', why: 'by design: one watcher per machine, acting on the topics that machine owns.' },
  'document-decisions': { posture: 'replicated', why: 'document rows replicate to every machine; a machine that is behind on a document shows its own fold (document-decisions §6).' },
};

export type NeedsViewerRole = 'owner' | 'member' | 'guest' | 'team' | 'msp';

export interface NeedItem {
  id: string;
  title: string;
  /** Why this needs the person (the row's own reason, or the source's). */
  why: string;
  detail: string | null;
  tone: 'bad' | 'attn' | 'unknown';
  source: string;
  sourceLabel: string;
  /** href = a console hash (or /dashboard path); topic = a conversation; attention = the attention topic; promise = a promise. */
  action: { kind: 'href'; href: string } | { kind: 'topic'; topicId: number } | { kind: 'attention' } | { kind: 'promise'; id: string; origin: string | null };
  refs: string[];
  /**
   * The work-board card that stands in for this item (docs/specs/work-board-cards-appear.md §3): the row keeps its
   * own words and action; the card is one tap away. Additive and optional: a reader that does not know it shows the row.
   */
  card?: { id: string; href: string; label: string };
  /**
   * When the item IS its card (the Chief of Staff's wait card, needs-one-list), `action` opens the card and this is the
   * source's own page (the project conversation), one tap away. Additive and optional: a reader that does not know it
   * opens the card, which links on to the project.
   */
  alsoOpens?: { href: string; label: string };
  /**
   * A pull request waiting for the owner's approval on GitHub (docs/specs/github-approval-from-the-app.md).
   * Additive and optional: `githubUrl` opens its changes, `headSha` is the version the owner would approve, and
   * `approveAvailable` says whether this machine can record the approval on the owner's Face ID tap
   * (POST /mobile/github/approvals/:pr/approve). A reader that does not know them shows the row as before.
   */
  pr?: number;
  githubUrl?: string;
  prTitle?: string;
  prSummary?: string;
  headSha?: string;
  approveAvailable?: boolean;
}

export interface NeedsAnswer {
  schemaVersion: number;
  generatedAt: string;
  machineId: string | null;
  agent: { name: string | null };
  viewer: { role: NeedsViewerRole };
  count: number;
  complete: boolean;
  items: NeedItem[];
  truncated: boolean;
  continuation?: { start: number; previousCursor: string | null; nextCursor: string | null };
  /** posture: where this source's answer comes from when the agent runs on several machines (spec §4.5). */
  sources: Array<{ id: string; label: string; state: 'ok' | 'off' | 'failed' | 'not-for-viewer'; posture?: string }>;
  couldNotCheck: string[];
  notes: string[];
}

export interface NeedsDeps {
  /** GET one of this server's own routes with its own token. */
  read: (path: string) => Promise<NeedsSelfRead>;
  bearerOk: (req: Request) => boolean;
  /** The work board read as this request's caller (a team person sees only their cards). */
  boardFor: (req: Request) => NeedsSelfRead;
  /** Where the console's models live (`<package>/dashboard/console`). */
  consoleDir?: string;
  agentName: () => string | null;
  machineId: () => string | null;
  now?: () => number;
}

/** The console directory next to this file, in both the source and the built layout. */
export function resolveConsoleDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    const dir = path.resolve(here, ...up, 'dashboard', 'console');
    if (fs.existsSync(path.join(dir, 'needs-model.js'))) return dir;
  }
  return path.resolve(here, '..', '..', 'dashboard', 'console');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ConsoleModels { needs: any; home: any }
const modelCache = new Map<string, Promise<ConsoleModels>>();
function loadModels(dir: string): Promise<ConsoleModels> {
  let p = modelCache.get(dir);
  if (!p) {
    p = Promise.all([
      import(pathToFileURL(path.join(dir, 'needs-model.js')).href),
      import(pathToFileURL(path.join(dir, 'home-model.js')).href),
    ]).then(([needs, home]) => ({ needs, home }));
    p.catch(() => modelCache.delete(dir)); // @silent-fallback-ok — a failed load is retried next read; the caller still gets the rejection
    modelCache.set(dir, p);
  }
  return p;
}

/** The console's read result shape (console.js getOnce), from a self-read. */
export function consoleResult(r: NeedsSelfRead): Rec {
  // A 503 that says the feature is still starting (or not ready) is not "off": the list must not read it as nothing waiting.
  if (r.status === 503) {
    const err = String(((r.body && typeof r.body === 'object' ? (r.body as Rec).error : '') ?? '')) + ' ' + String(((r.body && typeof r.body === 'object' ? (r.body as Rec).reason : '') ?? ''));
    // A 503 that says it is disabled ("enabled is false", "disabled", "off") is off, whatever else it says.
    if (/enabled[^a-z]{0,3}(is[ -])?false|disabled|switched off|not enabled|\boff\b/i.test(err)) return { ok: false, reason: 'switched off on this agent' };
    return /starting|not[ -]?(yet[ -])?(ready|initiali[sz]ed|constructed)|warming/i.test(err) ? { ok: false, reason: 'still starting' } : { ok: false, reason: 'switched off on this agent' };
  }
  if (r.status === 0) return { ok: false, reason: 'the server could not be reached' };
  if (r.status < 200 || r.status >= 300) return { ok: false, reason: `the server answered ${r.status}` };
  if (r.body === null || r.body === undefined) return { ok: false, reason: 'the answer was not readable' };
  return { ok: true, data: r.body };
}

/** Free text for any screen: secrets scrubbed, whitespace folded, length capped. */
function clean(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  // Fold whitespace before scrubbing, so a secret split by a long run of spaces is still whole when scrubbed.
  const folded = s.slice(0, (max + 2048) * 4).replace(/\s+/g, ' ').slice(0, max + 2048);
  const scrubbed = scrubSecrets(folded).trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1).trimEnd()}…` : scrubbed;
}

async function boundedAll<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

const DEFAULT_WHY: Record<string, string> = {
  attention: 'Raised for you in the attention queue.',
  promises: 'A promise that waits on you and is due soon.',
  workBoard: 'This card is waiting on you.',
  'document-decisions': 'A document asks for your decision. Decide on your phone.',
};

function toItem(row: Rec, source: string): NeedItem {
  const a = (row.action && typeof row.action === 'object' ? row.action : {}) as Rec;
  let action: NeedItem['action'];
  if (a.kind === 'topic' && Number.isFinite(Number(a.topicId))) action = { kind: 'topic', topicId: Number(a.topicId) };
  else if (a.kind === 'promise' && typeof a.id === 'string') action = { kind: 'promise', id: a.id, origin: typeof a.origin === 'string' ? a.origin : null };
  else if (a.kind === 'href' && typeof a.href === 'string' && /^(#\/|\/dashboard\/|\/docs\/[0-9a-f-]{36}$)/.test(a.href)) action = { kind: 'href', href: a.href };
  else action = { kind: 'attention' };
  const sub = clean(row.sub, DETAIL_MAX);
  const detail = clean(row.detail, DETAIL_MAX);
  return {
    id: clean(row.key, 240) || `${source}:${clean(row.main, 80)}`,
    title: clean(row.main, TITLE_MAX) || 'Something needs you',
    why: sub || DEFAULT_WHY[source] || `From ${NEED_SOURCE_LABELS[source] || source}.`,
    detail: detail || null,
    tone: row.tone === 'bad' ? 'bad' : row.tone === 'unknown' ? 'unknown' : 'attn',
    source,
    sourceLabel: NEED_SOURCE_LABELS[source] || source,
    action,
    refs: Array.isArray(row.refs) ? row.refs.filter((x): x is string => typeof x === 'string').slice(0, 8).map((x) => clean(x, 80)) : [],
    ...cardOf(row.card),
    ...alsoOpensOf(row.alsoOpens),
    ...githubOf(row),
  };
}

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]{0,9}\/files$/;

/** The pull-request fields of a code-owner approval row, each validated; anything malformed is left out. */
export function githubOf(row: Rec): Pick<NeedItem, 'pr' | 'githubUrl' | 'prTitle' | 'prSummary' | 'headSha' | 'approveAvailable'> {
  const out: Pick<NeedItem, 'pr' | 'githubUrl' | 'prTitle' | 'prSummary' | 'headSha' | 'approveAvailable'> = {};
  if (!(typeof row.pr === 'number' && Number.isInteger(row.pr) && row.pr > 0)) return out;
  out.pr = row.pr;
  if (typeof row.githubUrl === 'string' && GITHUB_URL.test(row.githubUrl) && row.githubUrl.includes(`/pull/${row.pr}/`)) out.githubUrl = row.githubUrl;
  const title = clean(row.prTitle, 256);
  if (title) out.prTitle = title;
  const summary = clean(row.prSummary, DETAIL_MAX);
  if (summary) out.prSummary = summary;
  if (typeof row.headSha === 'string' && /^[0-9a-f]{40}$/.test(row.headSha)) out.headSha = row.headSha;
  if (typeof row.approveAvailable === 'boolean') out.approveAvailable = row.approveAvailable && out.headSha !== undefined;
  return out;
}

/** The same href rule as an item's own action (a console hash or a dashboard path), so it can never point outside. */
function alsoOpensOf(a: unknown): { alsoOpens?: NeedItem['alsoOpens'] } {
  if (!a || typeof a !== 'object') return {};
  const r = a as Rec;
  if (typeof r.href !== 'string' || !/^(#\/|\/dashboard\/)/.test(r.href)) return {};
  return { alsoOpens: { href: r.href, label: clean(r.label, 80) || 'Open the project conversation' } };
}

function cardOf(c: unknown): { card?: NeedItem['card'] } {
  if (!c || typeof c !== 'object') return {};
  const r = c as Rec;
  if (typeof r.id !== 'string' || !/^wc_[0-9a-f]{16}$/.test(r.id) || typeof r.href !== 'string' || !/^#\/work\/board\?card=/.test(r.href)) return {};
  return { card: { id: r.id, href: r.href, label: clean(r.label, 80) || 'Has a card on the work board' } };
}

export interface NeedsComposer {
  /** The owner's full list (every source). */
  owner: () => Promise<Omit<NeedsAnswer, 'viewer'>>;
  /** A team person's list: their work board only. */
  team: (board: NeedsSelfRead | null) => Promise<Omit<NeedsAnswer, 'viewer'>>;
}

type Composed = Omit<NeedsAnswer, 'viewer'>;
type ComposerDeps = Pick<NeedsDeps, 'read' | 'consoleDir' | 'agentName' | 'machineId' | 'now'>;

function page(answer: Composed, start: number): Composed {
  return { ...answer, items: answer.items.slice(start, start + NEEDS_MAX_ITEMS) };
}

/** Direct callers receive the same bounded first page as before. */
export function createNeedsComposer(deps: ComposerDeps): NeedsComposer {
  const full = createFullComposer(deps);
  return {
    owner: async () => page(await full.owner(), 0),
    team: async (board) => page(await full.team(board), 0),
  };
}

function createFullComposer(deps: ComposerDeps): NeedsComposer {
  const now = () => (deps.now ? deps.now() : Date.now());
  const dir = deps.consoleDir ?? resolveConsoleDir();
  // Kept across reads so a failed source keeps its last good rows for the grace period (needs-model.js).
  const known: Record<string, Rec> = {};
  const base = () => ({ schemaVersion: NEEDS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), machineId: deps.machineId(), agent: { name: deps.agentName() } });

  const finish = (rows: Array<{ row: Rec; source: string }>, sources: NeedsAnswer['sources'], notes: string[]) => {
    const seen = new Set<string>();
    const items: NeedItem[] = [];
    for (const { row, source } of rows) {
      const it = toItem(row, source);
      if (seen.has(it.id)) continue; // each item once
      seen.add(it.id);
      items.push(it);
    }
    const couldNotCheck = sources.filter((s) => s.state === 'failed').map((s) => s.label);
    const withPosture = sources.map((s) => (NEED_SOURCE_POSTURE[s.id] ? { ...s, posture: NEED_SOURCE_POSTURE[s.id].posture } : s));
    return { ...base(), count: items.length, complete: couldNotCheck.length === 0, items, truncated: items.length > NEEDS_MAX_ITEMS, sources: withPosture, couldNotCheck, notes };
  };

  const owner = async () => {
    const { needs: N, home: H } = await loadModels(dir);
    const t = now();
    const cache = new Map<string, Promise<Rec>>();
    const get = (p: string) => { let r = cache.get(p); if (!r) { r = deps.read(p).then(consoleResult, () => ({ ok: false, reason: 'the server could not be reached' })); cache.set(p, r); } return r; };
    const readSource = async (s: Rec) => {
      const reads = s.reads as Record<string, string>;
      const keys = Object.keys(reads);
      const vals = await Promise.all(keys.map((k) => get(reads[k])));
      known[s.id as string] = { ...(known[s.id as string] || {}), results: Object.fromEntries(keys.map((k, i) => [k, vals[i]])) };
    };
    const all = N.NEED_SOURCES as Rec[];
    // Unconditional sources and Home's own reads first; a conditional source (`when`) reads the first round's answers.
    const homeReads = ['/attention?scope=pool&status=OPEN', '/commitments?scope=mesh', '/pool'];
    const first = all.filter((s) => !s.when);
    await boundedAll([...homeReads.map((p) => () => get(p).then(() => undefined)), ...first.map((s) => () => readSource(s))], NEEDS_MAX_CONCURRENT_READS);
    const later = all.filter((s) => typeof s.when === 'function' && (s.when as (k: Rec) => boolean)(known));
    await boundedAll(later.map((s) => () => readSource(s)), NEEDS_MAX_CONCURRENT_READS);
    for (const s of all) if (s.when && !later.includes(s)) delete known[s.id as string]; // not read here (not a maintainer's agent): not a source

    const surfaced = N.surfacedNeeds(known, t, NEEDS_GRACE_MS) as { rows: Rec[]; pending: string[]; failed: string[] };
    const attention = await get(homeReads[0]);
    const commitments = await get(homeReads[1]);
    const pool = await get(homeReads[2]);
    const names = pool.ok ? H.machineNames(pool) : {};
    const pd = pool.ok ? (pool.data as Rec) : null;
    const peers = pd && Array.isArray(pd.machines) ? (pd.machines as Rec[]).filter((m) => m && !m.isSelf && m.machineId !== pd.selfMachineId).length : null;
    const queue = H.buildNeeds(attention, t, names);
    const promised = H.buildPromised(commitments, t, peers);
    const combined = H.combineNeeds(queue, promised, surfaced) as Rec;

    // Which source each surfaced row came from: the rows each source produced on this read.
    const rowSource = new Map<string, string>();
    for (const s of all) { const k = known[s.id as string]; if (k && Array.isArray(k.rows)) for (const r of k.rows as Rec[]) rowSource.set(String(r.key), s.id as string); }
    const queueKeys = new Set(((queue && (queue.all as Rec[])) || []).map((r: Rec) => String(r.key)));
    const rows = (Array.isArray(combined.all) ? (combined.all as Rec[]) : []).filter((r) => r.tone !== 'unknown').map((row) => ({
      row,
      source: rowSource.get(String(row.key)) ?? (queueKeys.has(String(row.key)) ? 'attention' : 'promises'),
    }));

    const sources: NeedsAnswer['sources'] = [
      { id: 'attention', label: NEED_SOURCE_LABELS.attention, state: attention.ok && Number.isFinite(queue.count) ? 'ok' : 'failed' },
      { id: 'promises', label: NEED_SOURCE_LABELS.promises, state: commitments.ok ? (Number.isFinite(promised.count) ? 'ok' : (/switched off/i.test(String(promised.reason || promised.line || '')) ? 'off' : 'failed')) : (/switched off/.test(String(commitments.reason)) ? 'off' : 'failed') },
    ];
    for (const s of all) {
      const id = s.id as string;
      const k = known[id];
      if (!k) continue;
      const reads = Object.values(k.results as Rec);
      const state = surfaced.failed.includes(id) ? 'failed' : reads.every((r) => !(r as Rec).ok && /switched off/.test(String((r as Rec).reason))) ? 'off' : 'ok';
      sources.push({ id, label: NEED_SOURCE_LABELS[id] || id, state });
    }
    // A pooled read that some machine did not answer is incomplete even when it found nothing (the missing
    // machine may hold the need), so each one is named as could-not-check.
    const missingMachines = (res: Rec): string[] => {
      const d = res && res.ok ? (res.data as Rec) : null;
      const f = d && d.pool && typeof d.pool === 'object' ? (d.pool as Rec).failed : null;
      if (!Array.isArray(f)) return [];
      const self = deps.machineId();
      return f
        // A store that was never set up (no accounts added yet) is a complete "nothing", not a missing machine.
        .filter((m) => !(m && typeof m === 'object' && (m as Rec).error === 'peer-pool-unconfigured'))
        // This machine's own failed read is named as this machine; the console's label rule names the others.
        .map((m) => { const r = typeof m === 'string' ? { machineId: m } : (m as Rec); return r && r.machineId && (r.machineId === self || r.machineId === 'self') ? 'this machine' : clean(H.machineLabel(r, names), 60); });
    };
    const gaps: Array<[string, string[]]> = [['attention', missingMachines(attention)], ['accounts', known.accounts ? missingMachines(((known.accounts.results as Rec) || {}).pool as Rec) : []]];
    for (const [id, machines] of gaps) {
      if (!machines.length) continue;
      const label = `${NEED_SOURCE_LABELS[id]} on ${machines.join(', ')}`;
      const i = sources.findIndex((x) => x.id === id);
      if (i >= 0 && sources[i].state === 'ok') sources[i] = { ...sources[i], state: 'failed', label };
    }
    if (combined.coverage === 'partial view' && promised && promised.coverage === 'partial view') {
      const i = sources.findIndex((x) => x.id === 'promises');
      if (i >= 0 && sources[i].state === 'ok') sources[i] = { ...sources[i], state: 'failed', label: 'promises on other machines' };
    }
    const notes = [combined.statusNote, queue && queue.statusNote].filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => clean(x, 300));
    return finish(rows, sources, [...new Set(notes)]);
  };

  const team = async (board: NeedsSelfRead | null) => {
    const sources: NeedsAnswer['sources'] = [];
    let rows: Array<{ row: Rec; source: string }> = [];
    if (board === null) sources.push({ id: 'workBoard', label: NEED_SOURCE_LABELS.workBoard, state: 'not-for-viewer' });
    else {
      const { workBoardNeedRows } = await import(pathToFileURL(path.join(dir, 'work-model.js')).href);
      const wb = consoleResult(board);
      const raw = workBoardNeedRows(wb) as Rec[] | null;
      const off = !wb.ok && /switched off/.test(String(wb.reason));
      sources.push({ id: 'workBoard', label: NEED_SOURCE_LABELS.workBoard, state: raw === null ? 'failed' : off ? 'off' : 'ok' });
      rows = (raw || []).map((r) => ({ row: { ...r, action: { kind: 'href', href: r.href } }, source: 'workBoard' }));
    }
    for (const id of Object.keys(NEED_SOURCE_LABELS)) if (id !== 'workBoard') sources.push({ id, label: NEED_SOURCE_LABELS[id], state: 'not-for-viewer' });
    return finish(rows, sources, []);
  };

  return { owner, team };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Who is asking: the owner (bearer / owner phone), a team person (member / guest), a user on a shared machine, or nobody we know. */
export function needsViewer(req: Request, bearerOk: (req: Request) => boolean): NeedsViewerRole | null {
  if (ownerOrBearer(req, bearerOk)) return 'owner';
  const person = devicePersonOf(req);
  if (!person) return null;
  if (person.role === 'team') return person.tier === 'guest' ? 'guest' : person.tier === 'member' ? 'member' : 'team';
  // Any other resolved person is not the owner (ownerOrBearer already admitted the owner's phone): a user on a shared machine.
  return 'msp';
}

// ── The canary (spec §7 stage 1, rule 43) ──────────────────────────────────────
/** How often the synthetic need travels the real read, and how many misses in a row raise the one notice. */
export const NEEDS_CANARY_INTERVAL_MS = 60 * 60_000;
export const NEEDS_CANARY_FIRST_DELAY_MS = 2 * 60_000;
export const NEEDS_CANARY_MISSES_TO_NOTICE = 2;
/** The canary's own read waits for a whole build: two rounds of source reads, each read up to NEEDS_READ_TIMEOUT_MS. */
export const NEEDS_CANARY_READ_TIMEOUT_MS = 3 * NEEDS_READ_TIMEOUT_MS + 10_000;

export interface NeedsCanaryStatus { lastRunAt: string | null; lastOkAt: string | null; consecutiveMisses: number; lastMiss: string | null; noticeRaised: boolean }

/**
 * A recurring synthetic need that travels the real Needs-you read (the route, its auth, every source
 * read and the console models) and must come back in the answer. A miss twice in a row raises ONE
 * notice through the degradation path (the alerts topic); it clears itself on the next good round trip.
 * The synthetic item exists only for the one request that carries its single-use nonce, so no person
 * ever sees it. Signal only: it never hides, holds or changes the list.
 */
export class NeedsCanary {
  private nonce: string | null = null;
  private st: NeedsCanaryStatus = { lastRunAt: null, lastOkAt: null, consecutiveMisses: 0, lastMiss: null, noticeRaised: false };
  constructor(private readonly deps: { read: (path: string) => Promise<NeedsSelfRead>; now?: () => number; notice: (why: string) => void; cleared?: () => void }) {}

  /** The synthetic row for a request carrying the current nonce, else null. Consumes the nonce. */
  synthetic(nonce: unknown): NeedItem | null {
    if (typeof nonce !== 'string' || !this.nonce || nonce !== this.nonce) return null;
    this.nonce = null;
    return { id: `canary:${nonce}`, title: 'Needs-you canary', why: 'A synthetic check that the list works.', detail: null, tone: 'attn', source: 'canary', sourceLabel: 'the canary', action: { kind: 'href', href: '#/agent' }, refs: [] };
  }

  status(): NeedsCanaryStatus { return { ...this.st }; }

  async tick(): Promise<boolean> {
    const at = new Date(this.deps.now ? this.deps.now() : Date.now()).toISOString();
    this.st.lastRunAt = at;
    const nonce = `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    this.nonce = nonce;
    let why: string | null = null;
    try {
      const r = await this.deps.read(`/needs?canary=${nonce}`);
      const b = (r.body && typeof r.body === 'object' ? r.body : {}) as { items?: Array<{ id?: unknown }>; count?: unknown };
      if (r.status !== 200) why = `the read answered ${r.status || 'nothing'}`;
      else if (!Array.isArray(b.items) || !b.items.some((i) => i && i.id === `canary:${nonce}`)) why = 'the synthetic need did not come back in the list';
      else if (typeof b.count !== 'number' || b.count < 1) why = 'the synthetic need was not counted';
    } catch (err) {
      // @silent-fallback-ok — not silent: the failed read is the miss being counted, and two in a row raise the notice
      why = `the read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.nonce = null;
    if (!why) {
      this.st.lastOkAt = at;
      this.st.consecutiveMisses = 0;
      if (this.st.noticeRaised) { this.st.noticeRaised = false; this.deps.cleared?.(); }
      return true;
    }
    this.st.consecutiveMisses += 1;
    this.st.lastMiss = why;
    if (this.st.consecutiveMisses >= NEEDS_CANARY_MISSES_TO_NOTICE && !this.st.noticeRaised) {
      this.st.noticeRaised = true;
      this.deps.notice(why);
    }
    return false;
  }
}

/**
 * Whether a non-owner phone may read the work board at all: the board's own device rule decides, so this
 * read never shows a team person more than their phone could already ask for (spec §4.4).
 */
export function teamMayReadBoard(req: Request): boolean {
  const rule = DEVICE_ALLOWLIST.find((r) => r.method === 'GET' && r.re.test('/mobile/work-board'));
  const person = devicePersonOf(req);
  if (!rule || !person || rule.ownerOnly) return false;
  if (person.role !== 'team') return true;
  return !!person.tier && tierAtLeast(person.tier, rule.tier ?? 'owner');
}

export function mountNeedsRoutes(router: Router, deps: NeedsDeps & { canary?: NeedsCanary }): void {
  const composer = createFullComposer(deps);
  const now = () => (deps.now ? deps.now() : Date.now());
  const signingKey = randomBytes(32);
  const snapshot = (answer: Composed) => {
    const hash = createHash('sha256');
    for (const item of answer.items) hash.update(JSON.stringify([item.id, item.action]));
    return { answer, digest: hash.digest('base64url') };
  };
  type Snapshot = ReturnType<typeof snapshot>;
  // Keep only the first page and its digest after a build. Concurrent fresh reads share the build.
  let inFlight: Promise<Snapshot> | null = null;
  let last: { at: number; first: Snapshot } | null = null;
  const ownerFresh = () => {
    if (!inFlight) {
      inFlight = composer.owner().then(snapshot).then((full) => {
        last = { at: now(), first: { ...full, answer: page(full.answer, 0) } };
        return full;
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
  const handle = async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const role = needsViewer(req, deps.bearerOk);
    if (!role) { res.status(403).json({ error: 'needs-viewer-unknown', detail: 'This phone is not linked to a person on this agent.' }); return; }
    try {
      const cursor = req.query.cursor;
      // Four bytes of page position plus a 32-byte signature, encoded without padding.
      const cursorBytes = typeof cursor === 'string' && /^[A-Za-z0-9_-]{48}$/.test(cursor) ? Buffer.from(cursor, 'base64url') : null;
      const start = cursorBytes?.readUInt32BE(0) ?? 0;
      if (cursor !== undefined && (!cursorBytes || start % NEEDS_MAX_ITEMS !== 0)) {
        res.status(400).json({ error: 'needs-cursor-invalid' }); return;
      }
      const canaryRow = cursor === undefined && role === 'owner' && deps.canary ? deps.canary.synthetic(req.query.canary) : null;
      const full = role === 'owner'
        ? (!cursorBytes && !canaryRow && last && now() - last.at < NEEDS_CACHE_MS ? last.first : await ownerFresh())
        : snapshot(await composer.team(teamMayReadBoard(req) ? deps.boardFor(req) : null));
      const device = deviceAdmissionIdentity(req);
      const principal = [role, device?.keyHash ?? null, devicePersonOf(req)?.userId ?? null];
      const token = (offset: number) => {
        const position = Buffer.alloc(4);
        position.writeUInt32BE(offset);
        const signature = createHmac('sha256', signingKey).update(JSON.stringify([principal, full.digest, offset])).digest();
        return Buffer.concat([position, signature]);
      };
      if (cursorBytes && (full.answer.count <= NEEDS_MAX_ITEMS || start >= full.answer.count || !timingSafeEqual(cursorBytes, token(start)))) {
        res.status(409).json({ error: 'needs-cursor-stale' }); return;
      }
      const answer = page(full.answer, start);
      if (canaryRow) {
        answer.items = [...answer.items.slice(0, NEEDS_MAX_ITEMS - 1), canaryRow];
        answer.count += 1;
        answer.truncated = answer.count > answer.items.length;
      } else if (answer.count > NEEDS_MAX_ITEMS) {
        answer.continuation = {
          start, previousCursor: start ? token(start - NEEDS_MAX_ITEMS).toString('base64url') : null,
          nextCursor: start + NEEDS_MAX_ITEMS < answer.count ? token(start + NEEDS_MAX_ITEMS).toString('base64url') : null,
        };
      }
      res.json({ ...answer, viewer: { role } } satisfies NeedsAnswer);
    } catch (err) {
      // The list could not be built at all: say so; a surface shows "could not check" and keeps the strip.
      res.status(500).json({ error: 'needs-read-failed', detail: clean(operatorError(err), 200) });
    }
  };
  router.get('/needs/canary', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!deps.bearerOk(req)) { res.status(403).json({ error: 'bearer-required' }); return; }
    if (!deps.canary) { res.status(503).json({ error: 'needs-canary-off' }); return; }
    res.json(deps.canary.status());
  });
  router.get('/needs', handle);
  router.get('/mobile/needs', handle);
}
