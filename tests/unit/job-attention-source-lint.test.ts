/**
 * A shipped scheduled job never raises an attention item as `source: "agent"`.
 *
 * The Attention hub filter admits "agent" items unconditionally — that label
 * means the agent itself chose to put the item in front of the user. A job
 * that claims it bypasses the filter on every run: evolution-overdue-check did,
 * and its reworded body reposted into the operator's Attention topic every few
 * hours (operator report 2026-11-02). A job names itself as the source; one
 * whose item really needs the operator is listed in NEEDS_USER_SOURCES.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefaultJobs } from '../../src/commands/init.js';
import { admitItemToHub } from '../../src/messaging/attentionHubPolicy.js';

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'src', 'scaffold', 'templates', 'jobs', 'instar');

/** Every `-d '{...}'` JSON payload of a curl POST to /attention in a job body. */
function attentionPayloads(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!/curl [^\n]*-X POST[^\n]*\/attention(?![\w/])/.test(line)) continue;
    const m = line.match(/-d '(\{[^']*\})'/);
    expect(m, `an /attention POST without a parseable -d payload: ${line.slice(0, 160)}`).not.toBeNull();
    out.push(JSON.parse(m![1]) as Record<string, unknown>);
  }
  return out;
}

const bodies: Array<[string, string]> = [
  ...fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md'))
    .map((f): [string, string] => [`template ${f}`, fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')]),
  ...(getDefaultJobs(4321) as Array<{ slug: string; execute?: { value?: string } }>)
    .map((j): [string, string] => [`getDefaultJobs ${j.slug}`, j.execute?.value ?? '']),
];

describe('shipped jobs raise attention under their own name', () => {
  it('scans at least the two known attention-raising jobs', () => {
    const raising = bodies.filter(([, body]) => attentionPayloads(body).length > 0).map(([name]) => name);
    expect(raising).toEqual(expect.arrayContaining(['template evolution-overdue-check.md', 'template bench-refresh.md']));
  });

  for (const [name, body] of bodies) {
    const payloads = attentionPayloads(body);
    if (payloads.length === 0) continue;
    it(`${name}: names a source that is not "agent"`, () => {
      for (const p of payloads) {
        expect(typeof p.source, name).toBe('string');
        expect(p.source, name).not.toBe('agent');
      }
    });
  }

  it('the overdue-check row is held from the hub; the bench routing diff reaches the operator', () => {
    const payloadOf = (file: string) => attentionPayloads(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'))[0];
    const overdue = payloadOf('evolution-overdue-check.md');
    expect(admitItemToHub({ id: String(overdue.id), priority: 'NORMAL', sourceContext: String(overdue.source) }, 'signal').admit).toBe(false);
    const bench = payloadOf('bench-refresh.md');
    expect(admitItemToHub({ id: String(bench.id), priority: 'NORMAL', sourceContext: String(bench.source) }, 'signal').admit).toBe(true);
  });

  it('the overdue check is report-only and never messages the user', () => {
    for (const body of [
      fs.readFileSync(path.join(TEMPLATES_DIR, 'evolution-overdue-check.md'), 'utf8'),
      (getDefaultJobs(4321) as Array<{ slug: string; execute: { value: string } }>).find((j) => j.slug === 'evolution-overdue-check')!.execute.value,
    ]) {
      expect(body).not.toMatch(/escalate to the user/i);
      expect(body).not.toMatch(/"status":"cancelled"/);
      expect(body).toContain('Report only');
    }
  });
});
