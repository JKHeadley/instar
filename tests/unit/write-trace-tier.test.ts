// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tests for the tier declaration added to
 * skills/instar-dev/scripts/write-trace.mjs (Step A of the Tiered Development
 * Process, docs/specs/tier-classifier-and-tier1-path-spec.md).
 *
 * The trace writer must:
 *   - Round-trip a TIER-1 trace: `tier: 1` + `eli16Path` + `sideEffectsPath`,
 *     and NO `specPath` (a Tier-1 commit ships an ELI16 + side-effects instead
 *     of a converged + approved spec). `--spec` is OPTIONAL when `--tier 1`.
 *   - Round-trip a TIER-2 trace UNCHANGED: `specPath` is present, no tier
 *     declaration leaks into the legacy shape unless explicitly passed.
 *
 * The script derives its ROOT from its own location (import.meta.url → up three
 * dirs), not from cwd. So we copy it into a sandbox at the same relative depth
 * (skills/instar-dev/scripts/) and run the sandbox copy, exactly as the gate
 * tests copy the hook into their sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITE_TRACE = path.join(REPO_ROOT, 'skills', 'instar-dev', 'scripts', 'write-trace.mjs');

interface RunResult { status: number | null; stdout: string; stderr: string; }

describe('write-trace.mjs — tier declaration (Step A)', () => {
  let sandbox: string;
  let sandboxScript: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'write-trace-tier-'));
    // Mirror the script's expected layout: skills/instar-dev/scripts/<script>.
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'docs', 'specs'), { recursive: true });
    sandboxScript = path.join(sandbox, 'skills', 'instar-dev', 'scripts', 'write-trace.mjs');
    fs.copyFileSync(WRITE_TRACE, sandboxScript);
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/write-trace-tier.test.ts:cleanup' });
    } catch { /* ignore */ }
  });

  function run(args: string[]): RunResult {
    const r = spawnSync('node', [sandboxScript, ...args], { cwd: sandbox, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  function writeArtifact(rel: string): string {
    const abs = path.join(sandbox, rel);
    fs.writeFileSync(abs, `# Side-effects review\n\n## Summary\n\n${'x'.repeat(400)}\n`);
    return rel;
  }

  function readTrace(stdoutRel: string): any {
    const traceRel = stdoutRel.trim();
    return JSON.parse(fs.readFileSync(path.join(sandbox, traceRel), 'utf8'));
  }

  it('round-trips a TIER-1 trace: tier:1 + eli16Path + sideEffectsPath, NO specPath', () => {
    const artifact = writeArtifact('upgrades/side-effects/widget.md');
    const eli16 = 'docs/specs/widget.eli16.md';
    fs.writeFileSync(path.join(sandbox, eli16), `# ELI16\n\n${'y'.repeat(400)}\n`);

    const res = run([
      '--artifact', artifact,
      '--files', 'src/a.ts,src/b.ts',
      '--tier', '1',
      '--tier-reasoning', 'Small observability tweak, no risk signals.',
      '--eli16-path', eli16,
      '--side-effects-path', artifact,
    ]);

    expect(res.status).toBe(0);
    const trace = readTrace(res.stdout);

    expect(trace.tier).toBe(1);
    expect(trace.tierReasoning).toBe('Small observability tweak, no risk signals.');
    expect(trace.eli16Path).toBe(eli16);
    expect(trace.sideEffectsPath).toBe(artifact);
    // A Tier-1 trace carries NO specPath.
    expect(trace).not.toHaveProperty('specPath');
    // Existing fields still present + correct.
    expect(trace.phase).toBe('complete');
    expect(trace.artifactPath).toBe(artifact);
    expect(trace.coveredFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(typeof trace.artifactSha256).toBe('string');
  });

  it('--side-effects-path defaults to --artifact when omitted on a Tier-1 trace', () => {
    const artifact = writeArtifact('upgrades/side-effects/widget.md');
    const eli16 = 'docs/specs/widget.eli16.md';
    fs.writeFileSync(path.join(sandbox, eli16), `# ELI16\n\n${'y'.repeat(400)}\n`);

    const res = run([
      '--artifact', artifact,
      '--files', 'src/a.ts',
      '--tier', '1',
      '--eli16-path', eli16,
    ]);

    expect(res.status).toBe(0);
    const trace = readTrace(res.stdout);
    expect(trace.tier).toBe(1);
    expect(trace.sideEffectsPath).toBe(artifact);
    expect(trace).not.toHaveProperty('specPath');
  });

  it('a Tier-1 trace WITHOUT --eli16-path is rejected (usage error)', () => {
    const artifact = writeArtifact('upgrades/side-effects/widget.md');
    const res = run([
      '--artifact', artifact,
      '--files', 'src/a.ts',
      '--tier', '1',
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/eli16-path/i);
  });

  it('round-trips a TIER-2 trace UNCHANGED: specPath present, no tier1 fields', () => {
    const artifact = writeArtifact('upgrades/side-effects/widget.md');
    const spec = 'docs/specs/widget.md';
    fs.writeFileSync(path.join(sandbox, spec), `---\ntitle: Widget\napproved: true\nreview-convergence: tactical\n---\n\nbody\n`);

    const res = run([
      '--artifact', artifact,
      '--files', 'src/a.ts,src/b.ts',
      '--spec', spec,
      '--tier', '2',
      '--tier-reasoning', 'New subsystem — converged spec required.',
    ]);

    expect(res.status).toBe(0);
    const trace = readTrace(res.stdout);

    expect(trace.tier).toBe(2);
    expect(trace.specPath).toBe(spec);
    // Tier-1-only fields must NOT appear on a Tier-2 trace.
    expect(trace).not.toHaveProperty('eli16Path');
    expect(trace).not.toHaveProperty('sideEffectsPath');
    expect(trace.phase).toBe('complete');
  });

  it('a NO-TIER trace round-trips to the legacy shape (specPath present, no tier field)', () => {
    // Back-compat: an undeclared trace must look exactly as before Step A.
    const artifact = writeArtifact('upgrades/side-effects/widget.md');
    const spec = 'docs/specs/widget.md';
    fs.writeFileSync(path.join(sandbox, spec), `---\ntitle: Widget\napproved: true\nreview-convergence: tactical\n---\n\nbody\n`);

    const res = run([
      '--artifact', artifact,
      '--files', 'src/a.ts',
      '--spec', spec,
    ]);

    expect(res.status).toBe(0);
    const trace = readTrace(res.stdout);

    expect(trace.specPath).toBe(spec);
    expect(trace).not.toHaveProperty('tier');
    expect(trace).not.toHaveProperty('tierReasoning');
    expect(trace).not.toHaveProperty('eli16Path');
    expect(trace).not.toHaveProperty('sideEffectsPath');
  });
});
