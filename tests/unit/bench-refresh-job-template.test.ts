/**
 * bench-refresh job template — INSTAR-Bench v3, Task-4 S5.
 *
 * The scaffolded, OFF-by-default bench-refresh job (spec §7: monthly cadence +
 * routing-defaults drift check). This test pins the safety-load-bearing frontmatter
 * and body invariants so a later edit can't silently arm a cost-bearing bench run or
 * turn the review-only diff into an auto-apply. (The InstallBuiltinJobs regression
 * suite already proves the manifest LOADS; this proves it stays SAFE.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(
  __dirname,
  '../../src/scaffold/templates/jobs/instar/bench-refresh.md',
);

function parse(): { frontmatter: any; body: string } {
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('bench-refresh.md has no parseable frontmatter block');
  return { frontmatter: yaml.load(m[1]) as any, body: m[2] };
}

describe('bench-refresh job template', () => {
  it('exists as a shipped built-in template', () => {
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });

  it('ships OFF by default — a bench run is cost-bearing, so it must be deliberate opt-in', () => {
    const { frontmatter } = parse();
    expect(frontmatter.enabled).toBe(false);
  });

  it('is tier-1 supervised (a haiku job wrapping the deterministic harness)', () => {
    const { frontmatter } = parse();
    expect(frontmatter.supervision).toBe('tier1');
    expect(frontmatter.model).toBe('haiku');
  });

  it('runs on a MONTHLY cadence (spec §7), not more frequently', () => {
    const { frontmatter } = parse();
    // cron day-of-month field (3rd) must be a concrete day, not '*' (which would be daily/hourly).
    const fields = String(frontmatter.schedule).trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[2]).not.toBe('*'); // day-of-month pinned → monthly, never daily
  });

  it('is gated on server health (does not run against a dead server)', () => {
    const { frontmatter } = parse();
    expect(String(frontmatter.gate)).toContain('/health');
  });

  it('BODY: harness-presence gate — non-benching agents exit silently (no-op path)', () => {
    const { body } = parse();
    expect(body).toMatch(/run2\.mjs/);
    expect(body).toMatch(/parity-check\.mjs/);
    expect(body.toLowerCase()).toMatch(/exit silently|absent/);
  });

  it('BODY: NEVER auto-applies — it raises a review diff, never mutates routing config', () => {
    const { body } = parse();
    expect(body.toLowerCase()).toMatch(/never auto-apply|operator-review|raises? .*(diff|attention)/);
    // parity-check must run BEFORE spending metered budget.
    expect(body.toLowerCase()).toMatch(/parity/);
  });

  it('BODY: uses a STABLE attention id so a re-run updates one item, never floods', () => {
    const { body } = parse();
    expect(body).toMatch(/bench-refresh:routing-diff/);
  });
});
