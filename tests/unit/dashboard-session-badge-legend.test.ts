import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HTML = fs.readFileSync(path.join(__dirname, '../../dashboard/index.html'), 'utf-8');

// Topic 112490: the operator could not tell what the session-row badges meant.
describe('session badge tooltips + legend', () => {
  it('has a "?" button that toggles a legend panel, hidden by default', () => {
    expect(HTML).toContain('id="sessionLegendBtn" onclick="toggleSessionLegend()"');
    expect(HTML).toMatch(/<div class="session-legend" id="sessionLegend" style="display:none">/);
    expect(HTML).toContain('function toggleSessionLegend()');
  });

  it('the legend explains every badge on a row', () => {
    const legend = HTML.slice(HTML.indexOf('id="sessionLegend"'), HTML.indexOf('id="sessionList"'));
    for (const text of ['interactive', 'job', 'MODEL', '✈️', '🖥️', 'Machine', 'How long the session has been running']) {
      expect(legend).toContain(text);
    }
  });

  it('every badge on a row carries a plain tooltip', () => {
    expect(HTML).toContain("title=\"${sType === 'job' ? 'Job: a scheduled job run' : 'Interactive: a conversation session'}\"");
    expect(HTML).toContain('title="${escapeHtml(platformBadgeTitle(platform))}"');
    expect(HTML).toContain("return 'Headless: no messaging app attached';");
    expect(HTML).toContain('<span title="Running for ${elapsed}">${elapsed}</span>');
    expect(HTML).toContain('title="Machine this session runs on"');
  });

  it('a bare model alias says the exact version is not recorded', () => {
    expect(HTML).toMatch(/\/\^\(opus\|sonnet\|haiku\|fable\)\$\/i/);
    expect(HTML).toContain("so the exact version isn't recorded");
  });
});
