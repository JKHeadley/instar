/**
 * Pool-tile status filter (2026-06-11 live finding, topic 13481): a peer's
 * plain GET /sessions returns its FULL registry — completed/killed records
 * included — while the local sidebar is built from listRunningSessions().
 * The dashboard's pool poll must therefore filter remote sessions to LIVE
 * statuses, or long-dead peer sessions render as live "click to stream"
 * tiles (five closed Mac Mini sessions reappeared on the laptop dashboard
 * hours after they were closed). Inspects the HTML/JS at rest (no browser),
 * following the dashboard-sessionMachineBadge.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');

describe('dashboard pool poll — remote tile status filter', () => {
  it('filters remote sessions to live statuses (running/starting), never raw remote===true alone', () => {
    // The assignment that feeds renderSessionList's remote tiles.
    const assign = html.match(/remoteSessions\s*=\s*\(j\.sessions[^;]+;/);
    expect(assign, 'remoteSessions assignment not found — pool poll restructured? update this test').toBeTruthy();
    const expr = assign![0];
    expect(expr).toContain("s.remote === true");
    expect(expr).toContain("s.status === 'running'");
    expect(expr).toContain("s.status === 'starting'");
  });

  it('the unfiltered shape (remote===true with no status check) is gone', () => {
    expect(html).not.toMatch(/remoteSessions\s*=\s*\(j\.sessions \|\| \[\]\)\.filter\(s => s\.remote === true\);/);
  });
});
