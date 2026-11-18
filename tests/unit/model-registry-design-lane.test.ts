// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The design-lane teeth of the model-registry freshness lint
 * (docs/specs/frontier-design-review-standard.md §1): a door's `designLane`
 * must be in its frontier set, a `designLane: true` pin must equal the door's
 * lane, and the shipped manifest's real pins point at src/core/designLane.ts.
 */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkModelRegistryFreshness } from '../../scripts/lint-model-registry-freshness.mjs';

const LANE_PIN = {
  id: 'design-lane-claude-code',
  door: 'claude-code',
  tier: 'design',
  file: 'src/core/designLane.ts',
  regex: "DESIGN_LANE_CLAUDE_CODE\\s*=\\s*'((?:claude|gpt|gemini)-[^']+)'",
  designLane: true,
};

function run(opts: { lane: string | null; constant: string; frontier: string[] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-design-lane-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'core', 'designLane.ts'), `export const DESIGN_LANE_CLAUDE_CODE = '${opts.constant}';\n`);
    const manifest = {
      lastReviewedAt: '2999-01-01', stalenessWindowDays: 45, enforcement: 'strict',
      doors: { 'claude-code': { topModels: [
        { id: 'claude-fable-5', frontier: opts.frontier.includes('claude-fable-5') },
        { id: 'claude-fable-5-2', frontier: opts.frontier.includes('claude-fable-5-2') },
      ], designLane: opts.lane } },
      pins: [LANE_PIN],
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: new Date('2999-01-02') });
  } finally {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/model-registry-design-lane.test.ts' });
  }
}

describe('model registry — design lane', () => {
  it('a lane in the frontier set, pinned to the same id, passes', () => {
    const res = run({ lane: 'claude-fable-5-2', constant: 'claude-fable-5-2', frontier: ['claude-fable-5-2'] });
    expect(res.error).toBeNull();
    expect(res.findings).toEqual([]);
  });

  it('a lane outside the frontier set is a finding', () => {
    const res = run({ lane: 'claude-fable-5-2', constant: 'claude-fable-5-2', frontier: ['claude-fable-5'] });
    expect(res.findings.some((f: string) => f.startsWith('DESIGN-LANE:'))).toBe(true);
  });

  it('a lane pin unequal to the door lane is a finding, even when both are frontier', () => {
    const res = run({ lane: 'claude-fable-5-2', constant: 'claude-fable-5', frontier: ['claude-fable-5', 'claude-fable-5-2'] });
    expect(res.findings.some((f: string) => f.includes("design-lane pin 'design-lane-claude-code'"))).toBe(true);
  });

  it('a null lane is allowed', () => {
    const res = run({ lane: null, constant: 'claude-fable-5-2', frontier: ['claude-fable-5-2'] });
    expect(res.findings.filter((f: string) => f.startsWith('DESIGN-LANE:'))).toEqual([]);
  });

  it('the shipped manifest passes and its lane and reviewer pins point at designLane.ts', () => {
    const res = checkModelRegistryFreshness({});
    expect(res.findings.filter((f: string) => /DESIGN-LANE|design-lane/.test(f))).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/model-registry-freshness.manifest.json'), 'utf8'));
    const pins = manifest.pins.filter((p: { id: string }) => p.id.startsWith('design-lane-') || p.id === 'claude-clean-door-reviewer-default');
    expect(pins).toHaveLength(4);
    for (const p of pins) expect(p.file).toBe('src/core/designLane.ts');
  });
});
