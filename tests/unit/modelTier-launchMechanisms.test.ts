/**
 * §5.2 launch-time mechanism pins — Model-Tier Escalation
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §5.2 / §11).
 *
 * The spec's round-1 review found these three mechanisms MISSING; they have
 * since landed on main. These tests pin them so a regression re-opens the
 * spec's CRITICAL findings loudly:
 *  (a) interactive claude builder honors --model (Int-C1);
 *  (b) frameworkDefaultModels spans all four frameworks (Int-H1);
 *  (d) spawnInteractiveSession seeds Session.model from the RESOLVED launch
 *      model so GET /sessions is an honest oracle (Int-C3).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInteractiveLaunch, buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'src');

describe('§5.2(a) — interactive claude builder emits --model (Int-C1 pin)', () => {
  it('launches the ultra model when defaultModel is the raw fable id', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      defaultModel: 'claude-fable-5',
    });
    const i = spec.argv.indexOf('--model');
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBe('claude-fable-5');
  });

  it('headless claude builder honors the same id', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      model: 'claude-fable-5',
    });
    const i = spec.argv.indexOf('--model');
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBe('claude-fable-5');
  });

  it('emits NOTHING when unset (account default preserved — no surprise pinning)', () => {
    const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/x/claude' });
    expect(spec.argv).not.toContain('--model');
  });
});

describe('§5.2(b) — frameworkDefaultModels spans all four frameworks (Int-H1 pin)', () => {
  it('SessionManagerConfig.frameworkDefaultModels declares all four keys', () => {
    const types = fs.readFileSync(path.join(SRC, 'core', 'types.ts'), 'utf-8');
    const m = types.match(/frameworkDefaultModels\?\s*:\s*\{([^}]*)\}/);
    expect(m, 'frameworkDefaultModels not found on SessionManagerConfig').toBeTruthy();
    for (const fw of ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli']) {
      expect(m![1]).toContain(`'${fw}'`);
    }
  });
});

describe('§5.2(d) — Session.model seeded at interactive spawn (Int-C3 pin)', () => {
  it('spawnInteractiveSession seeds model from the RESOLVED launch model', () => {
    const sm = fs.readFileSync(path.join(SRC, 'core', 'SessionManager.ts'), 'utf-8');
    const spawnBody = sm.slice(sm.indexOf('async spawnInteractiveSession('));
    const recordIdx = spawnBody.indexOf('const session: Session = {');
    expect(recordIdx, 'interactive Session record creation not found').toBeGreaterThan(-1);
    const record = spawnBody.slice(recordIdx, recordIdx + 2500);
    // The seeding expression uses the shared interactive launch resolver so
    // Codex local-provider model pins and post-rate-limit swaps are reported
    // exactly as they were launched. Keep this assertion semantic rather than
    // pinning the helper's internal implementation shape.
    expect(record).toMatch(
      /resolveInteractiveLaunchModel\(framework,\s*launchDefaultModel,\s*options\?\.codexLocalProvider\)/,
    );
  });

  it('headless spawnSession seeds model from the resolved launch value', () => {
    const sm = fs.readFileSync(path.join(SRC, 'core', 'SessionManager.ts'), 'utf-8');
    expect(sm).toMatch(/model:\s*resolveModelForFramework\(headlessFramework,\s*options\.model\)\s*\?\?\s*options\.model/);
  });
});
