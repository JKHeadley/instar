/**
 * The constitution check's model calls send the whole spec on standard input,
 * never as a command-line argument (Chief of Staff's reviewer, 2026-11-27): driven
 * through the REAL Claude provider against a stand-in `claude` that records what it
 * was given.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { StandardsConformanceReviewer } from '../../src/core/reviewers/standards-conformance.js';
import { parseStandardsRegistry } from '../../src/core/StandardsRegistryParser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/standards-conformance-stdin-payload.test.ts' });
});

function recordingClaude(reply: string): { bin: string; argv: string; stdin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-stdin-'));
  dirs.push(dir);
  const bin = path.join(dir, 'claude');
  const argv = path.join(dir, 'argv.txt');
  const stdin = path.join(dir, 'stdin.txt');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\ncat > '${stdin}'\nprintf '%s' '${JSON.stringify({ is_error: false, result: reply })}'\n`, { mode: 0o755 });
  return { bin, argv, stdin };
}

describe('conformance calls carry the spec on standard input through the real Claude provider', () => {
  const articles = parseStandardsRegistry(fs.readFileSync(path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md'), 'utf-8'));

  it('review(): a 200,000-character spec arrives whole on stdin and none of it in argv; no tools offered', async () => {
    const rec = recordingClaude('[]');
    const marker = 'SPEC-BODY-MARKER-7f3a';
    const spec = `# Big\n${marker}\n` + 'x'.repeat(200_000) + `\nEND-${marker}`;
    const report = await new StandardsConformanceReviewer(new ClaudeCliIntelligenceProvider(rec.bin)).review(spec, articles);
    expect(report.degraded).toBe(false);
    const sent = fs.readFileSync(rec.stdin, 'utf-8');
    expect(sent).toContain(spec);
    const argv = fs.readFileSync(rec.argv, 'utf-8');
    expect(argv).not.toContain(marker);
    expect(argv.length).toBeLessThan(2_000);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv.split('\n')).toContain('--tools');
    expect(report.charsJudged).toBe(spec.length);
  });

  it('judgeFit(): the spec also goes on stdin, with the same model pin as the tier', async () => {
    const rec = recordingClaude('{"verdict":"fit","reason":"ok"}');
    const marker = 'FIT-MARKER-91c2';
    const fit = await new StandardsConformanceReviewer(new ClaudeCliIntelligenceProvider(rec.bin), { model: 'capable' })
      .judgeFit(`# S\n${marker}`, 'No Manual Work', articles);
    expect(fit.verdict).toBe('fit');
    expect(fs.readFileSync(rec.stdin, 'utf-8')).toContain(marker);
    const argv = fs.readFileSync(rec.argv, 'utf-8').split('\n');
    expect(argv).not.toContain(marker);
    const { resolveCliFlag } = await import('../../src/core/models.js');
    expect(argv[argv.indexOf('--model') + 1]).toBe(resolveCliFlag('capable'));
  });
});
