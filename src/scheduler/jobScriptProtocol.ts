/**
 * jobScriptProtocol — the parser for a shipped job script's output
 * (docs/specs/job-cost-reduction.md §5.2).
 *
 * A script prints exactly one result line, and optionally anomaly and
 * structured-evidence lines:
 *
 *   JOB_RESULT ok <short summary>
 *   JOB_RESULT skipped <reason>
 *   JOB_RESULT failed <reason>
 *   JOB_ANOMALY <kind> <severity 1-3> <evidence ≤ 300 chars>
 *   JOB_FIELD <key> <value>
 *
 * Mapping (the §5.2 table):
 *   - `ok` with exit 0                       → success
 *   - `skipped` with exit 0                  → skipped (neither success nor failure)
 *   - `failed`, a non-zero exit, a missing or malformed result line, more than
 *     one result line, or output over the cap → failure
 *   - an anomaly of an undeclared kind       → ignored (counted, caller logs)
 *   - a JOB_FIELD with an undeclared key or a value outside the value rule →
 *     dropped (counted in `droppedFields`); at most 16 fields a run.
 *
 * Pure: no I/O, no clock. The caller scrubs secrets and applies the byte cap
 * BEFORE parsing (see `capScriptOutput`).
 */

export type ScriptResult = 'success' | 'failure' | 'skipped';

/** A template's declared anomaly kind. `kind` may end with `:*` for a family
 *  (e.g. `degradation:*` matches `degradation:Foo.bar`). */
export interface AnomalyDecl {
  kind: string;
  class: 'critical' | 'recoverable';
}

export interface ParsedAnomaly {
  kind: string;
  severity: 1 | 2 | 3;
  evidence: string;
  class: 'critical' | 'recoverable';
}

export interface ParsedScriptRun {
  result: ScriptResult;
  /** Text after the result word ('' if none), or a synthetic reason for a
   *  failure the result line did not state (missing line, exit code, cap). */
  reason: string;
  /** First token of `reason` when it matches the value rule, else ''. */
  reasonCode: string;
  /** The full JOB_RESULT line text after the result word ('' when absent). */
  summary: string;
  anomalies: ParsedAnomaly[];
  /** Anomaly lines dropped: undeclared kind or malformed. */
  ignoredAnomalies: number;
  /** Accepted JOB_FIELD lines. */
  fields: Record<string, string>;
  droppedFields: number;
  missingResultLine: boolean;
  overCap: boolean;
}

/** Output cap per run (§5.1). A run over the cap is recorded as failed. */
export const SCRIPT_OUTPUT_CAP_BYTES = 64 * 1024;

/** Max accepted JOB_FIELD lines per run (§5.2). */
export const MAX_JOB_FIELDS = 16;

/** Max anomaly evidence length (§5.2). */
export const MAX_ANOMALY_EVIDENCE_CHARS = 300;

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Value rule shared by JOB_FIELD values and the result reason code. */
export const FIELD_VALUE_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;

/**
 * Apply the byte cap. Returns the (possibly truncated) text and whether the
 * output exceeded the cap. Truncation is only for storage/display: an over-cap
 * run is a failure (`parseScriptOutput` with `overCap: true`), never a silent cut.
 */
export function capScriptOutput(text: string): { text: string; overCap: boolean } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= SCRIPT_OUTPUT_CAP_BYTES) return { text, overCap: false };
  // Decode a prefix; a split multibyte char decodes to U+FFFD, which is fine
  // for a display-only remnant.
  return { text: buf.subarray(0, SCRIPT_OUTPUT_CAP_BYTES).toString('utf-8'), overCap: true };
}

/** First token of a reason when it satisfies the value rule, else ''. */
export function reasonCodeOf(reason: string): string {
  const first = reason.trim().split(/\s+/)[0] ?? '';
  return FIELD_VALUE_RE.test(first) ? first : '';
}

function matchDecl(kind: string, decls: AnomalyDecl[]): AnomalyDecl | null {
  for (const d of decls) {
    if (d.kind === kind) return d;
  }
  for (const d of decls) {
    if (d.kind.endsWith(':*')) {
      const prefix = d.kind.slice(0, -1); // keep the trailing ':'
      if (kind.startsWith(prefix) && kind.length > prefix.length) return d;
    }
  }
  return null;
}

/** Split `JOB_X rest` → rest, or null when the line is not that tag. */
function tagRest(line: string, tag: string): string | null {
  if (line === tag) return '';
  if (line.startsWith(tag + ' ') || line.startsWith(tag + '\t')) return line.slice(tag.length + 1);
  return null;
}

export function parseScriptOutput(
  stdout: string,
  exitCode: number,
  opts: { anomalies?: AnomalyDecl[]; triageFields?: string[]; overCap?: boolean } = {},
): ParsedScriptRun {
  const decls = opts.anomalies ?? [];
  const allowedFields = new Set((opts.triageFields ?? []).filter((k) => FIELD_KEY_RE.test(k)));

  const resultLines: string[] = [];
  const anomalies: ParsedAnomaly[] = [];
  let ignoredAnomalies = 0;
  const fields: Record<string, string> = {};
  let fieldCount = 0;
  let droppedFields = 0;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const r = tagRest(line, 'JOB_RESULT');
    if (r !== null) {
      resultLines.push(r);
      continue;
    }

    const a = tagRest(line, 'JOB_ANOMALY');
    if (a !== null) {
      const m = /^(\S+)\s+([1-3])(?:\s+([\s\S]*))?$/.exec(a.trim());
      if (!m) {
        ignoredAnomalies++;
        continue;
      }
      const decl = matchDecl(m[1], decls);
      if (!decl) {
        ignoredAnomalies++;
        continue;
      }
      anomalies.push({
        kind: m[1],
        severity: Number(m[2]) as 1 | 2 | 3,
        evidence: (m[3] ?? '').trim().slice(0, MAX_ANOMALY_EVIDENCE_CHARS),
        class: decl.class,
      });
      continue;
    }

    const f = tagRest(line, 'JOB_FIELD');
    if (f !== null) {
      const m = /^(\S+)\s+(\S+)\s*$/.exec(f.trim());
      if (
        !m ||
        !FIELD_KEY_RE.test(m[1]) ||
        !allowedFields.has(m[1]) ||
        !FIELD_VALUE_RE.test(m[2]) ||
        Object.prototype.hasOwnProperty.call(fields, m[1]) ||
        fieldCount >= MAX_JOB_FIELDS
      ) {
        droppedFields++;
        continue;
      }
      fields[m[1]] = m[2];
      fieldCount++;
      continue;
    }
  }

  const base = {
    anomalies,
    ignoredAnomalies,
    fields,
    droppedFields,
    overCap: opts.overCap === true,
  };

  const fail = (reason: string, summary: string, missingResultLine: boolean): ParsedScriptRun => ({
    ...base,
    result: 'failure',
    reason,
    reasonCode: reasonCodeOf(reason),
    summary,
    missingResultLine,
  });

  if (resultLines.length === 0) {
    if (opts.overCap) return fail('output-over-cap', '', true);
    return fail('missing-result-line', '', true);
  }
  if (resultLines.length > 1) {
    return fail('multiple-result-lines', resultLines[0].trim(), false);
  }

  const line = resultLines[0].trim();
  const wm = /^(ok|skipped|failed)(?:\s+([\s\S]*))?$/.exec(line);
  if (!wm) return fail('malformed-result-line', line, false);
  const word = wm[1];
  const text = (wm[2] ?? '').trim();

  if (opts.overCap) return fail('output-over-cap', text, false);

  if (word === 'failed') return fail(text, text, false);

  if (exitCode !== 0) {
    // ok/skipped with a non-zero exit is a failure (§5.2: "also exit code ≠ 0").
    return fail(`exit-code-${exitCode}`, text, false);
  }

  return {
    ...base,
    result: word === 'ok' ? 'success' : 'skipped',
    reason: text,
    reasonCode: reasonCodeOf(text),
    summary: text,
    missingResultLine: false,
  };
}
