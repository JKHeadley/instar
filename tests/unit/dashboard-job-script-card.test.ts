import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../../dashboard/index.html', import.meta.url)), 'utf8');

function extract(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`dashboard helper missing: ${name}`);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`dashboard helper unterminated: ${name}`);
}

const summary = new Function(`${extract('jobTriageSummaryFor')}\nreturn jobTriageSummaryFor;`)() as
  (view: unknown, slug: string) => { decisions: number; sessions: number };

describe('script-job dashboard triage card', () => {
  it('uses per-slug totals rather than the bounded recent list', () => {
    const view = {
      perSlug: {
        'health-check': { decisions: 17, sessions: 4 },
        'other-job': { decisions: 9, sessions: 2 },
      },
      recent: [{ slug: 'other-job', decision: 'investigate' }],
      sessions: [],
    };
    expect(summary(view, 'health-check')).toEqual({ decisions: 17, sessions: 4 });
    expect(summary(view, 'other-job')).toEqual({ decisions: 9, sessions: 2 });
    expect(summary(view, 'absent')).toEqual({ decisions: 0, sessions: 0 });
  });

  it('does not render the script card for a session runner', () => {
    expect(extract('loadJobScriptCard')).toContain("if (!card || job.runner !== 'script') return;");
  });
});
