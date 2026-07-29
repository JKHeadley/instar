import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isKnownInlineCodeEnumReference,
  MIGRATION_LEDGER_ACTION_VALUES,
} from '../../scripts/lib/markdown-code-identifier.mjs';

describe('isKnownInlineCodeEnumReference', () => {
  it('recognizes a closed-enum member only inside a same-line enum reference list', () => {
    const single = 'Outcomes: `migrated`, `deferred-in-flight`, or `failed`.';
    const multi = 'Outcomes: ``migrated``, ``deferred-in-flight``, or ``failed``.';
    expect(isKnownInlineCodeEnumReference(single, single.indexOf('deferred'), single.indexOf('deferred') + 8)).toBe(true);
    expect(isKnownInlineCodeEnumReference(multi, multi.indexOf('deferred'), multi.indexOf('deferred') + 8)).toBe(true);
  });

  it('pins the local closed set to the shipped MigrationPerEntryAction union', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scheduler', 'MigrationLedger.ts'), 'utf8');
    const union = source.match(/export type MigrationPerEntryAction =([\s\S]*?);/)?.[1] ?? '';
    const sourceValues = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(MIGRATION_LEDGER_ACTION_VALUES).toEqual(sourceValues);
  });

  it('does not classify a lone known value or an unknown identifier as an enum reference', () => {
    const known = 'Status: `deferred-in-flight`.';
    const unknown = 'Disposition: `follow-up-required-now`.';
    expect(isKnownInlineCodeEnumReference(known, known.indexOf('deferred'), known.indexOf('deferred') + 8)).toBe(false);
    expect(isKnownInlineCodeEnumReference(unknown, unknown.indexOf('follow'), unknown.indexOf('follow') + 9)).toBe(false);
  });

  it('does not classify escaped literal backticks as an inline-code span', () => {
    const markdown = 'Status: \\`deferred-in-flight\\`.';
    expect(isKnownInlineCodeEnumReference(markdown, markdown.indexOf('deferred'), markdown.indexOf('deferred') + 8)).toBe(false);
  });

  it('does not classify a known value outside inline code', () => {
    const markdown = 'Status is deferred-in-flight.';
    expect(isKnownInlineCodeEnumReference(markdown, markdown.indexOf('deferred'), markdown.indexOf('deferred') + 8)).toBe(false);
  });

  it.each([
    ['three-backtick', '```\ndeferred-in-flight\n```'],
    ['four-backtick', '````\ndeferred-in-flight\n````'],
    ['backtick fence with inline spans', '```\n`migrated` and `deferred-in-flight`\n```'],
    ['tilde fence with inline spans', '~~~\n`migrated` and `deferred-in-flight`\n~~~'],
    ['blockquoted tilde fence', '> ~~~\n> `migrated` and `deferred-in-flight`\n> ~~~'],
    ['list-nested tilde fence', '- ~~~\n  `migrated` and `deferred-in-flight`\n  ~~~'],
  ])('does not treat a %s fence as inline code', (_label, markdown) => {
    expect(isKnownInlineCodeEnumReference(markdown, markdown.indexOf('deferred'), markdown.indexOf('deferred') + 8)).toBe(false);
  });

  it('rejects malformed candidate ranges', () => {
    expect(isKnownInlineCodeEnumReference('`deferred-in-flight`', -1, 2)).toBe(false);
    expect(isKnownInlineCodeEnumReference('`deferred-in-flight`', 2, 2)).toBe(false);
  });
});
