/**
 * stallCoverageValidator — the single validator for framework stall-coverage
 * matrices (docs/frameworks/<framework>-stall-coverage.md).
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md (§2.2, §3.1, §3.2)
 *
 * ONE module, TWO callsites (spec §3.2). This file implements the HERMETIC
 * half only — the CI-ratchet callsite (tests/unit/stall-coverage-ratchet.test.ts):
 * schema, status tokens, canonical-class completeness, symbol existence under
 * the path jail, evidence containment + push-suite collection, ref FORMAT,
 * and the calendar aging ratchet. The NON-hermetic checks (closePath/issueRef
 * LIVENESS against the commitments ledger, guardKey posture cross-check
 * against /guards) belong to the PR-B runtime-gate callsite; the `deps`
 * injection seam below is where those checkers plug in without changing the
 * result shape (issues/warnings arrays absorb new rules additively).
 *
 * Refusal hygiene (spec Frontloaded Decision 16): every issue message
 * references the class id (only when canonical) + the rule name — rejected
 * raw field content is NEVER echoed into messages.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { STALL_CLASSES, REQUIRED_MATRIX_FRAMEWORKS } from '../data/stall-classes.js';
import { GUARD_MANIFEST, NOT_A_GUARD } from '../monitoring/guardManifest.js';

// ─── Public types ────────────────────────────────────────────────────────────────

/** One parsed `stall-coverage:` front-matter row (fields as authored). */
export interface StallMatrixRow {
  class?: string;
  status?: string;
  reason?: string;
  detector?: string;
  recovery?: string;
  guardKey?: string;
  posture?: string;
  evidence?: string;
  issueRef?: string;
  closePath?: string;
  seededAt?: string;
  acceptanceRef?: string;
  revalidateOn?: string;
  'liveness-surface'?: string;
  matchedClasses?: string[];
}

export interface StallMatrixIssue {
  /** Canonical class id — set ONLY when the row's class is canonical (an
   *  unknown class id is rejected content and never echoed). */
  classId?: string;
  /** Stable kebab rule name. */
  rule: string;
  /** References class id + rule name only — never rejected raw field content. */
  message: string;
}

/** Per-row verification record (spec §3.2): the validator's verdict is
 *  STRUCTURAL — `mechanically-verified: presence-only` on every row, so no
 *  downstream surface (the PR-B gate report included) can present `covered`
 *  as semantically proven. Whether a covered claim is TRUE stays with the
 *  overseer. */
export interface StallMatrixRowRecord {
  classId: string;
  status: string;
  mechanicallyVerified: 'presence-only';
}

export interface StallMatrixResult {
  framework: string;
  filePath: string;
  valid: boolean;
  issues: StallMatrixIssue[];
  warnings: StallMatrixIssue[];
  rowCount: number;
  /** One record per canonical-class row (spec §3.2 presence-only marker). */
  rows: StallMatrixRowRecord[];
  /** sha256 of the exact file bytes validated (single read). */
  contentHash: string;
}

export interface StallMatrixSetResult {
  valid: boolean;
  /** Set-level issues (e.g. matrix-file-missing). */
  issues: StallMatrixIssue[];
  results: StallMatrixResult[];
}

/** Injection seam for tests AND for the PR-B non-hermetic checkers. */
export interface StallCoverageValidatorDeps {
  /** Dotted guard-inventory keys (default: GUARD_MANIFEST keys). */
  guardManifestKeys?: ReadonlySet<string>;
  /** Manifest-exempt component → exemption reason (default: NOT_A_GUARD). */
  notAGuardComponents?: ReadonlyMap<string, string>;
  /** Canonical class ids (default: STALL_CLASSES ids). */
  stallClassIds?: readonly string[];
  /** Frameworks that must carry a matrix file (default: REQUIRED_MATRIX_FRAMEWORKS). */
  requiredFrameworks?: readonly string[];
  /** Repo-relative path of the push-suite vitest config (default vitest.push.config.ts). */
  pushConfigPath?: string;
}

// ─── Constants (spec §3.1 clamps) ────────────────────────────────────────────────

const MATRIX_FILE_CAP_BYTES = 256 * 1024;
const TARGET_FILE_CAP_BYTES = 1024 * 1024;
const ROW_CAP = 64;
const FREE_TEXT_CAP = 256;
const MATRIX_SUFFIX = '-stall-coverage.md';

const STATUS_TOKENS = new Set(['covered', 'covered-dark', 'declared-gap', 'not-applicable']);
const SYMBOL_RE = /^[A-Za-z0-9_./#-]{1,128}$/;
const ISSUE_REF_RE = /^[a-z0-9:-]{1,80}$/;
const CLOSE_PATH_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const ACCEPTANCE_REF_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREE_TEXT_FIELDS = ['reason', 'liveness-surface', 'revalidateOn'] as const;

/** Vitest skip-class modifier tokens — a test no runner executes proves nothing. */
const SKIP_TOKENS = [
  'describe.skip',
  'it.skip',
  'test.skip',
  'xit(',
  'xdescribe(',
  'it.todo',
  'test.todo',
  'it.skipIf',
  'test.skipIf',
  'describe.todo',
] as const;

const AGING_WARN_DAYS = 45;
const AGING_FAIL_DAYS = 60;

// ─── Internal context ────────────────────────────────────────────────────────────

type JailedRead = { text: string } | { error: 'missing' | 'escape' | 'too-large' };

interface Ctx {
  repoRoot: string;
  now: Date;
  classIds: readonly string[];
  classIdSet: ReadonlySet<string>;
  guardKeys: ReadonlySet<string>;
  exemptComponents: ReadonlyMap<string, string>;
  pushConfigPath: string;
  /** Lazily parsed push-suite sets; undefined = not yet parsed, null = unparseable. */
  pushSuite?: { includes: RegExp[]; flaky: RegExp[] } | null;
  fileCache: Map<string, JailedRead>;
}

function buildCtx(repoRoot: string, now: Date | undefined, deps: StallCoverageValidatorDeps | undefined): Ctx {
  const classIds = deps?.stallClassIds ?? STALL_CLASSES.map((c) => c.id);
  return {
    repoRoot,
    now: now ?? new Date(),
    classIds,
    classIdSet: new Set(classIds),
    guardKeys: deps?.guardManifestKeys ?? new Set(GUARD_MANIFEST.map((e) => e.key)),
    exemptComponents:
      deps?.notAGuardComponents ?? new Map(NOT_A_GUARD.map((e) => [e.component, e.reason])),
    pushConfigPath: deps?.pushConfigPath ?? 'vitest.push.config.ts',
    fileCache: new Map(),
  };
}

// ─── Path jail + capped reads (spec §3.1) ────────────────────────────────────────

function hasDotDotSegment(rel: string): boolean {
  return rel.split('/').includes('..');
}

/** Resolve `rel` against repoRoot, realpath-jail it inside the repo, and read it
 *  under the 1MB cap. Single read per path per validation (cached). */
function readJailed(ctx: Ctx, rel: string): JailedRead {
  const cached = ctx.fileCache.get(rel);
  if (cached) return cached;
  let result: JailedRead;
  try {
    const abs = path.resolve(ctx.repoRoot, rel);
    const real = fs.realpathSync(abs);
    const rootReal = fs.realpathSync(ctx.repoRoot);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      result = { error: 'escape' };
    } else if (fs.statSync(real).size > TARGET_FILE_CAP_BYTES) {
      result = { error: 'too-large' };
    } else {
      result = { text: fs.readFileSync(real, 'utf8') };
    }
  } catch {
    result = { error: 'missing' };
  }
  ctx.fileCache.set(rel, result);
  return result;
}

// ─── Push-suite effective collected set (static parse, no execution) ─────────────

/** Minimal glob matcher supporting `**` and `*` — no new dependencies. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else {
      out += /[A-Za-z0-9_/]/.test(c) ? c : '\\' + c;
      i += 1;
    }
  }
  return new RegExp(out + '$');
}

/** Statically extract the include globs + FLAKY_TESTS entries from the push
 *  config TEXT (never executes the config). Null = unparseable (fails closed
 *  at the callsite via push-config-unparseable). */
export function parsePushSuiteSets(
  text: string,
): { includes: RegExp[]; flaky: RegExp[] } | null {
  // Strip line comments so quoted strings inside prose can't pollute the sets.
  const stripped = text
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('//');
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join('\n');
  const flakyM = /FLAKY_TESTS\s*=\s*\[([\s\S]*?)\]/.exec(stripped);
  const includeM = /include:\s*\[([\s\S]*?)\]/.exec(stripped);
  if (!flakyM || !includeM) return null;
  const strings = (block: string): string[] =>
    [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const includes = strings(includeM[1]);
  if (includes.length === 0) return null;
  return {
    includes: includes.map(globToRegExp),
    flaky: strings(flakyM[1]).map(globToRegExp),
  };
}

function getPushSuite(ctx: Ctx): { includes: RegExp[]; flaky: RegExp[] } | null {
  if (ctx.pushSuite !== undefined) return ctx.pushSuite;
  const read = readJailed(ctx, ctx.pushConfigPath);
  ctx.pushSuite = 'text' in read ? parsePushSuiteSets(read.text) : null;
  return ctx.pushSuite;
}

// ─── Row validation ──────────────────────────────────────────────────────────────

interface RowSink {
  framework: string;
  issues: StallMatrixIssue[];
  warnings: StallMatrixIssue[];
}

function refuse(sink: RowSink, rule: string, classId: string | undefined, where: string): void {
  sink.issues.push({
    ...(classId ? { classId } : {}),
    rule,
    message: `${sink.framework} ${where}: rule '${rule}' violated`,
  });
}

function warn(sink: RowSink, rule: string, classId: string | undefined, message: string): void {
  sink.warnings.push({ ...(classId ? { classId } : {}), rule, message });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate one `path/to/file.ts#Export` ref: charset, `..`, format, jail,
 *  read cap, and identifier containment. Returns the identifier when fully
 *  resolvable, else null (issues already recorded). */
function checkSymbolRef(
  ctx: Ctx,
  sink: RowSink,
  classId: string | undefined,
  where: string,
  ref: string,
): string | null {
  if (!SYMBOL_RE.test(ref)) {
    refuse(sink, 'symbol-charset-invalid', classId, where);
    return null;
  }
  const hashIdx = ref.indexOf('#');
  if (hashIdx <= 0 || hashIdx !== ref.lastIndexOf('#') || hashIdx === ref.length - 1) {
    refuse(sink, 'symbol-format-invalid', classId, where);
    return null;
  }
  const filePart = ref.slice(0, hashIdx);
  const identifier = ref.slice(hashIdx + 1);
  if (hasDotDotSegment(filePart)) {
    refuse(sink, 'path-traversal-rejected', classId, where);
    return null;
  }
  const read = readJailed(ctx, filePart);
  if ('error' in read) {
    refuse(
      sink,
      read.error === 'escape'
        ? 'path-escapes-repo'
        : read.error === 'too-large'
          ? 'target-file-too-large'
          : 'symbol-unresolvable',
      classId,
      where,
    );
    return null;
  }
  if (!read.text.includes(identifier)) {
    refuse(sink, 'symbol-unresolvable', classId, where);
    return null;
  }
  return identifier;
}

function checkEvidence(
  ctx: Ctx,
  sink: RowSink,
  classId: string,
  where: string,
  evidence: string,
  detectorIdentifier: string | null,
): void {
  if (!SYMBOL_RE.test(evidence)) {
    refuse(sink, 'symbol-charset-invalid', classId, where);
    return;
  }
  if (hasDotDotSegment(evidence)) {
    refuse(sink, 'path-traversal-rejected', classId, where);
    return;
  }
  const read = readJailed(ctx, evidence);
  if ('error' in read) {
    refuse(
      sink,
      read.error === 'escape'
        ? 'path-escapes-repo'
        : read.error === 'too-large'
          ? 'target-file-too-large'
          : 'evidence-file-missing',
      classId,
      where,
    );
    return;
  }
  if (detectorIdentifier && !read.text.includes(detectorIdentifier)) {
    refuse(sink, 'evidence-identifier-missing', classId, where);
  }
  if (!read.text.includes(`stall-class: ${classId}`)) {
    refuse(sink, 'evidence-marker-missing', classId, where);
  }
  for (const token of SKIP_TOKENS) {
    if (read.text.includes(token)) {
      refuse(sink, 'evidence-skip-marked', classId, where);
      break;
    }
  }
  if (evidence.startsWith('tests/')) {
    const suite = getPushSuite(ctx);
    if (!suite) {
      refuse(sink, 'push-config-unparseable', classId, where);
    } else if (suite.flaky.some((re) => re.test(evidence))) {
      refuse(sink, 'evidence-excluded-from-push-suite', classId, where);
    } else if (!suite.includes.some((re) => re.test(evidence))) {
      refuse(sink, 'evidence-not-collected', classId, where);
    }
  }
}

function checkGuardKey(
  ctx: Ctx,
  sink: RowSink,
  classId: string | undefined,
  where: string,
  guardKey: string,
): void {
  if (guardKey.startsWith('exempt:')) {
    const component = guardKey.slice('exempt:'.length);
    const reason = ctx.exemptComponents.get(component);
    if (reason === undefined) {
      refuse(sink, 'guard-key-unknown', classId, where);
    } else {
      // Component name + reason come from our own manifest (matched, not rejected).
      warn(
        sink,
        'guard-exempt-vacuous',
        classId,
        `${where}: guard posture check is vacuous — manifest-exempt component '${component}' (${reason})`,
      );
    }
    return;
  }
  if (!ctx.guardKeys.has(guardKey)) {
    refuse(sink, 'guard-key-unknown', classId, where);
  }
}

function checkSeededAtAndAging(
  ctx: Ctx,
  sink: RowSink,
  classId: string | undefined,
  where: string,
  row: StallMatrixRow,
): void {
  const seededAt = row.seededAt;
  if (seededAt === undefined) return;
  if (typeof seededAt !== 'string' || !ISO_DATE_RE.test(seededAt)) {
    refuse(sink, 'seeded-at-invalid', classId, where);
    return;
  }
  // Calendar arithmetic in UTC dates (matches the codemod's UTC ISO stamp).
  const nowDate = ctx.now.toISOString().slice(0, 10);
  if (seededAt > nowDate) {
    refuse(sink, 'seeded-at-future-dated', classId, where);
    return;
  }
  const ageDays = (Date.parse(nowDate) - Date.parse(seededAt)) / 86_400_000;
  const reason = typeof row.reason === 'string' ? row.reason : '';
  if (reason.includes('unreviewed')) {
    if (ageDays >= AGING_FAIL_DAYS) {
      refuse(sink, 'unreviewed-aged-out', classId, where);
    } else if (ageDays >= AGING_WARN_DAYS) {
      warn(
        sink,
        'unreviewed-aging',
        classId,
        `${where}: seeded row still unreviewed at ${Math.floor(ageDays)} days (CI red at ${AGING_FAIL_DAYS})`,
      );
    }
  } else {
    // Clearing `unreviewed` requires review, not a label flip (spec §2.1).
    const ref = row.acceptanceRef;
    if (typeof ref !== 'string' || !ACCEPTANCE_REF_RE.test(ref)) {
      refuse(sink, 'unreviewed-cleared-without-acceptance', classId, where);
    }
  }
}

function validateRow(ctx: Ctx, sink: RowSink, row: unknown, index: number): string | null {
  const anonWhere = `row ${index}`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    refuse(sink, 'row-not-object', undefined, anonWhere);
    return null;
  }
  const r = row as StallMatrixRow;
  const canonical = typeof r.class === 'string' && ctx.classIdSet.has(r.class);
  const classId = canonical ? (r.class as string) : undefined;
  const where = classId ? `class '${classId}'` : anonWhere;
  if (!canonical) {
    refuse(sink, 'class-unknown', undefined, anonWhere);
  }

  // Free-text clamps (parsed values; YAML folded scalars are fine).
  for (const field of FREE_TEXT_FIELDS) {
    const v = (r as Record<string, unknown>)[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') refuse(sink, 'free-text-invalid', classId, where);
    else if (v.length > FREE_TEXT_CAP) refuse(sink, 'free-text-too-long', classId, where);
  }

  if (!isNonEmptyString(r['liveness-surface'])) {
    refuse(sink, 'liveness-surface-missing', classId, where);
  }

  checkSeededAtAndAging(ctx, sink, classId, where, r);

  const status = r.status;
  if (typeof status !== 'string' || !STATUS_TOKENS.has(status)) {
    refuse(sink, 'status-token-invalid', classId, where);
    return classId ?? null;
  }

  if (status === 'covered' || status === 'covered-dark') {
    let detectorIdentifier: string | null = null;
    if (!isNonEmptyString(r.detector)) {
      refuse(sink, 'detector-missing', classId, where);
    } else {
      detectorIdentifier = checkSymbolRef(ctx, sink, classId, where, r.detector);
    }
    if (!isNonEmptyString(r.recovery)) {
      refuse(sink, 'recovery-missing', classId, where);
    } else {
      checkSymbolRef(ctx, sink, classId, where, r.recovery);
    }
    if (isNonEmptyString(r.detector) && isNonEmptyString(r.recovery) && r.detector === r.recovery) {
      refuse(sink, 'detector-equals-recovery', classId, where);
    }
    if (!isNonEmptyString(r.guardKey)) {
      refuse(sink, 'guard-key-missing', classId, where);
    } else {
      checkGuardKey(ctx, sink, classId, where, r.guardKey);
    }
    if (!isNonEmptyString(r.evidence)) {
      refuse(sink, 'evidence-missing', classId, where);
    } else if (classId) {
      checkEvidence(ctx, sink, classId, where, r.evidence, detectorIdentifier);
    }
    if (status === 'covered') {
      if (r.posture !== 'live') refuse(sink, 'posture-not-live', classId, where);
    } else {
      // covered-dark: the flip-live debt must carry a tracked ref.
      if (!isNonEmptyString(r.closePath)) refuse(sink, 'closepath-missing', classId, where);
      else if (!CLOSE_PATH_RE.test(r.closePath)) refuse(sink, 'closepath-charset-invalid', classId, where);
    }
  } else if (status === 'declared-gap') {
    if (!isNonEmptyString(r.issueRef)) refuse(sink, 'issueref-missing', classId, where);
    else if (!ISSUE_REF_RE.test(r.issueRef)) refuse(sink, 'issueref-charset-invalid', classId, where);
    if (!isNonEmptyString(r.closePath)) refuse(sink, 'closepath-missing', classId, where);
    else if (!CLOSE_PATH_RE.test(r.closePath)) refuse(sink, 'closepath-charset-invalid', classId, where);
    else if (r.closePath === 'pending-mint' && !isNonEmptyString(r.seededAt)) {
      // The aging clock can never be escaped by omitting the stamp (spec §2.1).
      refuse(sink, 'pending-mint-without-seededat', classId, where);
    }
  } else if (status === 'not-applicable') {
    if (!isNonEmptyString(r.reason)) refuse(sink, 'reason-missing', classId, where);
    if (!isNonEmptyString(r.revalidateOn)) refuse(sink, 'revalidateon-missing', classId, where);
  }

  if (r.matchedClasses !== undefined) {
    if (!Array.isArray(r.matchedClasses)) {
      refuse(sink, 'matched-class-unknown', classId, where);
    } else {
      for (const m of r.matchedClasses) {
        if (typeof m !== 'string' || !ctx.classIdSet.has(m)) {
          refuse(sink, 'matched-class-unknown', classId, where);
          break;
        }
      }
    }
  }

  return classId ?? null;
}

// ─── File validation ─────────────────────────────────────────────────────────────

export function validateStallMatrixFile(args: {
  repoRoot: string;
  filePath: string;
  now?: Date;
  deps?: StallCoverageValidatorDeps;
}): StallMatrixResult {
  const ctx = buildCtx(args.repoRoot, args.now, args.deps);
  const abs = path.isAbsolute(args.filePath)
    ? args.filePath
    : path.resolve(args.repoRoot, args.filePath);
  const basename = path.basename(abs);
  const framework = basename.endsWith(MATRIX_SUFFIX)
    ? basename.slice(0, -MATRIX_SUFFIX.length)
    : basename.replace(/\.md$/, '');
  const sink: RowSink = { framework, issues: [], warnings: [] };
  const result: StallMatrixResult = {
    framework,
    filePath: args.filePath,
    valid: false,
    issues: sink.issues,
    warnings: sink.warnings,
    rowCount: 0,
    rows: [],
    contentHash: '',
  };

  // Single read — every check below runs against these exact bytes.
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    refuse(sink, 'matrix-file-missing', undefined, 'file');
    return result;
  }
  result.contentHash = createHash('sha256').update(bytes).digest('hex');

  if (!basename.endsWith(MATRIX_SUFFIX)) {
    refuse(sink, 'matrix-filename-invalid', undefined, 'file');
    return result;
  }
  if (bytes.length > MATRIX_FILE_CAP_BYTES) {
    refuse(sink, 'matrix-file-too-large', undefined, 'file');
    return result;
  }

  const text = bytes.toString('utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fm) {
    refuse(sink, 'front-matter-missing', undefined, 'file');
    return result;
  }
  let doc: unknown;
  try {
    // JSON_SCHEMA: unquoted ISO dates stay strings (never coerced to Date).
    doc = yaml.load(fm[1], { schema: yaml.JSON_SCHEMA });
  } catch {
    refuse(sink, 'front-matter-invalid', undefined, 'file');
    return result;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    refuse(sink, 'front-matter-invalid', undefined, 'file');
    return result;
  }
  const d = doc as Record<string, unknown>;
  if (d.framework !== framework) {
    refuse(sink, 'framework-field-mismatch', undefined, 'file');
  }
  const rows = d['stall-coverage'];
  if (!Array.isArray(rows)) {
    refuse(sink, 'stall-coverage-not-array', undefined, 'file');
    return result;
  }
  result.rowCount = rows.length;
  if (rows.length > ROW_CAP) {
    refuse(sink, 'row-cap-exceeded', undefined, 'file');
    return result;
  }

  // Exactly one row per canonical class (spec §2.1 complete enumeration).
  const counts = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const classId = validateRow(ctx, sink, rows[i], i);
    if (classId) {
      counts.set(classId, (counts.get(classId) ?? 0) + 1);
      const status = (rows[i] as StallMatrixRow).status;
      result.rows.push({
        classId,
        status: typeof status === 'string' ? status : 'invalid',
        mechanicallyVerified: 'presence-only',
      });
    }
  }
  for (const id of ctx.classIds) {
    const n = counts.get(id) ?? 0;
    if (n === 0) refuse(sink, 'class-row-missing', id, `class '${id}'`);
    else if (n > 1) refuse(sink, 'class-duplicate', id, `class '${id}'`);
  }

  result.valid = sink.issues.length === 0;
  return result;
}

// ─── Set validation ──────────────────────────────────────────────────────────────

export function validateAllStallMatrices(args: {
  repoRoot: string;
  now?: Date;
  deps?: StallCoverageValidatorDeps;
}): StallMatrixSetResult {
  const required = args.deps?.requiredFrameworks ?? REQUIRED_MATRIX_FRAMEWORKS;
  const setIssues: StallMatrixIssue[] = [];
  const results: StallMatrixResult[] = [];
  const seen = new Set<string>();

  for (const fw of required) {
    const rel = path.join('docs/frameworks', `${fw}${MATRIX_SUFFIX}`);
    if (!fs.existsSync(path.resolve(args.repoRoot, rel))) {
      // Deleting a matrix is a red build, not a silent pass (spec §3.2).
      setIssues.push({
        rule: 'matrix-file-missing',
        message: `required stall-coverage matrix missing for framework '${fw}' (${rel})`,
      });
      continue;
    }
    seen.add(fw);
    results.push(validateStallMatrixFile({ repoRoot: args.repoRoot, filePath: rel, now: args.now, deps: args.deps }));
  }

  // Extra matrices on disk (a framework beyond the required set) still validate.
  const dir = path.resolve(args.repoRoot, 'docs/frameworks');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(MATRIX_SUFFIX)) continue;
      const fw = f.slice(0, -MATRIX_SUFFIX.length);
      if (seen.has(fw)) continue;
      results.push(
        validateStallMatrixFile({
          repoRoot: args.repoRoot,
          filePath: path.join('docs/frameworks', f),
          now: args.now,
          deps: args.deps,
        }),
      );
    }
  }

  return {
    valid: setIssues.length === 0 && results.every((r) => r.valid),
    issues: setIssues,
    results,
  };
}

// ─── Spec-table agreement (spec §2.1: prose and code cannot drift) ───────────────

const SPEC_PATH = 'docs/specs/framework-stall-coverage-matrix.md';

export function validateSpecTableAgreement(args: {
  repoRoot: string;
  deps?: StallCoverageValidatorDeps;
}): { valid: boolean; issues: StallMatrixIssue[] } {
  const issues: StallMatrixIssue[] = [];
  const classIds = args.deps?.stallClassIds ?? STALL_CLASSES.map((c) => c.id);
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(args.repoRoot, SPEC_PATH), 'utf8');
  } catch {
    issues.push({ rule: 'spec-file-missing', message: `cannot read ${SPEC_PATH}` });
    return { valid: false, issues };
  }
  // §2.1 table rows: | `class-id` | Name | … | (the only table with a
  // backticked first cell).
  const tableIds = new Set(
    [...text.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]),
  );
  for (const id of classIds) {
    if (!tableIds.has(id)) {
      issues.push({
        classId: id,
        rule: 'spec-table-missing-class',
        message: `registry class '${id}' is missing from the spec §2.1 table`,
      });
    }
  }
  const registrySet = new Set(classIds);
  for (const id of tableIds) {
    if (!registrySet.has(id)) {
      issues.push({
        rule: 'spec-table-extra-class',
        message: `spec §2.1 table lists class '${id}' which is not in the registry`,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}
