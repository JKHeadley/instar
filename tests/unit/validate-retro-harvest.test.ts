// Unit tests for the pure retro-harvest validator (scripts/validate-retro-harvest.mjs),
// the structural SIGNAL for Apprenticeship Step 0 artifacts (spec §9). Each decision
// boundary is exercised on BOTH sides: a valid baseline passes, and a single targeted
// mutation fails with the expected error. The validator is pure/offline — the live
// ledger cross-check (checkLiveLedger) is tested separately with an injected fetch.

import { describe, it, expect } from 'vitest';
// @ts-expect-error: .mjs script, not typed
import {
  validateRetroHarvest,
  parseArtifact,
  countSectionItems,
  findSecret,
  safeArtifactPath,
  checkLiveLedger,
  SCHEMA_ID,
  APPROVED_SCRUBBERS,
} from '../../scripts/validate-retro-harvest.mjs';

// Build a VALID artifact, with optional frontmatter overrides + body override.
function buildArtifact(fmOverrides: Record<string, unknown> = {}, body?: string): string {
  const fm: Record<string, unknown> = {
    schema: SCHEMA_ID,
    instanceType: 'mentorship',
    from: 'echo',
    to: 'codey',
    framework: 'codex-cli',
    harvestedAt: '2026-06-02T03:00:00Z',
    scopeMode: 'full',
    completeness: 'complete',
    sourcesCovered: {
      ledger: { read: true, issueCount: 12 },
      playbook: { read: true, entryCount: 3 },
      memory: { read: true, files: 40 },
      threads: [{ id: 13435, fromTs: '2026-05-26T00:00:00Z', toTs: '2026-06-02T03:00:00Z', messagesRead: 500, truncated: false }],
      prs: [666, 669],
    },
    counts: { lessons: 1, metaLessons: 1, processInsights: 1 },
    seededToPlaybook: [],
    redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 2, scrubbedAt: '2026-06-02T03:00:00Z' },
    fidelityReview: { reviewer: 'claude-opus-independent', verdict: 'faithful', at: '2026-06-02T03:05:00Z' },
    programNeeds: 1,
    ...fmOverrides,
  };
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const defaultBody = [
    '## Lessons',
    '- Codex stop-hook emits invalid JSON on completion. ledger:4c4a8ded',
    '## Meta-lessons',
    '- The real work is the runtime adapter. thread:13435#m100',
    '## Process-insights',
    '- The dual-vantage loop finds root causes a checklist misses.',
    '## What the program needs',
    '- need-001 (motivatedBy: dual-vantage) the differential read-channel.',
  ].join('\n');
  return `---\n${yamlLines}\n---\n\n${body ?? defaultBody}\n`;
}

describe('validateRetroHarvest — valid baseline', () => {
  it('passes a well-formed full first harvest', () => {
    const r = validateRetroHarvest(buildArtifact());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('parseArtifact', () => {
  it('parses frontmatter + body', () => {
    const { frontmatter, body } = parseArtifact(buildArtifact());
    expect(frontmatter.schema).toBe(SCHEMA_ID);
    expect(body).toContain('## Lessons');
  });
  it('throws without frontmatter', () => {
    expect(() => parseArtifact('# just a doc, no frontmatter')).toThrow(/frontmatter/);
  });
});

describe('countSectionItems', () => {
  it('counts only top-level bullets within the named section', () => {
    const body = '## Lessons\n- a\n- b\n## Meta-lessons\n- c\n';
    expect(countSectionItems(body, 'Lessons')).toBe(2);
    expect(countSectionItems(body, 'Meta-lessons')).toBe(1);
    expect(countSectionItems(body, 'Process-insights')).toBe(0);
  });
});

describe('validateRetroHarvest — schema + required fields', () => {
  it('fails on wrong schema id', () => {
    const r = validateRetroHarvest(buildArtifact({ schema: 'wrong/v9' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/schema must be/);
  });
  it('fails on missing instanceType', () => {
    const r = validateRetroHarvest(buildArtifact({ instanceType: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/instanceType|missing required field: instanceType/);
  });
  it('fails on bad instanceType enum', () => {
    const r = validateRetroHarvest(buildArtifact({ instanceType: 'friendship' }));
    expect(r.errors.join()).toMatch(/instanceType must be one of/);
  });
});

describe('validateRetroHarvest — scope rule (first harvest must be full)', () => {
  it('fails: incremental with no prior baseline', () => {
    const r = validateRetroHarvest(buildArtifact({ scopeMode: 'incremental' }), { priorHarvestExists: false });
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/incremental.*requires a prior harvest|first harvest must be "full"/);
  });
  it('passes: incremental WITH a prior baseline', () => {
    const r = validateRetroHarvest(buildArtifact({ scopeMode: 'incremental' }), { priorHarvestExists: true });
    expect(r.valid).toBe(true);
  });
});

describe('validateRetroHarvest — sourcesCovered coverage extent', () => {
  it('fails when threads carry bare booleans instead of extent', () => {
    const r = validateRetroHarvest(buildArtifact({
      sourcesCovered: { ledger: { read: true, issueCount: 1 }, playbook: { read: true, entryCount: 1 }, memory: { read: true, files: 1 }, threads: [{ id: 1, read: true }], prs: [] },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/coverage extent|messagesRead/);
  });
  it('fails when ledger lacks issueCount', () => {
    const r = validateRetroHarvest(buildArtifact({
      sourcesCovered: { ledger: { read: true }, playbook: { read: true, entryCount: 1 }, memory: { read: true, files: 1 }, threads: [], prs: [] },
    }));
    expect(r.errors.join()).toMatch(/ledger must carry/);
  });
});

describe('validateRetroHarvest — completeness vs truncation', () => {
  it('fails: completeness "complete" but a thread is truncated', () => {
    const r = validateRetroHarvest(buildArtifact({
      completeness: 'complete',
      sourcesCovered: { ledger: { read: true, issueCount: 1 }, playbook: { read: true, entryCount: 1 }, memory: { read: true, files: 1 }, threads: [{ id: 1, messagesRead: 10, truncated: true }], prs: [] },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/complete.*invalid when a source is truncated|partial-accepted/);
  });
  it('passes: partial-accepted with a truncated source', () => {
    const r = validateRetroHarvest(buildArtifact({
      completeness: 'partial-accepted',
      sourcesCovered: { ledger: { read: true, issueCount: 1 }, playbook: { read: true, entryCount: 1 }, memory: { read: true, files: 1 }, threads: [{ id: 1, messagesRead: 10, truncated: true }], prs: [] },
    }));
    expect(r.valid).toBe(true);
  });
});

describe('validateRetroHarvest — count reconciliation', () => {
  it('fails when counts.lessons disagrees with the body', () => {
    const r = validateRetroHarvest(buildArtifact({ counts: { lessons: 5, metaLessons: 1, processInsights: 1 } }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/counts\.lessons=5 but body has 1/);
  });
  it('fails when programNeeds disagrees with the body', () => {
    const r = validateRetroHarvest(buildArtifact({ programNeeds: 9 }));
    expect(r.errors.join()).toMatch(/programNeeds=9 but body has 1/);
  });
});

describe('validateRetroHarvest — redaction gate', () => {
  it('fails on an unapproved scrubber', () => {
    const r = validateRetroHarvest(buildArtifact({ redaction: { scrubber: 'sketchy-scrub@v1', findingsRemoved: 0, scrubbedAt: 'x' } }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/not in approved list/);
  });
  it('fails on a failed scrub status', () => {
    const r = validateRetroHarvest(buildArtifact({ redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 0, scrubbedAt: 'x', status: 'failed' } }));
    expect(r.errors.join()).toMatch(/scrub must succeed/);
  });
  it('accepts every approved scrubber name', () => {
    for (const s of APPROVED_SCRUBBERS) {
      const r = validateRetroHarvest(buildArtifact({ redaction: { scrubber: `${s}@v2`, findingsRemoved: 1, scrubbedAt: 'x' } }));
      expect(r.valid).toBe(true);
    }
  });
});

describe('validateRetroHarvest — fidelity review authority', () => {
  it('fails on verdict rejected', () => {
    const r = validateRetroHarvest(buildArtifact({ fidelityReview: { reviewer: 'x', verdict: 'rejected', at: 'y' } }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/rejected/);
  });
  it('fails on partial without named gaps', () => {
    const r = validateRetroHarvest(buildArtifact({ fidelityReview: { reviewer: 'x', verdict: 'partial', at: 'y' } }));
    expect(r.errors.join()).toMatch(/partial.*must name the gaps/);
  });
  it('passes on partial WITH named gaps', () => {
    const r = validateRetroHarvest(buildArtifact({ fidelityReview: { reviewer: 'x', verdict: 'partial', at: 'y', gaps: 'thread 458 under-sampled' } }));
    expect(r.valid).toBe(true);
  });
});

describe('validateRetroHarvest — evidence pointers + secret backstop', () => {
  it('fails on a malformed pointer', () => {
    const body = '## Lessons\n- bad pointer ledger:NOThex!!\n## Meta-lessons\n- m\n## Process-insights\n- p\n## What the program needs\n- need-001 x\n';
    const r = validateRetroHarvest(buildArtifact({}, body));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/malformed evidence pointer/);
  });
  it('tolerates trailing punctuation after a pointer (clause boundary)', () => {
    const body = '## Lessons\n- ok ledger:abc123\n## Meta-lessons\n- ref (motivatedBy: ledger:def456, priority: high)\n## Process-insights\n- p thread:13435#m1.\n## What the program needs\n- need-001 x\n';
    const r = validateRetroHarvest(buildArtifact({}, body));
    expect(r.valid).toBe(true);
  });
  it('fails on a secret-shaped string (Bearer)', () => {
    const body = '## Lessons\n- leaked Bearer abcDEF12345 token\n## Meta-lessons\n- m\n## Process-insights\n- p\n## What the program needs\n- need-001 x\n';
    const r = validateRetroHarvest(buildArtifact({}, body));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/secret-shaped/);
  });
  it('fails on a tunnel sig', () => {
    const body = '## Lessons\n- see https://x/view/y?sig=0123456789abcdef0123\n## Meta-lessons\n- m\n## Process-insights\n- p\n## What the program needs\n- need-001 x\n';
    const r = validateRetroHarvest(buildArtifact({}, body));
    expect(r.errors.join()).toMatch(/secret-shaped/);
  });
});

describe('findSecret', () => {
  it('detects an email and clean text returns null', () => {
    expect(findSecret('contact me at a@b.com')).toBe('email');
    expect(findSecret('a clean process insight')).toBeNull();
  });
});

describe('safeArtifactPath', () => {
  it('builds the confined path', () => {
    expect(safeArtifactPath('echo', 'codey', 'mentorship')).toBe('docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md');
  });
  it('rejects a traversal component', () => {
    expect(() => safeArtifactPath('echo', '../etc', 'mentorship')).toThrow(/unsafe path component/);
  });
  it('rejects a slash component', () => {
    expect(() => safeArtifactPath('echo', 'a/b', 'mentorship')).toThrow(/unsafe path component/);
  });
});

describe('checkLiveLedger (injected fetch)', () => {
  it('ok when every seeded id resolves at candidate+', async () => {
    const fetchImpl = async (id: string) => ({ found: true, playbookStatus: 'candidate' });
    const r = await checkLiveLedger({ seededToPlaybook: [{ id: 'abc' }, { id: 'def' }] }, fetchImpl);
    expect(r.ok).toBe(true);
  });
  it('fails when a seeded id is missing', async () => {
    const fetchImpl = async () => ({ found: false });
    const r = await checkLiveLedger({ seededToPlaybook: [{ id: 'abc' }] }, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/not found/);
  });
  it('fails when a seeded id is below candidate', async () => {
    const fetchImpl = async () => ({ found: true, playbookStatus: 'none' });
    const r = await checkLiveLedger({ seededToPlaybook: [{ id: 'abc' }] }, fetchImpl);
    expect(r.errors.join()).toMatch(/expected candidate/);
  });
  it('ok with no seeds', async () => {
    const r = await checkLiveLedger({ seededToPlaybook: [] }, async () => ({ found: true, playbookStatus: 'candidate' }));
    expect(r.ok).toBe(true);
  });
});
