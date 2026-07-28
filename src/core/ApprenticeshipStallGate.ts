// safe-git-allow: read-only git audit metadata (rev-parse HEAD + status --porcelain) for the gate decision record — never a mutating git op.
/**
 * ApprenticeshipStallGate — the RUNTIME-GATE callsite of the framework
 * stall-coverage matrix standard (PR-B).
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md (§2.3, §3.2 callsite 2,
 * §3.4, Frontloaded Decisions 6, 10, 11, 16, 17, 21).
 *
 * ONE validator, TWO callsites: the hermetic half lives in
 * stallCoverageValidator.ts (CI ratchet, PR-A). THIS module wires that same
 * validator into the apprenticeship lifecycle transitions:
 *
 *   - pending→active  → PROVISIONAL check (hermetic depth ONLY — schema,
 *     complete enumeration, token legality, ref format; §2.3).
 *   - active→complete → FULL check: hermetic validation PLUS the non-hermetic
 *     checks CI cannot do — closePath LIVENESS against the commitments ledger
 *     and guardKey/posture cross-check against the live /guards inventory,
 *     both via loopback HTTP (Frontloaded Decision 17), plus the §2.2
 *     acceptance-authority requirement (whole-set operator sign-off).
 *
 * Bounded execution (Decision 6 / instar#1069): the full-matrix hermetic
 * validation runs in a worker thread (apprenticeshipStallGate.worker.ts) with
 * a 60s timeout; a timeout fails CLOSED for the transition with a reason that
 * DISTINGUISHES "validator timed out (retry)" from "matrix invalid". The
 * validation is single-read: the worker returns the validator's contentHash,
 * and the decision record additionally carries the checkout HEAD SHA + dirty
 * flag (no validate-then-decide TOCTOU).
 *
 * Refusal hygiene (Decision 16): every refusal reason names class id + rule
 * name only — rejected raw matrix field content is NEVER echoed into 409
 * bodies, audit rows, or reports.
 *
 * Rollout (§3.4 / Decision 11): gated ENTIRELY by
 * `apprenticeship.stallCoverageGate` in `.instar/config.json`, read LIVE at
 * the gate callsite (no restart; transitions are rare and human-paced). The
 * default is inline in code — absence ⇒ {enabled: true, dryRun: true}; a
 * malformed block resolves to the SAFE default (dry-run) with one loud log
 * line. Under dryRun BOTH presence and validity refusals are suppressed and
 * only a would-refuse verdict is logged to the decision audit.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import yaml from 'js-yaml';
import {
  validateStallMatrixFile,
  type StallMatrixIssue,
  type StallMatrixResult,
  type StallMatrixRow,
} from './stallCoverageValidator.js';

// ── Retroactivity constants (spec §3.4, Frontloaded Decision 10) ─────────────

/** Minor version from which the matrix is REQUIRED for pre-ship instances. */
export const STALL_MATRIX_REQUIRED_SINCE = '1.4.0';
/** ISO date the gate wiring ships (PR-B commit date). */
export const STALL_MATRIX_SHIP_DATE = '2026-07-18';

/**
 * Classes with a named production incident in spec §1's table — these can
 * never pass as declared-gap without explicit recorded acceptance (§2.2).
 */
export const INCIDENT_NAMED_STALL_CLASSES: readonly string[] = [
  'input-not-draining',
  'wedged-context',
  'policy-rejection-loop',
  'mid-turn-interrupt',
] as const;

/** True when `current`'s major.minor sorts below the required-since minor. */
export function versionBelowRequiredMinor(current: string, requiredSince: string = STALL_MATRIX_REQUIRED_SINCE): boolean {
  const parse = (v: string): [number, number] | null => {
    const m = /^(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const cur = parse(current);
  const req = parse(requiredSince);
  // Unparseable version → NOT below (the strict direction: grandfathering is
  // the relief valve, so an unknown version never widens it).
  if (!cur || !req) return false;
  return cur[0] < req[0] || (cur[0] === req[0] && cur[1] < req[1]);
}

export type StallMatrixRequirement = 'required' | 'grandfathered-warning';

/**
 * The canonical checklist function of (instanceType, createdAt) — Decision 10.
 * Post-ship framework-onboarding instances (both instance types onboard a
 * framework) read the requirement from HERE, never from the per-instance
 * immutable requiredArtifacts flags. Pre-ship instances are grandfathered
 * with a warning while the running version is below the required-since minor.
 */
export function stallMatrixRequirement(
  _instanceType: string,
  createdAt: string,
  opts?: { currentVersion?: string; shipDate?: string; requiredSince?: string },
): StallMatrixRequirement {
  const shipDate = opts?.shipDate ?? STALL_MATRIX_SHIP_DATE;
  const preShip = typeof createdAt === 'string' && createdAt.length > 0 && createdAt < shipDate;
  if (!preShip) return 'required';
  const current = opts?.currentVersion ?? readOwnPackageVersion();
  return versionBelowRequiredMinor(current, opts?.requiredSince ?? STALL_MATRIX_REQUIRED_SINCE)
    ? 'grandfathered-warning'
    : 'required';
}

let cachedOwnVersion: string | null = null;
function readOwnPackageVersion(): string {
  if (cachedOwnVersion !== null) return cachedOwnVersion;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    cachedOwnVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedOwnVersion = '0.0.0';
  }
  return cachedOwnVersion;
}

// ── Live-read config (spec §3.4, Frontloaded Decision 11) ────────────────────

export interface StallGateConfig {
  enabled: boolean;
  dryRun: boolean;
}

/** The inline code default — absence ⇒ enabled, dry-run (§3.4). */
export const STALL_GATE_DEFAULT: StallGateConfig = { enabled: true, dryRun: true };

/**
 * Resolve the `apprenticeship.stallCoverageGate` block. A malformed block
 * resolves to the SAFE default (dry-run) with one loud log line — mirroring
 * MessagingToneGate.getConfig()'s never-throw shape, plus the log the spec
 * requires.
 */
export function resolveStallGateConfig(raw: unknown, log?: (msg: string) => void): StallGateConfig {
  if (raw === undefined || raw === null) return { ...STALL_GATE_DEFAULT };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.('[stall-gate] malformed apprenticeship.stallCoverageGate block — using safe default {enabled:true, dryRun:true}');
    return { ...STALL_GATE_DEFAULT };
  }
  const block = raw as Record<string, unknown>;
  const badField = (v: unknown): boolean => v !== undefined && typeof v !== 'boolean';
  if (badField(block.enabled) || badField(block.dryRun)) {
    log?.('[stall-gate] malformed apprenticeship.stallCoverageGate block — using safe default {enabled:true, dryRun:true}');
    return { ...STALL_GATE_DEFAULT };
  }
  return {
    enabled: (block.enabled as boolean | undefined) ?? STALL_GATE_DEFAULT.enabled,
    dryRun: (block.dryRun as boolean | undefined) ?? STALL_GATE_DEFAULT.dryRun,
  };
}

// ── Decision-audit primitives (tamper-evident append) ────────────────────────

/**
 * The recordDecision primitive: one JSON line appended to the apprenticeship
 * decision audit. Never throws — the audit is observability; a write failure
 * must not block an already-decided transition.
 */
export function appendApprenticeshipDecisionRow(logPath: string, row: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(row) + '\n');
  } catch {
    // @silent-fallback-ok — audit write failure must not block the transition.
  }
}

/** sha256 over the canonical (sorted-key) serialization of a row sans `integrity`. */
export function rowIntegrityHash(row: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const k of Object.keys(row).filter((k) => k !== 'integrity').sort()) clone[k] = row[k];
  return createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

/** Append a row carrying a self-integrity hash (tamper-EVIDENT, not tamper-proof). */
export function appendTamperEvidentDecisionRow(logPath: string, row: Record<string, unknown>): void {
  appendApprenticeshipDecisionRow(logPath, { ...row, integrity: rowIntegrityHash(row) });
}

const DECISION_LOG_READ_CAP = 10 * 1024 * 1024;

/** Read the decision log's parsed rows (bounded; tail-read past the cap). */
export function readDecisionRows(logPath: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    const size = fs.statSync(logPath).size;
    if (size > DECISION_LOG_READ_CAP) {
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(DECISION_LOG_READ_CAP);
        fs.readSync(fd, buf, 0, DECISION_LOG_READ_CAP, size - DECISION_LOG_READ_CAP);
        text = buf.toString('utf8');
        // Drop the (likely partial) first line of a tail read.
        text = text.slice(text.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(logPath, 'utf8');
    }
  } catch {
    // @silent-fallback-ok — an absent/unreadable audit log yields no rows; the
    // CALLERS decide the consequence (e.g. provenance-record-missing refusal).
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
    } catch {
      // @silent-fallback-ok — a corrupt line is skipped; integrity hashes on
      // the rows that matter make targeted tampering evident.
    }
  }
  return rows;
}

// ── Install provenance (spec §3.2 degraded rung, Decision 21) ────────────────

export type InstallClass = 'source-carrying' | 'fleet';

export interface InstallProvenance {
  installClass: InstallClass;
  signals: { developmentAgent: boolean; frameworksDir: boolean; specFile: boolean };
}

/**
 * Classify the install at init time from the same signals the dev-agent gate
 * uses (config.developmentAgent) plus presence of the analyzable tree —
 * mirroring DoorwayRegistryReader's no-manifest pattern for source-absence
 * (a pure npm-package install ships no docs/).
 */
export function deriveInstallProvenance(
  projectDir: string,
  config?: { developmentAgent?: boolean },
): InstallProvenance {
  const frameworksDir = fs.existsSync(path.join(projectDir, 'docs', 'frameworks'));
  const specFile = fs.existsSync(
    path.join(projectDir, 'docs', 'specs', 'framework-stall-coverage-matrix.md'),
  );
  const developmentAgent = !!config?.developmentAgent;
  return {
    installClass: developmentAgent || (frameworksDir && specFile) ? 'source-carrying' : 'fleet',
    signals: { developmentAgent, frameworksDir, specFile },
  };
}

const PROVENANCE_GATE = 'install-provenance';

export function hasInstallProvenanceRecord(logPath: string): boolean {
  // Cheap presence scan (idempotency check for init + the migrator backfill).
  try {
    return fs.readFileSync(logPath, 'utf8').includes(`"gate":"${PROVENANCE_GATE}"`);
  } catch {
    // @silent-fallback-ok — no log file = no record; the caller then WRITES one
    // (append path), so this is the presence-scan miss, not a degraded read.
    return false;
  }
}

/**
 * Record the install-provenance row ONCE (presence-scan idempotent) — the
 * init-time derivation (§3.2) and the PostUpdateMigrator backfill both funnel
 * through here. Tamper-evident append via the recordDecision primitive.
 */
export function recordInstallProvenanceIfAbsent(
  projectDir: string,
  stateDir: string,
): 'recorded' | 'present' | 'error' {
  try {
    const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    if (hasInstallProvenanceRecord(logPath)) return 'present';
    let config: { developmentAgent?: boolean } | undefined;
    try {
      config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    } catch {
      // @silent-fallback-ok — an unreadable config only loses the developmentAgent
      // signal; the tree-presence signals still classify the install.
      config = undefined;
    }
    const prov = deriveInstallProvenance(projectDir, config);
    appendTamperEvidentDecisionRow(logPath, {
      ts: new Date().toISOString(),
      gate: PROVENANCE_GATE,
      installClass: prov.installClass,
      signals: prov.signals,
    });
    return 'recorded';
  } catch {
    return 'error';
  }
}

export type ProvenanceRead =
  | { ok: true; installClass: InstallClass }
  | { ok: false; error: 'missing' | 'invalid' };

/** Read the LATEST install-provenance row; verify its integrity hash. */
export function readInstallProvenance(logPath: string): ProvenanceRead {
  const rows = readDecisionRows(logPath).filter((r) => r.gate === PROVENANCE_GATE);
  if (rows.length === 0) return { ok: false, error: 'missing' };
  const latest = rows[rows.length - 1];
  const integrity = latest.integrity;
  if (typeof integrity !== 'string' || integrity !== rowIntegrityHash(latest)) {
    return { ok: false, error: 'invalid' };
  }
  const cls = latest.installClass;
  if (cls !== 'source-carrying' && cls !== 'fleet') return { ok: false, error: 'invalid' };
  return { ok: true, installClass: cls };
}

// ── Hermetic validation unit (shared by the worker thread + in-process fallback) ──

const FRAMEWORK_RE = /^[a-z0-9-]+$/;
const MATRIX_SUFFIX = '-stall-coverage.md';
const RAW_FIELD_CAP = 4096;

export interface StallGateValidationInput {
  repoRoot: string;
  framework: string;
  nowIso: string;
}

export interface StallGateValidationOutput {
  fileMissing: boolean;
  result?: StallMatrixResult;
  /** Authored rows (known fields only, byte-capped) — consumed for the
   *  non-hermetic checks + canonical row hashing, never echoed into errors. */
  rawRows?: StallMatrixRow[];
}

/**
 * The pure validation unit: derives the matrix path EXCLUSIVELY from the
 * registry's charset-clamped framework field, realpath-jailed to
 * docs/frameworks/ (§3.2), runs the REAL hermetic validator (PR-A), and
 * re-parses the front-matter for the raw row fields the non-hermetic checks
 * need. Runs inside the worker thread; also callable in-process (the fallback
 * when a worker cannot start, e.g. under vitest where the compiled worker
 * file does not exist — behavior parity, never a silent skip).
 */
export function runStallGateValidation(input: StallGateValidationInput): StallGateValidationOutput {
  if (!FRAMEWORK_RE.test(input.framework)) {
    // A non-clamped framework can never name a matrix file (Decision 6 jail).
    return { fileMissing: true };
  }
  const rel = path.join('docs/frameworks', `${input.framework}${MATRIX_SUFFIX}`);
  const abs = path.resolve(input.repoRoot, rel);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { fileMissing: true };
  }
  const jail = path.resolve(input.repoRoot, 'docs/frameworks');
  let jailReal: string;
  try {
    jailReal = fs.realpathSync(jail);
  } catch {
    return { fileMissing: true };
  }
  if (!real.startsWith(jailReal + path.sep)) return { fileMissing: true };

  const result = validateStallMatrixFile({
    repoRoot: input.repoRoot,
    filePath: rel,
    now: new Date(input.nowIso),
  });

  // Re-parse authored rows for the non-hermetic checks (bounded: the validator
  // already capped the file at 256KB; fields are byte-capped here).
  let rawRows: StallMatrixRow[] | undefined;
  try {
    const text = fs.readFileSync(real, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (fm) {
      const doc = yaml.load(fm[1], { schema: yaml.JSON_SCHEMA }) as Record<string, unknown> | null;
      const rows = doc && Array.isArray(doc['stall-coverage']) ? doc['stall-coverage'] : [];
      rawRows = rows.slice(0, 64).map((r) => sanitizeRawRow(r));
    }
  } catch {
    // @silent-fallback-ok — rawRows feed the NON-hermetic checks; their absence
    // surfaces there as named refusals, never as a silent pass.
    rawRows = undefined;
  }
  return { fileMissing: false, result, rawRows };
}

const RAW_ROW_FIELDS = [
  'class', 'status', 'reason', 'detector', 'recovery', 'guardKey', 'posture',
  'evidence', 'issueRef', 'closePath', 'seededAt', 'acceptanceRef',
  'revalidateOn', 'liveness-surface',
] as const;

function sanitizeRawRow(row: unknown): StallMatrixRow {
  const out: Record<string, unknown> = {};
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const r = row as Record<string, unknown>;
    for (const f of RAW_ROW_FIELDS) {
      const v = r[f];
      if (typeof v === 'string') out[f] = v.slice(0, RAW_FIELD_CAP);
    }
    if (Array.isArray(r.matchedClasses)) {
      out.matchedClasses = r.matchedClasses
        .filter((m): m is string => typeof m === 'string')
        .slice(0, 16)
        .map((m) => m.slice(0, 128));
    }
  }
  return out as StallMatrixRow;
}

// ── Gate report + verdict types ──────────────────────────────────────────────

export type StallGateVerdictKind =
  | 'skipped-disabled'
  | 'grandfathered-warning'
  | 'valid'
  | 'invalid'
  | 'would-refuse'
  | 'matrix-unverifiable-no-source'
  | 'provenance-record-missing'
  | 'provenance-record-invalid'
  | 'source-tree-unanalyzable'
  | 'validator-timeout'
  | 'validator-error'
  | 'ledger-unreachable'
  | 'acceptance-missing';

export interface StallGateGuardPair {
  classId: string;
  guardKey: string;
  detector?: string;
  effective: string | null;
  check: 'ok' | 'contradicts' | 'vacuous-with-reason' | 'missing';
}

export interface StallGateReport {
  phase: 'provisional' | 'full';
  framework: string;
  requirement: StallMatrixRequirement;
  installClass?: InstallClass;
  verdict: StallGateVerdictKind;
  contentHash?: string;
  headSha?: string | null;
  dirty?: boolean | null;
  /** class id + rule name ONLY (Decision 16). */
  issues: StallMatrixIssue[];
  /** Dead-closePath / liveness flags (rule names + class ids + the clamped ref). */
  flaggedRows: Array<{ classId: string; rule: string; ref?: string }>;
  guardPairs: StallGateGuardPair[];
  /** Enumerations for recorded acceptance (spec §3.2 — covered rows included:
   *  the path of least scrutiny must not be the strongest claim). */
  enumerated: {
    covered: Array<{ classId: string; evidence?: string }>;
    coveredDark: string[];
    declaredGaps: string[];
    notApplicable: string[];
  };
  acceptance: { wholeSetValid: boolean; checkedRefs: number; invalidRefs: number };
  warnings: string[];
}

export interface StallGateVerdict {
  allow: boolean;
  /** Named reason (class ids + rule names only). */
  reason: string;
  /** True when a refusal was suppressed by dryRun (would-refuse logged). */
  dryRunSuppressed: boolean;
  report: StallGateReport;
}

/** Structural slice of an ApprenticeshipInstance the gate consumes. */
export interface StallGateInstanceRef {
  id: string;
  instanceType: string;
  framework: string;
  createdAt: string;
}

// ── Acceptance-artifact validation surface (implemented by the acceptance store) ──

export interface AcceptanceChecker {
  /** A valid whole-set acceptance for this instance bound to EXACTLY this
   *  content hash, recorded by a principal distinct from the transition
   *  caller (never a bearer principal). */
  hasWholeSetAcceptance(instanceId: string, contentHash: string): boolean;
  /** Row-scoped acceptanceRef authenticity: the ref resolves to an artifact
   *  covering this rowId whose bound hash matches the CURRENT joint canonical
   *  hash of ALL the rowIds the artifact enumerates (canonicalRowSetHash) —
   *  the caller resolves that set against the live matrix (null = a named row
   *  no longer exists ⇒ invalid). */
  rowAcceptanceValid(ref: string, rowId: string, resolveRowSetHash: (rowIds: string[]) => string | null): boolean;
  /** Per-instance recorded override: excuses (rule, rowId) while the row's
   *  canonical content hash is unchanged (§3.4 rollback relief). */
  overrideExcuses(instanceId: string, rule: string, rowId: string, rowHash: string): boolean;
}

// ── The gate ─────────────────────────────────────────────────────────────────

export interface ApprenticeshipStallGateDeps {
  /** Project root — matrices + git checkout live here. */
  projectDir: string;
  /** Agent state dir (`.instar`) — config.json + the decision log live here. */
  stateDir: string;
  /** Decision-audit path (default `<stateDir>/logs/apprenticeship-decisions.jsonl`). */
  decisionLogPath?: string;
  /** Loopback HTTP target for the non-hermetic checks (Decision 17). Absent ⇒
   *  the non-hermetic checks refuse `ledger-unreachable (retry)` — named,
   *  never silently skipped. */
  loopback?: { port: number; authToken?: string } | null;
  /** Acceptance machinery (§2.2). Absent ⇒ acceptance cannot be verified ⇒
   *  the full gate refuses `acceptance-missing`. */
  acceptance?: AcceptanceChecker | null;
  /** Injectable bounded validation runner (tests). Default: worker thread
   *  with in-process fallback on worker-start failure. */
  runValidation?: (input: StallGateValidationInput) => Promise<
    { ok: true; output: StallGateValidationOutput }
    | { ok: false; timedOut?: boolean; error?: string }
  >;
  fetchImpl?: typeof fetch;
  getCurrentVersion?: () => string;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Worker timeout (default 60_000ms — Decision 6). */
  validatorTimeoutMs?: number;
}

const LOOPBACK_FETCH_TIMEOUT_MS = 10_000;

export class ApprenticeshipStallGate {
  private readonly d: ApprenticeshipStallGateDeps;
  private readonly decisionLogPath: string;

  constructor(deps: ApprenticeshipStallGateDeps) {
    this.d = deps;
    this.decisionLogPath =
      deps.decisionLogPath ?? path.join(deps.stateDir, 'logs', 'apprenticeship-decisions.jsonl');
  }

  /** Live config read at the callsite — no restart (§3.4). */
  getConfig(): StallGateConfig {
    let raw: unknown;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.d.stateDir, 'config.json'), 'utf8'),
      ) as Record<string, unknown>;
      raw = (parsed.apprenticeship as Record<string, unknown> | undefined)?.stallCoverageGate;
    } catch {
      // @silent-fallback-ok — absent/unreadable config file ⇒ the inline code
      // default {enabled:true, dryRun:true} (spec §3.4: absence = default).
      raw = undefined;
    }
    return resolveStallGateConfig(raw, this.d.log ?? ((m) => console.warn(m)));
  }

  /**
   * Evaluate the matrix gate for a lifecycle transition. NEVER throws — every
   * failure mode maps to a named verdict (fail closed under enforce, logged
   * would-refuse under dryRun).
   */
  async evaluateForTransition(
    instance: StallGateInstanceRef,
    phase: 'provisional' | 'full',
  ): Promise<StallGateVerdict> {
    const config = this.getConfig();
    const requirement = stallMatrixRequirement(instance.instanceType, instance.createdAt, {
      currentVersion: this.d.getCurrentVersion?.(),
    });
    const report: StallGateReport = {
      phase,
      framework: instance.framework,
      requirement,
      verdict: 'valid',
      issues: [],
      flaggedRows: [],
      guardPairs: [],
      enumerated: { covered: [], coveredDark: [], declaredGaps: [], notApplicable: [] },
      acceptance: { wholeSetValid: false, checkedRefs: 0, invalidRefs: 0 },
      warnings: [],
    };

    if (!config.enabled) {
      report.verdict = 'skipped-disabled';
      return { allow: true, reason: 'stall-coverage gate disabled by config', dryRunSuppressed: false, report };
    }

    if (requirement === 'grandfathered-warning') {
      // Pre-ship instance below the required-since minor: WARNING row only
      // (Decision 10) — on the provisional arm this is a full skip (the
      // provisional requirement exists only for post-ship instances, §2.3).
      report.verdict = 'grandfathered-warning';
      report.warnings.push(
        `stall-coverage matrix not yet required for this pre-${STALL_MATRIX_SHIP_DATE} instance — REQUIRED from v${STALL_MATRIX_REQUIRED_SINCE}`,
      );
      this.recordGateDecision(instance, config, report, true);
      return { allow: true, reason: 'grandfathered (pre-ship instance): matrix warning only', dryRunSuppressed: false, report };
    }

    const refusal = await this.evaluateRequired(instance, phase, report);
    if (refusal === null) {
      this.recordGateDecision(instance, config, report, true);
      return { allow: true, reason: `stall-coverage matrix ${report.verdict}`, dryRunSuppressed: false, report };
    }

    if (config.dryRun) {
      // BOTH presence and validity refusals are suppressed under dryRun —
      // only the would-refuse verdict is logged (§2.3/§3.4).
      const wouldRefuseFor = report.verdict;
      report.verdict = 'would-refuse';
      report.warnings.push(`dry-run: would refuse — ${refusal} (${wouldRefuseFor})`);
      this.recordGateDecision(instance, config, report, true, wouldRefuseFor);
      return { allow: true, reason: `dry-run: would refuse — ${refusal}`, dryRunSuppressed: true, report };
    }

    this.recordGateDecision(instance, config, report, false);
    return { allow: false, reason: refusal, dryRunSuppressed: false, report };
  }

  /** Returns null when the gate passes, else the named refusal reason. */
  private async evaluateRequired(
    instance: StallGateInstanceRef,
    phase: 'provisional' | 'full',
    report: StallGateReport,
  ): Promise<string | null> {
    // ── Install provenance decides the degraded rung (§3.2, Decision 21) ──
    const prov = readInstallProvenance(this.decisionLogPath);
    if (!prov.ok) {
      report.verdict = prov.error === 'missing' ? 'provenance-record-missing' : 'provenance-record-invalid';
      return `${report.verdict} — re-run update/migration`;
    }
    report.installClass = prov.installClass;

    if (prov.installClass === 'fleet') {
      // No docs/ ships on a fleet npm install: the verdict is recorded and the
      // authenticated overseer-acceptance path carries the sign-off — NEVER a
      // presence-check refusal for a reason unrelated to matrix quality.
      report.verdict = 'matrix-unverifiable-no-source';
      const degradedHash = degradedAcceptanceHash(instance.id, instance.framework);
      report.contentHash = degradedHash;
      if (phase === 'provisional') return null; // nothing verifiable to gate provisionally
      if (this.d.acceptance?.hasWholeSetAcceptance(instance.id, degradedHash)) {
        report.acceptance.wholeSetValid = true;
        return null;
      }
      return 'acceptance-missing — matrix-unverifiable-no-source verdict requires recorded overseer acceptance';
    }

    // ── source-carrying: the tree must be analyzable (never degrade-to-acceptance) ──
    const frameworksDir = path.join(this.d.projectDir, 'docs', 'frameworks');
    if (!fs.existsSync(frameworksDir)) {
      report.verdict = 'source-tree-unanalyzable';
      return 'source-tree-unanalyzable — install provenance is source-carrying but docs/frameworks is missing';
    }

    // ── Bounded hermetic validation (worker thread, Decision 6) ──
    const run = this.d.runValidation ?? ((input: StallGateValidationInput) => this.runValidationBounded(input));
    const nowIso = (this.d.now?.() ?? new Date()).toISOString();
    const outcome = await run({ repoRoot: this.d.projectDir, framework: instance.framework, nowIso });
    if (!outcome.ok) {
      if (outcome.timedOut) {
        report.verdict = 'validator-timeout';
        return 'validator-timeout (retry) — validation did not finish; this is NOT a matrix-invalid verdict';
      }
      report.verdict = 'validator-error';
      return 'validator-error (retry) — validation could not run; this is NOT a matrix-invalid verdict';
    }
    const { fileMissing, result, rawRows } = outcome.output;
    if (fileMissing || !result) {
      report.verdict = 'invalid';
      report.issues.push({ rule: 'matrix-file-missing', message: `matrix file missing for framework '${instance.framework}'` });
      return `matrix invalid: rule 'matrix-file-missing' (framework '${instance.framework}')`;
    }
    report.contentHash = result.contentHash;

    // Checkout HEAD SHA + dirty flag ride the decision record (§3.2 audit).
    const git = await this.gitState();
    report.headSha = git.headSha;
    report.dirty = git.dirty;

    // ── Hermetic issues, minus recorded per-instance overrides (§3.4 relief) ──
    const rowByClass = new Map<string, StallMatrixRow>();
    for (const r of rawRows ?? []) {
      if (typeof r.class === 'string' && !rowByClass.has(r.class)) rowByClass.set(r.class, r);
    }
    const unexcused: StallMatrixIssue[] = [];
    for (const issue of result.issues) {
      if (issue.classId && this.d.acceptance) {
        const row = rowByClass.get(issue.classId);
        const rowId = `${instance.framework}:${issue.classId}`;
        const rowHash = row ? canonicalRowHash(row) : '';
        if (row && this.d.acceptance.overrideExcuses(instance.id, issue.rule, rowId, rowHash)) {
          report.warnings.push(`rule '${issue.rule}' on class '${issue.classId}' excused by recorded override`);
          continue;
        }
      }
      unexcused.push(issue);
    }
    if (unexcused.length > 0) {
      report.verdict = 'invalid';
      report.issues.push(...unexcused);
      const named = unexcused
        .slice(0, 8)
        .map((i) => (i.classId ? `class '${i.classId}': rule '${i.rule}'` : `rule '${i.rule}'`))
        .join('; ');
      const more = unexcused.length > 8 ? ` (+${unexcused.length - 8} more)` : '';
      return `matrix invalid: ${named}${more}`;
    }

    // Enumerations for recorded acceptance (all statuses — §3.2).
    for (const r of rawRows ?? []) {
      const classId = typeof r.class === 'string' ? r.class : '';
      if (!classId) continue;
      switch (r.status) {
        case 'covered':
          report.enumerated.covered.push({ classId, evidence: r.evidence });
          break;
        case 'covered-dark':
          report.enumerated.coveredDark.push(classId);
          break;
        case 'declared-gap':
          report.enumerated.declaredGaps.push(classId);
          break;
        case 'not-applicable':
          report.enumerated.notApplicable.push(classId);
          break;
      }
    }

    if (phase === 'provisional') {
      // §2.3: provisional depth is the hermetic checks ONLY — never the
      // non-hermetic gate checks (liveness/guards) and no acceptance yet.
      report.verdict = 'valid';
      return null;
    }

    // ── Non-hermetic checks (full gate only, Decision 17: loopback HTTP) ──
    const ledger = await this.nonHermeticChecks(instance, rawRows ?? [], report);
    if (ledger !== null) return ledger;

    // ── Acceptance authority (§2.2): whole-set operator sign-off required ──
    if (this.d.acceptance?.hasWholeSetAcceptance(instance.id, result.contentHash)) {
      report.acceptance.wholeSetValid = true;
    } else {
      report.verdict = 'acceptance-missing';
      return 'acceptance-missing — active→complete requires a recorded whole-set operator acceptance bound to the current matrix content hash';
    }

    // Row-scoped acceptanceRef authenticity (accept-then-edit voids — §2.2).
    const currentRowsById = new Map<string, StallMatrixRow>();
    for (const r of rawRows ?? []) {
      if (typeof r.class === 'string') currentRowsById.set(`${instance.framework}:${r.class}`, r);
    }
    const resolveRowSetHash = (rowIds: string[]): string | null => {
      const entries: Array<{ rowId: string; row: StallMatrixRow }> = [];
      for (const id of rowIds) {
        const row = currentRowsById.get(id);
        if (!row) return null; // an accepted row no longer exists ⇒ invalid
        entries.push({ rowId: id, row });
      }
      return canonicalRowSetHash(entries);
    };
    for (const r of rawRows ?? []) {
      const ref = r.acceptanceRef;
      const classId = typeof r.class === 'string' ? r.class : '';
      if (typeof ref !== 'string' || !ref || !classId) continue;
      report.acceptance.checkedRefs++;
      const ok = this.d.acceptance?.rowAcceptanceValid(ref, `${instance.framework}:${classId}`, resolveRowSetHash) ?? false;
      if (!ok) {
        report.acceptance.invalidRefs++;
        report.issues.push({ classId, rule: 'acceptance-ref-invalid', message: `class '${classId}': rule 'acceptance-ref-invalid'` });
      }
    }
    if (report.acceptance.invalidRefs > 0) {
      report.verdict = 'invalid';
      return `matrix invalid: ${report.acceptance.invalidRefs} row acceptanceRef(s) failed authenticity (rule 'acceptance-ref-invalid')`;
    }

    report.verdict = 'valid';
    return null;
  }

  /** closePath liveness + guardKey/posture cross-check. Null = pass. */
  private async nonHermeticChecks(
    instance: StallGateInstanceRef,
    rawRows: StallMatrixRow[],
    report: StallGateReport,
  ): Promise<string | null> {
    if (!this.d.loopback || !Number.isFinite(this.d.loopback.port) || this.d.loopback.port <= 0) {
      report.verdict = 'ledger-unreachable';
      return 'ledger-unreachable (retry) — no loopback server configured for liveness/posture checks; this is NOT a matrix-invalid verdict';
    }

    // ── /guards posture cross-check via each row's guardKey join (§3.2) ──
    const guardsRes = await this.loopbackJson('GET', '/guards');
    if (!guardsRes.ok) {
      report.verdict = 'ledger-unreachable';
      return 'ledger-unreachable (retry) — guards inventory unreachable; this is NOT a matrix-invalid verdict';
    }
    const guardRows = Array.isArray((guardsRes.body as { guards?: unknown }).guards)
      ? ((guardsRes.body as { guards: Array<{ key?: string; effective?: string }> }).guards)
      : [];
    const effectiveByKey = new Map<string, string>();
    for (const g of guardRows) {
      if (typeof g.key === 'string' && typeof g.effective === 'string') effectiveByKey.set(g.key, g.effective);
    }
    const LIVE_STATES = new Set(['on-confirmed', 'on-unverified', 'on-stale']);
    const postureIssues: string[] = [];
    for (const r of rawRows) {
      const classId = typeof r.class === 'string' ? r.class : '';
      const guardKey = typeof r.guardKey === 'string' ? r.guardKey : '';
      if (!classId || !guardKey || (r.status !== 'covered' && r.status !== 'covered-dark')) continue;
      if (guardKey.startsWith('exempt:')) {
        // Manifest-exempt component: the posture check is vacuous-with-reason
        // (already format-verified hermetically).
        report.guardPairs.push({ classId, guardKey, detector: r.detector, effective: null, check: 'vacuous-with-reason' });
        continue;
      }
      const effective = effectiveByKey.get(guardKey) ?? null;
      if (effective === null || effective === 'missing') {
        report.guardPairs.push({ classId, guardKey, detector: r.detector, effective, check: 'missing' });
        postureIssues.push(`class '${classId}': rule 'guard-missing-from-inventory'`);
        report.issues.push({ classId, rule: 'guard-missing-from-inventory', message: `class '${classId}': rule 'guard-missing-from-inventory'` });
        continue;
      }
      if (r.status === 'covered' && !LIVE_STATES.has(effective)) {
        // "A Dark Feature Guards Nothing": posture:live contradicted by /guards.
        report.guardPairs.push({ classId, guardKey, detector: r.detector, effective, check: 'contradicts' });
        postureIssues.push(`class '${classId}': rule 'posture-contradicts-inventory'`);
        report.issues.push({ classId, rule: 'posture-contradicts-inventory', message: `class '${classId}': rule 'posture-contradicts-inventory'` });
        continue;
      }
      if (r.status === 'covered-dark' && LIVE_STATES.has(effective)) {
        // Live guard on a covered-dark row: stale under-claim — warn, not refuse
        // (§5 names only the missing-guard side as a failure).
        report.warnings.push(`class '${classId}': covered-dark row's guard classifies LIVE — row may be stale (flip to covered?)`);
      }
      report.guardPairs.push({ classId, guardKey, detector: r.detector, effective, check: 'ok' });
    }

    // ── closePath liveness (declared-gap + covered-dark rows; §2.2) ──
    let evolutionActions: Array<{ id?: string; status?: string }> | null | undefined;
    for (const r of rawRows) {
      const classId = typeof r.class === 'string' ? r.class : '';
      const closePath = typeof r.closePath === 'string' ? r.closePath : '';
      if (!classId || !closePath || (r.status !== 'declared-gap' && r.status !== 'covered-dark')) continue;
      if (closePath === 'pending-mint') continue; // the live-check job owns the mint (§2.1)
      if (/^CMT-/i.test(closePath)) {
        const res = await this.loopbackJson('GET', `/commitments/${encodeURIComponent(closePath)}`);
        if (!res.ok && res.status !== 404) {
          // Transport failure OR any non-404 HTTP error (500/401/…): the
          // ledger could not answer — retryable, NEVER conflated with a
          // dead ref / matrix invalidity.
          report.verdict = 'ledger-unreachable';
          return 'ledger-unreachable (retry) — commitments ledger unreachable; this is NOT a matrix-invalid verdict';
        }
        if (res.status === 404 || !commitmentIsOpen(res.body)) {
          // 404 or terminal status = DEAD ref (a delivered commitment is a
          // closed anchor — no anchor).
          report.flaggedRows.push({ classId, rule: 'closepath-dead-ref', ref: closePath });
        }
      } else if (/^ACT-/i.test(closePath)) {
        if (evolutionActions === undefined) {
          const res = await this.loopbackJson('GET', '/evolution/actions');
          if (!res.ok) {
            // The dead determination for ACT refs comes from a SUCCESSFUL list
            // lacking the id — any failure (transport or HTTP) is retryable.
            report.verdict = 'ledger-unreachable';
            return 'ledger-unreachable (retry) — evolution-actions ledger unreachable; this is NOT a matrix-invalid verdict';
          }
          evolutionActions = extractActions(res.body);
        }
        const open = (evolutionActions ?? []).some(
          (a) => a.id === closePath && (a.status === 'pending' || a.status === 'in_progress'),
        );
        if (!open) report.flaggedRows.push({ classId, rule: 'closepath-dead-ref', ref: closePath });
      } else {
        // A well-formed but unresolvable ref family cannot be proven live.
        report.flaggedRows.push({ classId, rule: 'closepath-unresolvable-ref', ref: closePath });
      }
    }
    if (report.flaggedRows.length > 0) {
      // ONE aggregated attention item for ALL flagged rows (never one per row).
      void this.postAggregatedAttention(instance, report.flaggedRows, report.contentHash ?? '');
      report.verdict = 'invalid';
      const named = report.flaggedRows
        .slice(0, 8)
        .map((f) => `class '${f.classId}': rule '${f.rule}'`)
        .join('; ');
      report.issues.push(...report.flaggedRows.map((f) => ({ classId: f.classId, rule: f.rule, message: `class '${f.classId}': rule '${f.rule}'` })));
      return `matrix invalid: ${named}${report.flaggedRows.length > 8 ? ` (+${report.flaggedRows.length - 8} more)` : ''}`;
    }
    if (postureIssues.length > 0) {
      report.verdict = 'invalid';
      return `matrix invalid: ${postureIssues.slice(0, 8).join('; ')}${postureIssues.length > 8 ? ` (+${postureIssues.length - 8} more)` : ''}`;
    }
    return null;
  }

  // ── Bounded worker execution (Decision 6; instar#1069) ──

  private runValidationBounded(input: StallGateValidationInput): Promise<
    { ok: true; output: StallGateValidationOutput } | { ok: false; timedOut?: boolean; error?: string }
  > {
    const timeoutMs = this.d.validatorTimeoutMs ?? 60_000;
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./apprenticeshipStallGate.worker.js', import.meta.url), {
          workerData: input,
        });
      } catch (err) {
        // Worker start failure (e.g. uncompiled tree under vitest): run the
        // SAME exported validation unit in-process — behavior parity, never a
        // silent skip. The validation is bounded (single matrix, capped reads).
        resolve(this.runInProcess(input, err));
        return;
      }
      let settled = false;
      const done = (r: { ok: true; output: StallGateValidationOutput } | { ok: false; timedOut?: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => { /* @silent-fallback-ok — already gone */ });
        resolve(r);
      };
      // Timeout fails CLOSED with the retryable, timeout-vs-invalid-distinct reason.
      const timer = setTimeout(() => done({ ok: false, timedOut: true }), timeoutMs);
      worker.once('message', (msg: { ok?: boolean; output?: StallGateValidationOutput; error?: string }) => {
        if (msg && msg.ok === true && msg.output) done({ ok: true, output: msg.output });
        else done({ ok: false, error: typeof msg?.error === 'string' ? msg.error : 'worker-malformed-result' });
      });
      worker.once('error', (err: Error) => {
        // A worker that errors at MODULE LOAD (missing compiled file) falls
        // back in-process; a mid-run error is a real validation error.
        if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(err.message)) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => { /* @silent-fallback-ok */ });
            resolve(this.runInProcess(input, err));
          }
          return;
        }
        done({ ok: false, error: err.message });
      });
      worker.once('exit', () => {
        if (!settled) done({ ok: false, error: 'worker-exited-before-result' });
      });
    });
  }

  private runInProcess(
    input: StallGateValidationInput,
    cause: unknown,
  ): { ok: true; output: StallGateValidationOutput } | { ok: false; error: string } {
    this.d.log?.(
      `[stall-gate] worker unavailable (${cause instanceof Error ? cause.message : String(cause)}) — running validation in-process`,
    );
    try {
      return { ok: true, output: runStallGateValidation(input) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Git checkout audit fields (§3.2 single-read record) ──

  private gitState(): Promise<{ headSha: string | null; dirty: boolean | null }> {
    const exec = (args: string[]): Promise<string | null> =>
      new Promise((resolve) => {
        try {
          execFile('git', args, { cwd: this.d.projectDir, timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            resolve(err ? null : stdout.toString());
          });
        } catch {
          resolve(null);
        }
      });
    return (async () => {
      const head = await exec(['rev-parse', 'HEAD']);
      if (head === null) return { headSha: null, dirty: null };
      const status = await exec(['status', '--porcelain']);
      return {
        headSha: head.trim().slice(0, 40) || null,
        dirty: status === null ? null : status.trim().length > 0,
      };
    })();
  }

  // ── Loopback HTTP (Decision 17) ──

  private async loopbackJson(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const f = this.d.fetchImpl ?? fetch;
    const lb = this.d.loopback!;
    try {
      const res = await f(`http://127.0.0.1:${lb.port}${route}`, {
        method,
        headers: {
          ...(lb.authToken ? { Authorization: `Bearer ${lb.authToken}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(LOOPBACK_FETCH_TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // @silent-fallback-ok — a non-JSON body is handled by the caller's
        // predicate (treated as not-open / not-ok), never silently succeeded.
        parsed = null;
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch {
      // status 0 = transport failure ⇒ ledger-unreachable (retry), never
      // conflated with matrix invalidity (Decision 17).
      return { ok: false, status: 0, body: null };
    }
  }

  private async postAggregatedAttention(
    instance: StallGateInstanceRef,
    flagged: Array<{ classId: string; rule: string; ref?: string }>,
    contentHash: string,
  ): Promise<void> {
    try {
      const lines = flagged
        .slice(0, 20)
        .map((f) => `- ${instance.framework} class '${f.classId}' — ${f.rule}${f.ref ? ` (${f.ref})` : ''}`);
      await this.loopbackJson('POST', '/attention', {
        // Dedup: createAttentionItem is id-keyed (existing id ⇒ returned, not
        // re-posted) — ONE item per (instance, matrix content); a retry loop
        // over the same matrix state can never repeat it, a content change
        // mints a fresh id.
        id: `stall-matrix-${createHash('sha256').update(`${instance.id}:${contentHash}`).digest('hex').slice(0, 24)}`,
        title: `Stall-coverage matrix: ${flagged.length} dead/unresolvable closePath ref(s) for ${instance.framework}`,
        body:
          `The apprenticeship stall-coverage gate flagged rows whose closePath no longer resolves to an OPEN commitment/action (a closed anchor is no anchor — spec §2.2):\n` +
          lines.join('\n') +
          (flagged.length > 20 ? `\n…and ${flagged.length - 20} more` : ''),
        priority: 'medium',
        source: 'stall-coverage-gate',
      });
    } catch {
      // @silent-fallback-ok — attention delivery is best-effort observability.
    }
  }

  // ── Decision audit (the extended row shape — additive, §3.2) ──

  private recordGateDecision(
    instance: StallGateInstanceRef,
    config: StallGateConfig,
    report: StallGateReport,
    allow: boolean,
    wouldRefuseFor?: StallGateVerdictKind,
  ): void {
    appendApprenticeshipDecisionRow(this.decisionLogPath, {
      ts: (this.d.now?.() ?? new Date()).toISOString(),
      gate: 'stall-matrix',
      instanceId: instance.id,
      phase: report.phase,
      framework: instance.framework,
      allow,
      verdict: report.verdict,
      ...(wouldRefuseFor ? { wouldRefuseFor } : {}),
      requirement: report.requirement,
      dryRun: config.dryRun,
      ...(report.installClass ? { installClass: report.installClass } : {}),
      ...(report.contentHash ? { contentHash: report.contentHash } : {}),
      ...(report.headSha !== undefined ? { headSha: report.headSha } : {}),
      ...(report.dirty !== undefined ? { dirty: report.dirty } : {}),
      // Rule names + class ids ONLY — never rejected raw content (Decision 16).
      ...(report.issues.length ? { rules: report.issues.slice(0, 32).map((i) => (i.classId ? `${i.classId}:${i.rule}` : i.rule)) } : {}),
    });
  }
}

// ── Shared hashing helpers (acceptance binding granularity — Decision 20) ────

/**
 * Canonical serialization of one authored matrix row: known fields only,
 * sorted keys, stable JSON. Row-scoped acceptances/overrides hash EXACTLY
 * this — a codemod adding UNRELATED rows does not void them; ANY change to
 * the row itself does.
 */
export function canonicalRowSerialization(row: StallMatrixRow): string {
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r).sort()) {
    // `acceptanceRef` is the pointer TO an acceptance, not accepted content —
    // excluding it breaks the chicken-and-egg (mint → bind → write the ref
    // into the row) without weakening the binding: every substantive field
    // still voids on change.
    if (k === 'acceptanceRef') continue;
    const v = r[k];
    if (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) out[k] = v;
  }
  return JSON.stringify(out);
}

export function canonicalRowHash(row: StallMatrixRow): string {
  return createHash('sha256').update(canonicalRowSerialization(row)).digest('hex');
}

/**
 * Joint hash over a SET of accepted rows (rows-scope challenges, Decision 20):
 * sorted by rowId, each entry [rowId, canonical serialization]. Adding
 * UNRELATED rows to the matrix leaves this hash untouched; ANY change to an
 * accepted row changes it.
 */
export function canonicalRowSetHash(entries: Array<{ rowId: string; row: StallMatrixRow }>): string {
  const sorted = [...entries].sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify(sorted.map((e) => [e.rowId, canonicalRowSerialization(e.row)])))
    .digest('hex');
}

/** The bound content for a fleet-install (no-source) whole-set acceptance. */
export function degradedAcceptanceHash(instanceId: string, framework: string): string {
  return createHash('sha256')
    .update(`matrix-unverifiable-no-source:${instanceId}:${framework}`)
    .digest('hex');
}

// ── Loopback response predicates ─────────────────────────────────────────────

/** OPEN iff status ∈ {pending, verified, violated} and unexpired
 *  (CommitmentTracker.getActive semantics). */
function commitmentIsOpen(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const c = body as { status?: unknown; expiresAt?: unknown };
  if (c.status !== 'pending' && c.status !== 'verified' && c.status !== 'violated') return false;
  if (typeof c.expiresAt === 'string' && c.expiresAt < new Date().toISOString()) return false;
  return true;
}

function extractActions(body: unknown): Array<{ id?: string; status?: string }> {
  if (Array.isArray(body)) return body as Array<{ id?: string; status?: string }>;
  if (body && typeof body === 'object') {
    const b = body as { actions?: unknown };
    if (Array.isArray(b.actions)) return b.actions as Array<{ id?: string; status?: string }>;
  }
  return [];
}
