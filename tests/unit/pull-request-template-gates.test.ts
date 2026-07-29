import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Import the real authority so a changed gate contract breaks this test instead of letting a copied regex drift.
import { checkPrDescriptionEli16 } from '../../scripts/eli16-pr-description-check.mjs';

const templatePath = path.resolve(process.cwd(), '.github/PULL_REQUEST_TEMPLATE.md');

describe('pull request template gate prompts', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const sectionOpening = (heading: string): string => {
    const start = template.indexOf(`## ${heading}`);
    const next = template.indexOf('\n## ', start + 1);
    return template.slice(start, next === -1 ? undefined : next);
  };

  it('prompts for the required ELI16 section and its minimum content', () => {
    const eli16 = sectionOpening('ELI16');
    expect(eli16).toMatch(/^## ELI16\r?\n\r?\n<!-- Gate: write at least 200 characters/);
    expect(eli16).toMatch(/plain-English explanation for a non-expert/i);
    expect(checkPrDescriptionEli16({ body: template })).toMatchObject({
      ok: false,
      reason: 'eli16-too-short',
    });
  });

  it('prompts for the required UX declaration and every gated detail', () => {
    const uxImpact = sectionOpening('UX Impact');
    expect(uxImpact).toMatch(/^## UX Impact\r?\n\r?\n<!-- Gate for user-facing paths:/);
    expect(uxImpact).toMatch(/who sees the change/i);
    expect(uxImpact).toMatch(/user-visible first contact/i);
    expect(uxImpact).toMatch(/quote an exact string from the diff/i);
  });
});
