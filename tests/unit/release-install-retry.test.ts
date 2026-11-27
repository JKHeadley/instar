import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const workflow = yaml.load(readFileSync('.github/workflows/publish.yml', 'utf8')) as any;
const steps = workflow.jobs.publish.steps;
const install = steps.find((step: any) => step.name === 'Install release dependencies (up to three attempts)');

function exercise(failures: number) {
  const dir = mkdtempSync(join(tmpdir(), 'release-install-retry-'));
  try {
    writeFileSync(join(dir, 'npm'), `#!/bin/bash\necho "$*" >> "$PROBE_DIR/calls"\nn=$(wc -l < "$PROBE_DIR/calls")\nif [ "$n" -le "$FAILURES" ]; then exit 42; fi\n`);
    writeFileSync(join(dir, 'sleep'), '#!/bin/bash\necho "$*" >> "$PROBE_DIR/waits"\n');
    for (const name of ['npm', 'sleep']) chmodSync(join(dir, name), 0o755);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', install.run], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROBE_DIR: dir, FAILURES: String(failures) },
      encoding: 'utf8', timeout: 5000,
    });
    const lines = (name: string) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n'); } catch { return []; } };
    return { status: result.status, calls: lines('calls'), waits: lines('waits'), output: result.stdout };
  } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'release-install-retry test cleanup' }); }
}

describe('release dependency install retry under GitHub Bash options', () => {
  it('is wired before the build and never retries npm publish', () => {
    expect(install.shell).toBe('bash');
    expect(steps.indexOf(install)).toBeLessThan(steps.findIndex((s: any) => s.run === 'npm run build'));
    expect(steps.find((s: any) => s.name === 'Publish to npm').run).toBe('npm publish --provenance --access public');
  });
  it.each([0, 1, 2])('succeeds after %i failed installs and stops immediately', (failures) => {
    const result = exercise(failures);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(Array(failures + 1).fill('ci'));
    expect(result.waits).toEqual(['15', '30'].slice(0, failures));
  });
  it('fails with the last install status after exactly three attempts', () => {
    const result = exercise(99);
    expect(result.status).toBe(42);
    expect(result.calls).toEqual(['ci', 'ci', 'ci']);
    expect(result.waits).toEqual(['15', '30']);
    expect(result.output).toContain('::error::');
  });
});
