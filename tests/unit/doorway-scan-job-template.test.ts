/**
 * doorway-scan job template invariants (DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC §2.1/§Testing).
 *
 * Pins the safety-load-bearing frontmatter + body invariants so a later edit
 * can't silently arm the dark scan, select a metered scope, or turn the review-
 * only diff into an auto-apply. Mirrors bench-refresh-job-template.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar/doorway-scan.md');

function parse(): { frontmatter: any; body: string } {
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('doorway-scan.md has no parseable frontmatter block');
  return { frontmatter: yaml.load(m[1]) as any, body: m[2] };
}

describe('doorway-scan job template', () => {
  it('exists as a shipped built-in template', () => {
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });

  it('ships OFF by default (dark — a scheduled session-spawner is a deliberate opt-in)', () => {
    expect(parse().frontmatter.enabled).toBe(false);
  });

  it('is tier-1 supervised on haiku (wraps the deterministic prober)', () => {
    const { frontmatter } = parse();
    expect(frontmatter.supervision).toBe('tier1');
    expect(frontmatter.model).toBe('haiku');
  });

  it('is perMachineIndependent (each machine scans its own disk — §2.8)', () => {
    expect(parse().frontmatter.perMachineIndependent).toBe(true);
  });

  it('runs on a pinned WEEKDAY cadence (not * — never daily/hourly)', () => {
    const fields = String(parse().frontmatter.schedule).trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[4]).not.toBe('*'); // day-of-week pinned → weekly
  });

  it('is gated on server health', () => {
    expect(String(parse().frontmatter.gate)).toContain('/health');
  });

  it('toolAllowlist is Bash-only — NO Edit/Write (cannot touch source, §2.7)', () => {
    const { frontmatter } = parse();
    const allow = frontmatter.toolAllowlist;
    expect(Array.isArray(allow) ? allow : [allow]).toEqual(['Bash']);
    expect(frontmatter.unrestrictedTools).toBe(false);
    expect(frontmatter.mcpAccess).toBe('none');
  });

  it('BODY: cites the deterministic prober + a prober-presence gate that exits silently', () => {
    const { body } = parse();
    expect(body).toMatch(/scripts\/doorway-scan\.mjs/);
    expect(body).toMatch(/test -f scripts\/doorway-scan\.mjs/);
    expect(body.toLowerCase()).toMatch(/exit silently|absent/);
  });

  it('BODY: invokes the FIXED literal --scope free-probes and NEVER a metered scope', () => {
    const { body } = parse();
    expect(body).toMatch(/node scripts\/doorway-scan\.mjs --scope free-probes/);
    // The metered scopes must never appear as a literal in the scheduled body (D10).
    expect(body).not.toContain('+liveness');
    expect(body).not.toContain('+web-verify');
  });

  it('BODY: names the machine-qualified sourceContext (never coalesced — P17/§2.6)', () => {
    expect(parse().body).toMatch(/doorway-scan:<machineId>|machine-qualified/);
  });

  it('BODY: never auto-applies to source; the prober POSTs in-process (no data-carrying curl)', () => {
    const { body } = parse();
    expect(body.toLowerCase()).toMatch(/never auto-appl|maintainer diff|never touch/);
    // In-process delivery — the session runs no data-carrying curl.
    expect(body).not.toMatch(/curl[^\n]*--data\b/);
    expect(body).not.toMatch(/curl[^\n]*--data-binary\b/);
    expect(body).not.toMatch(/curl[^\n]*\|/);
  });
});
