// Integration test for Apprenticeship Step 0 — the produced artifacts are a
// fixture-of-record: the REAL echo-to-codey-mentorship.md harvest must pass the
// REAL validator, and the INDEX must reference it. Per spec §11.
//
// Seeding: this harvest seeds nothing (seededToPlaybook: []), by design — process
// meta-lessons live in the artifact, not the bug-shaped playbook, and no bug-class
// item was promoted this run. So there is no live-ledger dependency to assert here;
// the honest candidate-only/#50-independent posture is documented in the spec §5c.
// If a future harvest seeds, this test gains a checkLiveLedger assertion.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateRetroHarvest, parseArtifact } from '../../src/core/retroHarvestValidator';

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md');
const INDEX = path.join(ROOT, 'docs/apprenticeship/retro-harvests/INDEX.json');

describe('Step 0 — the real echo-to-codey harvest artifact', () => {
  it('validates against the real validator (no prior baseline → must be full)', () => {
    const text = readFileSync(ARTIFACT, 'utf8');
    const r = validateRetroHarvest(text, { priorHarvestExists: false });
    if (!r.valid) console.error(r.errors);
    expect(r.valid).toBe(true);
  });

  it('is a full first harvest with an independent (non-Echo) fidelity reviewer', () => {
    const { frontmatter } = parseArtifact(readFileSync(ARTIFACT, 'utf8'));
    expect(frontmatter.scopeMode).toBe('full');
    expect(frontmatter.fidelityReview.reviewer).not.toBe('pending');
    expect(frontmatter.fidelityReview.reviewer).not.toBe('echo');
    expect(['faithful', 'partial']).toContain(frontmatter.fidelityReview.verdict);
  });

  it('seeds nothing (no live-ledger dependency this run — #50-independent by design)', () => {
    const { frontmatter } = parseArtifact(readFileSync(ARTIFACT, 'utf8'));
    expect(frontmatter.seededToPlaybook).toEqual([]);
  });

  it('is registered in the latest-harvest INDEX', () => {
    const index = JSON.parse(readFileSync(INDEX, 'utf8'));
    const entry = index.harvests['echo-to-codey-mentorship'];
    expect(entry).toBeTruthy();
    expect(entry.artifact).toBe('docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md');
  });

  it('the validator-resolvable ledger pointers in the body are well-formed', () => {
    const { body } = parseArtifact(readFileSync(ARTIFACT, 'utf8'));
    const ledgerRefs = (body.match(/\bledger:[0-9a-f]{6,}/g) || []);
    expect(ledgerRefs.length).toBeGreaterThanOrEqual(10);
  });
});
