import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dashboard throughput floor pull surface', () => {
  it('renders the authenticated pull endpoint without an action control', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'index.html'), 'utf8');
    expect(html).toContain('Autonomous throughput observations');
    expect(html).toContain("apiFetch('/autonomous/throughput-floor')");
    const start = html.indexOf('<section aria-labelledby="throughputFloorTitle"');
    const section = html.slice(start, html.indexOf('</section>', start));
    expect(section).not.toMatch(/<button|onclick=|method:\s*['"]POST/i);
  });
});
