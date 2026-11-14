/**
 * job-cost-reduction §5.2 — the script output parser. Every row of the
 * mapping table, the JOB_FIELD accept/drop rules, and the 64 KB cap.
 */
import { describe, it, expect } from 'vitest';
import {
  parseScriptOutput,
  capScriptOutput,
  reasonCodeOf,
  SCRIPT_OUTPUT_CAP_BYTES,
  MAX_JOB_FIELDS,
  type AnomalyDecl,
} from '../../../src/scheduler/jobScriptProtocol.js';

const decls: AnomalyDecl[] = [
  { kind: 'disk-low', class: 'critical' },
  { kind: 'sessions-exhausted', class: 'recoverable' },
  { kind: 'degradation:*', class: 'recoverable' },
];

describe('parseScriptOutput — result mapping (§5.2 table)', () => {
  it('ok + exit 0 → success, summary and reason carried', () => {
    const r = parseScriptOutput('JOB_RESULT ok all healthy\n', 0);
    expect(r.result).toBe('success');
    expect(r.summary).toBe('all healthy');
    expect(r.reasonCode).toBe('all');
    expect(r.missingResultLine).toBe(false);
  });

  it('skipped + exit 0 → skipped with reason', () => {
    const r = parseScriptOutput('noise\nJOB_RESULT skipped feature-dark 503\n', 0);
    expect(r.result).toBe('skipped');
    expect(r.reason).toBe('feature-dark 503');
    expect(r.reasonCode).toBe('feature-dark');
  });

  it('failed → failure with the stated reason', () => {
    const r = parseScriptOutput('JOB_RESULT failed server-unreachable ECONNREFUSED\n', 1);
    expect(r.result).toBe('failure');
    expect(r.reason).toBe('server-unreachable ECONNREFUSED');
    expect(r.reasonCode).toBe('server-unreachable');
  });

  it('ok with a non-zero exit → failure (exit code wins)', () => {
    const r = parseScriptOutput('JOB_RESULT ok fine\n', 3);
    expect(r.result).toBe('failure');
    expect(r.reason).toBe('exit-code-3');
  });

  it('skipped with a non-zero exit → failure', () => {
    expect(parseScriptOutput('JOB_RESULT skipped x\n', 2).result).toBe('failure');
  });

  it('missing result line → failure, missingResultLine set', () => {
    const r = parseScriptOutput('just some output\n', 0);
    expect(r.result).toBe('failure');
    expect(r.missingResultLine).toBe(true);
    expect(r.reason).toBe('missing-result-line');
  });

  it('two result lines → failure (exactly one is the protocol)', () => {
    const r = parseScriptOutput('JOB_RESULT ok a\nJOB_RESULT ok b\n', 0);
    expect(r.result).toBe('failure');
    expect(r.reason).toBe('multiple-result-lines');
  });

  it('unknown result word → failure', () => {
    expect(parseScriptOutput('JOB_RESULT great\n', 0).reason).toBe('malformed-result-line');
  });

  it('over the cap → failure even with an ok line', () => {
    const r = parseScriptOutput('JOB_RESULT ok fine\n', 0, { overCap: true });
    expect(r.result).toBe('failure');
    expect(r.overCap).toBe(true);
    expect(r.reason).toBe('output-over-cap');
  });

  it('a result tag mid-line is not a result line', () => {
    expect(parseScriptOutput('echo JOB_RESULT ok fake\n', 0).missingResultLine).toBe(true);
  });

  it('CRLF line endings parse', () => {
    expect(parseScriptOutput('JOB_RESULT ok fine\r\n', 0).result).toBe('success');
  });

  it('a reason that breaks the value rule yields an empty reasonCode', () => {
    expect(reasonCodeOf('héllo world')).toBe('');
    expect(reasonCodeOf('')).toBe('');
  });
});

describe('parseScriptOutput — anomalies', () => {
  it('declared kinds are accepted with their class; evidence capped at 300', () => {
    const long = 'x'.repeat(400);
    const r = parseScriptOutput(`JOB_ANOMALY disk-low 3 ${long}\nJOB_RESULT ok done\n`, 0, { anomalies: decls });
    expect(r.anomalies).toEqual([{ kind: 'disk-low', severity: 3, evidence: 'x'.repeat(300), class: 'critical' }]);
  });

  it('a family declaration matches its members', () => {
    const r = parseScriptOutput('JOB_ANOMALY degradation:Foo.bar 1 seen\nJOB_RESULT ok\n', 0, { anomalies: decls });
    expect(r.anomalies[0]).toMatchObject({ kind: 'degradation:Foo.bar', class: 'recoverable' });
  });

  it('an undeclared kind is ignored and counted', () => {
    const r = parseScriptOutput('JOB_ANOMALY surprise 2 boo\nJOB_RESULT ok\n', 0, { anomalies: decls });
    expect(r.anomalies).toEqual([]);
    expect(r.ignoredAnomalies).toBe(1);
  });

  it('a bad severity is ignored and counted', () => {
    const r = parseScriptOutput('JOB_ANOMALY disk-low 7 boo\nJOB_RESULT ok\n', 0, { anomalies: decls });
    expect(r.anomalies).toEqual([]);
    expect(r.ignoredAnomalies).toBe(1);
  });
});

describe('parseScriptOutput — JOB_FIELD', () => {
  const triageFields = ['outcome', 'http_status', 'processed'];

  it('accepts declared keys with values matching the rule', () => {
    const r = parseScriptOutput('JOB_FIELD outcome merged\nJOB_FIELD http_status 200\nJOB_RESULT ok\n', 0, { triageFields });
    expect(r.fields).toEqual({ outcome: 'merged', http_status: '200' });
    expect(r.droppedFields).toBe(0);
  });

  it('drops undeclared keys, prose values, bad key shapes and duplicates', () => {
    const out = [
      'JOB_FIELD secret abc',          // undeclared
      'JOB_FIELD outcome two words',   // value has a space
      'JOB_FIELD Outcome merged',      // key shape
      'JOB_FIELD outcome ok',
      'JOB_FIELD outcome again',       // duplicate
      'JOB_FIELD processed ' + 'a'.repeat(65), // value too long
      'JOB_RESULT ok',
    ].join('\n');
    const r = parseScriptOutput(out, 0, { triageFields });
    expect(r.fields).toEqual({ outcome: 'ok' });
    expect(r.droppedFields).toBe(5);
  });

  it('accepts at most 16 fields', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const out = keys.map((k) => `JOB_FIELD ${k} v`).join('\n') + '\nJOB_RESULT ok\n';
    const r = parseScriptOutput(out, 0, { triageFields: keys });
    expect(Object.keys(r.fields)).toHaveLength(MAX_JOB_FIELDS);
    expect(r.droppedFields).toBe(4);
  });
});

describe('capScriptOutput', () => {
  it('passes output under the cap', () => {
    expect(capScriptOutput('abc')).toEqual({ text: 'abc', overCap: false });
  });
  it('flags output over the cap', () => {
    const r = capScriptOutput('a'.repeat(SCRIPT_OUTPUT_CAP_BYTES + 1));
    expect(r.overCap).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(SCRIPT_OUTPUT_CAP_BYTES);
  });
});
