/**
 * llm-decision-grading job template invariants (llm-decision-quality-meter §5.5/§5.7).
 *
 * Pins the safety-load-bearing frontmatter + body invariants so a later edit
 * can't silently arm the dark grading job, put an LLM in the grading path, or
 * turn the curl-only cadence body into a messaging job (FD5: the meter is
 * observe-only — the job NEVER messages, NEVER interprets). Mirrors
 * doorway-scan-job-template.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar/llm-decision-grading.md');

function parse(): { frontmatter: any; body: string } {
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('llm-decision-grading.md has no parseable frontmatter block');
  return { frontmatter: yaml.load(m[1]) as any, body: m[2] };
}

describe('llm-decision-grading job template', () => {
  it('exists as a shipped built-in template (installBuiltinJobs auto-discovers the dir; migrateBuiltinJobs installs it on update)', () => {
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });

  it('ships OFF by default (enabled:false — cost-bearing job class, spec §5.7)', () => {
    expect(parse().frontmatter.enabled).toBe(false);
  });

  it('is tier-1 supervised on haiku (wraps the deterministic grade-pass endpoint)', () => {
    const { frontmatter } = parse();
    expect(frontmatter.supervision).toBe('tier1');
    expect(frontmatter.model).toBe('haiku');
  });

  it('runs on the hourly cron the §5.3 grading slack derives from', () => {
    const fields = String(parse().frontmatter.schedule).trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe('0'); // minute pinned
    expect(fields.slice(1)).toEqual(['*', '*', '*', '*']); // every hour
  });

  it('is perMachineIndependent (grading runs per machine over that machine\'s local rows — §Multi-machine posture)', () => {
    expect(parse().frontmatter.perMachineIndependent).toBe(true);
  });

  it('is gated on server health and grants no MCP access', () => {
    const { frontmatter } = parse();
    expect(String(frontmatter.gate)).toContain('/health');
    expect(frontmatter.mcpAccess).toBe('none');
  });

  it('BODY: curls POST /decision-quality/grade-pass with the Bearer header and an EMPTY body (knobs come from config)', () => {
    const { body } = parse();
    expect(body).toMatch(/curl[^\n]*-X POST[^\n]*decision-quality\/grade-pass/);
    expect(body).toMatch(/Authorization: Bearer \$AUTH/);
    expect(body).toMatch(/-d '\{\}'/);
  });

  it('BODY: the grade-pass curl is the ONLY endpoint the job drives (no other POST/PUT/DELETE)', () => {
    const { body } = parse();
    const mutatingCurls = [...body.matchAll(/curl[^\n]*-X\s+(POST|PUT|DELETE|PATCH)[^\n]*/g)];
    expect(mutatingCurls).toHaveLength(1);
    expect(mutatingCurls[0][0]).toContain('/decision-quality/grade-pass');
  });

  it('BODY: pins FD5 in prose — the job must NEVER message the user, never interpret', () => {
    const { body } = parse();
    expect(body).toMatch(/do NOT message the user/i);
    expect(body).toMatch(/FD5/);
    expect(body).toMatch(/Do NOT relay anything to Telegram/i);
    expect(body.toLowerCase()).toMatch(/never interprets|not interpret/);
  });

  it('BODY: treats a 503 as the dark seam (exit silently — dev-gated honesty, never an error to escalate)', () => {
    const { body } = parse();
    expect(body).toMatch(/503/);
    expect(body.toLowerCase()).toMatch(/exit silently/);
    expect(body).toMatch(/provenance\.uniformSeam/);
  });

  it('BODY: never retry-floods (idempotent endpoint; the next tick re-attempts)', () => {
    expect(parse().body.toLowerCase()).toMatch(/do not retry-flood/);
  });
});
