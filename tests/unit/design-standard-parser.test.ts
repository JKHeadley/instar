import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesignStandard } from '../../src/designGate/standardParser.js';

const standard = fs.readFileSync(new URL('../../docs/DESIGN-STANDARD.md', import.meta.url), 'utf8');
const fixture = (extra = '') => `# Standard
## Machine-checkable rules at a glance
| Rule | What the check measures |
|---|---|
| \`DS-A11Y-1\` | Minimum contrast. |
## Accessibility
### DS-A11Y-1 · Readable labels
- **Rule**: Labels are readable.
- **Why**: People must read them.
- **Bad**: Invisible text.
- **Good**: Readable text.
- **Surfaces**: Web, Mac.
- **Check**: machine. Contrast is measured.
- **Source**: An existing standard. **Earned from**: DF-0001.
${extra}`;

describe('design standard parser', () => {
  it('reads the approved standard unchanged, including all accessibility and inline earned references', () => {
    const parsed = parseDesignStandard(standard);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules).toHaveLength(65);
    expect(parsed.rules.filter(r => r.checkKind === 'machine')).toHaveLength(27);
    expect(parsed.rules.find(r => r.id === 'DS-A11Y-1')).toBeDefined();
    expect(parsed.rules.find(r => r.id === 'DS-DELIGHT-6')?.earnedFrom).toContain('DF-0001');
    expect(parsed.rules.find(r => r.id === 'DS-DATA-2')?.measurement).toContain('within 1 unit');
  });
  it('preserves complete field text and canonical applicability', () => {
    const result = parseDesignStandard(fixture());
    expect(result.errors).toEqual([]);
    expect(result.rules[0]).toMatchObject({ id: 'DS-A11Y-1', title: 'Readable labels', surfaces: ['Web', 'Mac'], checkKind: 'machine', source: 'An existing standard.', earnedFrom: ['DF-0001'], measurement: 'Minimum contrast.' });
  });
  it.each(['Rule', 'Why', 'Bad', 'Good', 'Surfaces', 'Check'])('rejects a missing %s field', field => {
    const input = fixture().split('\n').filter(line => !line.startsWith(`- **${field}**:`)).join('\n');
    expect(parseDesignStandard(input).errors.some(e => e.code === 'missing-field' && e.field === field)).toBe(true);
  });
  it('rejects duplicate rule identifiers', () => {
    expect(parseDesignStandard(fixture('\n' + fixture().split('## Accessibility')[1])).errors.some(e => e.code === 'duplicate-rule')).toBe(true);
  });
  it.each(['Desktop', 'Web, Web', ''])('rejects invalid surface declarations %j', surfaces => {
    expect(parseDesignStandard(fixture().replace('Web, Mac.', surfaces)).errors.length).toBeGreaterThan(0);
  });
  it('does not silently downgrade an unknown check kind', () => {
    const parsed = parseDesignStandard(fixture().replace('machine. Contrast', 'manual-ish. Contrast'));
    expect(parsed.errors.some(e => e.code === 'invalid-check')).toBe(true);
    expect(parsed.rules[0].checkKind).toBeNull();
  });
  it('requires source provenance or an earned entry', () => {
    const text = fixture().split('\n').filter(line => !line.startsWith('- **Source**')).join('\n');
    expect(parseDesignStandard(text).errors.some(e => e.code === 'missing-provenance')).toBe(true);
  });
  it('does not truncate an invalid earned reference into a different valid entry', () => {
    const result = parseDesignStandard(fixture().replace('DF-0001.', 'DF-00010.'));
    expect(result.errors.some(e => e.code === 'invalid-earned-reference')).toBe(true);
    expect(result.rules[0].earnedFrom).toEqual([]);
  });
  it('requires the machine index to match machine rules in both directions', () => {
    expect(parseDesignStandard(fixture().replace('| `DS-A11Y-1` | Minimum contrast. |', '')).errors.some(e => e.code === 'machine-index-missing')).toBe(true);
    expect(parseDesignStandard(fixture().replace('machine. Contrast', 'review. Contrast')).errors.some(e => e.code === 'machine-index-extra')).toBe(true);
  });
});


it('rejects a malformed provenance ID even when another valid ID is present', () => {
  const result = parseDesignStandard(fixture().replace('DF-0001.', 'DF-0001, DF-00020.'));
  expect(result.errors.some(e => e.code === 'invalid-earned-reference')).toBe(true);
});
