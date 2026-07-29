import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPrDescriptionEli16 } from '../../scripts/eli16-pr-description-check.mjs';

const templatePath = path.resolve(process.cwd(), '.github/PULL_REQUEST_TEMPLATE.md');

describe('pull request template gate prompts', () => {
  const template = fs.readFileSync(templatePath, 'utf8');

  it('prompts for the required ELI16 section and its minimum content', () => {
    expect(template).toMatch(/^## ELI16\s*$/m);
    expect(template).toMatch(/at least 200 characters/i);
    expect(template).toMatch(/plain-English explanation for a non-expert/i);
    expect(checkPrDescriptionEli16({ body: template })).toMatchObject({
      ok: false,
      reason: 'eli16-too-short',
    });
  });

  it('prompts for the required UX declaration and every gated detail', () => {
    expect(template).toMatch(/^## UX Impact\s*$/m);
    expect(template).toMatch(/who sees the change/i);
    expect(template).toMatch(/user-visible first contact/i);
    expect(template).toMatch(/quote an exact string from the diff/i);
  });
});
