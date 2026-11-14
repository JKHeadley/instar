/**
 * redactSpawnError (#2184) — a failed `tmux new-session` must not hand the
 * credentials it was given as argv (`-e GH_TOKEN=…`) to whoever sees the error.
 *
 * Uses a REAL child-process failure so the assertions run against Node's
 * actual `Command failed: <argv>\n<stderr>` message shape, not a guess at it.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { redactSpawnError } from '../../src/core/redactSpawnError.js';

// Fake credentials only. The fine-grained shape is NOT matched by scrubSecrets,
// so it proves the argv line is dropped rather than merely pattern-scrubbed.
const CLASSIC = `ghp_${'A1b2C3d4'.repeat(5)}`;
const FINE_GRAINED = `github_pat_11${'Z9y8X7w6'.repeat(8)}`;

function realSpawnFailure(stderr: string): unknown {
  try {
    execFileSync(process.execPath, [
      '-e', `GH_TOKEN=${CLASSIC}`,
      '-e', `INSTAR_AUTH_TOKEN=${FINE_GRAINED}`,
      '-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(3)`,
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return err;
  }
  throw new Error('expected the child to fail');
}

describe('redactSpawnError', () => {
  it('the raw Node error really does carry the argv credentials (the leak)', () => {
    const err = realSpawnFailure('duplicate session: x');
    const raw = (err as Error).message;
    expect(raw).toContain(CLASSIC);
    expect(raw).toContain(FINE_GRAINED);
  });

  it('drops the argv credentials but keeps the exit status and stderr', () => {
    const out = redactSpawnError(realSpawnFailure('duplicate session: instar-job-a'));
    expect(out).not.toContain(CLASSIC);
    expect(out).not.toContain(FINE_GRAINED);
    expect(out).not.toContain('Command failed');
    expect(out).toContain('exit status 3');
    expect(out).toContain('duplicate session: instar-job-a');
  });

  it('scrubs credentials that show up in stderr itself', () => {
    const out = redactSpawnError(realSpawnFailure(`bad env GH_TOKEN=${FINE_GRAINED} token ${CLASSIC}`));
    expect(out).not.toContain(CLASSIC);
    expect(out).not.toContain(FINE_GRAINED);
    expect(out).toContain('GH_TOKEN=[redacted]');
  });

  it('drops argv that continues past a multi-line element (e.g. a prompt)', () => {
    let err: unknown;
    try {
      execFileSync(process.execPath, [
        '-e', 'process.stderr.write("refused"); process.exit(2)',
        'line one of a prompt\nline two', '-e', `GH_TOKEN=${FINE_GRAINED}`,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { err = e; }
    expect((err as Error).message).toContain(FINE_GRAINED);
    const out = redactSpawnError(err);
    expect(out).not.toContain(FINE_GRAINED);
    expect(out).not.toContain('line two');
    expect(out).toContain('refused');
  });

  it('strips the argv even behind a caller prefix', () => {
    const err = realSpawnFailure('no server running');
    // A re-wrapped message has lost the stderr field, so nothing after
    // `Command failed:` can be told apart from argv; all of it goes.
    const wrapped = new Error(`Failed to create tmux session: ${(err as Error).message}`);
    const out = redactSpawnError(wrapped);
    expect(out).not.toContain(CLASSIC);
    expect(out).not.toContain(FINE_GRAINED);
    expect(out).toContain('Failed to create tmux session:');
  });

  it('keeps the origin-token redaction it replaces', () => {
    const origin = `ior1_${'a'.repeat(43)}`;
    expect(redactSpawnError(new Error(`spawn refused for ${origin}`))).toBe('spawn refused for [origin-token-redacted]');
  });

  it('passes ordinary errors through unchanged and bounds long output', () => {
    expect(redactSpawnError(new Error('Max sessions (10) reached'))).toBe('Max sessions (10) reached');
    expect(redactSpawnError(new Error('x'.repeat(5000))).length).toBeLessThan(600);
  });
});
