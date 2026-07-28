/**
 * Dashboard empty-state floor — F6 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; Structure > Willpower).
 *
 * F6: an empty / resting state must be self-explanatory — it says what will
 * fill the area (and, where relevant, how), in plain language. Not a blank box,
 * and not raw developer jargon (`POST /projects`, a curl line) that a
 * non-technical operator cannot act on. The audit (2026-07-08) found two empty
 * states instructing the user to "Create one via POST /projects" — meaningless
 * to the person reading the dashboard.
 *
 * This floor scans the dashboard's `*Empty*` resting-state containers and fails,
 * naming the offender, if one is bare (no real sentence) or leaks API jargon.
 * (Transient "Loading…" placeholders are a different, acceptable state and are
 * not resting empty states.)
 *
 * Guarded by a population floor so a regressed matcher fails loudly, not silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

/** Empty-state containers to audit (id contains "Empty"). */
const EMPTY_ID_RE = /id="([a-zA-Z]*[Ee]mpty[a-zA-Z]*)"/g;

/** Raw API/developer jargon a non-technical operator cannot act on. */
const JARGON_RE = /\b(?:POST|GET|PUT|PATCH|DELETE)\s+\/|curl\b|<code>\s*(?:POST|GET|PUT|PATCH|DELETE)\b/i;

function segmentAfter(html: string, id: string): string {
  const open = html.indexOf(`id="${id}"`);
  if (open < 0) return '';
  // Grab a bounded window covering the container's inner markup.
  return html.slice(open, open + 400);
}

describe('dashboard empty-state floor (F6)', () => {
  it('every empty-state container is self-explanatory and jargon-free', () => {
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');

    const ids = [...html.matchAll(EMPTY_ID_RE)].map(m => m[1]);
    // Population floor: the known static empty-state containers must be visible.
    // As tabs adopt the shared glance component (Phase 4: pr-pipeline, tokens,
    // llm-activity, secrets, resources, initiatives), their bespoke `*Empty*`
    // containers move INTO the component — the glance renders its own honest
    // empty-state (`.glance-empty` "Nothing here right now"), enforced at the
    // component boundary by tests/unit/dashboard-glance-drilldown.test.ts (every
    // zero-count tile opens an honest empty-state) rather than by this static
    // scan. So the static population ratchets DOWN as views migrate; the floor
    // still fails loudly (→ 0) if the matcher regex regresses.
    expect(new Set(ids).size, 'static empty-state containers visible to the F6 floor').toBeGreaterThanOrEqual(4);

    const bare: string[] = [];
    const jargon: string[] = [];
    for (const id of new Set(ids)) {
      const seg = segmentAfter(html, id);
      const text = seg
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // A real explanatory sentence: several words of alphanumeric text.
      const words = (text.match(/[A-Za-z][A-Za-z']+/g) || []).length;
      if (words < 4) bare.push(`${id} ("${text.slice(0, 40)}")`);
      if (JARGON_RE.test(seg)) jargon.push(id);
    }

    expect(
      bare,
      `Bare empty states (F6): ${bare.join(', ')}. Add a plain sentence saying ` +
        `what fills this area and how.`
    ).toEqual([]);
    expect(
      jargon,
      `Empty states leaking API jargon (F6): ${jargon.join(', ')}. Replace raw ` +
        `HTTP/curl instructions with plain language ("ask your agent to …").`
    ).toEqual([]);
  });
});
