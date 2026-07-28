// safe-git-allow: test-tmpdir-cleanup — finally-block removes the per-test mkdtempSync tmpdir.
/**
 * Freshness-lint NON-VACUITY test (REVIEWER-DOOR-REWIRING §Testing / §Migration
 * parity). The `claude-clean-door-reviewer-default` pin extracts a frontier
 * CONSTANT (`CLAUDE_REVIEWER_DEFAULT_MODEL`), NOT a `capable:'…'` tier decl the
 * existing pins target — so its regex could silently fail to match (a VACUOUS
 * tooth that passes without checking anything). This test proves the tooth is
 * live: rot the constant → the strict lint FAILS with a DRIFT finding; keep it
 * frontier → no finding. Closes the vacuity risk with a test, not a prose
 * "the implementer MUST verify".
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkModelRegistryFreshness } from '../../scripts/lint-model-registry-freshness.mjs';

const REVIEWER_PIN = {
  id: 'claude-clean-door-reviewer-default',
  door: 'claude-code',
  tier: 'capable',
  file: 'src/core/crossModelReviewer.ts',
  regex: "CLAUDE_REVIEWER_DEFAULT_MODEL\\s*=\\s*'((?:claude|gpt|gemini)-[^']+)'",
};

// A manifest whose claude-code door frontier set is [opus-4-8, fable-5], with ONLY
// the reviewer pin — so a finding can only come from the reviewer pin itself.
function fixtureManifest(): Record<string, unknown> {
  return {
    lastReviewedAt: '2999-01-01', // never stale, so staleness never confounds the drift result
    stalenessWindowDays: 45,
    enforcement: 'strict',
    doors: {
      'claude-code': {
        topModels: [
          { id: 'claude-opus-4-8', frontier: true },
          { id: 'claude-fable-5', frontier: true },
        ],
      },
    },
    pins: [REVIEWER_PIN],
  };
}

function runWithConstant(constantValue: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-reviewer-pin-'));
  const manifestPath = path.join(root, 'manifest.json');
  try {
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'core', 'crossModelReviewer.ts'),
      `export const CLAUDE_REVIEWER_DEFAULT_MODEL = '${constantValue}';\n`,
      'utf-8',
    );
    fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest()), 'utf-8');
    return checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: new Date('2999-01-02') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('freshness lint — reviewer default pin is NOT vacuous', () => {
  it('a ROTTED constant (claude-fable-4) produces a DRIFT finding (the tooth bites)', () => {
    const res = runWithConstant('claude-fable-4');
    expect(res.error).toBeNull();
    const drift = res.findings.filter((f) => /DRIFT/.test(f) && /claude-clean-door-reviewer-default/.test(f));
    expect(drift.length).toBeGreaterThan(0);
    // and the finding names the rotted id, proving the regex extracted the value
    expect(drift.join('\n')).toContain('claude-fable-4');
  });

  it('the current frontier pin (claude-fable-5) produces NO finding', () => {
    const res = runWithConstant('claude-fable-5');
    expect(res.error).toBeNull();
    expect(res.findings).toHaveLength(0);
  });

  it('the regex MATCHES the constant (a non-match would itself be a finding, never a silent pass)', () => {
    // A completely wrong shape would emit "pattern did not match" — assert the
    // extraction is live by confirming the happy path is clean AND the rot path bites.
    const clean = runWithConstant('claude-fable-5');
    const rotted = runWithConstant('claude-opus-4-6');
    expect(clean.findings).toHaveLength(0);
    expect(rotted.findings.some((f) => /claude-clean-door-reviewer-default/.test(f))).toBe(true);
  });
});
