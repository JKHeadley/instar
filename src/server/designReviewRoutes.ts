/**
 * Design review routes (docs/specs/frontier-design-review-standard.md §3, §4).
 *
 *   POST /design/review/runs   the driver's report of one recorded run (server is the only writer)
 *   GET  /design/review?path=  status, write record, verdicts, the provenance line and its reference
 *   GET  /design/review/runs?since=N  this machine's rows, for peers (proxied-on-read)
 *
 * Live on every agent from the release (routing, B26 and the same-door change are
 * what the development-agent gate controls). A memory-private session is refused
 * by the auth middleware's default-deny guard and cannot record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  designReviewLedgerPath,
  readDesignReviewLedger,
  type DesignReviewRun,
  type DesignWriteEntry,
} from '../core/designReviewLedger.js';
import {
  appendDesignReviewRun,
  deriveDesignReview,
  designFingerprint,
  designReviewReference,
  designTitle,
  parseRunReport,
  renderProvenanceLine,
  type DesignRunReport,
} from '../core/designReviewRecord.js';
import { DESIGN_LANE_MODELS } from '../core/designLane.js';
import { KNOWN_MODEL_IDS } from '../core/ModelTierEscalation.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export const DESIGN_REVIEW_SPOOL_FILE = 'design-review-spool.jsonl';
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_RUNS_PAGE = 500;

export interface DesignReviewRouteDeps {
  stateDir: string;
  projectDir: string;
  machineId: () => string;
  /** The server's own record of a session: its working directory and pool account. */
  sessionRecord: (sessionId: string) => { cwd?: string; subscriptionAccountId?: string } | null;
  /** Stored hook events: every Claude session id, and one session's events. */
  hookEvents?: { listSessions(): string[]; getSessionEvents(id: string): Array<{ receivedAt: string; payload: Record<string, unknown> }> } | null;
  tokenLedger?: { modelsAround(sessionId: string, atMs: number): { before: string | null; after: string | null } } | null;
  /** The Claude reviewer explicitly turned off in this agent's settings. */
  claudeTurnedOff?: () => boolean;
}

const KNOWN_MODELS = new Set<string>(Object.values(KNOWN_MODEL_IDS).flat());
export const isKnownReviewModel = (m: string): boolean => KNOWN_MODELS.has(m);
const LANES = Object.values(DESIGN_LANE_MODELS).filter((m): m is string => m !== null);

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; } // @silent-fallback-ok: an unresolvable root or path is simply not a root/acceptable path
}

export type AcceptedDoc = { ok: true; realPath: string; text: string } | { ok: false; status: number; error: string; message: string };

/**
 * Accept a path only if its real path is a regular text file outside the state
 * directory and inside the project directory, the agent home, or the reporting
 * session's own working directory (from the server's record, never the request).
 * The limit exists so the route cannot be used to read arbitrary files.
 */
const OUTSIDE: AcceptedDoc = { ok: false, status: 403, error: 'path-outside-allowed-roots', message: 'The design document must be inside the project, the agent home, or this session\'s working folder, and not in the agent state folder. Copy the plan into the project.' };

export function acceptDesignDocument(deps: DesignReviewRouteDeps, rawPath: unknown, sessionId: string | null): AcceptedDoc {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4096) {
    return { ok: false, status: 400, error: 'path-invalid', message: 'Pass the absolute path of the design document.' };
  }
  const roots = [deps.projectDir, path.dirname(deps.stateDir)];
  const rec = sessionId ? deps.sessionRecord(sessionId) : null;
  if (rec?.cwd) roots.push(rec.cwd);
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null);
  const stateReal = realOrNull(deps.stateDir);
  const allowed = (p: string) => realRoots.some((r) => inside(p, r)) && !(stateReal && inside(p, stateReal));
  // Roots first, and one answer for everything outside them, so the route cannot be
  // used to learn which files exist elsewhere on the machine.
  const lexical = path.resolve(deps.projectDir, rawPath);
  const lexicalOk = roots.some((r) => inside(lexical, path.resolve(r))) || realRoots.some((r) => inside(lexical, r));
  if (!lexicalOk) return OUTSIDE;
  const real = realOrNull(lexical);
  if (!real) return { ok: false, status: 404, error: 'path-not-found', message: 'The design document does not exist at that path. Write the plan to a file first.' };
  if (!allowed(real)) return OUTSIDE;
  // Open the resolved path once without following a link swapped in since, and read
  // from that handle, so what is hashed is the file that was checked.
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, status: 404, error: 'path-not-found', message: 'The design document could not be opened.' }; // @silent-fallback-ok: reported to the caller
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, status: 400, error: 'path-not-a-file', message: 'The path is not a regular file.' };
    if (st.size > MAX_DOC_BYTES) return { ok: false, status: 413, error: 'document-too-large', message: 'The design document is larger than 2 MB.' };
    const buf = fs.readFileSync(fd);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, status: 415, error: 'not-a-text-file', message: 'The design document is not a text file.' };
    return { ok: true, realPath: real, text: buf.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes to the file found in stored hook events (tool name, path, session id and
 * time only), each with the model on that session's usage rows either side of it
 * when they agree. A write already recorded is appended again only when its model
 * has become known (§3).
 */
export function resolveDesignWrites(deps: DesignReviewRouteDeps, realPath: string, prior: readonly DesignReviewRun[]): DesignWriteEntry[] {
  if (!deps.hookEvents) return [];
  const known = new Map<string, string | null>();
  for (const run of prior) for (const w of run.writes ?? []) {
    const k = `${w.sessionId}\n${w.at}`;
    if (!known.has(k) || known.get(k) === null) known.set(k, w.model);
  }
  const out: DesignWriteEntry[] = [];
  const base = path.basename(realPath);
  for (const sid of deps.hookEvents.listSessions()) {
    let events: Array<{ receivedAt: string; payload: Record<string, unknown> }>;
    try { events = deps.hookEvents.getSessionEvents(sid); } catch { continue; } // @silent-fallback-ok: an unreadable event file contributes no writes
    for (const e of events) {
      const p = e.payload ?? {};
      const tool = p.tool_name;
      if (tool !== 'Write' && tool !== 'Edit') continue;
      const input = (p.tool_input ?? {}) as Record<string, unknown>;
      const fp = typeof input.file_path === 'string' ? input.file_path : typeof p.file_path === 'string' ? p.file_path : null;
      // Cheap filter first: only a write to a file of the same name is resolved.
      if (!fp || path.basename(fp) !== base) continue;
      const real = realOrNull(fp) ?? path.resolve(fp);
      if (real !== realPath) continue;
      const at = e.receivedAt;
      const atMs = Date.parse(at);
      let model: string | null = null;
      if (deps.tokenLedger && Number.isFinite(atMs)) {
        const around = deps.tokenLedger.modelsAround(sid, atMs);
        if (around.before && around.before === around.after && isKnownReviewModel(around.before)) model = around.before;
      }
      const k = `${sid}\n${at}`;
      if (known.has(k) && (known.get(k) !== null || model === null)) continue;
      out.push({ sessionId: sid.slice(0, 100), at, model });
    }
  }
  return out;
}

export interface RecordOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Validate and record one report; shared by the route and the spool intake. */
export function recordDesignReviewReport(deps: DesignReviewRouteDeps, raw: unknown, reportingSessionId: string | null): RecordOutcome {
  const parsed = parseRunReport(raw, isKnownReviewModel);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const report: DesignRunReport = parsed.report;
  const sessionId = reportingSessionId ?? report.sessionId;
  const doc = acceptDesignDocument(deps, report.path, sessionId);
  if (!doc.ok) return { status: doc.status, body: { error: doc.error, message: doc.message } };
  const fingerprint = designFingerprint(doc.text);
  if (fingerprint !== report.fingerprint) {
    return { status: 409, body: { error: 'document-changed-during-review', message: 'The file changed while it was being reviewed. Run the review again on the file as it stands.' } };
  }
  const ledger = readDesignReviewLedger(deps.stateDir);
  if (ledger.unreadable) return { status: 503, body: { error: 'records-unavailable' } };
  const existing = ledger.runs.find((r) => r.runId === report.runId);
  if (existing) {
    if (existing.fingerprint === report.fingerprint) return { status: 200, body: { recorded: false, duplicate: true, runId: report.runId } };
    return { status: 409, body: { error: 'run-id-conflict' } };
  }
  const machineId = deps.machineId();
  const forPath = ledger.runs.filter((r) => r.machineId === machineId && r.path === doc.realPath);
  const rec = sessionId ? deps.sessionRecord(sessionId) : null;
  const writes = resolveDesignWrites(deps, doc.realPath, forPath);
  const run: DesignReviewRun = {
    v: 1,
    runId: report.runId,
    machineId,
    recordedAt: new Date().toISOString(),
    path: doc.realPath,
    fingerprint,
    title: designTitle(doc.text),
    sessionId,
    account: rec?.subscriptionAccountId ?? null,
    passes: report.passes,
    ...(writes.length ? { writes } : {}),
  };
  appendDesignReviewRun(deps.stateDir, run);
  const derived = deriveDesignReview([...forPath, run], fingerprint, LANES);
  const reference = designReviewReference(machineId, doc.realPath, fingerprint);
  featureEvidence.record('frontier-design-review', {
    kind: 'fired',
    reason: 'review-run-recorded',
    context: { status: derived.status, passes: run.passes.length, okPasses: run.passes.filter((p) => p.status === 'ok').length, designModelTookPart: derived.designModelTookPart },
  });
  return {
    status: 201,
    body: {
      recorded: true,
      runId: run.runId,
      status: derived.status,
      timesReviewed: derived.timesReviewed,
      reference,
      line: renderProvenanceLine(derived, reference, { claudeTurnedOff: deps.claudeTurnedOff?.() ?? false }),
    },
  };
}

/** Take spooled reports in at server start; a refused one is dropped and counted, never retried. */
export function ingestDesignReviewSpool(deps: DesignReviewRouteDeps): { recorded: number; dropped: number } {
  const file = path.join(deps.stateDir, DESIGN_REVIEW_SPOOL_FILE);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { recorded: 0, dropped: 0 }; } // @silent-fallback-ok: no spool is the normal case
  let recorded = 0;
  let dropped = 0;
  const keep: string[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { report?: unknown };
    try {
      entry = JSON.parse(line) as { report?: unknown };
    } catch {
      dropped++; // @silent-fallback-ok: a torn spool line is dropped and counted
      continue;
    }
    try {
      const r = recordDesignReviewReport(deps, entry.report, null);
      if (r.status === 201 || r.status === 200) recorded++;
      // Only a refusal (4xx) drops a report; a fault on this side keeps it for the next start.
      else if (r.status >= 500) keep.push(line);
      else dropped++;
    } catch {
      keep.push(line); // @silent-fallback-ok: kept and retried at the next start
    }
  }
  // Keep anything appended while this ran, after the lines kept here.
  let tail = '';
  try { tail = fs.readFileSync(file, 'utf8').slice(raw.length); } catch { tail = ''; } // @silent-fallback-ok: nothing appended
  fs.writeFileSync(file, (keep.length ? keep.join('\n') + '\n' : '') + tail, { mode: 0o600 });
  if (dropped > 0) featureEvidence.record('frontier-design-review', { kind: 'error', reason: 'spooled-report-dropped', context: { dropped } });
  return { recorded, dropped };
}

export function createDesignReviewRoutes(deps: DesignReviewRouteDeps): Router {
  const router = Router();

  router.post('/design/review/runs', (req: Request, res: Response) => {
    const headerSession = req.get('X-Instar-Session-Id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof headerSession === 'string' && headerSession.length > 0 ? headerSession.slice(0, 200)
      : typeof body.sessionId === 'string' ? body.sessionId : null;
    try {
      const out = recordDesignReviewReport(deps, body, sessionId);
      res.status(out.status).json(out.body);
    } catch (err) {
      featureEvidence.record('frontier-design-review', { kind: 'error', reason: 'record-fault' });
      res.status(500).json({ error: 'record-failed', message: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    }
  });

  router.get('/design/review', (req: Request, res: Response) => {
    const sessionId = typeof req.get('X-Instar-Session-Id') === 'string' ? String(req.get('X-Instar-Session-Id')).slice(0, 200) : null;
    const doc = acceptDesignDocument(deps, req.query.path, sessionId);
    if (!doc.ok) { res.status(doc.status).json({ error: doc.error, message: doc.message }); return; }
    const ledger = readDesignReviewLedger(deps.stateDir);
    if (ledger.unreadable) { res.status(503).json({ error: 'records-unavailable' }); return; }
    const machineId = deps.machineId();
    const fingerprint = designFingerprint(doc.text);
    const forPath = ledger.runs.filter((r) => r.machineId === machineId && r.path === doc.realPath);
    const reference = designReviewReference(machineId, doc.realPath, fingerprint);
    if (forPath.length === 0) {
      res.json({ status: 'not-reviewed', timesReviewed: 0, writeRecord: null, passes: [], line: null, reference: null, path: doc.realPath });
      return;
    }
    const d = deriveDesignReview(forPath, fingerprint, LANES);
    const line = d.status === 'not-reviewed' && d.passes.length === 0 ? null : renderProvenanceLine(d, reference, { claudeTurnedOff: deps.claudeTurnedOff?.() ?? false });
    res.json({
      status: d.status,
      timesReviewed: d.timesReviewed,
      writeRecord: d.writeRecord,
      passes: d.passes,
      line,
      reference: line ? reference : null,
      path: doc.realPath,
      ...(ledger.skipped ? { skippedLines: ledger.skipped } : {}),
    });
  });

  router.get('/design/review/runs', (req: Request, res: Response) => {
    const ledger = readDesignReviewLedger(deps.stateDir);
    if (ledger.unreadable) { res.status(503).json({ error: 'records-unavailable' }); return; }
    const since = Math.max(0, Number.parseInt(String(req.query.since ?? '0'), 10) || 0);
    const machineId = deps.machineId();
    const mine = ledger.runs.filter((r) => r.machineId === machineId);
    const page = mine.slice(since, since + MAX_RUNS_PAGE);
    res.json({ runs: page, cursor: since + page.length, total: mine.length, ledgerFile: path.basename(designReviewLedgerPath(deps.stateDir)) });
  });

  return router;
}
