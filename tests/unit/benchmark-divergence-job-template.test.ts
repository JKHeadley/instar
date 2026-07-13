/**
 * benchmark-divergence-analysis job template invariants
 * (benchmark-divergence-detector FD12/FD13).
 *
 * Pins the safety-load-bearing frontmatter + body invariants so a later edit
 * can't silently arm the dark cadence job, put an LLM supervisor where tier-0
 * is the justified contract, or turn the curl-only trigger body into a
 * messaging job (the detector is observe-only). Mirrors
 * llm-decision-grading-job-template.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar/benchmark-divergence-analysis.md');

function parse(): { frontmatter: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('benchmark-divergence-analysis.md has no parseable frontmatter block');
  return { frontmatter: yaml.load(m[1]) as Record<string, unknown>, body: m[2] };
}

describe('benchmark-divergence-analysis job template', () => {
  it('exists as a shipped built-in template (installBuiltinJobs auto-discovers the dir; migrateBuiltinJobs installs it on update)', () => {
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });

  it('ships OFF by default (enabled:false fleet-wide — FD13; the rollout step enables it on the dev agent only)', () => {
    expect(parse().frontmatter.enabled).toBe(false);
  });

  it('is tier-0 supervised (FD12: fully deterministic aggregation + comparison, no LLM step to validate)', () => {
    expect(parse().frontmatter.supervision).toBe('tier0');
  });

  it('runs a daily cadence cron (the analysisCadenceHours=24 default)', () => {
    const fields = String(parse().frontmatter.schedule).trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe('*');
    expect(fields[3]).toBe('*');
    expect(fields[4]).toBe('*'); // daily
  });

  it('the body triggers POST /benchmark-divergence/analyze with the cadence trigger and NOTHING else knob-shaped', () => {
    const { body } = parse();
    expect(body).toContain('/benchmark-divergence/analyze');
    expect(body).toContain('"trigger":"cadence"');
    // Observe-only: the job must never message the user.
    expect(body.toLowerCase()).toContain('do not message the user');
    expect(body).not.toContain('telegram-reply.sh');
  });

  it('documents every healthy non-200 outcome (503 dark / 409 non-holder / 429 rate-limited) as exit-silently', () => {
    const { body } = parse();
    expect(body).toContain('503');
    expect(body).toContain('409');
    expect(body).toContain('429');
  });
});
