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
  it('labels an inactive supervisor in the Jobs list without implying a model will run', () => {
    const list = { innerHTML: '' };
    const render = new Function('document', 'jobsData', 'jobFilter', 'PRIORITY_ORDER',
      'cronToHuman', 'timeAgo', 'selectedJob', 'esc',
      `${extract('renderJobList')}\nreturn renderJobList;`)(
        { getElementById: (id: string) => id === 'jobsList' ? list : { value: 'name' } },
        [{ slug: 'script-job-supervisor', schedule: '0 0 * * *', enabled: true,
          model: 'haiku', runner: 'inactive', state: {} }],
        'all', {}, () => 'daily', () => 'never', '', (value: string) => value,
      ) as () => void;
    render();
    expect(list.innerHTML).toContain('>inactive</span>');
    expect(list.innerHTML).not.toContain('>haiku</span>');
  });

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

  it('shows inactive supervision accurately and leaves ordinary sessions without a script card', async () => {
    const card = { innerHTML: '', style: { display: 'none' } };
    let reads = 0;
    const load = new Function('document', 'apiFetch', 'selectedJob', 'esc', 'jobCostRowFor',
      'jobTokensOf', 'fmtTokens', 'jobTriageSummaryFor',
      `async ${extract('loadJobScriptCard')}\nreturn loadJobScriptCard;`)(
        { getElementById: () => card },
        async () => { reads++; return null; },
        'script-job-supervisor',
        (value: string) => value,
        () => null,
        () => null,
        () => '0',
        () => ({ decisions: 0, sessions: 0 }),
      ) as (job: { slug: string; runner: string; state: object }) => Promise<void>;
    await load({ slug: 'script-job-supervisor', runner: 'inactive', state: {} });
    expect(card.innerHTML).toContain('Inactive');
    expect(card.innerHTML).not.toContain('An AI session');
    expect(card.style.display).toBe('');
    const rendered = card.innerHTML;
    await load({ slug: 'script-job-supervisor', runner: 'session', state: {} });
    expect(card.innerHTML).toBe(rendered);
    expect(reads).toBe(2);
  });
});
