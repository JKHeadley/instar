import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const script = path.resolve('skills/spec-converge/scripts/write-convergence-tag.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'write-convergence-tag-maturation-plan.test cleanup' });
});

describe('write-convergence-tag maturation warning', () => {
  it('warns but still stamps a structurally incomplete maturation plan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-warn-'));
    roots.push(root);
    const spec = path.join(root, 'warn.md');
    const report = path.join(root, 'report.md');
    const eli16 = path.join(root, 'warn.eli16.md');
    fs.writeFileSync(spec, '---\ntitle: warn\nslug: warn\neli16-overview: ' + eli16 + '\n---\n# Warn\n\n## Decision points touched\n*(none)*\n\n## Maturation plan\n- **fleet:** later\n');
    fs.writeFileSync(report, '# report\n');
    fs.writeFileSync(eli16, 'x'.repeat(900));
    const run = spawnSync(process.execPath, [script, '--spec', spec, '--iterations', '1', '--report', report], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('MATURATION_PLAN_WARN');
    expect(fs.readFileSync(spec, 'utf8')).toContain('review-convergence:');
  });
});
