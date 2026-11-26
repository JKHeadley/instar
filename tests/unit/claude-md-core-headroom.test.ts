/**
 * Headroom guard for the always-loaded CLAUDE.md core.
 *
 * The core has a fixed size limit (CLAUDE_MD_CORE_BUDGET_CHARS, 84,000) that must not be
 * raised: Claude Code loads the core into every session. On 2026-11-18 the generated core
 * reached 83,999 characters, so every open change that added one row failed the size test in
 * tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts, and fourteen pull requests were
 * blocked at once. The cause was long rows under two core headings ("Registry First" and
 * "Feature Proactivity"); the fix moved their full text to the "Lookup details" reference
 * section and left short rows behind.
 *
 * The size test only fails at the limit, when the next change is already blocked. This file
 * fails earlier, and names the fix:
 *   (a) no single row under those two headings may be long, and
 *   (b) the core must keep free space below the limit.
 *
 * What is measured: the canonical document an agent has after an update
 * (`PostUpdateMigrator.buildCanonicalClaudeMd()`: the template, the migrator's append chain,
 * the context-death block and the awareness entries in src/data/awareness/), rendered as the
 * CLAUDE.md of an agent with no notes of its own (`renderLayoutClaudeMd(full, '')`: the core
 * between its markers, with the tail stamp line). The migrator is built with the same options
 * as the "after an update" step of the e2e test (Telegram on, a four-digit port, a ten-letter
 * agent name), because Telegram on is the larger of the two cases. No file is written and no
 * network or Telegram is used: the project directory does not exist.
 */

import { describe, it, expect } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  renderLayoutClaudeMd,
  renderReferenceFiles,
} from '../../src/scaffold/claudeMdLayout.js';

/**
 * Longest allowed row (a markdown table row or a top-level bullet) under the two guarded
 * headings. Reason for 400: after the 2026-11-18 trim the longest row is 303 characters and
 * the median is 187, so 400 fits every row there is, with room for a question, the first
 * command, one "never answer from memory" clause and the "(→ Lookup details)" pointer.
 * Before the trim thirteen rows were over 400 (the longest 1,037).
 */
const MAX_CORE_ROW_CHARS = 400;

/**
 * Least free space the core must keep below CLAUDE_MD_CORE_BUDGET_CHARS. Reason for 2,000:
 * a new row adds between 14 and 109 characters to the core when measured alone (2026-11-14,
 * the comment on the limit in src/scaffold/claudeMdLayout.ts) and a short row of this file's
 * size is at most 400, so 2,000 is room for at least five rows that merge at the same time
 * after this test last ran on each of them. Below it, the next handful of merges would hit
 * the limit together, which is the 2026-11-18 blockage again.
 */
const MIN_CORE_HEADROOM_CHARS = 2_000;

/** Headings whose rows are guarded (prefix match on the heading text, as the layout does). */
const GUARDED_HEADINGS = ['Registry First', 'Feature Proactivity'] as const;

const migrator = new PostUpdateMigrator({
  projectDir: '/nonexistent-core-headroom',
  stateDir: '/nonexistent-core-headroom/.instar',
  port: 4098,
  hasTelegram: true,
  projectName: 'cml-abcdef',
});
const full = migrator.buildCanonicalClaudeMd();
const claudeMd = renderLayoutClaudeMd(full, '');

/** The lines of the core section whose heading starts with `heading` (up to the next heading). */
function sectionLines(doc: string, heading: string): string[] {
  const lines = doc.split('\n');
  const start = lines.findIndex(l => /^#{2,6} /.test(l) && l.replace(/^#+\s*/, '').startsWith(heading));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^#{2,6} /.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Table rows (not the |---| separator) and top-level bullets. */
function rows(lines: string[]): string[] {
  return lines.filter(l => (l.startsWith('|') && !/^\|[\s|:-]+\|?$/.test(l)) || l.startsWith('- '));
}

describe('CLAUDE.md core headroom', () => {
  it('both guarded sections are in the core and hold rows (the guard is looking at real text)', () => {
    for (const heading of GUARDED_HEADINGS) {
      expect(rows(sectionLines(claudeMd, heading)).length, `rows under "${heading}"`).toBeGreaterThan(10);
    }
  });

  it(`no row under "Registry First" or "Feature Proactivity" is longer than ${MAX_CORE_ROW_CHARS} characters`, () => {
    const tooLong: string[] = [];
    for (const heading of GUARDED_HEADINGS) {
      for (const row of rows(sectionLines(claudeMd, heading))) {
        if (row.length > MAX_CORE_ROW_CHARS) tooLong.push(`${row.length} characters under "${heading}": ${row.slice(0, 120)}...`);
      }
    }
    expect(
      tooLong,
      `A row in the always-loaded CLAUDE.md core is longer than ${MAX_CORE_ROW_CHARS} characters. `
      + 'Keep the row to its trigger (the question or situation) and the first thing to do, end it with '
      + '"(→ Lookup details)", and put the full text in the "Lookup details" section of '
      + 'src/scaffold/templates.ts (it goes to a reference file, which has no size limit). '
      + 'Do not raise MAX_CORE_ROW_CHARS to make this pass.',
    ).toEqual([]);
  });

  it(`the core keeps at least ${MIN_CORE_HEADROOM_CHARS} characters free below the limit`, () => {
    const headroom = CLAUDE_MD_CORE_BUDGET_CHARS - claudeMd.length;
    expect(
      headroom,
      `The generated CLAUDE.md core is ${claudeMd.length} characters; the limit is ${CLAUDE_MD_CORE_BUDGET_CHARS}, `
      + `so only ${headroom} are free and at least ${MIN_CORE_HEADROOM_CHARS} must be. What to do: shorten a row `
      + 'under a core heading (the list is CLAUDE_MD_CORE_HEADINGS in src/scaffold/claudeMdLayout.ts), or move its '
      + 'detail into a section that goes to a reference file (the "Lookup details" section in '
      + 'src/scaffold/templates.ts, or an entry file in src/data/awareness/). Do NOT raise '
      + 'CLAUDE_MD_CORE_BUDGET_CHARS and do not lower MIN_CORE_HEADROOM_CHARS: the core is loaded into every '
      + 'session, and at the limit every open change that adds a row is blocked at once.',
    ).toBeGreaterThanOrEqual(MIN_CORE_HEADROOM_CHARS);
  });

  it('a short row points at "Lookup details", and that section is in a reference file, not the core', () => {
    const pointer = '(→ Lookup details)';
    const title = '### Lookup details (full text of the short Registry First and Feature Proactivity rows)';
    expect(claudeMd).toContain(pointer);
    expect(claudeMd).not.toContain(title);
    // The always-loaded capability list still names the section, so the agent knows it exists.
    expect(claudeMd).toMatch(/\*\*Principles and working practices\*\*: [^\n]*Lookup details/);
    const holder = [...renderReferenceFiles(full)].find(([name, body]) => name !== 'INDEX.md' && body.includes(title));
    expect(holder?.[0]).toBe('principles-and-practices.md');
    // Detail that left the core is still there for the agent to read, word for word.
    const reference = holder![1];
    for (const kept of [
      '**Registry First — channel registry:**',
      '**Registry First — team access:**',
      '**Registry First — team requests:**',
      '**Registry First — people:**',
      '**Registry First — team settings:**',
      '`eligibleWithoutFold`',
      '`contextBudget.deltaHook.enabled`',
      '`POST /skills/learned/pending/NAME/confirm`',
      '`POST /skills/learned/retire-all`',
      '`POST /framework-issues/observe` {framework,bucket,severity,title,dedupKey,...}',
      '`POST /playwright-profiles/provision`',
      '`/chief-of-staff/projects/KEY`',
      '`skill-learning-disabled`',
      '`wholeDisk`',
      'pre-2026-08-19 `unclassifiable`',
      'trust the loop to carry it forward',
      '7-day "new" label',
      'The /build skill provides rigorous quality gates',
      'Do not commit it to a repo and send a GitHub link',
      'immediate commits after big changes are good practice',
      'a done checklist',
    ]) {
      expect(reference, `"${kept}" in the Lookup details reference section`).toContain(kept);
    }
  });

  it('every row marked short has its full row, under the same question or trigger, in Lookup details', () => {
    const template = generateClaudeMd('cml-abcdef', 'cml-abcdef', 4098, true);
    const start = template.indexOf('### Lookup details (');
    const details = template.slice(start, template.indexOf('\n### ', start + 1));
    const short = [...GUARDED_HEADINGS].flatMap(h => rows(sectionLines(template, h))).filter(r => r.includes('(→ Lookup details)'));
    expect(short.length).toBeGreaterThan(15);
    for (const row of short) {
      // A table row is keyed by its question cell; a bullet by its text up to the arrow.
      const key = row.startsWith('|') ? `| ${row.split('|')[1].trim()} |` : row.slice(0, row.indexOf('→')).trimEnd();
      expect(details, `full row for: ${key}`).toContain(key);
    }
  });
});
