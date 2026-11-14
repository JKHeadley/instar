/**
 * EVO-008 template census (docs/specs/job-tool-allowlist-real-enforcement.md §10): once job
 * tool lists are really applied, a shipped builtin that needs shell must not silently lose
 * it. Every shipped job template either asks for all tools WITH authorization, or declares a
 * list that the confined launch can apply exactly (no name the CLI drops or does not know).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { CLAUDE_CONFINABLE_TOOL_NAMES } from '../../src/scheduler/JobScheduler.js';

const DIR = path.join(__dirname, '../../src/scaffold/templates/jobs/instar');

function frontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(DIR, file), 'utf-8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  return yaml.load(m[1]) as Record<string, unknown>;
}

describe('shipped job templates confine cleanly (EVO-008)', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));

  it('there are shipped templates to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file}: "*" is authorized, or every listed tool is confinable`, () => {
      const fm = frontmatter(file);
      const list = fm.toolAllowlist;
      if (list === undefined) return; // no list: not applicable (instar-no-allowlist)
      if (list === '*') {
        expect(fm.unrestrictedTools, `${file} asks for "*" without unrestrictedTools: true — it would run Read-only`).toBe(true);
        return;
      }
      expect(Array.isArray(list), `${file}: toolAllowlist must be "*" or an array`).toBe(true);
      for (const t of list as string[]) {
        expect(CLAUDE_CONFINABLE_TOOL_NAMES.has(t), `${file}: "${t}" is not a tool the confined launch can apply`).toBe(true);
      }
    });
  }

  it('evolution-proposal-implement keeps full tools (it builds and commits)', () => {
    const fm = frontmatter('evolution-proposal-implement.md');
    expect(fm.toolAllowlist).toBe('*');
    expect(fm.unrestrictedTools).toBe(true);
  });
});
