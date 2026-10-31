/**
 * Genuine cross-machine duplicate badge (session-listing hygiene, CMT-1936
 * part c): the pool poll collects server-computed pool.duplicateTopics into a
 * conversation-pair set, and renderSessionList badges any tile — LOCAL (WS-fed,
 * which never carries the per-row flag) or REMOTE — whose conversation is
 * live on >=2 machines at once. Inspects the HTML/JS at rest (no browser),
 * following the dashboard-poolTileStatusFilter.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');

describe('dashboard — genuine cross-machine duplicate badge', () => {
  it('collects pool.duplicateTopics conversation pairs in the pool poll', () => {
    // The set is (re)fed on every refreshPoolSessions tick from the server-
    // computed duplicateTopics — never derived client-side by name matching.
    expect(html).toContain('poolDuplicateConversations = new Set(');
    expect(html).toContain('j.pool.duplicateTopics');
    expect(html).toContain('.map(d => `${d.platform}:${String(d.platformId)}`)');
  });

  it('renders the badge for a flagged row OR a local tile whose conversation is in the flagged set', () => {
    const badge = html.match(/session\.duplicateTopic === true \|\| \(session\.platform && session\.platformId != null && poolDuplicateConversations\.has\(`/);
    expect(badge, 'duplicate-badge condition not found — renderSessionList restructured? update this test').toBeTruthy();
    expect(html).toContain('class="duplicate-badge"');
  });

  it('explains itself in plain language (title names the REAL condition, not jargon)', () => {
    expect(html).toContain('live session on more than one machine');
  });

  it('has a stylesheet rule (red, distinct from the machine badge)', () => {
    expect(html).toMatch(/\.duplicate-badge\s*\{/);
  });
});
