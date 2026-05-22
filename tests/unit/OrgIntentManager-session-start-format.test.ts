/**
 * Unit tests — `formatOrgIntentForSessionStart`.
 *
 * Tier 1 of the Testing Integrity Standard for Phase 2 of the ORG-INTENT
 * runtime project (session-start injection). The formatter is pure and
 * deterministic; these tests pin the exact output structure so a future
 * refactor cannot silently change what the agent sees at session boot.
 */

import { describe, it, expect } from 'vitest';
import { formatOrgIntentForSessionStart, type ParsedOrgIntent } from '../../src/core/OrgIntentManager.js';

function makeIntent(overrides: Partial<ParsedOrgIntent> = {}): ParsedOrgIntent {
  return {
    name: 'Test Org',
    constraints: [],
    goals: [],
    values: [],
    tradeoffHierarchy: [],
    raw: '',
    ...overrides,
  };
}

describe('formatOrgIntentForSessionStart', () => {
  it('renders all four buckets in the expected order with the contract preamble', () => {
    const intent = makeIntent({
      name: 'Acme Co',
      constraints: [
        { text: 'Never quote internal pricing', source: 'org-intent' },
        { text: 'Always disclose AI nature', source: 'org-intent' },
      ],
      goals: [{ text: 'Resolve on first contact', source: 'org-intent', specializable: true }],
      values: ['Honesty over expedience'],
      tradeoffHierarchy: ['Customer trust over speed', 'Compliance over convenience'],
    });

    const block = formatOrgIntentForSessionStart(intent);

    expect(block).toContain('=== ORGANIZATIONAL INTENT ===');
    expect(block).toContain('Organization: Acme Co');
    expect(block).toContain('This is your operating contract');
    expect(block).toContain('CONSTRAINTS (mandatory');
    expect(block).toContain('Never quote internal pricing');
    expect(block).toContain('Always disclose AI nature');
    expect(block).toContain('GOALS (organizational defaults');
    expect(block).toContain('Resolve on first contact');
    expect(block).toContain('VALUES (representation');
    expect(block).toContain('Honesty over expedience');
    expect(block).toContain('TRADEOFF HIERARCHY');
    expect(block).toContain('1. Customer trust over speed');
    expect(block).toContain('2. Compliance over convenience');
    expect(block).toContain('=== END ORGANIZATIONAL INTENT ===');

    // Bucket order: CONSTRAINTS first, then GOALS, VALUES, TRADEOFF HIERARCHY
    const cIdx = block.indexOf('CONSTRAINTS');
    const gIdx = block.indexOf('GOALS');
    const vIdx = block.indexOf('VALUES');
    const tIdx = block.indexOf('TRADEOFF HIERARCHY');
    expect(cIdx).toBeGreaterThan(0);
    expect(cIdx).toBeLessThan(gIdx);
    expect(gIdx).toBeLessThan(vIdx);
    expect(vIdx).toBeLessThan(tIdx);
  });

  it('omits empty buckets entirely (no empty section headers)', () => {
    const intent = makeIntent({
      name: 'GoalsOnly Inc',
      goals: [{ text: 'Be friendly', source: 'org-intent', specializable: true }],
    });

    const block = formatOrgIntentForSessionStart(intent);
    expect(block).toContain('GOALS (organizational defaults');
    expect(block).toContain('Be friendly');
    expect(block).not.toContain('CONSTRAINTS (mandatory');
    expect(block).not.toContain('VALUES (representation');
    expect(block).not.toContain('TRADEOFF HIERARCHY');
  });

  it('renders a minimal intent (name only) with just preamble + framing', () => {
    const intent = makeIntent({ name: 'Minimal Org' });
    const block = formatOrgIntentForSessionStart(intent);

    expect(block).toContain('Organization: Minimal Org');
    expect(block).toContain('=== ORGANIZATIONAL INTENT ===');
    expect(block).toContain('=== END ORGANIZATIONAL INTENT ===');
    expect(block).not.toContain('CONSTRAINTS (mandatory');
    expect(block).not.toContain('GOALS (organizational defaults');
  });

  it('numbers tradeoff hierarchy entries starting at 1', () => {
    const intent = makeIntent({
      tradeoffHierarchy: ['Alpha', 'Beta', 'Gamma'],
    });
    const block = formatOrgIntentForSessionStart(intent);
    expect(block).toContain('  1. Alpha');
    expect(block).toContain('  2. Beta');
    expect(block).toContain('  3. Gamma');
  });

  it('uses two-space indent for bullet items (consistent with other session-start blocks)', () => {
    const intent = makeIntent({
      constraints: [{ text: 'Item one', source: 'org-intent' }],
    });
    const block = formatOrgIntentForSessionStart(intent);
    expect(block).toContain('  - Item one');
  });

  it('output is deterministic — same input produces same string', () => {
    const intent = makeIntent({
      name: 'Determ Inc',
      constraints: [{ text: 'X', source: 'org-intent' }],
      goals: [{ text: 'Y', source: 'org-intent', specializable: true }],
    });
    const block1 = formatOrgIntentForSessionStart(intent);
    const block2 = formatOrgIntentForSessionStart(intent);
    expect(block1).toBe(block2);
  });
});
