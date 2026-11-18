/**
 * Design review records: the fingerprint, report validation, the append, and
 * everything derived on read — status, verdicts, the write record and the
 * provenance line (docs/specs/frontier-design-review-standard.md §3, §4).
 *
 * Pure except `appendDesignReviewRun`. The server is the only writer of the
 * ledger; peers' rows are untrusted data and are cleaned with the same closed
 * lists before they can add a run.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  DURABLE_REVIEW_REASONS,
  TRANSIENT_REVIEW_REASONS,
  designReviewLedgerPath,
  type DesignReviewRun,
  type DesignWriteEntry,
  type ReviewAttempt,
  type ReviewPass,
  type ReviewReason,
  type ReviewVerdict,
} from './designReviewLedger.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK, GEMINI_CLI_FRAMEWORK, GROK_BUILD_FRAMEWORK } from './frameworkFacts.js';

// ── Fingerprint ──────────────────────────────────────────────────────────

/**
 * Frontmatter keys written after review by tools and the operator; a change to
 * any other frontmatter field is a change to the design (§3).
 */
export const FINGERPRINT_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'provenance',
  'review-convergence', 'review-iterations', 'review-completed-at', 'review-report',
  'cross-model-review', 'cross-model-review-reason', 'single-run-completable',
  'frontloaded-decisions', 'cheap-to-change-tags', 'contested-then-cleared',
  'approved',
]);

function excludedKey(key: string): boolean {
  return FINGERPRINT_EXCLUDED_KEYS.has(key) || key.startsWith('approved-') || key.startsWith('approval-');
}

/**
 * The design fingerprint: sha256 of the whole text with line endings
 * normalised, leaving out only the excluded frontmatter fields (each with any
 * indented continuation lines). Shared by the server and the driver.
 */
export function designFingerprint(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n');
  const m = normalised.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  let body = normalised;
  if (m) {
    const kept: string[] = [];
    let dropping = false;
    for (const line of m[1].split('\n')) {
      const key = line.match(/^([A-Za-z0-9_-]+)\s*:/);
      if (key) dropping = excludedKey(key[1]);
      else if (!/^\s/.test(line)) dropping = false;
      if (!dropping) kept.push(line);
    }
    body = `---\n${kept.join('\n')}\n---${m[2]}${normalised.slice(m[0].length)}`;
  }
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The record reference: 12 hex characters naming one document at one revision on one machine. */
export function designReviewReference(machineId: string, realPath: string, fingerprint: string): string {
  return crypto.createHash('sha256').update(`${machineId}\n${realPath}\n${fingerprint}`, 'utf8').digest('hex').slice(0, 12);
}

/** The first `# ` heading, frontmatter stripped, clamped like the constitution-check ledger. */
export function designTitle(markdown: string): string {
  const body = markdown.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const m = body.match(/^#\s+(.+)$/m);
  return clamp(m ? m[1] : '', 160);
}

function clamp(s: unknown, n: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '';
}

// ── Closed lists and reason mapping ─────────────────────────────────────

export const REVIEW_FAMILIES = ['claude', 'codex', 'gemini', 'grok'] as const;
/** Each family reviews through exactly one door. */
const DOOR_OF_FAMILY: Record<string, string> = {
  claude: CLAUDE_CODE_FRAMEWORK, codex: CODEX_CLI_FRAMEWORK, gemini: GEMINI_CLI_FRAMEWORK, grok: GROK_BUILD_FRAMEWORK,
};
export const REVIEW_STATUSES = ['ok', 'degraded', 'unavailable'] as const;
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['CLEAN', 'MINOR ISSUES', 'SERIOUS ISSUES', 'UNKNOWN'];
export const REVIEW_REASONS: readonly ReviewReason[] = [...DURABLE_REVIEW_REASONS, ...TRANSIENT_REVIEW_REASONS];
const OUTCOMES = ['ok', 'refused', 'failed'] as const;
const BASES = ['reported', 'requested'] as const;

export function isDurableReason(r: ReviewReason | undefined): boolean {
  return r !== undefined && (DURABLE_REVIEW_REASONS as readonly string[]).includes(r);
}

/**
 * Map the reviewer module's own reason codes onto the ledger's closed list (§3).
 * Installation, sign-in, setting and plan conditions are durable; one call's
 * failure is transient. A reason the mapping does not know is transient
 * (`call-failed`) and reported as unmapped so the route can count it.
 */
export function mapModuleReason(reason: string | undefined): { reason: ReviewReason; unmapped: boolean } {
  const r = reason ?? '';
  if (/-not-installed$/.test(r)) return { reason: 'not-installed', unmapped: false };
  if (/-not-authed$/.test(r) || r === 'claude-config-missing') return { reason: 'not-signed-in', unmapped: false };
  if (r === 'model-not-on-plan') return { reason: 'not-on-plan', unmapped: false };
  if ([
    'claude-forbidden', 'codex-auth-apikey-forbidden', 'grok-auth-apikey-forbidden', 'grok-not-enabled',
    'grok-login-policy-unverified', 'hardening-unsupported', 'override-not-concrete', 'override-not-frontier',
    'disabled', 'no-supported-framework', 'untrusted-framework',
  ].includes(r)) return { reason: 'disabled', unmapped: false };
  if (['rate-limited', 'weekly-pool-exhausted', 'daily-budget-exhausted'].includes(r)) return { reason: 'limit-reached', unmapped: false };
  if (r === 'timeout') return { reason: 'timed-out', unmapped: false };
  if (['provider-unavailable', 'model-resolution-canary', 'hardening-inconclusive', 'error'].includes(r)) return { reason: 'call-failed', unmapped: false };
  return { reason: 'call-failed', unmapped: true };
}

// ── Report validation (driver → server) and peer-row cleaning ──────────

export interface DesignRunReport {
  runId: string;
  path: string;
  fingerprint: string;
  sessionId: string | null;
  passes: ReviewPass[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{32}$/;

function cleanAttempt(raw: unknown, knownModel: (m: string) => boolean): ReviewAttempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.askedModel !== 'string' || !knownModel(a.askedModel)) return null;
  if (!(OUTCOMES as readonly unknown[]).includes(a.outcome)) return null;
  if (a.reason !== undefined && !(REVIEW_REASONS as readonly unknown[]).includes(a.reason)) return null;
  return { askedModel: a.askedModel, outcome: a.outcome as ReviewAttempt['outcome'], ...(a.reason ? { reason: a.reason as ReviewReason } : {}) };
}

/** Validate one pass against the closed lists; null when anything is off-list. */
export function cleanPass(raw: unknown, knownModel: (m: string) => boolean): ReviewPass | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!(REVIEW_FAMILIES as readonly unknown[]).includes(p.family)) return null;
  if (typeof p.door !== 'string' || DOOR_OF_FAMILY[p.family as string] !== p.door) return null;
  if (!(REVIEW_STATUSES as readonly unknown[]).includes(p.status)) return null;
  if (!(BASES as readonly unknown[]).includes(p.modelBasis)) return null;
  if (p.model !== null && (typeof p.model !== 'string' || !knownModel(p.model))) return null;
  if (p.reason !== undefined && !(REVIEW_REASONS as readonly unknown[]).includes(p.reason)) return null;
  if (p.verdict !== undefined && !(REVIEW_VERDICTS as readonly unknown[]).includes(p.verdict)) return null;
  if (!Array.isArray(p.attempts) || p.attempts.length > 4) return null;
  const attempts: ReviewAttempt[] = [];
  for (const a of p.attempts) {
    const c = cleanAttempt(a, knownModel);
    if (!c) return null;
    attempts.push(c);
  }
  if (p.status === 'ok' && p.model === null) return null;
  return {
    family: p.family as string,
    door: p.door,
    attempts,
    model: p.model as string | null,
    modelBasis: p.modelBasis as ReviewPass['modelBasis'],
    status: p.status as ReviewPass['status'],
    ...(p.reason ? { reason: p.reason as ReviewReason } : {}),
    ...(p.verdict ? { verdict: p.verdict as ReviewVerdict } : {}),
  };
}

export function parseRunReport(raw: unknown, knownModel: (m: string) => boolean):
  { ok: true; report: DesignRunReport } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'report-not-an-object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.runId !== 'string' || !RUN_ID.test(r.runId)) return { ok: false, error: 'runId-invalid' };
  if (typeof r.path !== 'string' || r.path.length === 0 || r.path.length > 4096) return { ok: false, error: 'path-invalid' };
  if (typeof r.fingerprint !== 'string' || !HEX64.test(r.fingerprint)) return { ok: false, error: 'fingerprint-invalid' };
  if (r.sessionId !== null && r.sessionId !== undefined && (typeof r.sessionId !== 'string' || r.sessionId.length > 200)) return { ok: false, error: 'sessionId-invalid' };
  if (!Array.isArray(r.passes) || r.passes.length === 0 || r.passes.length > 8) return { ok: false, error: 'passes-invalid' };
  const passes: ReviewPass[] = [];
  for (const p of r.passes) {
    const c = cleanPass(p, knownModel);
    if (!c) return { ok: false, error: 'pass-invalid' };
    passes.push(c);
  }
  return { ok: true, report: { runId: r.runId, path: r.path, fingerprint: r.fingerprint, sessionId: (r.sessionId as string | null | undefined) ?? null, passes } };
}

/** Clean a peer's row: every field clamped or checked against its closed list; null when it cannot be trusted. */
export function cleanPeerRun(raw: unknown, knownModel: (m: string) => boolean): DesignReviewRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.runId !== 'string' || !RUN_ID.test(r.runId)) return null;
  if (typeof r.fingerprint !== 'string' || !HEX64.test(r.fingerprint)) return null;
  if (typeof r.machineId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.machineId)) return null;
  if (typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt))) return null;
  if (typeof r.path !== 'string' || r.path.length === 0) return null;
  if (!Array.isArray(r.passes) || r.passes.length > 8) return null;
  const passes: ReviewPass[] = [];
  for (const p of r.passes) {
    const c = cleanPass(p, knownModel);
    if (!c) return null;
    passes.push(c);
  }
  const writes: DesignWriteEntry[] = [];
  if (Array.isArray(r.writes)) {
    for (const w of r.writes.slice(0, 200)) {
      if (!w || typeof w !== 'object') continue;
      const e = w as Record<string, unknown>;
      if (typeof e.sessionId !== 'string' || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) continue;
      const model = typeof e.model === 'string' && knownModel(e.model) ? e.model : null;
      writes.push({ sessionId: clamp(e.sessionId, 100), at: clamp(e.at, 40), model });
    }
  }
  return {
    v: 1,
    runId: r.runId,
    machineId: r.machineId,
    recordedAt: clamp(r.recordedAt, 40),
    path: clamp(r.path, 400),
    fingerprint: r.fingerprint,
    title: clamp(r.title, 160),
    sessionId: typeof r.sessionId === 'string' ? clamp(r.sessionId, 100) : null,
    account: typeof r.account === 'string' ? clamp(r.account, 64) : null,
    passes,
    ...(writes.length ? { writes } : {}),
  };
}

// ── Append ───────────────────────────────────────────────────────────────

/**
 * Append one run. Before writing, make sure the file ends in a line break so a
 * torn fragment from a crash stays on its own line and cannot swallow this record.
 */
export function appendDesignReviewRun(stateDir: string, run: DesignReviewRun): void {
  const file = designReviewLedgerPath(stateDir);
  let prefix = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    // @silent-fallback-ok: a file that does not exist yet needs no leading break.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(run)}\n`, { mode: 0o600 });
}

// ── Derived on read ──────────────────────────────────────────────────────

export type DesignReviewStatus = 'reviewed' | 'no-reviewer-reachable' | 'not-reviewed';

export interface DerivedDesignReview {
  status: DesignReviewStatus;
  timesReviewed: number;
  /** Passes of the latest run on the current fingerprint (empty when none). */
  passes: ReviewPass[];
  writeRecord: { models: string[]; unattributedWrites: boolean; anyWrite: boolean };
  designModelTookPart: boolean;
  outsideFamilyTookPart: boolean;
  latestRunId: string | null;
}

/** Merge write entries across runs: one per (session, time), attributed if any copy is. */
export function mergeWrites(runs: readonly DesignReviewRun[]): DesignWriteEntry[] {
  const byKey = new Map<string, DesignWriteEntry>();
  for (const run of runs) {
    for (const w of run.writes ?? []) {
      const key = `${w.sessionId}\n${w.at}`;
      const prev = byKey.get(key);
      if (!prev || (prev.model === null && w.model !== null)) byKey.set(key, w);
    }
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const FAMILY_OF_MODEL = (model: string): string =>
  model.startsWith('claude-') ? 'claude' : model.startsWith('gpt-') ? 'codex' : model.startsWith('gemini-') ? 'gemini' : model.startsWith('grok-') ? 'grok' : 'other';

export function deriveDesignReview(
  runsForPath: readonly DesignReviewRun[],
  fingerprint: string,
  laneModels: readonly string[],
): DerivedDesignReview {
  const sorted = runsForPath.slice().sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const timesReviewed = sorted.filter((r) => r.passes.some((p) => p.status === 'ok')).length;
  const onCurrent = sorted.filter((r) => r.fingerprint === fingerprint);
  const latest = onCurrent[onCurrent.length - 1] ?? null;
  const reviewedNow = onCurrent.some((r) => r.passes.some((p) => p.status === 'ok'));
  let status: DesignReviewStatus = 'not-reviewed';
  if (reviewedNow) status = 'reviewed';
  else if (latest && latest.passes.length > 0 && latest.passes.every((p) => p.status !== 'ok' && isDurableReason(p.reason))) {
    status = 'no-reviewer-reachable';
  }
  const writes = mergeWrites(sorted);
  const models = [...new Set(writes.map((w) => w.model).filter((m): m is string => m !== null))];
  const writeFamilies = new Set(models.map(FAMILY_OF_MODEL));
  const okNow = onCurrent.flatMap((r) => r.passes.filter((p) => p.status === 'ok'));
  return {
    status,
    timesReviewed,
    passes: latest ? latest.passes : [],
    writeRecord: { models, unattributedWrites: writes.some((w) => w.model === null), anyWrite: writes.length > 0 },
    designModelTookPart: okNow.some((p) => p.model !== null && laneModels.includes(p.model)),
    outsideFamilyTookPart: okNow.some((p) => p.model !== null && (writeFamilies.size === 0 ? p.family !== 'claude' : !writeFamilies.has(FAMILY_OF_MODEL(p.model)))),
    latestRunId: latest ? latest.runId : null,
  };
}

// ── The provenance line ─────────────────────────────────────────────────

/** Display name from a model id: claude-fable-5-2 → "Claude Fable 5.2", gpt-6-astra → "GPT-6 Astra". */
export function modelDisplayName(id: string): string {
  const parts = id.split('-');
  const vendor = parts.shift() ?? id;
  if (vendor === 'gpt') {
    const ver = parts.shift() ?? '';
    return [`GPT-${ver}`, ...parts.map(cap)].join(' ').trim();
  }
  const out: string[] = [vendor === 'claude' ? 'Claude' : cap(vendor)];
  let num: string[] = [];
  const flush = () => { if (num.length) { out.push(num.join('.')); num = []; } };
  for (const p of parts) {
    if (/^\d+(\.\d+)?$/.test(p)) num.push(p);
    else { flush(); out.push(cap(p)); }
  }
  flush();
  return out.join(' ');
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

const VERDICT_PHRASE: Record<ReviewVerdict, string> = {
  CLEAN: 'found no issues',
  'MINOR ISSUES': 'found minor issues',
  'SERIOUS ISSUES': 'found serious issues',
  UNKNOWN: 'gave no clear verdict',
};

const REASON_PHRASE: Record<ReviewReason, string> = {
  'not-installed': 'not installed',
  'not-signed-in': 'not signed in',
  disabled: 'not enabled for this agent',
  'not-on-plan': "not on this account's plan",
  'limit-reached': 'limit reached',
  'timed-out': 'timed out',
  'call-failed': 'the call failed',
};

const FAMILY_NAME: Record<string, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok' };

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface LineOptions {
  /** The Claude reviewer is turned off in this agent's settings (explicit `enabled: false`). */
  claudeTurnedOff?: boolean;
}

/**
 * Render the provenance line (§4). Anything missing and any serious verdict
 * comes first; the write record claims only "on record"; the reference ends it.
 */
export function renderProvenanceLine(d: DerivedDesignReview, reference: string, opts: LineOptions = {}): string {
  const opening: string[] = [];
  const rest: string[] = [];
  const passes = d.passes;
  const okPasses = passes.filter((p) => p.status === 'ok' && p.model);
  const pushed = new Set<ReviewPass>();

  for (const p of okPasses) {
    if (p.verdict === 'SERIOUS ISSUES') { opening.push(`${modelDisplayName(p.model!)} ${VERDICT_PHRASE['SERIOUS ISSUES']}.`); pushed.add(p); }
  }
  if (d.status === 'no-reviewer-reachable' || (passes.length > 0 && okPasses.length === 0)) {
    const why = [...new Set(passes.map((p) => p.reason).filter((r): r is ReviewReason => !!r).map((r) => REASON_PHRASE[r]))];
    opening.push(`No reviewer could be reached (${why.join('; ') || 'no reviewer answered'}).`);
  } else {
    for (const p of passes) {
      // A refused design-model attempt followed by a fallback that answered.
      const refused = p.attempts.find((a) => a.outcome !== 'ok');
      if (refused && p.status === 'ok' && p.model && refused.askedModel !== p.model) {
        const verdict = p.verdict ? VERDICT_PHRASE[p.verdict] : VERDICT_PHRASE.UNKNOWN;
        const tail = p.verdict === 'SERIOUS ISSUES' ? '' : ` and ${verdict}`;
        opening.push(`${modelDisplayName(refused.askedModel)} did not review this (${REASON_PHRASE[refused.reason ?? 'call-failed']}); ${modelDisplayName(p.model)} reviewed in its place${tail}.`);
        pushed.add(p);
      } else if (p.status !== 'ok') {
        if (p.family === 'claude' && opts.claudeTurnedOff) opening.push("Review by Claude is turned off in this agent's settings.");
        else if (p.reason !== 'disabled') {
          const asked = p.attempts[0]?.askedModel ?? p.model;
          opening.push(`${asked ? modelDisplayName(asked) : FAMILY_NAME[p.family] ?? p.family} did not review this (${REASON_PHRASE[p.reason ?? 'call-failed']}).`);
        }
      }
    }
    if (!d.outsideFamilyTookPart) {
      const enabledOutside = passes.some((p) => p.family !== 'claude' && p.reason !== 'disabled');
      opening.push(enabledOutside
        ? 'No model from another provider reviewed this.'
        : 'No model from another provider reviewed this (none enabled for this agent).');
    }
  }
  for (const p of okPasses) {
    if (p.verdict === 'UNKNOWN' && !pushed.has(p)) { opening.push(`${modelDisplayName(p.model!)} ${VERDICT_PHRASE.UNKNOWN}.`); pushed.add(p); }
  }
  if (!d.writeRecord.anyWrite) opening.push('No record of which model wrote this.');

  if (d.writeRecord.anyWrite) {
    const names = d.writeRecord.models.map(modelDisplayName);
    if (names.length === 0) rest.push('On record as written in a session with no model on record.');
    else {
      const who = names.length === 1 ? `a session running ${names[0]}` : `sessions running ${joinList(names)}`;
      rest.push(`On record as written in ${who}${d.writeRecord.unattributedWrites ? ', and at least one write with no model on record' : ''}.`);
    }
  }
  rest.push(`Reviewed ${d.timesReviewed} ${d.timesReviewed === 1 ? 'time' : 'times'}.`);
  const remaining = okPasses.filter((p) => !pushed.has(p)).map((p) => `${modelDisplayName(p.model!)} ${VERDICT_PHRASE[p.verdict ?? 'UNKNOWN']}`);
  if (remaining.length) rest.push(`On this version: ${remaining.join(', ')}.`);
  return `${[...opening, ...rest].join(' ')} (Review record ${reference})`;
}
