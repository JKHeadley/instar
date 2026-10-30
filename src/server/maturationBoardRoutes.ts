/**
 * GET /maturation/board — the read-only maturation board (spec: docs/specs/maturation-board.md).
 *
 * Reads only: review files on disk, and in-process read methods of existing
 * owners (commitments, initiatives, D7, guards, the dark-flag registry). It
 * never calls `/growth/*` (those routes write), never calls an LLM, never
 * writes. The response is `advisory: true, authority: 'none'`.
 *
 * Parts:
 *   scope=local (default)            — this machine's board
 *   scope=local&part=owners          — this machine's live owner facts + review digest (peer fan-out)
 *   scope=local&part=review          — this machine's review rows + history + commitment projection
 *   scope=pool                       — the merged board across answering machines
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';

import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { buildGuardInventory } from '../monitoring/guardPostureView.js';
import { GuardRegistry } from '../monitoring/GuardRegistry.js';
import { readGuardPostureBootSnapshot, resolveGuardConfigSnapshot } from '../monitoring/guardPosture.js';
import { readAcceptedFallbacks, scopeAcceptedFallbacks } from '../monitoring/guardAcceptedFallbacks.js';
import type { DarkFlagMaturationRegistry } from '../monitoring/DarkFlagMaturationRegistry.js';
import {
  BOARD_SCHEMA,
  MAX_HISTORY,
  REVIEW_FILE_RE,
  buildMaturationBoard,
  historySeries,
  parseReviewJson,
  parseReviewMarkdown,
  pickLatest,
  type CommitmentFact,
  type OwnerEntry,
  type ParsedReview,
  type ReviewRow,
  type SourceStatus,
} from '../monitoring/MaturationBoard.js';
import type { RouteContext } from './routes.js';

export const DEFAULT_REVIEWS_DIR = 'docs/research/feature-maturation/reviews';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_PEER_OWNERS_BYTES = 512 * 1024;
const MAX_POOL_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_COMMITMENT_PROJECTION = 16_384;
const RESPONSE_CACHE_MS = 60_000;
const DARK_FLAG_STALE_MS = 24 * 3_600_000;
const REVIEW_CACHE_MAX_AGE_MS = 7 * 86_400_000;
const FACT_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** Paths a reviews directory may never resolve into (key material and agent state). */
const FORBIDDEN_SEGMENTS = ['.instar', '.git', '.ssh', 'node_modules'];

type BoardCtx = Pick<RouteContext,
  'config' | 'meshSelfId' | 'machinePoolRegistry' | 'resolvePeerUrls' | 'recordRopeResult'
  | 'commitmentTracker' | 'initiativeTracker' | 'blockerLifecycleService' | 'guardRegistry'
> & { darkFlagRegistry?: DarkFlagMaturationRegistry | null };

interface MaturationBoardConfig { enabled?: boolean; reviewsDir?: string }

export function maturationBoardConfig(config: RouteContext['config']): MaturationBoardConfig {
  return ((config as unknown as { maturationBoard?: MaturationBoardConfig }).maturationBoard) ?? {};
}

export function isMaturationBoardEnabled(config: RouteContext['config']): boolean {
  return resolveDevAgentGate(maturationBoardConfig(config).enabled, config);
}

// ── Review files ──────────────────────────────────────────────────────────

export interface ReviewDirRead {
  reviews: ParsedReview[];
  rejected: SourceStatus[];
  dirError: string | null;
}

/**
 * Resolve the reviews directory: must stay inside the project directory after
 * symlinks are resolved, and must not pass through key-material or agent-state
 * directories.
 */
export function resolveReviewsDir(projectDir: string, configured: string | undefined): { dir: string | null; error: string | null } {
  const rel = configured && configured.trim() ? configured.trim() : DEFAULT_REVIEWS_DIR;
  const candidate = path.resolve(projectDir, rel);
  let real: string;
  let projectReal: string;
  try { projectReal = fs.realpathSync(projectDir); } catch { return { dir: null, error: 'project-dir-unreadable' }; }
  try { real = fs.realpathSync(candidate); } catch { return { dir: null, error: 'no-reviews-dir' }; }
  const inside = real === projectReal || real.startsWith(projectReal + path.sep);
  if (!inside) return { dir: null, error: 'reviews-dir-outside-project' };
  const relReal = path.relative(projectReal, real).split(path.sep);
  if (relReal.some(seg => FORBIDDEN_SEGMENTS.includes(seg))) return { dir: null, error: 'reviews-dir-forbidden' };
  return { dir: real, error: null };
}

const parseCache = new Map<string, { mtimeMs: number; size: number; result: ReturnType<typeof parseReviewJson> }>();

export async function readReviewDir(dir: string, now: number, machine: string): Promise<ReviewDirRead> {
  const rejected: SourceStatus[] = [];
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return { reviews: [], rejected, dirError: 'reviews-dir-unreadable' }; }
  const files = names.filter(n => REVIEW_FILE_RE.test(n)).sort().reverse().slice(0, MAX_HISTORY * 2);
  const reviews: ParsedReview[] = [];
  let budget = MAX_READ_BYTES;
  for (const name of files) {
    const full = path.join(dir, name);
    try {
      const lst = await fs.promises.lstat(full);
      if (lst.isSymbolicLink() || !lst.isFile()) { rejected.push({ name: `review:${name}`, machine, ok: false, reason: 'not-a-regular-file' }); continue; }
      if (lst.size > MAX_FILE_BYTES) { rejected.push({ name: `review:${name}`, machine, ok: false, reason: 'file-too-large' }); continue; }
      if (lst.size > budget) { rejected.push({ name: `review:${name}`, machine, ok: false, reason: 'read-budget' }); continue; }
      const real = await fs.promises.realpath(full);
      if (path.dirname(real) !== dir) { rejected.push({ name: `review:${name}`, machine, ok: false, reason: 'outside-reviews-dir' }); continue; }
      budget -= lst.size;
      const cached = parseCache.get(full);
      let result = cached && cached.mtimeMs === lst.mtimeMs && cached.size === lst.size ? cached.result : null;
      if (!result) {
        const text = await fs.promises.readFile(full, 'utf-8');
        result = name.endsWith('.json') ? parseReviewJson(name, text, now) : parseReviewMarkdown(name, text, now);
        parseCache.set(full, { mtimeMs: lst.mtimeMs, size: lst.size, result });
      }
      if (result.ok) reviews.push(result.review);
      else rejected.push({ name: `review:${name}`, machine, ok: false, reason: result.reason });
    } catch {
      rejected.push({ name: `review:${name}`, machine, ok: false, reason: 'read-failed' });
    }
  }
  return { reviews, rejected, dirError: null };
}

export function reviewHash(review: ParsedReview): string {
  return crypto.createHash('sha256').update(JSON.stringify({ date: review.date, rows: review.rows })).digest('hex');
}

// ── Live owner facts (this machine) ─────────────────────────────────────────

function nicknameOf(ctx: BoardCtx, machineId: string | null | undefined): string {
  if (!machineId) return 'this machine';
  return ctx.machinePoolRegistry?.getCapacity(machineId)?.nickname ?? machineId;
}

export function collectLocalOwners(ctx: BoardCtx, now: number): { owners: OwnerEntry[]; sources: SourceStatus[] } {
  const machine = nicknameOf(ctx, ctx.meshSelfId);
  const owners: OwnerEntry[] = [];
  const sources: SourceStatus[] = [];

  // Rollout records (FeatureRolloutReconciler → InitiativeTracker).
  try {
    const tracker = ctx.initiativeTracker;
    if (!tracker) {
      sources.push({ name: 'rollout', machine, ok: false, reason: 'tracker-not-running' });
    } else {
      for (const ini of tracker.list()) {
        const r = ini.rollout;
        if (!r || !r.stage || !r.flagPath) continue; // digest bookkeeping only — not a feature
        owners.push({
          machine, source: 'rollout', ownerId: ini.id, aliases: [r.flagPath],
          facts: { stage: r.stage, flagPath: r.flagPath, title: ini.title.slice(0, 160) },
          at: ini.updatedAt ?? null,
        });
      }
      sources.push({ name: 'rollout', machine, ok: true });
    }
  } catch {
    sources.push({ name: 'rollout', machine, ok: false, reason: 'read-failed' });
  }

  // D7 recurring scorer (BlockerLifecycleService).
  try {
    const svc = ctx.blockerLifecycleService;
    if (!svc) {
      sources.push({ name: 'd7', machine, ok: false, reason: 'scorer-not-running' });
    } else {
      const summary = svc.localSummary(168) as unknown as { maturation?: { features?: Array<Record<string, unknown>>; accounting?: Array<Record<string, unknown>> } };
      // D7 keys features by slug; the rollout record links a slug to its flag path.
      const flagByFeature = new Map<string, string>();
      for (const ini of ctx.initiativeTracker?.list() ?? []) {
        if (ini.rollout?.flagPath) flagByFeature.set(ini.id, ini.rollout.flagPath);
      }
      for (const a of summary.maturation?.accounting ?? []) {
        if (typeof a.featureId === 'string' && typeof a.flagPath === 'string') flagByFeature.set(a.featureId, a.flagPath);
      }
      for (const f of summary.maturation?.features ?? []) {
        if (typeof f.featureId !== 'string') continue;
        const flag = flagByFeature.get(f.featureId);
        owners.push({
          machine, source: 'd7', ownerId: f.featureId, aliases: flag ? [flag] : [],
          facts: {
            status: typeof f.status === 'string' ? f.status : null,
            rung: typeof f.rung === 'string' ? f.rung : null,
            passingMetrics: typeof f.passingMetrics === 'number' ? f.passingMetrics : null,
            totalMetrics: typeof f.totalMetrics === 'number' ? f.totalMetrics : null,
            newestEvidenceAt: typeof f.newestEvidenceAt === 'string' ? f.newestEvidenceAt : null,
          },
          at: typeof f.evaluatedAt === 'string' ? f.evaluatedAt : null,
        });
      }
      sources.push({ name: 'd7', machine, ok: true });
    }
  } catch {
    sources.push({ name: 'd7', machine, ok: false, reason: 'read-failed' });
  }

  // Dark-flag registry (machine-local by its own design).
  try {
    const reg = ctx.darkFlagRegistry;
    if (!reg) {
      sources.push({ name: 'dark-flag', machine, ok: false, reason: 'registry-not-running' });
    } else {
      const loaded = reg.load();
      let mtime: number | null = null;
      try { mtime = fs.statSync(reg.path).mtimeMs; } catch { /* @silent-fallback-ok — absence is reported below as can't-tell */ }
      if (loaded.foreign) {
        sources.push({ name: 'dark-flag', machine, ok: false, reason: 'foreign-registry' });
      } else if (loaded.firstRegistration && mtime === null) {
        sources.push({ name: 'dark-flag', machine, ok: false, reason: 'registry-file-missing' });
      } else if (loaded.firstRegistration) {
        sources.push({ name: 'dark-flag', machine, ok: false, reason: 'registry-unreadable' });
      } else {
        const stale = mtime !== null && now - mtime > DARK_FLAG_STALE_MS;
        for (const e of Object.values(loaded.entries)) {
          const open = !['graduated', 'killed', 'superseded'].includes(e.state);
          owners.push({
            machine, source: 'dark-flag', ownerId: e.guardKey,
            facts: {
              state: e.state,
              owner: e.owner,
              riskTier: e.riskTier,
              windowDays: e.windowDays,
              firstObservedDarkAt: e.firstObservedDarkAt,
              proofOfLife: e.proofOfLife === 'unknown' ? 'not measured' : e.proofOfLife,
              lastObservedState: e.lastObservedState,
              registryStale: stale,
            },
            at: e.lastObservedAt,
            deadline: { date: e.deadline, open, milestone: `dark-flag window (${e.windowDays} d)` },
            transitions: e.history.slice(-64).map(h => ({ at: h.at, from: h.from, to: h.to })),
          });
        }
        sources.push({ name: 'dark-flag', machine, ok: true, at: mtime !== null ? new Date(mtime).toISOString() : null, ...(stale ? { reason: 'registry-not-refreshed-24h' } : {}) });
      }
    }
  } catch {
    sources.push({ name: 'dark-flag', machine, ok: false, reason: 'read-failed' });
  }

  // Guard posture (same inputs the /guards route uses).
  try {
    const stateDir = ctx.config.stateDir;
    const snapshot = resolveGuardConfigSnapshot(path.dirname(stateDir));
    if (snapshot.readError) {
      sources.push({ name: 'guard', machine, ok: false, reason: 'config-read-failed' });
    } else {
      const inventory = buildGuardInventory({
        snapshot,
        bootSnapshot: readGuardPostureBootSnapshot(stateDir),
        registry: ctx.guardRegistry ?? new GuardRegistry(),
        now,
        acceptedFallbacks: scopeAcceptedFallbacks(readAcceptedFallbacks(stateDir), ctx.meshSelfId ?? null),
      });
      for (const g of inventory.guards) {
        owners.push({
          machine, source: 'guard', ownerId: g.key,
          facts: { effective: g.effective, configEnabled: g.configEnabled, offClass: g.offClass, loadBearing: g.loadBearing === true },
          at: null,
        });
      }
      sources.push({ name: 'guard', machine, ok: true });
    }
  } catch {
    sources.push({ name: 'guard', machine, ok: false, reason: 'read-failed' });
  }

  return { owners, sources };
}

function commitmentProjection(ctx: BoardCtx, ids: Set<string>): { map: Map<string, CommitmentFact> | null; truncated: boolean } {
  const tracker = ctx.commitmentTracker;
  if (!tracker) return { map: null, truncated: false };
  const map = new Map<string, CommitmentFact>();
  let truncated = false;
  for (const c of tracker.getAll()) {
    if (!ids.has(c.id)) continue;
    if (map.size >= MAX_COMMITMENT_PROJECTION) { truncated = true; break; }
    map.set(c.id, {
      id: c.id,
      status: c.status,
      createdAt: c.createdAt ?? null,
      checkInAt: c.checkInAt ?? null,
      nextUpdateDueAt: c.nextUpdateDueAt ?? null,
      resolvedAt: c.resolvedAt ?? null,
    });
  }
  return { map, truncated };
}

function linkedInitiatives(ctx: BoardCtx) {
  const tracker = ctx.initiativeTracker;
  if (!tracker) return null;
  return tracker.list()
    .filter(i => i.status === 'active' || i.status === 'awaiting-user' || i.status === 'paused')
    .map(i => ({ id: i.id, flagPath: i.rollout?.flagPath ?? null, title: i.title.slice(0, 160), status: i.status, nextCheckAt: i.nextCheckAt ?? null }));
}

// ── Peer payload sanitizers ────────────────────────────────────────────────

function sanitizeFacts(v: unknown): OwnerEntry['facts'] | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: OwnerEntry['facts'] = Object.create(null);
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!FACT_KEY_RE.test(k)) continue;
    if (++n > 32) break;
    if (typeof val === 'string') out[k] = val.slice(0, 512);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean' || val === null) out[k] = val;
  }
  return out;
}

const OWNER_SOURCES = new Set(['d7', 'rollout', 'dark-flag', 'guard']);

export function sanitizePeerOwners(raw: unknown, machine: string): OwnerEntry[] | null {
  if (!Array.isArray(raw) || raw.length > 4096) return null;
  const out: OwnerEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.source !== 'string' || !OWNER_SOURCES.has(o.source)) continue;
    if (typeof o.ownerId !== 'string' || o.ownerId.length > 160) continue;
    const facts = sanitizeFacts(o.facts);
    if (!facts) continue;
    const aliases = Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === 'string' && a.length <= 160).slice(0, 4) : [];
    let deadline: OwnerEntry['deadline'] = null;
    const d = o.deadline as Record<string, unknown> | null | undefined;
    if (d && typeof d === 'object' && typeof d.date === 'string' && Number.isFinite(Date.parse(d.date)) && typeof d.open === 'boolean') {
      deadline = { date: d.date, open: d.open, milestone: typeof d.milestone === 'string' ? d.milestone.slice(0, 80) : 'deadline' };
    }
    const transitions = o.source === 'dark-flag' && Array.isArray(o.transitions)
      ? o.transitions.slice(-64).flatMap(t => {
          const x = t as Record<string, unknown>;
          if (!x || typeof x.at !== 'string' || !Number.isFinite(Date.parse(x.at)) || typeof x.to !== 'string') return [];
          return [{ at: x.at, from: typeof x.from === 'string' ? x.from.slice(0, 32) : null, to: x.to.slice(0, 32) }];
        })
      : [];
    out.push({
      machine,
      source: o.source as OwnerEntry['source'],
      ownerId: o.ownerId,
      aliases,
      facts,
      at: typeof o.at === 'string' && Number.isFinite(Date.parse(o.at)) ? o.at : null,
      deadline,
      transitions,
    });
  }
  return out;
}

export function sanitizeCommitments(raw: unknown[]): Map<string, CommitmentFact> {
  const out = new Map<string, CommitmentFact>();
  const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  for (const r of raw.slice(0, MAX_COMMITMENT_PROJECTION)) {
    const c = r as Record<string, unknown>;
    if (!c || typeof c.id !== 'string' || !/^CMT-\d{1,8}$/.test(c.id) || typeof c.status !== 'string') continue;
    out.set(c.id, { id: c.id, status: c.status.slice(0, 32), createdAt: iso(c.createdAt), checkInAt: iso(c.checkInAt), nextUpdateDueAt: iso(c.nextUpdateDueAt), resolvedAt: iso(c.resolvedAt) });
  }
  return out;
}

// ── Router ─────────────────────────────────────────────────────────────────

interface ReviewPayload {
  schema: typeof BOARD_SCHEMA;
  part: 'review';
  date: string;
  hash: string;
  format: 'json' | 'md';
  rows: ReviewRow[];
  history: Array<{ date: string; id: string; verdict: string; carried: boolean }>;
  commitments: CommitmentFact[] | null;
  commitmentsTruncated: boolean;
  unparsedRows: number;
  duplicatesDropped: number;
}

export function createMaturationBoardRoutes(ctx: BoardCtx): Router {
  const router = Router();
  /** Pool rebuilds per minute (cache hits are free): bounds peer fan-out like /guards?scope=pool. */
  const poolBuilds: number[] = [];
  const poolLimiter = (now: number): boolean => {
    while (poolBuilds.length && poolBuilds[0] <= now - 60_000) poolBuilds.shift();
    if (poolBuilds.length >= 12) return false;
    poolBuilds.push(now);
    return true;
  };
  const responseCache = new Map<string, { at: number; body: unknown }>();
  /** Last review assessment fetched from another machine (in-memory only; offline rule). */
  let lastRemoteReview: { machine: string; machineId: string; fetchedAt: number; reviews: ParsedReview[] } | null = null;

  const projectDir = () => path.dirname(ctx.config.stateDir);
  const selfName = () => nicknameOf(ctx, ctx.meshSelfId);

  async function localReviews(now: number): Promise<ReviewDirRead> {
    const { dir, error } = resolveReviewsDir(projectDir(), maturationBoardConfig(ctx.config).reviewsDir);
    if (!dir) {
      // A missing directory is a confirmed absence, not a failure.
      return { reviews: [], rejected: error === 'no-reviews-dir' ? [] : [{ name: 'reviews-dir', machine: selfName(), ok: false, reason: error ?? 'unknown' }], dirError: error };
    }
    return readReviewDir(dir, now, selfName());
  }

  function reviewPayload(reviews: ParsedReview[]): ReviewPayload | null {
    const latest = pickLatest(reviews);
    if (!latest) return null;
    const series = historySeries(reviews).filter(r => r !== latest);
    const ids = new Set(latest.rows.flatMap(r => r.commitments));
    const proj = commitmentProjection(ctx, ids);
    return {
      schema: BOARD_SCHEMA,
      part: 'review',
      date: latest.date,
      hash: reviewHash(latest),
      format: latest.format,
      rows: latest.rows,
      history: series.flatMap(r => r.rows.map(x => ({ date: r.date, id: x.id, verdict: x.verdict, carried: x.evidenceReadToday === false }))),
      commitments: proj.map ? [...proj.map.values()] : null,
      commitmentsTruncated: proj.truncated,
      unparsedRows: latest.unparsedRows,
      duplicatesDropped: latest.duplicatesDropped,
    };
  }

  /** Rebuild ParsedReview[] from a review payload (latest rows + verdict-only history). */
  function reviewsFromPayload(p: ReviewPayload): ParsedReview[] {
    const byDate = new Map<string, ReviewRow[]>();
    for (const h of p.history) {
      const rows = byDate.get(h.date) ?? [];
      rows.push({ id: h.id, title: null, stage: null, verdict: h.verdict as ReviewRow['verdict'], verdictRaw: h.verdict, evidence: null, evidenceReadToday: !h.carried, measures: null, rule: null, decision: null, action: null, commitments: [], expectedBy: null, shippedAt: null });
      byDate.set(h.date, rows);
    }
    const older: ParsedReview[] = [...byDate.entries()].map(([date, rows]) => ({ date, format: 'json', fileName: `${date}.json`, rows, duplicatesDropped: 0, unparsedRows: 0 }));
    return [...older, { date: p.date, format: p.format, fileName: `${p.date}.${p.format}`, rows: p.rows, duplicatesDropped: p.duplicatesDropped, unparsedRows: p.unparsedRows }];
  }

  router.get('/maturation/board', async (req: Request, res: Response) => {
    if (!isMaturationBoardEnabled(ctx.config)) {
      res.status(503).json({ error: 'maturation board is not switched on for this agent (maturationBoard.enabled)' });
      return;
    }
    const scope = req.query.scope === 'pool' ? 'pool' : 'local';
    const part = typeof req.query.part === 'string' ? req.query.part : 'board';
    const now = Date.now();
    if (part === 'probe') { res.json({ schema: BOARD_SCHEMA, part: 'probe', enabled: true }); return; }
    try {
      if (scope === 'local' && part === 'owners') {
        const { owners, sources } = collectLocalOwners(ctx, now);
        const rv = await localReviews(now);
        const latest = pickLatest(rv.reviews);
        res.json({
          schema: BOARD_SCHEMA, part: 'owners', machineId: ctx.meshSelfId ?? null, owners, sources,
          reviewDigest: latest ? { date: latest.date, hash: reviewHash(latest), featureCount: latest.rows.length } : null,
        });
        return;
      }
      if (scope === 'local' && part === 'review') {
        const rv = await localReviews(now);
        const payload = reviewPayload(rv.reviews);
        if (!payload) { res.status(404).json({ error: 'no-review' }); return; }
        const text = JSON.stringify(payload);
        if (Buffer.byteLength(text) > MAX_REVIEW_PAYLOAD_BYTES) { res.status(413).json({ error: 'review-payload-too-large' }); return; }
        res.type('application/json').send(text);
        return;
      }

      const cacheKey = scope;
      const hit = responseCache.get(cacheKey);
      if (hit && now - hit.at < RESPONSE_CACHE_MS) { res.json(hit.body); return; }

      if (scope === 'local') {
        const { owners, sources } = collectLocalOwners(ctx, now);
        const rv = await localReviews(now);
        const latest = pickLatest(rv.reviews);
        const ids = new Set((latest?.rows ?? []).flatMap(r => r.commitments));
        const proj = commitmentProjection(ctx, ids);
        const body = buildMaturationBoard({
          now, scope: 'local', reviews: rv.reviews, reviewMachine: latest ? selfName() : null, owners,
          commitments: proj.map, linkedInitiatives: linkedInitiatives(ctx),
          sources: [...sources, ...rv.rejected, ...(proj.map ? [] : [{ name: 'commitments', machine: selfName(), ok: false, reason: 'tracker-not-running' }])],
        });
        responseCache.set(cacheKey, { at: now, body });
        res.json(body);
        return;
      }

      // ── Pool ──
      if (!poolLimiter(now)) { res.status(429).json({ error: 'rate-limited' }); return; }
      const local = collectLocalOwners(ctx, now);
      const localRv = await localReviews(now);
      const localLatest = pickLatest(localRv.reviews);
      const owners: OwnerEntry[] = [...local.owners];
      const sources: SourceStatus[] = [...local.sources, ...localRv.rejected];
      type Peer = NonNullable<ReturnType<NonNullable<BoardCtx['resolvePeerUrls']>>>[number];
      type Candidate = { machineId: string; machine: string; date: string; hash: string; peer: Peer | null };
      const candidates: Candidate[] = [];
      const selfId = ctx.meshSelfId ?? 'self';
      if (localLatest) candidates.push({ machineId: selfId, machine: selfName(), date: localLatest.date, hash: reviewHash(localLatest), peer: null });

      const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
      const missing: string[] = [];
      const started = Date.now();
      let bytes = 0;
      const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
      for (let i = 0; i < peers.length; i += 4) {
        await Promise.all(peers.slice(i, i + 4).map(async p => {
          const machine = nicknameOf(ctx, p.machineId);
          const fail = (reason: string) => { sources.push({ name: 'peer', machine, ok: false, reason }); missing.push(machine); };
          if (Date.now() - started > 2_500) return fail('deadline');
          if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) return fail('omitted-cap');
          try {
            const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, '/maturation/board?scope=local&part=owners', {
              headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(750),
            });
            if (r.status === 404 || r.status === 503) return fail(r.status === 503 ? 'board-off' : 'unsupported');
            if (!r.ok) return fail('http-error');
            const text = await r.text();
            const size = Buffer.byteLength(text);
            if (size > MAX_PEER_OWNERS_BYTES || bytes + size > MAX_POOL_BYTES) return fail('too-large');
            bytes += size;
            const body = JSON.parse(text) as Record<string, unknown>;
            if (body.schema !== BOARD_SCHEMA) return fail('invalid-body');
            const peerOwners = sanitizePeerOwners(body.owners, machine);
            if (!peerOwners) return fail('invalid-body');
            owners.push(...peerOwners);
            sources.push({ name: 'peer', machine, ok: true });
            const dg = body.reviewDigest as Record<string, unknown> | null;
            if (dg && typeof dg.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dg.date) && typeof dg.hash === 'string'
              && dg.date <= new Date(now + 86_400_000).toISOString().slice(0, 10)) {
              candidates.push({ machineId: p.machineId, machine, date: dg.date, hash: dg.hash.slice(0, 64), peer: p });
            }
          } catch (err) {
            fail(err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable');
          }
        }));
      }

      // One selection rule: newest date; tie → lowest machine id.
      candidates.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.machineId < b.machineId ? -1 : 1));
      for (const c of candidates) sources.push({ name: 'review-candidate', machine: c.machine, ok: true, at: c.date, reason: `hash ${c.hash.slice(0, 12)}` });
      const chosen = candidates[0] ?? null;

      let reviews: ParsedReview[] = [];
      let reviewMachine: string | null = null;
      let commitments: Map<string, CommitmentFact> | null = null;
      let reviewCachedAt: string | null = null;
      let reviewUnavailable: { machine: string; since: string | null } | null = null;
      let linked = linkedInitiatives(ctx);

      const lastWasMissing = lastRemoteReview && missing.includes(lastRemoteReview.machine)
        && (!chosen || chosen.date < (lastRemoteReview.reviews.length ? pickLatest(lastRemoteReview.reviews)!.date : ''));
      if (lastWasMissing && lastRemoteReview && now - lastRemoteReview.fetchedAt <= REVIEW_CACHE_MAX_AGE_MS) {
        reviews = lastRemoteReview.reviews;
        reviewMachine = lastRemoteReview.machine;
        reviewCachedAt = new Date(lastRemoteReview.fetchedAt).toISOString();
        commitments = null; // never reuse cached follow-up status as current
        linked = null;
      } else if (lastWasMissing && lastRemoteReview) {
        reviewUnavailable = { machine: lastRemoteReview.machine, since: null };
      } else if (chosen && !chosen.peer) {
        reviews = localRv.reviews;
        reviewMachine = chosen.machine;
        const ids = new Set((localLatest?.rows ?? []).flatMap(r => r.commitments));
        commitments = commitmentProjection(ctx, ids).map;
      } else if (chosen && chosen.peer) {
        try {
          const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, chosen.peer, '/maturation/board?scope=local&part=review', {
            headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(3_000),
          });
          const text = r.ok ? await r.text() : '';
          if (!r.ok) {
            sources.push({ name: 'review', machine: chosen.machine, ok: false, reason: r.status === 413 ? 'review-payload-too-large' : 'http-error' });
          } else if (Buffer.byteLength(text) > MAX_REVIEW_PAYLOAD_BYTES) {
            sources.push({ name: 'review', machine: chosen.machine, ok: false, reason: 'review-payload-too-large' });
          } else {
            const payload = JSON.parse(text) as ReviewPayload;
            const shapeOk = payload && payload.schema === BOARD_SCHEMA && Array.isArray(payload.rows) && Array.isArray(payload.history);
            // The digest binds the rows exactly as the review machine served them.
            const servedHash = shapeOk ? crypto.createHash('sha256').update(JSON.stringify({ date: payload.date, rows: payload.rows })).digest('hex') : '';
            const rebuilt = shapeOk ? revalidate(payload, now) : null;
            if (!rebuilt) {
              sources.push({ name: 'review', machine: chosen.machine, ok: false, reason: 'invalid-body' });
            } else if (payload.date !== chosen.date || servedHash !== chosen.hash) {
              sources.push({ name: 'review', machine: chosen.machine, ok: false, reason: 'digest-mismatch' });
            } else {
              reviews = rebuilt;
              reviewMachine = chosen.machine;
              commitments = Array.isArray(payload.commitments) ? sanitizeCommitments(payload.commitments) : null;
              linked = null; // initiatives live on the review machine; not projected
              lastRemoteReview = { machine: chosen.machine, machineId: chosen.machineId, fetchedAt: now, reviews: rebuilt };
            }
          }
        } catch {
          sources.push({ name: 'review', machine: chosen.machine, ok: false, reason: 'unreachable' });
        }
      }
      if (missing.length) sources.push({ name: 'may-be-superseded', machine: missing.join(', '), ok: false, reason: 'did-not-answer' });

      const body = buildMaturationBoard({
        now, scope: 'pool', reviews, reviewMachine, owners, commitments, linkedInitiatives: linked, sources,
        reviewCachedAt, reviewUnavailable,
      });
      responseCache.set(cacheKey, { at: now, body });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'maturation board build failed', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    }
  });

  /** Re-validate a peer review payload through the same JSON contract a local file passes. */
  function revalidate(p: ReviewPayload, now: number): ParsedReview[] | null {
    // Feed the raw verdict text back through the same contract a local file passes.
    const doc = { schema: 'maturation-review/1', date: p.date, features: p.rows.map(r => ({ ...r, verdict: r.verdictRaw || r.verdict })) };
    const res = parseReviewJson(`${p.date}.json`, JSON.stringify(doc), now);
    if (!res.ok) return null;
    const safe: ReviewPayload = {
      ...p,
      rows: res.review.rows.map(r => ({ ...r, evidenceReadToday: p.rows.find(x => x.id === r.id)?.evidenceReadToday ?? r.evidenceReadToday })),
      history: p.history.slice(0, MAX_HISTORY * 1024)
        .filter(h => h && typeof h.id === 'string' && typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date) && typeof h.verdict === 'string')
        .map(h => ({ date: h.date, id: h.id.slice(0, 160), verdict: h.verdict.slice(0, 32), carried: h.carried === true })),
    };
    return reviewsFromPayload(safe);
  }

  return router;
}
